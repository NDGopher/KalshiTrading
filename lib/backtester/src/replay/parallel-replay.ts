import type { ArchiveMarketTick } from "../normalize.js";
import type {
  BacktestMetrics,
  MultiStrategyBacktestReport,
  MultiStrategyEquitySample,
  RankedStrategyRow,
  ReplayRiskLimits,
  SimulatedTrade,
  Strategy,
} from "../types.js";
import { sortStrategiesByRunOrder } from "../strategies/strategy-run-order.js";
import { runStrategyReplayWithRisk, type RunReplayParams } from "./replay-engine.js";

/** Half-Kelly multiplier on the analytical Kelly fraction (see `computeStakeUsd`). */
export const defaultHalfKellySizing = { mode: "kelly" as const, kellyFraction: 0.5, capFraction: 0.06 };

/** Aggressive throttling: fewer trades, higher edge floor, longer per-ticker spacing. */
export const defaultReplayRiskLimits: ReplayRiskLimits = {
  maxTradesPerHour: 7,
  minEdgePp: 6,
  minConfidence: 0.32,
  positionSizing: { mode: "fixed_fraction", fraction: 0.02 },
  cooldownSameTickerMs: 180_000,
  targetBetUsd: 15,
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

function metricsToRankedRow(strategyName: string, m: BacktestMetrics, h: number): RankedStrategyRow {
  return {
    rank: 0,
    strategyName,
    totalPnlUsd: m.totalPnlUsd,
    winRate: m.winRate,
    sharpeApprox: m.sharpeApprox,
    maxDrawdownPct: m.maxDrawdownPct,
    trades: m.trades,
    tradesPerHour: h > 0 ? m.trades / h : 0,
    usedSyntheticOutcomes: m.usedSyntheticOutcomes,
    expectancyPerTradeUsd: m.trades ? m.totalPnlUsd / m.trades : 0,
  };
}

function buildSnapshotReport(
  ticks: ArchiveMarketTick[],
  risk: ReplayRiskLimits,
  ordered: Strategy[],
  perStrategy: MultiStrategyBacktestReport["perStrategy"],
  rankingInput: RankedStrategyRow[],
  sourceExtras: Record<string, unknown>,
): MultiStrategyBacktestReport {
  const h = hoursSpan(ticks);
  const sortedInput = [...rankingInput].sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
  const rankings = sortedInput.map((r, i) => ({ ...r, rank: i + 1 }));
  const namesDone = ordered.map((s) => s.name).filter((n) => perStrategy[n] != null);
  const combinedEquitySamples = buildCombinedEquitySamples(namesDone, perStrategy);
  const sportTableByStrategy = Object.fromEntries(namesDone.map((n) => [n, perStrategy[n]?.bySport ?? []]));
  const readability = buildReadabilityNotes(perStrategy, rankings);

  return {
    generatedAt: new Date().toISOString(),
    source: { tickCount: ticks.length, hoursApprox: h, ...sourceExtras },
    risk,
    rankings,
    perStrategy,
    combinedEquitySamples,
    sportTableByStrategy,
    suggestedSettingsPatch: buildSuggestedPatch(rankings),
    readability,
  };
}

export type MultiStrategySequentialParams = RunReplayParams & {
  forbidSyntheticOutcomes?: boolean;
  progressWallClockMs?: number;
  /** Resume / warm-log: pre-filled strategy blocks; those strategies are not replayed. */
  seedPerStrategy?: MultiStrategyBacktestReport["perStrategy"];
  /**
   * Optional ranking rows for seeded strategies (e.g. warm-from-log preserves log trades/h).
   * If absent, rows are derived from `seedPerStrategy` metrics and tape hour span.
   */
  seedRankingOverrides?: Record<string, RankedStrategyRow>;
  /** Extra fields merged into `report.source` (e.g. warmFromLogStrategies). */
  sourceExtras?: Record<string, unknown>;
  /** Called after each strategy (including skipped seeds) with the cumulative report snapshot. */
  onCheckpoint?: (partial: MultiStrategyBacktestReport) => Promise<void>;
};

/**
 * Runs strategies **one at a time** in priority order (see `strategy-run-order.ts`).
 * Seeds (resume / warm-log) are checkpointed first without replay.
 */
export async function runParallelStrategies(
  ticks: ArchiveMarketTick[],
  strategies: Strategy[],
  risk: ReplayRiskLimits = defaultReplayRiskLimits,
  params?: MultiStrategySequentialParams,
): Promise<MultiStrategyBacktestReport> {
  const h = hoursSpan(ticks);
  const ordered = sortStrategiesByRunOrder(strategies);
  const allowedNames = new Set(ordered.map((s) => s.name));
  const perStrategy: MultiStrategyBacktestReport["perStrategy"] = {};
  if (params?.seedPerStrategy) {
    for (const n of allowedNames) {
      const b = params.seedPerStrategy[n];
      if (b) perStrategy[n] = b;
    }
  }
  const rankingInput: RankedStrategyRow[] = [];
  const progressMs = params?.progressWallClockMs ?? 0;

  const runParamsBase: RunReplayParams = {
    initialBankroll: params?.initialBankroll ?? 5000,
    forbidSyntheticOutcomes: params?.forbidSyntheticOutcomes,
  };

  for (const s of ordered) {
    const seeded = perStrategy[s.name] != null;

    if (seeded) {
      console.log(`\n── Skipping replay (seeded checkpoint/log): ${s.name} ──`);
      if (!rankingInput.some((r) => r.strategyName === s.name)) {
        const ovr = params?.seedRankingOverrides?.[s.name];
        rankingInput.push(ovr ?? metricsToRankedRow(s.name, perStrategy[s.name]!.metrics, h));
      }
    } else {
      console.log(`\n── Running strategy: ${s.name} (${ordered.indexOf(s) + 1}/${ordered.length}) ──`);
      const runParams: RunReplayParams = {
        ...runParamsBase,
        progress:
          progressMs > 0 && ticks.length > 0
            ? { everyWallClockMs: progressMs, strategyName: s.name, totalTicks: ticks.length }
            : undefined,
      };
      const { metrics, trades, bySport } = runStrategyReplayWithRisk(ticks, s, risk, runParams);
      const top = [...trades].sort((a, b) => Math.abs(b.pnlUsd) - Math.abs(a.pnlUsd)).slice(0, 50);
      perStrategy[s.name] = {
        metrics,
        bySport,
        topTrades: top,
        tradesPreview: trades.slice(0, 150),
      };
      rankingInput.push(metricsToRankedRow(s.name, metrics, h));
    }

    const partial = [...rankingInput].sort((a, b) => b.totalPnlUsd - a.totalPnlUsd);
    console.log("\n── Partial rankings (completed strategies) ──");
    for (let i = 0; i < partial.length; i++) {
      const r = partial[i]!;
      console.log(
        `  ${i + 1}. ${r.strategyName}  PnL $${r.totalPnlUsd.toFixed(2)}  WR ${(r.winRate * 100).toFixed(1)}%  Sharpe ${r.sharpeApprox.toFixed(2)}  trades ${r.trades} (${r.tradesPerHour.toFixed(1)}/h)`,
      );
    }

    if (params?.onCheckpoint) {
      const snap = buildSnapshotReport(ticks, risk, ordered, perStrategy, rankingInput, params.sourceExtras ?? {});
      await params.onCheckpoint(snap);
    }
  }

  return buildSnapshotReport(ticks, risk, ordered, perStrategy, rankingInput, params?.sourceExtras ?? {});
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
  if (totalPnl < -60 && trades > 35) return "Sized loss — retire or major retune before live capital.";
  if (totalPnl < 0 && ev < -1.5) return "Negative per-trade expectancy — tighten entry or drop.";
  if (totalPnl > 0 && sharpe > 0.25) return "Positive risk-adjusted — keep; consider narrow follow-up tests.";
  if (totalPnl > 0) return "Green but noisy — confirm on adjacent months / sports.";
  return "Mixed — extend date range or split by sport.";
}

function nextTestHintRow(name: string, trades: number, totalPnl: number): string {
  if (trades === 0) {
    if (name === "Dip Buy") return "Try a volatile week (playoffs) or lower dip % further if still flat.";
    return "Loosen one gate at a time and re-run a 1-week slice.";
  }
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

  return {
    minEdge,
    kellyFraction,
    confidencePenaltyPct,
    targetBetUsd: 15,
    enabledStrategies: ["Whale Flow", "Volume Imbalance", "Dip Buy", "Pure Value"],
    paperTradingMode: true,
    rationale,
  };
}
