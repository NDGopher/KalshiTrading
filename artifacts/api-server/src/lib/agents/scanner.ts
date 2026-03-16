import {
  getAllLiquidMarkets,
  getSportsMarkets,
  getMarketYesAsk,
  getMarketYesBid,
  type KalshiMarket,
} from "../kalshi-client.js";
import { db, historicalMarketsTable } from "@workspace/db";
import { ne, desc } from "drizzle-orm";

export interface ScanCandidate {
  market: KalshiMarket;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
}

// Max look-ahead window: 7 days. Beyond that, prices are too speculative.
const MAX_HOURS_TO_EXPIRY = 168;

function proximityScore(hoursToExpiry: number): number {
  if (hoursToExpiry <= 6) return 5.0;
  if (hoursToExpiry <= 24) return 4.0;
  if (hoursToExpiry <= 48) return 3.0;
  if (hoursToExpiry <= 96) return 2.0;
  if (hoursToExpiry <= 168) return 1.0;
  return 0.0;
}

function compositeScore(candidate: ScanCandidate): number {
  const volNorm = Math.min(1, candidate.volume24h / 10000);
  const liqNorm = Math.min(1, candidate.liquidity / 50000);
  const proximity = proximityScore(candidate.hoursToExpiry);
  // Spread quality: tighter spreads = more efficient market = better execution
  const spreadQuality = Math.max(0, 1 - candidate.spread / 0.2);
  return proximity * 3 + volNorm * 1.5 + liqNorm * 0.5 + spreadQuality * 0.5;
}

function buildCandidateFromKalshi(market: KalshiMarket): ScanCandidate | null {
  const now = new Date();
  const yesPrice =
    parseFloat(String(market.last_price_dollars || "0")) ||
    getMarketYesAsk(market) ||
    (market.yes_bid + market.yes_ask) / 2 / 100;
  if (!yesPrice || yesPrice <= 0.01 || yesPrice >= 0.99) return null;

  const noPrice = 1 - yesPrice;
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  const rawSpread = rawAsk > 0 && rawBid > 0 ? Math.abs(rawAsk - rawBid) : 0;
  const spread = rawSpread > 0 && rawSpread < 0.5 ? rawSpread : Math.min(0.05, yesPrice * 0.05);
  const volume24h = market.volume_24h || 0;
  const liquidity = parseFloat(String(market.liquidity_dollars || "0")) || market.liquidity || 0;
  const expiresAt = new Date(
    market.expected_expiration_time || market.expiration_time || market.close_time
  );
  const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursToExpiry < 0.5) return null;
  if (hoursToExpiry > MAX_HOURS_TO_EXPIRY) return null;

  return { market, yesPrice, noPrice, spread, volume24h, liquidity, hoursToExpiry };
}

async function scanFromCachedDb(): Promise<{ candidates: ScanCandidate[]; totalScanned: number }> {
  const now = new Date();
  const maxClose = new Date(now.getTime() + MAX_HOURS_TO_EXPIRY * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(historicalMarketsTable)
    .where(ne(historicalMarketsTable.status, "settled"))
    .orderBy(desc(historicalMarketsTable.snapshotAt))
    .limit(200);

  const seen = new Set<string>();
  const candidates: ScanCandidate[] = [];

  for (const row of rows) {
    if (seen.has(row.kalshiTicker)) continue;
    seen.add(row.kalshiTicker);

    const price = row.lastPrice || 0;
    if (price <= 0.01 || price >= 0.99) continue;

    const expiresAt = new Date(row.closeTime || row.expirationTime || now);
    const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursToExpiry < 0.5) continue;
    if (expiresAt > maxClose) continue;

    const yesAsk = row.yesAsk || price + 0.02;
    const yesBid = row.yesBid || price - 0.02;
    const spread = Math.min(0.05, Math.max(0.01, Math.abs(yesAsk - yesBid)));

    const typicalLiquidity = price < 0.15 ? 5000 : price < 0.30 ? 15000 : 30000;
    const typicalVolume = price < 0.15 ? 500 : price < 0.30 ? 2000 : 5000;

    const market: KalshiMarket = {
      ...(row.rawData as object),
      ticker: row.kalshiTicker,
      title: row.title || row.kalshiTicker,
      category: row.category || "Unknown",
      last_price_dollars: String(price),
      yes_ask: Math.round(yesAsk * 100),
      yes_bid: Math.round(yesBid * 100),
      volume_24h: row.volume24h || typicalVolume,
      liquidity: typicalLiquidity,
      liquidity_dollars: String(typicalLiquidity),
      status: row.status || "active",
      result: row.result || null,
      close_time: row.closeTime?.toISOString() || expiresAt.toISOString(),
      expiration_time: row.expirationTime?.toISOString() || expiresAt.toISOString(),
    } as KalshiMarket;

    candidates.push({
      market,
      yesPrice: price,
      noPrice: 1 - price,
      spread,
      volume24h: row.volume24h || typicalVolume,
      liquidity: typicalLiquidity,
      hoursToExpiry,
    });
  }

  candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
  return { candidates: candidates.slice(0, 50), totalScanned: rows.length };
}

