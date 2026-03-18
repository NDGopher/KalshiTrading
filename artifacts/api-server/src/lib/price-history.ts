/**
 * Price History & Dip Detection
 *
 * Queries the historical_markets snapshots table to compute a rolling mean
 * and detect pregame price dips. A "dip" is when a market's current price
 * has fallen significantly below its recent mean without a clear fundamental
 * reason — a potential mean-reversion buy opportunity.
 *
 * Example: KXNHLGAME-26MAR19WPGBOS was trading at 0.44 for hours,
 * dropped to 0.39 in one scanner cycle → 11.4% dip vs recent mean → flag it.
 */

import { db, historicalMarketsTable } from "@workspace/db";
import { eq, desc, gte, and } from "drizzle-orm";

export interface PriceHistory {
  snapshots: number;
  recentMean: number;
  recentMin: number;
  recentMax: number;
  stdDev: number;
  /** Positive = price above mean. Negative = price below (dip). As percentage. */
  currentVsMeanPct: number;
  isDip: boolean;
  isSurge: boolean;
}

const DIP_THRESHOLD_PCT = 8;    // current < mean by ≥8% → dip
const SURGE_THRESHOLD_PCT = 10; // current > mean by ≥10% → surge (potential fade)
const MIN_SNAPSHOTS = 12;       // need ≥12 points (1h at 5-min) to trust the mean

/**
 * Fetch recent price history for a ticker and compute dip/surge signals.
 * Returns null if there are not enough snapshots to be meaningful.
 */
export async function getPriceHistory(
  ticker: string,
  lookbackHours = 12
): Promise<PriceHistory | null> {
  const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  const rows = await db
    .select({
      lastPrice: historicalMarketsTable.lastPrice,
      snapshotAt: historicalMarketsTable.snapshotAt,
    })
    .from(historicalMarketsTable)
    .where(
      and(
        eq(historicalMarketsTable.kalshiTicker, ticker),
        gte(historicalMarketsTable.snapshotAt, cutoff)
      )
    )
    .orderBy(desc(historicalMarketsTable.snapshotAt))
    .limit(200);

  if (rows.length < MIN_SNAPSHOTS) return null;

  const prices = rows.map((r) => r.lastPrice).filter((p) => p > 0);
  if (prices.length < MIN_SNAPSHOTS) return null;

  const currentPrice = prices[0]; // most recent snapshot
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  const currentVsMeanPct = mean > 0 ? ((currentPrice - mean) / mean) * 100 : 0;

  return {
    snapshots: prices.length,
    recentMean: parseFloat(mean.toFixed(4)),
    recentMin: parseFloat(min.toFixed(4)),
    recentMax: parseFloat(max.toFixed(4)),
    stdDev: parseFloat(stdDev.toFixed(4)),
    currentVsMeanPct: parseFloat(currentVsMeanPct.toFixed(2)),
    isDip: currentVsMeanPct <= -DIP_THRESHOLD_PCT,
    isSurge: currentVsMeanPct >= SURGE_THRESHOLD_PCT,
  };
}

/**
 * Batch-fetch price history for multiple tickers concurrently.
 */
export async function batchGetPriceHistory(
  tickers: string[],
  lookbackHours = 12
): Promise<Map<string, PriceHistory>> {
  const result = new Map<string, PriceHistory>();
  const batchSize = 10;

  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const histories = await Promise.all(
      batch.map(async (ticker) => {
        const h = await getPriceHistory(ticker, lookbackHours).catch(() => null);
        return { ticker, h };
      })
    );
    for (const { ticker, h } of histories) {
      if (h) result.set(ticker, h);
    }
  }

  return result;
}
