import fs from "node:fs/promises";
import path from "node:path";
import type { ArchiveMarketTick } from "../normalize.js";
import type { ParquetRow } from "../parquet-load.js";
import { readParquetFile } from "../parquet-load.js";
import { jbeckerKalshiRoot } from "../paths.js";

export type JBeckerMarketMeta = {
  ticker: string;
  result: "yes" | "no";
  event_ticker: string;
  volume24h: number;
  openInterest: number;
  /**
   * When the market is treated as settled for causal wallet profiling (ms since epoch).
   * Parsed from market parquet when present; otherwise null (wallet stats skip this ticker).
   */
  settledMs: number | null;
};

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function walletIdFromRow(row: ParquetRow): string | undefined {
  const keys = [
    "maker_id",
    "taker_id",
    "trader_id",
    "user_id",
    "owner_id",
    "wallet_id",
    "maker_user_id",
    "taker_user_id",
    "buyer_id",
    "seller_id",
    "account_id",
    "member_id",
  ];
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).length > 0) return String(v);
  }
  return undefined;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function parseTimeMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v > 1e12 ? Math.floor(v) : Math.floor(v * 1000);
  }
  if (typeof v === "bigint") {
    const n = Number(v);
    return Number.isFinite(n) ? (n > 1e12 ? Math.floor(n) : Math.floor(n * 1000)) : null;
  }
  if (typeof v === "string") {
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

/** Trade row timestamps (Jon-Becker / Kalshi exports vary by dump version). */
function parseTradeTimeMs(row: ParquetRow): number | null {
  const keys = [
    "created_time",
    "createdTime",
    "trade_time",
    "tradeTime",
    "timestamp",
    "ts",
    "time",
    "created_at",
    "createdAt",
    "executed_time",
    "executedTime",
    "match_time",
    "matchTime",
  ];
  for (const k of keys) {
    if (k in row && row[k] != null) {
      const t = parseTimeMs(row[k]);
      if (t != null) return t;
    }
  }
  return null;
}

function dayKeyFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function inDateRange(dayKey: string, from?: string, to?: string): boolean {
  if (from && dayKey < from) return false;
  if (to && dayKey > to) return false;
  return true;
}

/** Resolve `markets/` and `trades/` directories (direct layout or legacy `kalshi/` subfolder). */
export async function resolveJbeckerParquetDirs(rootDir: string): Promise<{
  marketsDir: string;
  tradesDir: string;
}> {
  const directMarkets = path.join(rootDir, "markets");
  try {
    await fs.access(directMarkets);
    return {
      marketsDir: directMarkets,
      tradesDir: path.join(rootDir, "trades"),
    };
  } catch {
    return {
      marketsDir: path.join(rootDir, "kalshi", "markets"),
      tradesDir: path.join(rootDir, "kalshi", "trades"),
    };
  }
}

function parseSettledMs(row: ParquetRow): number | null {
  const candidates = [
    row.close_time,
    row.closeTime,
    row.expected_expiration_time,
    row.expectedExpirationTime,
    row.expiration_time,
    row.expirationTime,
    row.latest_expiration_time,
    row.latestExpirationTime,
    row.settlement_time,
    row.settlementTime,
    row.end_time,
    row.endTime,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const t = parseTimeMs(c);
    if (t != null) return t;
  }
  return null;
}

function rowToMarketMeta(row: ParquetRow): JBeckerMarketMeta | null {
  const ticker = str(row.ticker);
  const status = str(row.status)?.toLowerCase() ?? "";
  const result = str(row.result)?.toLowerCase() ?? "";
  if (!ticker || (result !== "yes" && result !== "no")) return null;
  if (status && status !== "finalized" && status !== "settled" && status !== "closed") return null;
  return {
    ticker,
    result: result as "yes" | "no",
    event_ticker: str(row.event_ticker) ?? "",
    volume24h: num(row.volume_24h ?? row.volume24h ?? row.volume),
    openInterest: num(row.open_interest ?? row.openInterest),
    settledMs: parseSettledMs(row),
  };
}

/**
 * Pass 1: scan trade shards for distinct tickers that appear in the date window (no market join).
 */
export async function collectTradeTickersInDateRange(
  rootDir: string,
  opts: {
    fromDay?: string;
    toDay?: string;
    maxRowsPerFile?: number;
    /** Stop after scanning this many trade rows across all shards (safety). */
    maxTradeRowsScanned?: number;
  },
): Promise<Set<string>> {
  const { tradesDir } = await resolveJbeckerParquetDirs(rootDir);
  const tickers = new Set<string>();
  let files: string[] = [];
  try {
    const names = await fs.readdir(tradesDir);
    files = names.filter((n) => n.toLowerCase().endsWith(".parquet")).sort();
  } catch {
    return tickers;
  }
  const maxRowsPer = opts.maxRowsPerFile ?? 150_000;
  const cap =
    opts.maxTradeRowsScanned === 0
      ? Number.MAX_SAFE_INTEGER
      : (opts.maxTradeRowsScanned ?? 80_000_000);
  let scanned = 0;

  outer: for (const file of files) {
    const full = path.join(tradesDir, file);
    const rows: ParquetRow[] = await readParquetFile(full, { rowEnd: maxRowsPer });
    for (const row of rows) {
      scanned++;
      if (scanned > cap) break outer;
      const ticker = str(row.ticker);
      if (!ticker) continue;
      const tsMs = parseTradeTimeMs(row);
      if (tsMs == null) continue;
      const dayKey = dayKeyFromMs(tsMs);
      if (!inDateRange(dayKey, opts.fromDay, opts.toDay)) continue;
      const yesRaw = row.yes_price ?? row.yesPrice;
      const yesCents = typeof yesRaw === "bigint" ? Number(yesRaw) : num(yesRaw);
      if (yesCents <= 0) continue;
      const mid = yesCents > 1 ? yesCents / 100 : yesCents;
      if (mid <= 0.01 || mid >= 0.99) continue;
      tickers.add(ticker);
    }
  }
  return tickers;
}

/**
 * Pass 2: scan all market shards; keep rows whose ticker is in `wanted` and has a real yes/no result.
 */
export async function loadJbeckerResolvedMarketsForTickers(
  rootDir: string,
  wanted: Set<string>,
  opts?: { maxRowsPerFile?: number },
): Promise<Map<string, JBeckerMarketMeta>> {
  const map = new Map<string, JBeckerMarketMeta>();
  if (wanted.size === 0) return map;
  const { marketsDir } = await resolveJbeckerParquetDirs(rootDir);
  let files: string[] = [];
  try {
    const names = await fs.readdir(marketsDir);
    files = names.filter((n) => n.toLowerCase().endsWith(".parquet")).sort();
  } catch {
    return map;
  }
  const maxRows = opts?.maxRowsPerFile ?? 400_000;

  for (const file of files) {
    if (map.size >= wanted.size) break;
    const full = path.join(marketsDir, file);
    const rows: ParquetRow[] = await readParquetFile(full, { rowEnd: maxRows });
    for (const row of rows) {
      const ticker = str(row.ticker);
      if (!ticker || !wanted.has(ticker)) continue;
      const meta = rowToMarketMeta(row);
      if (meta) map.set(ticker, meta);
    }
  }
  return map;
}

/**
 * Scan JBecker `markets/*.parquet` (or legacy `kalshi/markets/`) and build resolution map.
 */
export async function loadJbeckerResolvedMarkets(
  rootDir: string,
  opts?: { maxFiles?: number; maxRowsPerFile?: number },
): Promise<Map<string, JBeckerMarketMeta>> {
  const { marketsDir } = await resolveJbeckerParquetDirs(rootDir);
  const map = new Map<string, JBeckerMarketMeta>();
  let files: string[] = [];
  try {
    const names = await fs.readdir(marketsDir);
    files = names.filter((n) => n.toLowerCase().endsWith(".parquet")).sort();
  } catch {
    return map;
  }
  const maxFiles = opts?.maxFiles ?? 8;
  const maxRows = opts?.maxRowsPerFile ?? 200_000;
  for (const file of files.slice(0, maxFiles)) {
    const full = path.join(marketsDir, file);
    const rows: ParquetRow[] = await readParquetFile(full, { rowEnd: maxRows });
    for (const row of rows) {
      const meta = rowToMarketMeta(row);
      if (meta) map.set(meta.ticker, meta);
    }
  }
  return map;
}

/**
 * Load trade rows as replay ticks (YES price from tape, **real** outcomes from `marketsMap`).
 */
export async function loadJbeckerTradeTicks(
  rootDir: string,
  marketsMap: Map<string, JBeckerMarketMeta>,
  opts?: {
    /** @deprecated Trades scan all `*.parquet` shards until `maxTotalRows`; kept for CLI compatibility. */
    maxFiles?: number;
    maxRowsPerFile?: number;
    maxTotalRows?: number;
    fromDay?: string;
    toDay?: string;
  },
): Promise<ArchiveMarketTick[]> {
  const { tradesDir } = await resolveJbeckerParquetDirs(rootDir);
  const ticks: ArchiveMarketTick[] = [];
  let files: string[] = [];
  try {
    const names = await fs.readdir(tradesDir);
    files = names.filter((n) => n.toLowerCase().endsWith(".parquet")).sort();
  } catch {
    return ticks;
  }
  const maxRowsPer = opts?.maxRowsPerFile ?? 150_000;
  const maxTotal = opts?.maxTotalRows ?? 400_000;
  let total = 0;

  outer: for (const file of files) {
    if (total >= maxTotal) break outer;
    const full = path.join(tradesDir, file);
    const rows: ParquetRow[] = await readParquetFile(full, { rowEnd: maxRowsPer });
    for (const row of rows) {
      if (total >= maxTotal) break outer;
      const ticker = str(row.ticker);
      if (!ticker) continue;
      const meta = marketsMap.get(ticker);
      if (!meta) continue;

      const tsMs = parseTradeTimeMs(row);
      if (tsMs == null) continue;
      const dayKey = dayKeyFromMs(tsMs);
      if (!inDateRange(dayKey, opts?.fromDay, opts?.toDay)) continue;

      const yesRaw = row.yes_price ?? row.yesPrice;
      const yesCents = typeof yesRaw === "bigint" ? Number(yesRaw) : num(yesRaw);
      if (yesCents <= 0) continue;
      const mid = yesCents > 1 ? yesCents / 100 : yesCents;
      if (mid <= 0.01 || mid >= 0.99) continue;

      const spread = 0.02;
      const outcomeYes = meta.result === "yes";
      const cnt = Math.max(1, Math.floor(num(row.count ?? row.quantity ?? row.size)));

      ticks.push({
        ticker,
        tsMs,
        yesMid: mid,
        yesBid: Math.max(0.01, mid - spread / 2),
        yesAsk: Math.min(0.99, mid + spread / 2),
        volume24h: meta.volume24h || cnt * 10,
        liquidity: Math.max(500, meta.openInterest || 1000),
        outcomeYes,
        eventTicker: meta.event_ticker || undefined,
        walletId: walletIdFromRow(row),
        tradeCount: cnt,
        marketSettledMs: meta.settledMs,
        raw: row,
      });
      total++;
    }
  }

  return ticks.sort((a, b) => a.tsMs - b.tsMs || a.ticker.localeCompare(b.ticker));
}

export function defaultJbeckerRoot(dataRoot: string): string {
  return jbeckerKalshiRoot(dataRoot);
}
