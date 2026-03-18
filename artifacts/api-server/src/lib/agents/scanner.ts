import {
  getAllLiquidMarkets,
  getSportsMarkets,
  getMarketYesAsk,
  getMarketYesBid,
  type KalshiMarket,
} from "../kalshi-client.js";
import { db, historicalMarketsTable } from "@workspace/db";
import { ne, desc } from "drizzle-orm";
import { batchGetPriceHistory, type PriceHistory } from "../price-history.js";
import { batchGetSharpLines, type SharpLine } from "../sharp-odds.js";

export interface ScanCandidate {
  market: KalshiMarket;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
  /** Price dip/surge signal from recent snapshot history (null if insufficient data) */
  priceHistory?: PriceHistory | null;
  /** Sharp book comparison vs Pinnacle (null if no API key or not a game market) */
  sharpLine?: SharpLine | null;
}

// Kalshi KXMVE markets typically close 1-2 weeks out; keep window at 2 weeks (336 h)
const MAX_HOURS_TO_EXPIRY = 336;

/**
 * Ticker prefixes that are structurally un-analyzable and will always lose:
 *
 * KXMVECROSSCATEGORY / KXMVESPORTSMULTIGAMEEXTENDED
 *   Multi-leg AND-condition parlays (e.g. "NYK wins AND OKC wins AND player scores 30+").
 *   The AI cannot compute conjunction probabilities without per-game outcomes and
 *   consistently misprices these — confirmed by empirical loss data.
 *
 * KXWBCTOTAL
 *   World Baseball Classic total-runs markets where the resolution threshold is absent
 *   from the title, making the contract uninterpretable.
 *
 * KXNBASPREAD / KXNHLSPREAD / KXNFLSPREAD / KXMLBSPREAD
 *   Sports point-spread markets priced by sharp, high-volume orderbooks.
 *   The AI has no live scores, injury data, or line-movement signal to justify
 *   disagreeing with these prices — empirical win rate: 29% at −$1,887 net.
 */
const BLOCKED_TICKER_PREFIXES = [
  "KXMVECROSSCATEGORY",
  "KXMVESPORTSMULTIGAMEEXTENDED",
  "KXWBCTOTAL",
  "KXNBASPREAD",
  "KXNHLSPREAD",
  "KXNFLSPREAD",
  "KXMLBSPREAD",
];

function isBlockedTicker(ticker: string): boolean {
  return BLOCKED_TICKER_PREFIXES.some((prefix) => ticker.startsWith(prefix));
}

function proximityScore(hoursToExpiry: number): number {
  if (hoursToExpiry <= 6) return 5.0;
  if (hoursToExpiry <= 24) return 4.0;
  if (hoursToExpiry <= 48) return 3.0;
  if (hoursToExpiry <= 96) return 2.0;
  if (hoursToExpiry <= 168) return 1.0;
  if (hoursToExpiry <= 336) return 0.5;
  return 0.0;
}

function compositeScore(candidate: ScanCandidate): number {
  const volNorm = Math.min(1, candidate.volume24h / 10000);
  const liqNorm = Math.min(1, candidate.liquidity / 50000);
  const proximity = proximityScore(candidate.hoursToExpiry);
  // Spread quality: tighter spreads = more efficient market = better execution
  const spreadQuality = Math.max(0, 1 - candidate.spread / 0.2);
  // Bonus for dip/surge signals — bump these up in priority
  const dipBonus = candidate.priceHistory?.isDip || candidate.priceHistory?.isSurge ? 0.8 : 0;
  // Bonus when sharp book comparison shows an edge
  const sharpBonus = candidate.sharpLine && candidate.sharpLine.edgeSide !== "NONE" ? 1.5 : 0;
  return proximity * 3 + volNorm * 1.5 + liqNorm * 0.5 + spreadQuality * 0.5 + dipBonus + sharpBonus;
}

function buildCandidateFromKalshi(market: KalshiMarket): ScanCandidate | null {
  // Structurally un-analyzable market families — block unconditionally
  if (isBlockedTicker(market.ticker)) return null;

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

  // Global liquidity floor: any market with no volume AND under $20 liquidity
  // is untradeable — the AI has no price discovery signal to anchor on.
  if (volume24h === 0 && liquidity < 20) return null;

  // Secondary gate: near-expiry illiquid markets are ghost markets
  if (hoursToExpiry < 4 && volume24h < 10 && liquidity < 50) return null;

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
 * Enrich top candidates with price history (dip detection) and sharp book lines.
 * Only applied to top N candidates to avoid excessive DB load on each scan cycle.
 */
async function enrichCandidates(candidates: ScanCandidate[]): Promise<void> {
  const TOP_N = 40;
  const toEnrich = candidates.slice(0, TOP_N);
  const tickers = toEnrich.map((c) => c.market.ticker);

  const [priceHistories, sharpLines] = await Promise.all([
    batchGetPriceHistory(tickers, 24).catch(() => new Map<string, PriceHistory>()),
    batchGetSharpLines(tickers.map((t) => ({
      ticker: t,
      yesPrice: toEnrich.find((c) => c.market.ticker === t)?.yesPrice ?? 0.5,
    }))).catch(() => new Map<string, SharpLine>()),
  ]);

  for (const candidate of toEnrich) {
    candidate.priceHistory = priceHistories.get(candidate.market.ticker) ?? null;
    candidate.sharpLine = sharpLines.get(candidate.market.ticker) ?? null;
  }
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
    // Fetch all markets across ALL categories — no volume pre-filter
    const markets = await getAllLiquidMarkets(10);
    const candidates: ScanCandidate[] = [];

    for (const market of markets) {
      const candidate = buildCandidateFromKalshi(market);
      if (candidate) candidates.push(candidate);
    }

    candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
    const topCandidates = candidates.slice(0, 100);

    // If API returned nothing usable, fall through to the DB cache
    if (topCandidates.length === 0) {
      console.warn("[Scanner] API returned 0 valid candidates — falling back to cached market data");
      const cached = await scanFromCachedDb();
      return { ...cached, source: "cached" };
    }

    // Persist snapshots to DB (best-effort, so we have a warm cache for future fallbacks)
    try {
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
    } catch (_e) {}

    // Enrich with price history and sharp odds (best-effort, non-blocking)
    await enrichCandidates(topCandidates).catch(() => {});

    // Re-sort after enrichment so dip/sharp signals bubble up
    topCandidates.sort((a, b) => compositeScore(b) - compositeScore(a));

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
