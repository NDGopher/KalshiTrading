import type { ArchiveMarketTick } from "../normalize.js";
import type {
  MultiStrategyBacktestReport,
  MultiStrategyEquitySample,
  RankedStrategyRow,
  ReplayRiskLimits,
  SimulatedTrade,
  Strategy,
} from "../types.js";
import { runStrategyReplayWithRisk, type RunReplayParams } from "./replay-engine.js";

/** Half-Kelly multiplier on the analytical Kelly fraction (see `computeStakeUsd`). */
export const defaultHalfKellySizing = { mode: "kelly" as const, kellyFraction: 0.5, capFraction: 0.06 };

export const defaultReplayRiskLimits: ReplayRiskLimits = {
  maxTradesPerHour: 48,
  minEdgePp: 4,
  minConfidence: 0.25,
  positionSizing: { mode: "fixed_fraction", fraction: 0.02 },
  cooldownSameTickerMs: 120_000,
};

function hoursSpan(ticks: ArchiveMarketTick[]): number {
  if (ticks.length < 2) return 1;
  const a = ticks[0]!.tsMs;
  const b = ticks[ticks.length - 1]!.tsMs;
  return Math.max(1 / 60, (b - a) / (3600 * 1000));
}

function equityAtOrBefore(curve: { tsMs: number; equity: number }[], tsMs: number): number {
  let best = curve[0]?.equity ?? 0;
  for (const p of curve) {
    if (p.tsMs <= tsMs) best = p.equity;
    else break;
  }
  return best;
}

function buildCombinedEquitySamples(
  strategyNames: string[],
  perStrategy: MultiStrategyBacktestReport["perStrategy"],
): MultiStrategyEquitySample[] {
  const tsSet = new Set<number>();
  for (const name of strategyNames) {
    const curve = perStrategy[name]?.metrics.equityCurve ?? [];
    for (const p of curve) tsSet.add(p.tsMs);
  }
  const sorted = [...tsSet].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const curves = Object.fromEntries(
    strategyNames.map((n) => [n, perStrategy[n]?.metrics.equityCurve ?? []] as const),
  );
  const out: MultiStrategyEquitySample[] = [];
  for (const tsMs of sorted) {
    const equityByStrategy: Record<string, number> = {};
    let sum = 0;
    for (const name of strategyNames) {
      const v = equityAtOrBefore(curves[name]!, tsMs);
      equityByStrategy[name] = v;
      sum += v;
    }
    out.push({
      tsMs,
      equityByStrategy,
      meanEquity: sum / Math.max(1, strategyNames.length),
    });
  }
  return out;
}

export function runParallelStrategies(
  ticks: ArchiveMarketTick[],
  strategies: Strategy[],
  risk: ReplayRiskLimits = defaultReplayRiskLimits,
  params?: RunReplayParams & { forbidSyntheticOutcomes?: boolean },
): MultiStrategyBacktestReport {
  const h = hoursSpan(ticks);
  const perStrategy: MultiStrategyBacktestReport["perStrategy"] = {};
  const rankingInput: RankedStrategyRow[] = [];
  const strategyNames = strategies.map((s) => s.name);

  const runParams: RunReplayParams = {
    initialBankroll: params?.initialBankroll ?? 5000,
    forbidSyntheticOutcomes: params?.forbidSyntheticOutcomes,
  };

  for (const s of strategies) {
    const { metrics, trades, bySport } = runStrategyReplayWithRisk(ticks, s, risk, runParams);
    const top = [...trades].sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd)).slice(0, 50);
    perStrategy[s.name] = {
      metrics,
      bySport,
      topTrades: top,
      tradesPreview: trades.slice(0, 150),
    };
    rankingInput.push({
      rank: 0,
      strategyName: s.name,
      totalPnlUsd: metrics.totalPnlUsd,
      winRate: metrics.winRate,
      sharpeApprox: metrics.sharpeApprox,
      maxDrawdownPct: metrics.maxDrawdownPct,
      trades: metrics.trades,
      tradesPerHour: metrics.trades / h,
      usedSyntheticOutcomes: metrics.usedSyntheticOutcomes,
      expectancyPerTradeUsd: metrics.trades ? metrics.totalPnlUsd / metrics.trades : 0,
    });
  }

  rankingInput.sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  const rankings = rankingInput.map((r, i) => ({ ...r, rank: i + 1 }));

  const combinedEquitySamples = buildCombinedEquitySamples(strategyNames, perStrategy);
  const sportTableByStrategy = Object.fromEntries(
    strategyNames.map((n) => [n, perStrategy[n]?.bySport ?? []]),
  );

  const readability = buildReadabilityNotes(perStrategy, rankings);

  return {
    generatedAt: new Date().toISOString(),
    source: { tickCount: ticks.length, hoursApprox: h },
    risk,
    rankings,
    perStrategy,
    combinedEquitySamples,
    sportTableByStrategy,
    suggestedSettingsPatch: buildSuggestedPatch(rankings),
    readability,
  };
}