/**
 * Scan markets from Kalshi.
 * By default fetches ALL liquid markets across every category (sports, politics, crypto, etc.).
 * If sportFilters is provided and non-empty, it is logged but does not restrict the universe —
 * we now trade all Kalshi markets with sufficient volume.
 */
export async function scanMarkets(_sportFilters?: string[]): Promise<{
  candidates: ScanCandidate[];
  totalScanned: number;
  source: "live" | "cached";
}> {
  try {
    // Fetch all liquid markets across ALL categories
    const markets = await getAllLiquidMarkets(50, 10);
    const candidates: ScanCandidate[] = [];

    for (const market of markets) {
      const candidate = buildCandidateFromKalshi(market);
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
    const topCandidates = candidates.slice(0, 100);

    // Persist snapshots to DB (best-effort)
    try {
      if (topCandidates.length > 0) {
        const snapshots = topCandidates.map((c) => ({
          kalshiTicker: c.market.ticker,
          title: c.market.title || c.market.ticker,
          category: c.market.category || null,
          openPrice: null as number | null,
          lastPrice: c.yesPrice,
          yesAsk: getMarketYesAsk(c.market) || c.yesPrice + 0.02,
          yesBid: getMarketYesBid(c.market) || c.yesPrice - 0.02,
          volume24h: c.volume24h,
          liquidity: c.liquidity,
          status: c.market.status || "active",
          result: c.market.result || null,
          closeTime: c.market.close_time ? new Date(c.market.close_time) : null,
          expirationTime: c.market.expiration_time ? new Date(c.market.expiration_time) : null,
          rawData: c.market as unknown as Record<string, unknown>,
        }));
        await db.insert(historicalMarketsTable).values(snapshots);
      }
    } catch (_e) {}

    return { candidates: topCandidates, totalScanned: markets.length, source: "live" };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isRateLimit = errMsg.includes("429") || errMsg.includes("too_many_requests");
    const isAuthError = errMsg.includes("401") || errMsg.includes("403");

    if (isRateLimit || isAuthError) {
      console.warn(
        `[Scanner] Kalshi API unavailable (${isRateLimit ? "rate limited" : "auth error"}), falling back to cached market data`
      );
      const cached = await scanFromCachedDb();

      // Also try sports-specific scan as secondary source
      try {
        const sportsMarkets = await getSportsMarkets([
          "nfl", "nba", "mlb", "soccer", "nhl", "ufc",
        ]);
        const sportsCandidates: ScanCandidate[] = [];
        for (const m of sportsMarkets) {
          const c = buildCandidateFromKalshi(m);
          if (c) sportsCandidates.push(c);
        }
        const seen = new Set(cached.candidates.map((c) => c.market.ticker));
        const newOnes = sportsCandidates.filter((c) => !seen.has(c.market.ticker));
        cached.candidates.push(...newOnes);
        cached.candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
        cached.totalScanned += sportsMarkets.length;
      } catch {}

      return { ...cached, source: "cached" };
    }

    throw err;
  }
}
