import type { ParquetRow } from "./parquet-load.js";

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

function pick(row: ParquetRow, keys: string[]): unknown {
  for (const k of keys) {
    if (k in row && row[k] !== undefined && row[k] !== null) return row[k];
  }
  return undefined;
}

/** Polymarket pmxt dumps often nest orderbook fields in a string `data` JSON column. */
function flattenArchiveRow(row: ParquetRow): ParquetRow {
  const dataStr = str(row.data);
  if (!dataStr) return row;
  try {
    const nested = JSON.parse(dataStr) as Record<string, unknown>;
    return { ...row, ...nested };
  } catch {
    return row;
  }
}

/** NO-token row: convert complementary prices to YES bid/ask. */
function noSideToYesBidAsk(noBid: number, noAsk: number): { yesBid: number; yesAsk: number } {
  return { yesBid: 1 - noAsk, yesAsk: 1 - noBid };
}

/**
 * Canonical tick from a pmxt archive row (schema may vary by dump version).
 */
export interface ArchiveMarketTick {
  ticker: string;
  tsMs: number;
  yesMid: number;
  yesBid: number;
  yesAsk: number;
  volume24h: number;
  liquidity: number;
  /** When present, used for realized PnL; otherwise a deterministic fallback is documented in reports */
  outcomeYes: boolean | null;
  /** Kalshi `event_ticker` when replaying JBecker / archive rows. */
  eventTicker?: string;
  /** Optional trade tape participant id (JBecker / Kalshi exports). */
  walletId?: string;
  /** Trade count / contracts from tape row when present. */
  tradeCount?: number;
  /** When known from market metadata — used for causal wallet profiling only. */
  marketSettledMs?: number | null;
  raw: ParquetRow;
}

function parseTimeMs(row: ParquetRow): number {
  const t =
    pick(row, [
      "timestamp",
      "ts",
      "time",
      "observed_at",
      "snapshot_time",
      "created_at",
      "datetime",
      "timestamp_received",
      "timestamp_created_at",
    ]) ?? 0;
  const n = num(t);
  if (n != null && n > 1e12) return Math.floor(n);
  if (n != null && n > 1e9) return Math.floor(n * 1000);
  const s = str(t);
  if (s) {
    const d = Date.parse(s);
    if (!Number.isNaN(d)) return d;
  }
  return Date.now();
}

function parseOutcome(row: ParquetRow): boolean | null {
  const v = pick(row, ["result", "outcome", "settlement", "winner", "resolved_yes", "yes_won"]);
  const s = str(v)?.toLowerCase();
  if (s === "yes" || s === "y" || s === "true" || s === "1") return true;
  if (s === "no" || s === "n" || s === "false" || s === "0") return false;
  const b = num(v);
  if (b === 1) return true;
  if (b === 0) return false;
  return null;
}

/**
 * Map a parquet object row into a normalized tick. Returns null if no ticker or unusable prices.
 */
export function normalizeArchiveRow(row: ParquetRow): ArchiveMarketTick | null {
  const r = flattenArchiveRow(row);

  const tokenId = str(pick(r, ["token_id", "clob_token_id", "asset_id"]));
  const marketId = str(pick(r, ["market_id", "condition_id"]));
  const ticker =
    str(
      pick(r, [
        "ticker",
        "market_ticker",
        "ticker_name",
        "symbol",
        "contract_ticker",
        "event_ticker",
        "slug",
        "id",
      ]),
    ) ??
    (tokenId && marketId ? `${marketId}:${tokenId}` : null) ??
    tokenId;
  if (!ticker) return null;

  let yesBidRaw = num(
    pick(r, ["yes_bid", "yesBid", "best_bid_yes", "bid_yes", "yes_bid_dollars", "best_bid", "bid"]),
  );
  let yesAskRaw = num(
    pick(r, ["yes_ask", "yesAsk", "best_ask_yes", "ask_yes", "yes_ask_dollars", "best_ask", "ask"]),
  );
  const midRaw = num(
    pick(r, ["mid", "yes_mid", "midpoint", "last_price", "last_price_dollars", "price", "last"]),
  );

  const side = str(pick(r, ["side"]))?.toUpperCase() ?? null;
  if (side === "NO" && yesBidRaw != null && yesAskRaw != null) {
    const y = noSideToYesBidAsk(yesBidRaw, yesAskRaw);
    yesBidRaw = y.yesBid;
    yesAskRaw = y.yesAsk;
  }

  let yesBid = yesBidRaw;
  let yesAsk = yesAskRaw;
  let yesMid = midRaw;

  if (yesBid != null && yesBid > 1 && yesBid <= 100) yesBid /= 100;
  if (yesAsk != null && yesAsk > 1 && yesAsk <= 100) yesAsk /= 100;
  if (yesMid != null && yesMid > 1 && yesMid <= 100) yesMid /= 100;

  if (yesMid == null && yesBid != null && yesAsk != null) {
    yesMid = (yesBid + yesAsk) / 2;
  }
  if (yesBid == null && yesMid != null && yesAsk != null) {
    yesBid = Math.max(0, yesMid - (yesAsk - yesMid));
  }
  if (yesAsk == null && yesMid != null && yesBid != null) {
    yesAsk = Math.min(1, yesMid + (yesMid - yesBid));
  }

  if (yesMid == null || yesMid <= 0 || yesMid >= 1) return null;
  if (yesBid == null) yesBid = yesMid;
  if (yesAsk == null) yesAsk = yesMid;

  const volume24h = num(pick(r, ["volume_24h", "volume24h", "volume", "daily_volume"])) ?? 0;
  const liquidity = num(pick(r, ["liquidity", "open_interest", "oi", "depth"])) ?? 0;

  return {
    ticker,
    tsMs: parseTimeMs(r),
    yesMid,
    yesBid,
    yesAsk,
    volume24h,
    liquidity,
    outcomeYes: parseOutcome(r),
    raw: row,
  };
}
