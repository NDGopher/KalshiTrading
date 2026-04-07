import type { ArchiveMarketTick } from "../normalize.js";
import {
  blindReplayAnalysisForTick,
  buildBlindReplayCandidate,
  resolveOutcomeForTick,
} from "../synthetic-analysis.js";
import { pnlKalshiTaker } from "../kalshi-fees.js";
import { CONSERVATIVE_LIP_USD_PER_CONTRACT } from "../kalshi-fees.js";
import type {
  BacktestMetrics,
  EquityPoint,
  ReplayAnalysis,
  ReplayCandidate,
  ReplayRiskLimits,
  SimulatedTrade,
  SportBucketMetrics,
  Strategy,
} from "../types.js";
import { GameLegBook } from "./game-legs.js";
import { aggregateSportBuckets, kalshiSportLabel } from "./sport-bucket.js";
import { TickerPriceRolling } from "./price-history.js";
import { ReplayRiskState, computeStakeUsd } from "./replay-risk.js";
import { effectiveRiskForStrategy } from "./strategy-risk-merge.js";
import {
  FreshWalletTracker,
  MarketMakerSim,
  TapeFlowTracker,
  WalletActivityTracker,
  WalletSettlementProfiler,
} from "./tape-context.js";

function sortTicks(ticks: ArchiveMarketTick[]): ArchiveMarketTick[] {
  return [...ticks].sort((a, b) => a.tsMs - b.tsMs || a.ticker.localeCompare(b.ticker));
}

function maxDrawdownPct(curve: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak <= 0) continue;
    maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
  }
  return maxDd;
}

function sharpeFromPnls(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const v = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (pnls.length - 1);
  const sd = Math.sqrt(v) || 1e-9;
  return (mean / sd) * Math.sqrt(pnls.length);
}

function resolveOutcome(tick: ArchiveMarketTick): { yes: boolean; synthetic: boolean } {
  if (tick.outcomeYes !== null) {
    return { yes: tick.outcomeYes, synthetic: false };
  }
  const r = resolveOutcomeForTick(tick);
  return { yes: r.yes, synthetic: r.synthetic };
}

function decorateCandidate(
  base: ReplayCandidate,
  tick: ArchiveMarketTick,
  flow: TapeFlowTracker,
  fresh: FreshWalletTracker,
  walletAct: WalletActivityTracker,
  walletProf: WalletSettlementProfiler,
): ReplayCandidate {
  const { imbalance, whalePrint } = flow.update(tick);
  const wid = tick.walletId;
  const diversityBefore = walletAct.diversity(wid);
  if (wid) walletAct.noteTrade(wid, tick.ticker);
  const sport = kalshiSportLabel(tick.ticker);
  const wSnap = walletProf.snapshot(wid, sport);
  return {
    ...base,
    replayTapeWalletId: wid,
    replayFlowImbalance: imbalance,
    replayWhalePrint: whalePrint,
    replayFreshWallet: fresh.isFresh(wid, tick.tsMs),
    replayWalletDiversity: diversityBefore,
    ...(wSnap.winRate != null ? { replayWalletWinRate: wSnap.winRate } : {}),
    ...(wSnap.sharpe != null ? { replayWalletSharpe: wSnap.sharpe } : {}),
    ...(wSnap.settledTrades > 0 ? { replayWalletSettledTrades: wSnap.settledTrades } : {}),
    ...(wSnap.topSport ? { replayWalletTopSport: wSnap.topSport } : {}),
    ...(wSnap.topSportWinRate != null ? { replayWalletTopSportWinRate: wSnap.topSportWinRate } : {}),
    ...(wSnap.currentSportWinRate != null
      ? { replayWalletCurrentSportWinRate: wSnap.currentSportWinRate }
      : {}),
  };
}

const PROB_ARB = "Probability Arb";
const MARKET_MAKER = "Market Maker";
const PROB_ARB_MIN_GAME_GAP_MS = 22 * 60_000;

function gameKeyFromTicker(ticker: string): string | null {
  const parts = ticker.split("-");
  if (parts.length < 3) return null;
  return parts.slice(0, 2).join("-");
}

export interface RunReplayParams {
  initialBankroll?: number;
  /** When true, skip any tick whose outcome would be synthetic (JBecker real-only). */
  forbidSyntheticOutcomes?: boolean;
}

/**
 * Single-strategy replay with shared risk limits (cooldown, max/hour, min edge/conf, sizing).
 * Strictly no lookahead: strategies never receive settlement fields on `ReplayMarket`.
 */
