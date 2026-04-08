import type { ArchiveMarketTick } from "../normalize.js";
import {
  blindReplayAnalysisForTick,
  buildBlindReplayCandidate,
  resolveOutcomeForTick,
} from "../synthetic-analysis.js";
import { pnlKalshiTaker } from "../kalshi-fees.js";
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
import { aggregateSportBuckets, kalshiSportLabel } from "./sport-bucket.js";
import { TickerPriceRolling } from "./price-history.js";
import { ReplayRiskState, computeStakeUsd } from "./replay-risk.js";
import { effectiveRiskForStrategy } from "./strategy-risk-merge.js";
import {
  FreshWalletTracker,
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

export interface ReplayProgressTickConfig {
  everyWallClockMs: number;
  strategyName: string;
  totalTicks: number;
}

export interface RunReplayParams {
  initialBankroll?: number;
  /** When true, skip any tick whose outcome would be synthetic (JBecker real-only). */
  forbidSyntheticOutcomes?: boolean;
  /** Optional wall-clock progress lines (long month replays). */
  progress?: ReplayProgressTickConfig;
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
  const effectiveRisk = effectiveRiskForStrategy(risk, strategy.name);
  const riskState = new ReplayRiskState(effectiveRisk);

  const trades: SimulatedTrade[] = [];
  const equityCurve: EquityPoint[] = [
    { tsMs: sorted[0]?.tsMs ?? Date.now(), equity: initialBankroll },
  ];
  let equity = initialBankroll;

  const prog = params?.progress;
  let lastProgressWall = 0;
  if (prog && sorted.length > 0) {
    console.log(
      `\n── [${prog.strategyName}] starting replay: ${prog.totalTicks.toLocaleString()} ticks, progress every ~${Math.round(prog.everyWallClockMs / 60000)}m wall ──`,
    );
    lastProgressWall = Date.now();
  }

  for (let ti = 0; ti < sorted.length; ti++) {
    const tick = sorted[ti]!;

    if (prog && sorted.length > 0) {
      const nowW = Date.now();
      const due = nowW - lastProgressWall >= prog.everyWallClockMs;
      const lastTick = ti === sorted.length - 1;
      if (due || lastTick) {
        lastProgressWall = nowW;
        const pct = ((ti + 1) / sorted.length) * 100;
        const top3 = [...trades].sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd)).slice(0, 3);
        console.log(
          `   [${prog.strategyName}] ${pct.toFixed(1)}% ticks (${(ti + 1).toLocaleString()}/${sorted.length.toLocaleString()})  equity $${equity.toFixed(2)}  trades ${trades.length}`,
        );
        for (const t of top3) {
          const tag = t.won ? "W" : "L";
          const r = t.reason.length > 90 ? `${t.reason.slice(0, 87)}…` : t.reason;
          console.log(`      ${tag} $${t.pnlUsd.toFixed(2)}  ${t.ticker}  ${r}`);
        }
      }
    }
    const { yes: outcomeYes, synthetic } = resolveOutcome(tick);
    if (forbidSynth && synthetic) continue;

    walletProf.onTime(tick.tsMs);
    walletProf.ensureTickerMeta(tick);

    try {
      const spread = Math.abs(tick.yesAsk - tick.yesBid);
      rolling.push(tick.ticker, tick.tsMs, tick.yesMid, spread);

      const baseCand = buildBlindReplayCandidate(tick, rolling);
      const candidate = decorateCandidate(baseCand, tick, flow, fresh, walletAct, walletProf);

      const pool = strategy.selectCandidates([candidate]);
      const active = pool.find((c) => c.market.ticker === tick.ticker);
      if (!active) continue;

      const analysis: ReplayAnalysis = blindReplayAnalysisForTick(tick, rolling);

      mergeReplayDecorators(analysis, candidate);

      if (!riskState.allowsTrade(tick.tsMs, tick.ticker, analysis)) continue;

      const decision = strategy.shouldTrade(analysis);
      if (!decision.trade) continue;

      const side = analysis.side;
      const entry = side === "yes" ? analysis.candidate.yesAsk : analysis.candidate.noAsk;
      if (entry <= 0.01 || entry >= 0.99) continue;

      const stakeUsd = computeStakeUsd(equity, analysis, effectiveRisk);
      const contracts = Math.round(stakeUsd / entry);
      if (contracts < 1) continue;
      const pnlUsd = pnlKalshiTaker(side, entry, contracts, outcomeYes);

      equity += pnlUsd;
      equityCurve.push({ tsMs: tick.tsMs, equity });
      riskState.recordTrade(tick.tsMs, tick.ticker);

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
