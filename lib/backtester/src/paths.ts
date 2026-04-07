import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (kalshitrading/) */
export function getRepoRoot(): string {
  return path.resolve(here, "../../..");
}

export function defaultDataDir(): string {
  return path.join(getRepoRoot(), "data");
}

export function kalshiCacheDir(dataRoot = defaultDataDir()): string {
  return path.join(dataRoot, "kalshi");
}

export function backtestResultsDir(dataRoot = defaultDataDir()): string {
  return path.join(dataRoot, "backtest-results");
}

export function latestBacktestResultPath(dataRoot = defaultDataDir()): string {
  return path.join(backtestResultsDir(dataRoot), "latest.json");
}

/**
 * Default Jon-Becker Kalshi parquet root: folder that contains `markets/` and `trades/` directly
 * (e.g. extracted layout `data/jbecker-data/data/kalshi`).
 * Legacy layout `…/jbecker/kalshi/{markets,trades}` is still supported via `resolveJbeckerParquetDirs`.
 */
export function jbeckerKalshiRoot(dataRoot = defaultDataDir()): string {
  return path.join(dataRoot, "jbecker-data", "data", "kalshi");
}

export function multiBacktestRankPath(dataRoot = defaultDataDir()): string {
  return path.join(backtestResultsDir(dataRoot), "multi", "last-ranked.json");
}