export function runStrategyReplayWithRisk(
  ticks: ArchiveMarketTick[],
  strategy: Strategy,
  risk: ReplayRiskLimits,
  params?: RunReplayParams,
): { metrics: BacktestMetrics; trades: SimulatedTrade[]; bySport: SportBucketMetrics[] } {
  const initialBankroll = params?.initialBankroll ?? 5000;
  const forbidSynth = params?.forbidSyntheticOutcomes ?? false;
  const sorted = sortTicks(ticks);
  const rolling = new TickerPriceRolling();
  const flow = new TapeFlowTracker();
  const fresh = new FreshWalletTracker();
  const walletAct = new WalletActivityTracker();
  const walletProf = new WalletSettlementProfiler();
  const legs = new GameLegBook();
  const effectiveRisk = effectiveRiskForStrategy(risk, strategy.name);
  const riskState = new ReplayRiskState(effectiveRisk);
  const mmSim = new MarketMakerSim();
  const prevMidMm = new Map<string, number>();
  const lastProbArbByGame = new Map<string, number>();

  const trades: SimulatedTrade[] = [];
  const equityCurve: EquityPoint[] = [
    { tsMs: sorted[0]?.tsMs ?? Date.now(), equity: initialBankroll },
  ];
  let equity = initialBankroll;

  for (const tick of sorted) {
    const { yes: outcomeYes, synthetic } = resolveOutcome(tick);
    if (forbidSynth && synthetic) continue;

    walletProf.onTime(tick.tsMs);
    walletProf.ensureTickerMeta(tick);

    try {
      const spread = Math.abs(tick.yesAsk - tick.yesBid);
      rolling.push(tick.ticker, tick.tsMs, tick.yesMid, spread);

      const baseCand = buildBlindReplayCandidate(tick, rolling);
      const candidate = decorateCandidate(baseCand, tick, flow, fresh, walletAct, walletProf);
      legs.update(candidate);

      const batch: ReplayCandidate[] =
        strategy.name === PROB_ARB ? legs.legsForTicker(tick.ticker) : [candidate];

      if (strategy.name === PROB_ARB && batch.length < 2) continue;

      const pool = strategy.selectCandidates(batch);
      const active = pool.find((c) => c.market.ticker === tick.ticker);
      if (!active) continue;

      const analysis: ReplayAnalysis =
        strategy.name === PROB_ARB ? buildProbArbAnalysis(active, batch) : blindReplayAnalysisForTick(tick, rolling);

      mergeReplayDecorators(analysis, strategy.name === PROB_ARB ? active : candidate);

      if (strategy.name === PROB_ARB) {
        const gk = gameKeyFromTicker(tick.ticker);
        if (gk != null) {
          const lastG = lastProbArbByGame.get(gk);
          if (lastG != null && tick.tsMs - lastG < PROB_ARB_MIN_GAME_GAP_MS) continue;
        }
      }

      if (!riskState.allowsTrade(tick.tsMs, tick.ticker, analysis)) continue;

      const decision = strategy.shouldTrade(analysis);
      if (!decision.trade) continue;

      if (strategy.name === MARKET_MAKER) {
        if (!mmSim.deterministicFill(tick.ticker, tick.tsMs)) continue;
        const prev = prevMidMm.get(tick.ticker) ?? tick.yesMid;
        prevMidMm.set(tick.ticker, tick.yesMid);
        const halfSpread = Math.max(0.005, (tick.yesAsk - tick.yesBid) / 2);
        const adverse = Math.abs(tick.yesMid - prev);
        const stakeUsd = computeStakeUsd(equity, analysis, effectiveRisk);
        const unitCost = Math.max(0.15, tick.yesMid * 0.5);
        const contracts = Math.max(1, Math.floor(stakeUsd / unitCost));
        const spreadEarn = contracts * halfSpread * 0.35;
        const lip = contracts * CONSERVATIVE_LIP_USD_PER_CONTRACT;
        const pnlUsd = spreadEarn + lip - contracts * adverse * 0.22;

        equity += pnlUsd;
        equityCurve.push({ tsMs: tick.tsMs, equity });
        riskState.recordTrade(tick.tsMs, tick.ticker);

        const sportLabel = kalshiSportLabel(tick.ticker);
        trades.push({
          ticker: tick.ticker,
          side: "yes",
          entryPrice: tick.yesMid,
          stakeUsd: contracts * unitCost,
          contracts,
          pnlUsd,
          won: pnlUsd > 0,
          usedSyntheticOutcome: synthetic,
          reason: decision.reason,
          tsMs: tick.tsMs,
          sportLabel,
          edgeAtEntry: analysis.edge,
          modelProbability: analysis.modelProbability,
          strategyName: strategy.name,
        });
        continue;
      }

      const side = analysis.side;
      const entry = side === "yes" ? analysis.candidate.yesAsk : analysis.candidate.noAsk;
      if (entry <= 0.01 || entry >= 0.99) continue;

      const stakeUsd = computeStakeUsd(equity, analysis, effectiveRisk);
      const contracts = Math.max(1, Math.floor(stakeUsd / entry));
      const pnlUsd = pnlKalshiTaker(side, entry, contracts, outcomeYes);

      equity += pnlUsd;
      equityCurve.push({ tsMs: tick.tsMs, equity });
      riskState.recordTrade(tick.tsMs, tick.ticker);
      if (strategy.name === PROB_ARB) {
        const gk = gameKeyFromTicker(tick.ticker);
        if (gk != null) lastProbArbByGame.set(gk, tick.tsMs);
      }

      const sportLabel = kalshiSportLabel(tick.ticker);
      trades.push({
        ticker: tick.ticker,
        side,
        entryPrice: entry,
        stakeUsd: contracts * entry,
        contracts,
        pnlUsd,
        won: pnlUsd > 0,
        usedSyntheticOutcome: synthetic,
        reason: decision.reason,
        tsMs: tick.tsMs,
        sportLabel,
        edgeAtEntry: analysis.edge,
        modelProbability: analysis.modelProbability,
        strategyName: strategy.name,
      });
    } finally {
      walletProf.recordTapeTrade(tick);
    }
  }

  walletProf.finalizeUnsettledFromTapeEnd(sorted[sorted.length - 1]?.tsMs ?? Date.now());

  const wins = trades.filter((t) => t.won).length;
  const metrics: BacktestMetrics = {
    strategyName: strategy.name,
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnlUsd: equity - initialBankroll,
    maxDrawdownPct: maxDrawdownPct(equityCurve),
    sharpeApprox: sharpeFromPnls(trades.map((t) => t.pnlUsd)),
    equityCurve,
    usedSyntheticOutcomes: trades.filter((t) => t.usedSyntheticOutcome).length,
  };

  return { metrics, trades, bySport: aggregateSportBuckets(trades) };
}