function aggregateReasons(trades: SimulatedTrade[], won: boolean, limit: number) {
  const map = new Map<string, { count: number; pnlUsd: number }>();
  for (const t of trades) {
    if (t.won !== won) continue;
    const key = t.reason.length > 140 ? `${t.reason.slice(0, 137)}…` : t.reason;
    const row = map.get(key) ?? { count: 0, pnlUsd: 0 };
    row.count++;
    row.pnlUsd += t.pnlUsd;
    map.set(key, row);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([reason, v]) => ({ reason, count: v.count, pnlUsd: v.pnlUsd }));
}

function strategyVerdict(name: string, totalPnl: number, trades: number, sharpe: number): string {
  if (trades === 0) return "No trades — filters or risk gates may be too tight for this window.";
  if (trades < 10) return "Very sparse sample — do not draw strong conclusions.";
  const ev = totalPnl / trades;
  if (name === "Probability Arb" && totalPnl < -40 && trades > 25) {
    return "Large loss at meaningful count — keep throttled or disable until legs model improves.";
  }
  if (totalPnl < -60 && trades > 35) return "Sized loss — retire or major retune before live capital.";
  if (totalPnl < 0 && ev < -1.5) return "Negative per-trade expectancy — tighten entry or drop.";
  if (totalPnl > 0 && sharpe > 0.25) return "Positive risk-adjusted — keep; consider narrow follow-up tests.";
  if (totalPnl > 0) return "Green but noisy — confirm on adjacent months / sports.";
  return "Mixed — extend date range or split by sport.";
}

function nextTestHintRow(name: string, trades: number, totalPnl: number): string {
  if (trades === 0) {
    if (name === "Dip Buy") return "Try a volatile week (playoffs) or lower dip % further if still flat.";
    if (name === "Sharp Wallet") return "Set KALSHI_SHARP_WALLET_IDS or lower WR gates if still empty.";
    if (name === "Fresh Wallet") return "Check tape wallet coverage; 48h window should help vs prior.";
    return "Loosen one gate at a time and re-run a 1-week slice.";
  }
  if (name === "Probability Arb" && totalPnl < 0) return "Re-run with sumYes > 1.06 only, or cap 4 trades/day.";
  if (totalPnl > 0) return "Stress-test April–May same sport filter; watch drawdown.";
  return "A/B minEdge ±1pp on this same month.";
}

function sampleTradesForInsights(block: MultiStrategyBacktestReport["perStrategy"][string] | undefined): SimulatedTrade[] {
  if (!block) return [];
  const a = block.topTrades ?? [];
  const b = block.tradesPreview ?? [];
  const seen = new Set<string>();
  const out: SimulatedTrade[] = [];
  for (const t of [...a, ...b]) {
    const k = `${t.tsMs}|${t.ticker}|${t.reason}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 500) break;
  }
  return out;
}

function buildReadabilityNotes(
  perStrategy: MultiStrategyBacktestReport["perStrategy"],
  rankings: RankedStrategyRow[],
): NonNullable<MultiStrategyBacktestReport["readability"]> {
  const out: NonNullable<MultiStrategyBacktestReport["readability"]> = {};
  for (const r of rankings) {
    const block = perStrategy[r.strategyName];
    const sample = sampleTradesForInsights(block);
    out[r.strategyName] = {
      topWinReasons: aggregateReasons(sample, true, 5),
      topLossReasons: aggregateReasons(sample, false, 5),
      verdict: strategyVerdict(r.strategyName, r.totalPnlUsd, r.trades, r.sharpeApprox),
      nextTestHint: nextTestHintRow(r.strategyName, r.trades, r.totalPnlUsd),
    };
  }
  return out;
}

function buildSuggestedPatch(rankings: RankedStrategyRow[]): MultiStrategyBacktestReport["suggestedSettingsPatch"] {
  const top = rankings[0];
  if (!top) {
    return { rationale: "No strategies ran." };
  }
  let minEdge: number | undefined;
  let kellyFraction: number | undefined;
  let confidencePenaltyPct: number | undefined;
  let rationale = `Leader: ${top.strategyName} (PnL $${top.totalPnlUsd.toFixed(2)}, Sharpe ~${top.sharpeApprox.toFixed(2)}).`;

  if (rankings.every((r) => r.totalPnlUsd < 0)) {
    minEdge = 6.5;
    confidencePenaltyPct = 10;
    rationale += " All negative on this slice — suggest tighter minEdge/confidence for live.";
  } else if (top.sharpeApprox > 0.35 && top.totalPnlUsd > 0) {
    kellyFraction = 0.28;
    rationale += " Leader shows positive risk-adjusted return — slight kelly bump (still capped server-side).";
  }

  const prob = rankings.find((r) => r.strategyName === "Probability Arb");
  if (prob && prob.totalPnlUsd < -25 && prob.trades > 15) {
    rationale +=
      " Probability Arb still negative at scale — prefer live off, or require sumYes>1.06 / hard daily cap until revalidated.";
  }

  return { minEdge, kellyFraction, confidencePenaltyPct, rationale };
}
