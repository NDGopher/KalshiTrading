import { getSportsMarkets, getMarketYesAsk, getMarketYesBid, type KalshiMarket } from "../kalshi-client.js";
import { db, marketOpportunitiesTable, historicalMarketsTable } from "@workspace/db";
import { eq, desc, ne } from "drizzle-orm";

export interface ScanCandidate {
  market: KalshiMarket;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
}

const SPORT_KEYWORDS = [
  "nfl", "nba", "mlb", "soccer", "mls", "premier league",
  "ncaa", "college", "football", "basketball", "baseball",
  "nhl", "hockey", "ufc", "mma", "tennis", "golf",
  "sports", "game", "match", "win", "points", "score",
  "player", "team",
  "KXNFL", "KXNBA", "KXMLB", "KXNHL", "KXSOC", "KXNCAA",
  "KXSPORT", "KXMVE"
];

function buildCandidateFromKalshi(market: KalshiMarket): ScanCandidate | null {
  const now = new Date();
  const yesPrice = parseFloat(market.last_price_dollars || "0")
    || getMarketYesAsk(market)
    || (market.yes_bid + market.yes_ask) / 2 / 100;
  if (!yesPrice || yesPrice <= 0.01 || yesPrice >= 0.99) return null;

  const noPrice = 1 - yesPrice;
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  const rawSpread = rawAsk > 0 && rawBid > 0 ? Math.abs(rawAsk - rawBid) : 0;
  const spread = rawSpread > 0 && rawSpread < 0.5 ? rawSpread : Math.min(0.05, yesPrice * 0.05);
  const volume24h = market.volume_24h || 0;
  const liquidity = parseFloat(market.liquidity_dollars || "0") || market.liquidity || 0;
  const expiresAt = new Date(market.expected_expiration_time || market.expiration_time || market.close_time);
  const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursToExpiry < 0.5) return null;

  return { market, yesPrice, noPrice, spread, volume24h, liquidity, hoursToExpiry };
}

async function scanFromCachedDb(): Promise<{ candidates: ScanCandidate[]; totalScanned: number }> {
  const now = new Date();
  const rows = await db
    .select()
    .from(historicalMarketsTable)
    .where(ne(historicalMarketsTable.status, "settled"))
    .orderBy(desc(historicalMarketsTable.snapshotAt))
    .limit(100);

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

    const yesAsk = row.yesAsk || price + 0.02;
    const yesBid = row.yesBid || price - 0.02;
    const spread = Math.min(0.05, Math.max(0.01, Math.abs(yesAsk - yesBid)));

    const typicalLiquidity = price < 0.15 ? 5000 : price < 0.30 ? 15000 : 30000;
    const typicalVolume = price < 0.15 ? 500 : price < 0.30 ? 2000 : 5000;

    const market: KalshiMarket = {
      ...(row.rawData as object),
      ticker: row.kalshiTicker,
      title: row.title || row.kalshiTicker,
      category: row.category || "Sports",
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

  candidates.sort((a, b) => b.volume24h - a.volume24h);
  return { candidates: candidates.slice(0, 50), totalScanned: rows.length };
}

export async function scanMarkets(customKeywords?: string[]): Promise<{
  candidates: ScanCandidate[];
  totalScanned: number;
  source: "live" | "cached";
}> {
  const keywords = customKeywords || SPORT_KEYWORDS;

  try {
    const markets = await getSportsMarkets(keywords);
    const candidates: ScanCandidate[] = [];

    for (const market of markets) {
      const candidate = buildCandidateFromKalshi(market);
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => b.volume24h - a.volume24h);
    const topCandidates = candidates.slice(0, 50);

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
      console.warn(`[Scanner] Kalshi API unavailable (${isRateLimit ? "rate limited" : "auth error"}), falling back to cached market data`);
      const cached = await scanFromCachedDb();
      return { ...cached, source: "cached" };
    }

    throw err;
  }
}