function mergeReplayDecorators(target: ReplayAnalysis, from: ReplayCandidate): void {
  target.candidate = {
    ...target.candidate,
    replayTapeWalletId: from.replayTapeWalletId,
    replayFlowImbalance: from.replayFlowImbalance,
    replayWhalePrint: from.replayWhalePrint,
    replayFreshWallet: from.replayFreshWallet,
    replayWalletDiversity: from.replayWalletDiversity,
    replayWalletWinRate: from.replayWalletWinRate,
    replayWalletSharpe: from.replayWalletSharpe,
    replayWalletSettledTrades: from.replayWalletSettledTrades,
    replayWalletTopSport: from.replayWalletTopSport,
    replayWalletTopSportWinRate: from.replayWalletTopSportWinRate,
    replayWalletCurrentSportWinRate: from.replayWalletCurrentSportWinRate,
  };
}

/** Synthetic analyst signal for probability arb from leg prices alone (no outcomes). */
function buildProbArbAnalysis(target: ReplayCandidate, legs: ReplayCandidate[]): ReplayAnalysis {
  const sumYes = legs.reduce((s, l) => s + l.yesAsk, 0);
  const over = sumYes > 1.04;
  const sorted = [...legs].sort((a, b) => b.yesAsk - a.yesAsk);
  const richest = sorted[0]!;
  const isTarget = richest.market.ticker === target.market.ticker;
  const yesPrice = target.yesPrice;
  let modelProb = yesPrice;
  let side: "yes" | "no" = "yes";
  let edge = Math.abs(modelProb - yesPrice) * 100;
  let confidence = 0.3;
  if (over && isTarget) {
    modelProb = Math.max(0.04, 1 - target.yesAsk - 0.06);
    side = "no";
    edge = Math.abs(modelProb - yesPrice) * 100;
    confidence = 0.52;
  }

  const edgeFloor = over && isTarget ? 8 : 0;

  return {
    candidate: target,
    modelProbability: modelProb,
    edge: Math.max(edge, edgeFloor),
    confidence,
    side,
    reasoning: `Prob arb replay: sumYesAsk=${sumYes.toFixed(3)}`,
  };
}
