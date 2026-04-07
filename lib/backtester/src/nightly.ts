import path from "node:path";
import { Backtester } from "./backtester.js";
import { writePmxtBacktestOutputs } from "./pmxt-result-writer.js";

/**
 * Optional hook for the API Learner: set `PMXT_NIGHTLY_BACKTEST=1` to refresh
 * `data/backtest-results/latest.json` after learning cycles.
 */
export async function runPmxtNightlyBacktestIfEnabled(): Promise<void> {
  if (process.env.PMXT_NIGHTLY_BACKTEST !== "1") return;

  const date =
    process.env.PMXT_BACKTEST_DATE?.trim() ||
    new Date().toISOString().slice(0, 10);
  const maxRows = Number(process.env.PMXT_MAX_ROWS ?? "120000");

  const bt = new Backtester();
  const { paths, failures } = await bt.ensureKalshiDay(date);

  if (paths.length === 0) {
    console.warn("[pmxt-nightly] No parquet files for", date, failures[0] ?? "");
    return;
  }

  const ticks = await bt.loadTicksFromParquetPaths(paths, maxRows);
  const { metrics, trades } = bt.runPureValueReplay(ticks);

  const { runPath } = await writePmxtBacktestOutputs(
    bt.dataRoot(),
    {
      generatedAt: new Date().toISOString(),
      source: { mode: "nightly", date, paths, maxRowsPerFile: maxRows },
      metrics,
      trades,
    },
    {
      strategyName: metrics.strategyName,
      sourceDate: date,
      hourUtc: undefined,
    },
  );
  console.log("[pmxt-nightly] wrote", path.relative(bt.dataRoot(), runPath));
}
