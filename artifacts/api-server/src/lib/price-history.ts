/**
 * Price History & Dip/Surge Detection
 *
 * Queries the historical_markets snapshots table to compute rolling price
 * statistics and detect tradeable signals:
 *
 * 1. LIQUIDITY FLUSH DIP — price drops without new information.
 *    Signature: price falls 8%+ from mean, BUT spread widens (bid retreating,
 *    not a wave of new sellers) AND volume is LOW relative to liquidity.
 *    → Safe to buy the dip; it will revert once the seller is absorbed.
 *
 * 2. INFORMATION DIP — price drops because new information arrived.
 *    Signature: sustained high volume across multiple cycles + tight spread
 *    (buyers and sellers agree on the new price).
 *    → Do NOT fade; the market is correctly re-pricing.
 *
 * 3. SURGE — price spikes above mean.
 *    Can be a liquidity buy (revert down) or momentum (follow up).
 *    Analyst decides based on model probability.
 *
 * Example: KXNHLGAME-26MAR19WPGBOS was stable at 0.44 for hours,
 * dropped to 0.39 in one scanner cycle → 11.4% dip vs recent mean,
 * spread widened from 4¢ to 9¢, volume was near-zero → liquidity flush → buy YES.
 */

import { db, historicalMarketsTable } from "@workspace/db";
import { eq, desc, gte, and } from "drizzle-orm";

export interface PriceSnapshot {
  price: number;
  yesAsk: number;
  yesBid: number;
  spread: number;
  volume24h: number;
  snapshotAt: Date;
}

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
  /**
   * True when the dip looks like a LIQUIDITY FLUSH rather than new information:
   *  - spread widened during the drop (bid retreated, few real sellers)
   *  - volume is low during the drop window
   * A liquidity flush dip is the highest-confidence mean reversion setup.
   */
  isLiquidityFlush: boolean;
  /**
   * Volume trend over the dip window: "rising" means informed selling (be cautious),
   * "falling" or "flat" means a single large dump that's already absorbed.
   */
  volumeTrend: "rising" | "falling" | "flat" | "unknown";
  /** Average spread widening during the dip window vs. the pre-dip baseline. */
  spreadWidening: number;
  /** Hours since the price was last at the pre-dip mean level. */
  hoursSincePeak: number | null;
  /** Full snapshot series, newest first, for the analyst to reason about. */
  series: PriceSnapshot[];
}

const DIP_THRESHOLD_PCT = 8;    // current < mean by ≥8% → dip
const SURGE_THRESHOLD_PCT = 10; // current > mean by ≥10% → surge (potential fade)
const MIN_SNAPSHOTS = 8;        // need ≥8 points to trust the mean (40 min at 5-min cadence)

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
      yesAsk: historicalMarketsTable.yesAsk,
      yesBid: historicalMarketsTable.yesBid,
      volume24h: historicalMarketsTable.volume24h,
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

  const series: PriceSnapshot[] = rows
    .filter((r) => r.lastPrice > 0)
    .map((r) => {
      const ask = r.yesAsk ?? r.lastPrice + 0.02;
      const bid = r.yesBid ?? r.lastPrice - 0.02;
      return {
        price: r.lastPrice,
        yesAsk: ask,
        yesBid: bid,
        spread: Math.max(0, ask - bid),
        volume24h: r.volume24h ?? 0,
        snapshotAt: r.snapshotAt,
      };
    });

  if (series.length < MIN_SNAPSHOTS) return null;

  const prices = series.map((s) => s.price);
  const currentPrice = prices[0];
  const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
  const variance = prices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / prices.length;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const currentVsMeanPct = mean > 0 ? ((currentPrice - mean) / mean) * 100 : 0;
  const isDip = currentVsMeanPct <= -DIP_THRESHOLD_PCT;
  const isSurge = currentVsMeanPct >= SURGE_THRESHOLD_PCT;

  // ── Liquidity flush detection ──────────────────────────────────────────────
  // Look at the most recent 3 snapshots (the "dip window") vs the prior baseline
  const dipWindow = series.slice(0, 3);
  const baseline = series.slice(3, 10);

  let isLiquidityFlush = false;
  let spreadWidening = 0;
  let volumeTrend: PriceHistory["volumeTrend"] = "unknown";
  let hoursSincePeak: number | null = null;

  if (isDip && baseline.length >= 2) {
    const baselineSpread = baseline.reduce((s, r) => s + r.spread, 0) / baseline.length;
    const dipSpread = dipWindow.reduce((s, r) => s + r.spread, 0) / dipWindow.length;
    spreadWidening = baselineSpread > 0 ? (dipSpread - baselineSpread) / baselineSpread : 0;

    const baselineVolume = baseline.reduce((s, r) => s + r.volume24h, 0) / baseline.length;
    const dipVolume = dipWindow.reduce((s, r) => s + r.volume24h, 0) / dipWindow.length;
    const volumeRatio = baselineVolume > 0 ? dipVolume / baselineVolume : 1;

    if (volumeRatio > 1.3) volumeTrend = "rising";
    else if (volumeRatio < 0.8) volumeTrend = "falling";
    else volumeTrend = "flat";

    // Liquidity flush: spread widened (bid retreated, not many real sellers)
    // AND volume is NOT surging (not informed selling)
    isLiquidityFlush = spreadWidening > 0.1 && volumeTrend !== "rising";
  }

  // Hours since price was last at the pre-dip mean level (how long ago was it "normal"?)
  if (isDip && series.length > 3) {
    const preDropIndex = series.findIndex((s) => s.price >= mean * 0.97);
    if (preDropIndex > 0) {
      const preDropMs = series[preDropIndex].snapshotAt.getTime();
      hoursSincePeak = (Date.now() - preDropMs) / (1000 * 60 * 60);
    }
  }

  return {
    snapshots: series.length,
    recentMean: parseFloat(mean.toFixed(4)),
    recentMin: parseFloat(min.toFixed(4)),
    recentMax: parseFloat(max.toFixed(4)),
    stdDev: parseFloat(stdDev.toFixed(4)),
    currentVsMeanPct: parseFloat(currentVsMeanPct.toFixed(2)),
    isDip,
    isSurge,
    isLiquidityFlush,
    volumeTrend,
    spreadWidening: parseFloat(spreadWidening.toFixed(3)),
    hoursSincePeak,
    series: series.slice(0, 12), // send most recent 12 to analyst
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
