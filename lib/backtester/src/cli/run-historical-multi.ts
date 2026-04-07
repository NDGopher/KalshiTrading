#!/usr/bin/env node
import path from "node:path";
import { tryApplyMultiBacktestRankPatch } from "../apply-multi-rank-pg.js";
import {
  collectTradeTickersInDateRange,
  defaultJbeckerRoot,
  loadJbeckerResolvedMarketsForTickers,
  loadJbeckerTradeTicks,
} from "../historical/jbecker-loader.js";
import { jbeckerDownloadInstructions } from "../jbecker-downloader.js";
import { writeMultiBacktestRankReport } from "../multi-report-writer.js";
import { defaultHalfKellySizing, defaultReplayRiskLimits, runParallelStrategies } from "../replay/parallel-replay.js";
import { filterTicksBySport } from "../replay/sport-bucket.js";
import type { ReplayRiskLimits } from "../types.js";
import { Backtester } from "../backtester.js";
import { replayStrategiesByNames } from "../strategies/replay-registry.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  const jbeckerRoot = arg("--jbecker-root");
  const usePmxt = hasFlag("--pmxt-fallback");
  const strategyArg = arg("--strategies");
  const sportArg = arg("--sport") ?? "all";
  const maxTradeRows = Number(arg("--max-trade-rows") ?? "400000");
  const marketRowsPerFile = Number(arg("--market-rows-per-file") ?? "400000");
  const scanArg = arg("--max-trade-scan-rows");
  const maxTradeScanRows =
    scanArg === "0"
      ? 0
      : Number(scanArg ?? String(Math.max(maxTradeRows * 40, 8_000_000)));

  const bt = new Backtester();
  const dataRoot = bt.dataRoot();
  const root = path.resolve(jbeckerRoot ?? defaultJbeckerRoot(dataRoot));
  if (!usePmxt) {
    console.log("JBecker parquet root:", root, "(override with --jbecker-root)");
  }

  let ticks;

  if (usePmxt) {
    if (!fromDay) {
      console.error("With --pmxt-fallback, pass --from YYYY-MM-DD (and optional --to).");
      process.exit(1);
    }
    const end = toDay ?? fromDay;
    const paths: string[] = [];
    const startD = new Date(`${fromDay}T00:00:00Z`);
    const endD = new Date(`${end}T00:00:00Z`);
    for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      const { paths: dayPaths } = await bt.ensureKalshiDay(ds);
      paths.push(...dayPaths);
    }
    if (paths.length === 0) {
      console.error("No pmxt parquet hours found for range. Try archive / R2 or --jbecker-root.");
      process.exit(2);
    }
    ticks = await bt.loadTicksFromParquetPaths(paths, maxTradeRows);
    console.log(`Pmxt archive: ${ticks.length} ticks from ${paths.length} parquet file(s) (synthetic outcomes)`);
  } else {
    if (!fromDay) {
      console.error(`Usage:
  pnpm --filter @workspace/backtester run historical-multi -- \\
    --from YYYY-MM-DD [--to YYYY-MM-DD] [--sport NFL|NBA|all] \\
    [--jbecker-root <path>] [--strategies all|"Pure Value,Dip Buy"] \\
    [--bankroll 5000] [--kelly] [--kelly-fraction 0.5] \\
    [--max-trades-hour N] [--min-edge N] [--min-confidence x] [--cooldown-ms ms] \\
    [--market-rows-per-file N] [--max-trade-scan-rows R] [--max-trade-rows R] \\
    [--apply-learner]   (needs DATABASE_URL)

  Synthetic / orderbook replay (no JBecker):
    --pmxt-fallback --from YYYY-MM-DD [--to YYYY-MM-DD]

${jbeckerDownloadInstructions(dataRoot)}
`);
      process.exit(1);
    }
    const endDay = toDay ?? fromDay;

    console.log("Pass 1: tape tickers in date range from", root, "…");
    const tickerSet = await collectTradeTickersInDateRange(root, {
      fromDay,
      toDay: endDay,
      maxRowsPerFile: 200_000,
      maxTradeRowsScanned: maxTradeScanRows,
    });
    console.log("Distinct tickers in window:", tickerSet.size);
    if (tickerSet.size === 0) {
      console.error("No qualifying trades in date range (check dates / --max-trade-scan-rows).");
      process.exit(3);
    }

    console.log("Pass 2: resolved markets for those tickers (scanning markets/*.parquet)…");
    const marketsMap = await loadJbeckerResolvedMarketsForTickers(root, tickerSet, {
      maxRowsPerFile: marketRowsPerFile,
    });
    console.log("Resolved markets matched:", marketsMap.size, "/", tickerSet.size);
    if (marketsMap.size === 0) {
      console.error("No resolved yes/no markets for tape tickers. Check --jbecker-root.");
      process.exit(3);
    }

    ticks = await loadJbeckerTradeTicks(root, marketsMap, {
      fromDay,
      toDay: endDay,
      maxRowsPerFile: 200_000,
      maxTotalRows: maxTradeRows,
    });
    console.log("Trade ticks (real outcomes):", ticks.length);
    if (ticks.length === 0) {
      console.error("No ticks after join. Try widening dates or raising --max-trade-rows / --max-trade-scan-rows.");
      process.exit(4);
    }
  }

  const beforeSport = ticks.length;
  ticks = filterTicksBySport(ticks, sportArg);
  console.log(`Sport filter "${sportArg}": ${ticks.length} ticks (was ${beforeSport})`);
  if (ticks.length === 0) {
    console.error("No ticks left after sport filter.");
    process.exit(5);
  }

  const sampleN = Math.min(800, ticks.length);
  let walletHits = 0;
  for (let i = 0; i < sampleN; i++) {
    if (ticks[i]!.walletId) walletHits++;
  }
  if (walletHits === 0) {
    console.warn(
      "[historical-multi] No walletId on sampled ticks — trade parquet likely lacks maker/taker columns. Fresh Wallet & Sharp Wallet will not fire; add ids to the dump or merge wallet-enriched trades.",
    );
  }

  const names = strategyArg ? strategyArg.split(",").map((s) => s.trim()) : ["all"];
  const strategies = replayStrategiesByNames(names);

  const bankroll = Number(arg("--bankroll") ?? "5000");
  const kellyFrac = arg("--kelly-fraction");
  const useKelly = hasFlag("--kelly") || kellyFrac != null;
  const positionSizing = useKelly
    ? {
        mode: "kelly" as const,
        kellyFraction: Number(kellyFrac ?? "0.5"),
        capFraction: Number(arg("--kelly-cap") ?? "0.06"),
      }
    : defaultReplayRiskLimits.positionSizing;

  const risk: ReplayRiskLimits = {
    ...defaultReplayRiskLimits,
    maxTradesPerHour: Number(arg("--max-trades-hour") ?? defaultReplayRiskLimits.maxTradesPerHour),
    minEdgePp: Number(arg("--min-edge") ?? defaultReplayRiskLimits.minEdgePp),
    minConfidence: Number(arg("--min-confidence") ?? defaultReplayRiskLimits.minConfidence),
    cooldownSameTickerMs: Number(arg("--cooldown-ms") ?? defaultReplayRiskLimits.cooldownSameTickerMs),
    positionSizing: useKelly ? positionSizing : defaultReplayRiskLimits.positionSizing,
  };

  if (hasFlag("--kelly") && !kellyFrac) {
    risk.positionSizing = defaultHalfKellySizing;
  }

  const report = runParallelStrategies(ticks, strategies, risk, {
    initialBankroll: bankroll,
    forbidSyntheticOutcomes: !usePmxt,
  });

  report.source = {
    ...report.source,
    mode: usePmxt ? "pmxt_archive_synthetic_outcomes" : "jbecker_kalshi_realized",
    jbeckerRoot: usePmxt ? null : path.resolve(root),
    fromDay: fromDay ?? null,
    toDay: (toDay ?? fromDay) ?? null,
    sportFilter: sportArg,
    bankroll,
    halfKellyDefaultNote: "Pass --kelly for half-Kelly-style sizing (kellyFraction=0.5) or set --kelly-fraction.",
  };

  const { path: outPath, timestampedPath, summaryCsv, tradesCsv } = await writeMultiBacktestRankReport(dataRoot, report);

  if (hasFlag("--apply-learner")) {
    const r = await tryApplyMultiBacktestRankPatch(dataRoot);
    console.log("\n── Learner DB apply ──");
    console.log(r.applied ? "Applied." : "Skipped.", r.detail);
  }

  const pad = (s: string, w: number) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));

  console.log("\n── Ranked strategies (PnL / WR / Sharpe / E[trade] / trades) ──");
  console.log(
    pad("Strat", 22) +
      pad("PnL $", 12) +
      pad("WR%", 8) +
      pad("Sharpe", 10) +
      pad("E/trade", 12) +
      pad("Trades", 10) +
      "/h",
  );
  console.log("-".repeat(86));
  for (const r of report.rankings) {
    console.log(
      pad(r.strategyName, 22) +
        pad(r.totalPnlUsd.toFixed(2), 12) +
        pad(`${(r.winRate * 100).toFixed(1)}`, 8) +
        pad(r.sharpeApprox.toFixed(2), 10) +
        pad((r.expectancyPerTradeUsd ?? 0).toFixed(3), 12) +
        pad(String(r.trades), 10) +
        r.tradesPerHour.toFixed(1),
    );
  }

  if (report.readability) {
    console.log("\n── Per-strategy verdicts & reason hints ──");
    for (const r of report.rankings) {
      const rb = report.readability[r.strategyName];
      if (!rb) continue;
      console.log(`\n▸ ${r.rank}. ${r.strategyName}`);
      console.log(`  Verdict: ${rb.verdict}`);
      console.log(`  Next test: ${rb.nextTestHint}`);
      if (rb.topWinReasons.length) {
        console.log("  Top win reasons (sampled):");
        for (const row of rb.topWinReasons) {
          console.log(`    · ${row.count}×  $${row.pnlUsd.toFixed(2)}  ${row.reason}`);
        }
      }
      if (rb.topLossReasons.length) {
        console.log("  Top loss reasons (sampled):");
        for (const row of rb.topLossReasons) {
          console.log(`    · ${row.count}×  $${row.pnlUsd.toFixed(2)}  ${row.reason}`);
        }
      }
    }
  }

  console.log("\nSuggested patch:", report.suggestedSettingsPatch);
  console.log("\nWrote", outPath);
  console.log("Timestamped:", timestampedPath);
  if (summaryCsv) console.log("CSV summary:", summaryCsv);
  if (tradesCsv) console.log("CSV trades:", tradesCsv);
  if (report.outputFiles?.rankedJson) console.log("Relative:", report.outputFiles);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
