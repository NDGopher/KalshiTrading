#!/usr/bin/env node
import path from "node:path";
import { Backtester } from "../backtester.js";
import { writePmxtBacktestOutputs } from "../pmxt-result-writer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const date = arg("--date");
  const file = arg("--file");
  const hourStr = arg("--hour");
  const maxRows = Number(arg("--max-rows") ?? "80000");

  const bt = new Backtester();

  let paths: string[] = [];

  if (file) {
    const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    paths = [abs];
    console.log("Using local parquet:", abs);
  } else if (!date) {
    console.error(`Usage:
  pnpm --filter @workspace/backtester run backtest -- --date YYYY-MM-DD [--hour 0-23] [--max-rows N]
  pnpm --filter @workspace/backtester run backtest -- --file path/to/file.parquet [--max-rows N]

Options:
  --date       UTC calendar day; downloads hourly kalshi_orderbook_* dumps into data/kalshi/ (unless cached).
  --hour       Only fetch/cache one UTC hour (smaller first run).
  --file       Skip archive; read a single Parquet file.
  --max-rows   Row cap per file (limits memory on huge orderbook dumps). Default 80000.
`);
    process.exit(1);
  } else if (hourStr !== undefined) {
    const hour = Number(hourStr);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      console.error("--hour must be 0-23");
      process.exit(1);
    }
    const r = await bt.ensureKalshiHour(date, hour);
    if (!r.ok) {
      console.error("Download failed:", r.reason);
      console.error("URL tried:", r.url);
      process.exit(2);
    }
    paths = [r.localPath];
    console.log("Cached parquet:", r.localPath);
  } else {
    const { paths: dayPaths, failures } = await bt.ensureKalshiDay(date);
    paths = dayPaths;
    console.log(`Loaded ${paths.length} hourly parquet file(s) for ${date}`);
    if (failures.length && hasFlag("--verbose")) {
      console.error("Some hours missing:\n", failures.slice(0, 8).join("\n"));
    }
    if (paths.length === 0) {
      console.error(
        "No parquet files available. The Kalshi folder on archive.pmxt.dev may be empty yet, " +
          "or filenames may differ. Place a file under data/kalshi/ and pass --file.",
      );
      process.exit(3);
    }
  }

  console.log("Reading parquet rows (max per file:", maxRows, ") …");
  const ticks = await bt.loadTicksFromParquetPaths(paths, maxRows);
  console.log("Normalized ticks:", ticks.length);

  const { metrics, trades } = bt.runPureValueReplay(ticks);

  const hourNum = hourStr !== undefined ? Number(hourStr) : undefined;
  const fileLabel =
    file !== undefined ? path.basename(paths[0] ?? "input", path.extname(paths[0] ?? "")) : undefined;

  const { runFilename, runPath, latestPath } = await writePmxtBacktestOutputs(
    bt.dataRoot(),
    {
      generatedAt: new Date().toISOString(),
      source: { date: date ?? null, paths, maxRowsPerFile: maxRows },
      metrics,
      trades,
    },
    {
      strategyName: metrics.strategyName,
      sourceDate: date ?? null,
      hourUtc: Number.isInteger(hourNum) ? hourNum : undefined,
      fileLabel: file !== undefined ? fileLabel : undefined,
    },
  );

  console.log("\n── Pure Value (pmxt archive replay) ──");
  console.log("Trades:", metrics.trades, " Win rate:", (metrics.winRate * 100).toFixed(1) + "%");
  console.log("Total PnL $", metrics.totalPnlUsd.toFixed(2));
  console.log("Max drawdown %", metrics.maxDrawdownPct.toFixed(2));
  console.log("Sharpe (approx)", metrics.sharpeApprox.toFixed(3));
  console.log("Synthetic outcomes used:", metrics.usedSyntheticOutcomes, "/", metrics.trades);
  console.log("\nWrote", runPath);
  console.log("Latest mirror:", latestPath);
  console.log("Run file:", runFilename);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
