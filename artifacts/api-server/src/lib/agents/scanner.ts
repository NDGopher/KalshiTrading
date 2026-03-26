import {
  getAllLiquidMarkets,
  getSportsMarkets,
  getMarketYesAsk,
  getMarketYesBid,
  getMarketNoAsk,
  getMarketYesPrice,
  getMarketVolume24h,
  getMarketLiquidity,
  type KalshiMarket,
} from "../kalshi-client.js";
import { db, historicalMarketsTable } from "@workspace/db";
import { ne, desc, inArray } from "drizzle-orm";
import { batchGetPriceHistory, type PriceHistory } from "../price-history.js";
import { batchGetSharpLines, type SharpLine } from "../sharp-odds.js";

export interface ScanCandidate {
  market: KalshiMarket;
  yesPrice: number;
  noPrice: number;
  /** Live YES ask price from order book (actual cost when buying YES) */
  yesAsk: number;
  /** Live NO ask price from order book (actual cost when buying NO) */
  noAsk: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
  /**
   * True when volume24h and liquidity came from the live Kalshi API order book.
   * False when sourced from the DB cache with synthetic/estimated volume numbers.
   * Strategies that depend on real volume flow (Sharp Money, Late Efficiency spread)
   * must gate on this flag — synthetic numbers produce direction-blind noise signals.
   */
  hasLiveData: boolean;
  /** Price dip/surge signal from recent snapshot history (null if insufficient data) */
  priceHistory?: PriceHistory | null;
  /** Sharp book comparison vs Pinnacle (null if no API key or not a game market) */
  sharpLine?: SharpLine | null;
}

// Sports markets rarely list games > 2 weeks out; non-sports (politics, crypto,
// economics) can run 30-90 days. 720 h (30 days) lets both through. The vol/liq
// floor in buildCandidateFromKalshi and the Sharp Money strategy gate dead markets.
const MAX_HOURS_TO_EXPIRY = 720;

function proximityScore(hoursToExpiry: number): number {
  if (hoursToExpiry <= 6) return 5.0;
  if (hoursToExpiry <= 24) return 4.0;
  if (hoursToExpiry <= 48) return 3.0;
  if (hoursToExpiry <= 96) return 2.0;
  if (hoursToExpiry <= 168) return 1.0;
  if (hoursToExpiry <= 336) return 0.5;
  if (hoursToExpiry <= 720) return 0.2; // 2–4 weeks: non-sports markets (politics, crypto)
  return 0.0;
}

const NON_SPORTS_CATEGORIES = ["Politics", "Economics", "Financials", "Entertainment", "Weather", "Crypto", "Finance"];

function isNonSportsCategory(candidate: ScanCandidate): boolean {
  const cat = candidate.market.category || "";
  return NON_SPORTS_CATEGORIES.some((nc) => cat.includes(nc));
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
  // Non-sports bonus: sports markets dominate proximity scoring (games are today/tomorrow).
  // Add a flat bonus for non-sports markets that have real active trading volume so they
  // can compete with sports in the composite ranking. No bonus for dead markets (vol=0).
  const nonSportsBonus = isNonSportsCategory(candidate) && candidate.volume24h > 100 ? 2.5 : 0;
  return proximity * 3 + volNorm * 1.5 + liqNorm * 0.5 + spreadQuality * 0.5 + dipBonus + sharpBonus + nonSportsBonus;
}

function buildCandidateFromKalshi(market: KalshiMarket): ScanCandidate | null {
  const now = new Date();
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  // Live order book midpoint — NOT stale last_price
  const yesPrice = getMarketYesPrice(market);
  // Hard floor: < 10¢ or > 90¢ means the market has already priced in the outcome
  // (or the game is over and we'd be betting into near-certain settled contracts).
  // We have zero information advantage at the extremes — skip entirely.
  if (!yesPrice || yesPrice < 0.10 || yesPrice > 0.90) return null;

  const noPrice = 1 - yesPrice;
  // Actual ask prices for execution — what you pay when you buy YES or NO
  const yesAsk = rawAsk > 0 ? rawAsk : yesPrice;
  const noAsk = getMarketNoAsk(market) || noPrice;
  const rawSpread = rawAsk > 0 && rawBid > 0 ? Math.abs(rawAsk - rawBid) : 0;
  const spread = rawSpread > 0 && rawSpread < 0.5 ? rawSpread : Math.min(0.05, yesPrice * 0.05);
  const volume24h = getMarketVolume24h(market);
  const liquidity = getMarketLiquidity(market);
  const expiresAt = new Date(
    market.expected_expiration_time || market.expiration_time || market.close_time
  );
  const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

  if (hoursToExpiry < 0.5) return null;
  if (hoursToExpiry > MAX_HOURS_TO_EXPIRY) return null;

  // Liquidity floor: markets with zero volume AND under $50 liquidity have no
  // real price discovery signal — skip them regardless of category.
  if (volume24h === 0 && liquidity < 50) return null;

  // Near-expiry illiquid ghost markets — spread is meaningless and fills are impossible
  if (hoursToExpiry < 4 && volume24h < 10 && liquidity < 100) return null;

  return { market, yesPrice, noPrice, yesAsk, noAsk, spread, volume24h, liquidity, hoursToExpiry, hasLiveData: true };
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
    // Same 10–90¢ hard floor as live path: skip near-certain / post-game markets
    if (price < 0.10 || price > 0.90) continue;

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
      yesAsk: row.yesAsk || price + 0.02,
      noAsk: 1 - (row.yesBid || price - 0.02),
      spread,
      volume24h: row.volume24h || typicalVolume,
      liquidity: typicalLiquidity,
      hoursToExpiry,
      // DB-sourced candidates use synthetic liquidity estimates — volume-flow
      // signals like Sharp Money must not fire on these.
      hasLiveData: false,
    });
  }

  candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
  return { candidates: candidates.slice(0, 50), totalScanned: rows.length };
}

