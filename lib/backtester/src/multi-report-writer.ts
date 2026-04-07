import fs from "node:fs/promises";
import path from "node:path";
import type { MultiStrategyBacktestReport } from "./types.js";
import { backtestResultsDir } from "./paths.js";

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(pathOut: string, header: string[], rows: (string | number)[][]): Promise<void> {
  const lines = [header.join(","), ...rows.map((r) => r.map((c) => csvEscape(String(c))).join(","))];
  return fs.writeFile(pathOut, lines.join("\n"), "utf8");
}

/**
 * Writes `multi/{iso}-ranked.json`, `multi/last-ranked.json`, summary CSV, and per-strategy top trades CSV.
 */
export async function writeMultiBacktestRankReport(
  dataRoot: string,
  report: MultiStrategyBacktestReport,
): Promise<{ path: string; timestampedPath: string; summaryCsv?: string; tradesCsv?: string }> {
  const dir = path.join(backtestResultsDir(dataRoot), "multi");
  await fs.mkdir(dir, { recursive: true });

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const timestampedPath = path.join(dir, `${stamp}-ranked.json`);
  const lastPath = path.join(dir, "last-ranked.json");

  const relRanked = path.relative(dataRoot, timestampedPath).replace(/\\/g, "/");
  const relLast = path.relative(dataRoot, lastPath).replace(/\\/g, "/");

  const summaryCsvPath = path.join(dir, `${stamp}-summary.csv`);
  const tradesCsvPath = path.join(dir, `${stamp}-trades.csv`);

  const summaryRows: (string | number)[][] = report.rankings.map((r) => [
    r.rank,
    r.strategyName,
    r.totalPnlUsd.toFixed(2),
    (r.winRate * 100).toFixed(2),
    r.sharpeApprox.toFixed(4),
    r.maxDrawdownPct.toFixed(2),
    r.trades,
    r.tradesPerHour.toFixed(2),
    (r.expectancyPerTradeUsd ?? 0).toFixed(4),
    r.usedSyntheticOutcomes,
  ]);

  await writeCsv(summaryCsvPath, [
    "rank",
    "strategy",
    "total_pnl_usd",
    "win_rate_pct",
    "sharpe_approx",
    "max_dd_pct",
    "trades",
    "trades_per_hour",
    "expectancy_per_trade_usd",
    "synthetic_outcome_trades",
  ], summaryRows);

  const tradeRows: (string | number)[][] = [];
  for (const r of report.rankings) {
    const top = report.perStrategy[r.strategyName]?.topTrades ?? [];
    for (const t of top) {
      tradeRows.push([
        r.strategyName,
        new Date(t.tsMs).toISOString(),
        t.ticker,
        t.sportLabel ?? "",
        t.side,
        t.entryPrice.toFixed(4),
        t.contracts,
        t.pnlUsd.toFixed(4),
        t.won ? 1 : 0,
        t.edgeAtEntry ?? "",
        t.reason,
      ]);
    }
  }

  await writeCsv(tradesCsvPath, [
    "strategy",
    "ts_iso",
    "ticker",
    "sport",
    "side",
    "entry",
    "contracts",
    "pnl_usd",
    "won",
    "edge_pp",
    "reason",
  ], tradeRows);

  report.outputFiles = {
    rankedJson: relRanked,
    summaryCsv: path.relative(dataRoot, summaryCsvPath).replace(/\\/g, "/"),
    tradesCsv: path.relative(dataRoot, tradesCsvPath).replace(/\\/g, "/"),
  };

  const body = JSON.stringify(report, null, 2);
  await fs.writeFile(timestampedPath, body, "utf8");
  await fs.writeFile(lastPath, body, "utf8");

  return {
    path: lastPath,
    timestampedPath,
    summaryCsv: summaryCsvPath,
    tradesCsv: tradesCsvPath,
  };
}
