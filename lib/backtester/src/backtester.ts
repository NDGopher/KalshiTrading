import { ensureKalshiDayCached, ensureKalshiHourCached, type DownloadResult } from "./archive-client.js";
import { readParquetFile, type ParquetRow } from "./parquet-load.js";
import { normalizeArchiveRow, type ArchiveMarketTick } from "./normalize.js";
import { pureValueStrategy } from "./strategies/pure-value.js";
import { resolveOutcomeForTick, blindReplayAnalysisForTick } from "./synthetic-analysis.js";
import { pnlKalshiTaker } from "./kalshi-fees.js";
import { TickerPriceRolling } from "./replay/price-history.js";
import type { BacktestMetrics, EquityPoint, MultiStrategyBacktestReport, ReplayRiskLimits, SimulatedTrade, Strategy } from "./types.js";
import { defaultReplayRiskLimits, runParallelStrategies as runParallelStrategiesImpl } from "./replay/parallel-replay.js";
import type { RunReplayParams } from "./replay/replay-engine.js";
import { defaultDataDir, kalshiCacheDir } from "./paths.js";

type ParallelReplayParams = RunReplayParams & { forbidSyntheticOutcomes?: boolean };

export interface BacktesterOptions {
  dataRoot?: string;
  archiveBaseUrl?: string;
}

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

export class Backtester {
  constructor(private readonly opts: BacktesterOptions = {}) {}

  dataRoot(): string {
    return this.opts.dataRoot ?? defaultDataDir();
  }

  /**
   * Ensure all hourly Kalshi parquet files for a UTC calendar day are cached under data/kalshi/.
   */
  async ensureKalshiDay(date: string): Promise<{ paths: string[]; failures: string[] }> {
    return ensureKalshiDayCached(date, {
      baseUrl: this.opts.archiveBaseUrl,
      cacheDir: kalshiCacheDir(this.dataRoot()),
    });
  }

  /** Single hour slice (smaller download for first run). */
  async ensureKalshiHour(date: string, hourUtc: number): Promise<DownloadResult> {
    return ensureKalshiHourCached(date, hourUtc, {
      baseUrl: this.opts.archiveBaseUrl,
      cacheDir: kalshiCacheDir(this.dataRoot()),
    });
  }

  async loadTicksFromParquetPaths(paths: string[], maxRowsPerFile?: number): Promise<ArchiveMarketTick[]> {
    const ticks: ArchiveMarketTick[] = [];
    for (const p of paths) {
      const rows: ParquetRow[] = await readParquetFile(p, {
        rowEnd: maxRowsPerFile,
      });
      for (const row of rows) {
        const t = normalizeArchiveRow(row);
        if (t) ticks.push(t);
      }
    }
    return sortTicks(ticks);
  }

  /**
   * Replay sorted ticks with the Pure Value strategy (taker execution at posted ask).
   * At most one trade per ticker (first qualifying snapshot wins).
   */
  runPureValueReplay(
    ticks: ArchiveMarketTick[],
    params?: { initialBankroll?: number; stakePct?: number },
  ): { metrics: BacktestMetrics; trades: SimulatedTrade[] } {
    const initialBankroll = params?.initialBankroll ?? 10_000;
    const stakePct = params?.stakePct ?? 0.02;

    const sorted = sortTicks(ticks);
    const seen = new Set<string>();
    const rolling = new TickerPriceRolling();
    const trades: SimulatedTrade[] = [];
    const equityCurve: EquityPoint[] = [{ tsMs: sorted[0]?.tsMs ?? Date.now(), equity: initialBankroll }];
    let equity = initialBankroll;

    for (const tick of sorted) {
      if (seen.has(tick.ticker)) continue;

      const { yes: outcomeYes, synthetic } = resolveOutcomeForTick(tick);
      const spread = Math.abs(tick.yesAsk - tick.yesBid);
      rolling.push(tick.ticker, tick.tsMs, tick.yesMid, spread);
      const analysis = blindReplayAnalysisForTick(tick, rolling);
      const pool = pureValueStrategy.selectCandidates([analysis.candidate]);
      if (pool.length === 0) continue;

      const decision = pureValueStrategy.shouldTrade(analysis);
      if (!decision.trade) continue;

      const side = analysis.side;
      const entry = side === "yes" ? analysis.candidate.yesAsk : analysis.candidate.noAsk;
      if (entry <= 0.01 || entry >= 0.99) continue;

      const stakeUsd = Math.min(equity * stakePct, equity * 0.25);
      const contracts = Math.round(stakeUsd / entry);
      if (contracts < 1) continue;
      const pnlUsd = pnlKalshiTaker(side, entry, contracts, outcomeYes);

      equity += pnlUsd;
      equityCurve.push({ tsMs: tick.tsMs, equity });

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
      });
      seen.add(tick.ticker);
    }

    const wins = trades.filter((t) => t.won).length;
    const metrics: BacktestMetrics = {
      strategyName: pureValueStrategy.name,
      trades: trades.length,
      wins,
      winRate: trades.length ? wins / trades.length : 0,
      totalPnlUsd: equity - initialBankroll,
      maxDrawdownPct: maxDrawdownPct(equityCurve),
      sharpeApprox: sharpeFromPnls(trades.map((t) => t.pnlUsd)),
      equityCurve,
      usedSyntheticOutcomes: trades.filter((t) => t.usedSyntheticOutcome).length,
    };

    return { metrics, trades };
  }

  /**
   * Run multiple strategies on identical ticks (separate bankrolls). Uses shared risk limits.
   * Sequential replay with priority ordering; checkpoints are CLI-only (`historical-multi`).
   */
  async runParallelStrategies(
    ticks: ArchiveMarketTick[],
    strategies: Strategy[],
    risk?: ReplayRiskLimits,
    params?: ParallelReplayParams,
  ): Promise<MultiStrategyBacktestReport> {
    return await runParallelStrategiesImpl(ticks, strategies, risk ?? defaultReplayRiskLimits, params);
  }

  runMakerSimulation(_ticks: ArchiveMarketTick[]): never {
    throw new Error("runMakerSimulation: not implemented yet");
  }
}