/**
 * Probability Arb needs ALL legs of a multi-outcome soccer game to compute the
 * YES-sum overpricing. The main scan cuts to top-50, which may include only 1 of
 * the 3 legs. This function finds those missing sibling legs in the DB and injects
 * them into the candidate list so Probability Arb can detect the full overpricing.
 *
 * A "game key" is the first two dash-separated ticker segments:
 *   KXLALIGAGAME-26MAR20RVCLEV-RVC → key = "KXLALIGAGAME-26MAR20RVCLEV"
 */
async function injectSiblingLegs(candidates: ScanCandidate[]): Promise<void> {
  const now = new Date();
  // Collect game keys from existing soccer candidates
  const gameKeys = new Set<string>();
  const existingTickers = new Set(candidates.map((c) => c.market.ticker));

  for (const c of candidates) {
    const parts = c.market.ticker.split("-");
    // Soccer multi-outcome markets have ≥3 dash-separated segments
    if (parts.length >= 3 && (c.market.category === "Sports" || c.market.ticker.includes("GAME"))) {
      gameKeys.add(parts.slice(0, 2).join("-"));
    }
  }
  if (gameKeys.size === 0) return;

  // Fetch recent snapshots for tickers matching these game keys
  const allRows = await db
    .select()
    .from(historicalMarketsTable)
    .where(ne(historicalMarketsTable.status, "settled"))
    .orderBy(desc(historicalMarketsTable.snapshotAt))
    .limit(500)
    .catch(() => []);

  const seen = new Set<string>();
  for (const row of allRows) {
    if (!row.kalshiTicker || seen.has(row.kalshiTicker)) continue;
    seen.add(row.kalshiTicker);

    const parts = row.kalshiTicker.split("-");
    if (parts.length < 3) continue;
    const gameKey = parts.slice(0, 2).join("-");
    if (!gameKeys.has(gameKey)) continue;
    if (existingTickers.has(row.kalshiTicker)) continue;

    const price = row.lastPrice || 0;
    if (price < 0.10 || price > 0.90) continue;
    const expiresAt = new Date(row.closeTime || row.expirationTime || now);
    const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    if (hoursToExpiry < 0.5) continue;

    const yesAsk = row.yesAsk || price + 0.02;
    const yesBid = row.yesBid || price - 0.02;
    const spread = Math.min(0.05, Math.max(0.01, Math.abs(yesAsk - yesBid)));
    const typicalLiquidity = 15000;
    const typicalVolume = row.volume24h || 2000;

    const market = {
      ...(row.rawData as object),
      ticker: row.kalshiTicker,
      title: row.title || row.kalshiTicker,
      category: row.category || "Sports",
      last_price_dollars: String(price),
      yes_ask: Math.round(yesAsk * 100),
      yes_bid: Math.round(yesBid * 100),
      volume_24h: typicalVolume,
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
      yesAsk,
      noAsk: 1 - yesBid,
      spread,
      volume24h: typicalVolume,
      liquidity: typicalLiquidity,
      hoursToExpiry,
      hasLiveData: false,
    });
    existingTickers.add(row.kalshiTicker);
  }
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

    console.info(`[Scanner] buildCandidateFromKalshi: ${candidates.length} candidates from ${markets.length} markets`);

    candidates.sort((a, b) => compositeScore(b) - compositeScore(a));

    // Category-diversity selection:
    // 1. Take top-60 by compositeScore (will be heavily sports-dominated)
    // 2. Guarantee up to 5 slots per non-sports category from the remainder
    //    — but only inject markets with REAL trading activity (volume > 50 or liq > 500)
    //    to avoid wasting AI budget on dead placeholder markets.
    // 3. CRITICAL: put diversity extras FIRST in the returned list so the pipeline's
    //    top-35 slice always includes them. Without this, non-sports candidates append
    //    after 60+ sports markets and never reach the analyst.
    const POOL_SIZE = 60;
    const DIVERSITY_SLOTS_PER_CAT = 5;
    const diversityPool = candidates.slice(0, POOL_SIZE);
    const diversityExtras: ScanCandidate[] = [];
    const includedTickers = new Set(diversityPool.map((c) => c.market.ticker));

    for (const cat of NON_SPORTS_CATEGORIES) {
      const catCandidates = candidates
        .filter((c) =>
          !includedTickers.has(c.market.ticker) &&
          (c.market.category || "").toLowerCase().includes(cat.toLowerCase()) &&
          // Volume floor: must have some trading activity to be worth AI analysis.
          // Kept low (10/100) so lightly-traded non-sports markets (politics near-term,
          // active crypto) get analyzed. Sharp Money's own vol/liq ≥ 1.4× filter
          // gates actual execution — this is just the "is the market alive?" check.
          (c.volume24h > 10 || c.liquidity > 100)
        )
        .slice(0, DIVERSITY_SLOTS_PER_CAT);
      for (const dc of catCandidates) {
        diversityExtras.push(dc);
        includedTickers.add(dc.market.ticker);
      }
    }

    // Sort diversity extras by compositeScore so the best non-sports markets lead.
    // Then interleave: first 7 non-sports slots (1 per category max), then sports pool.
    // This guarantees non-sports reach the pipeline's top-35 analysis slice.
    diversityExtras.sort((a, b) => compositeScore(b) - compositeScore(a));
    const topCandidates = [...diversityExtras, ...diversityPool].slice(0, 100);

    if (diversityExtras.length > 0) {
      const catLog = diversityExtras.map((c) => `${c.market.category || "?"}(vol=${c.volume24h})`).join(", ");
      console.info(`[Scanner] Diversity injection: +${diversityExtras.length} non-sports candidates → ${catLog}`);
    } else {
      console.info(`[Scanner] No non-sports candidates with sufficient volume found this cycle`);
    }

    // If API returned nothing usable, fall through to the DB cache
    if (topCandidates.length === 0) {
      console.warn("[Scanner] API returned 0 valid candidates — falling back to cached market data");
      const cached = await scanFromCachedDb();
      return { ...cached, source: "cached" };
    }

    console.info(`[Scanner] Top ${topCandidates.length} candidates selected. Enriching top 40...`);

    // Persist snapshots to DB in small batches (best-effort warm cache)
    console.info(`[Scanner] Persisting ${topCandidates.length} snapshots to DB...`);
    try {
      const snapshots = topCandidates.map((c) => {
        // Store only compact metadata in rawData — omit large text fields (rules, descriptions)
        const { rules_primary: _r1, rules_secondary: _r2, ...compactMarket } =
          c.market as Record<string, unknown>;
        return {
          kalshiTicker: c.market.ticker,
          title: (c.market.title || c.market.ticker).slice(0, 200),
          category: c.market.category || null,
          openPrice: null as number | null,
          lastPrice: c.yesPrice,
          yesAsk: getMarketYesAsk(c.market) || c.yesPrice + 0.02,
          yesBid: getMarketYesBid(c.market) || c.yesPrice - 0.02,
          volume24h: Math.round(c.volume24h),
          liquidity: c.liquidity,
          status: c.market.status || "active",
          result: c.market.result || null,
          closeTime: c.market.close_time ? new Date(c.market.close_time) : null,
          expirationTime: c.market.expiration_time ? new Date(c.market.expiration_time) : null,
          rawData: compactMarket,
        };
      });
      // Insert in batches of 10 to stay within driver limits
      const BATCH = 10;
      for (let i = 0; i < snapshots.length; i += BATCH) {
        await db.insert(historicalMarketsTable).values(snapshots.slice(i, i + BATCH));
      }
      console.info(`[Scanner] DB persist complete (${snapshots.length} rows).`);
    } catch (_e) {
      const msg = (_e as Error).message || String(_e);
      console.warn(`[Scanner] DB persist failed (non-fatal):`, msg.slice(0, 200));
    }

    // Enrich with price history and sharp odds (best-effort, non-blocking)
    console.info(`[Scanner] Enriching candidates...`);
    await enrichCandidates(topCandidates).catch((e) => {
      console.warn(`[Scanner] Enrichment failed (non-fatal):`, (e as Error).message?.slice(0, 80));
    });

    // Inject missing sibling legs for Probability Arb (soccer 3-way games)
    await injectSiblingLegs(topCandidates).catch(() => {});
    console.info(`[Scanner] Enrichment done. Total candidates after sibling injection: ${topCandidates.length}`);

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
