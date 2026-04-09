import {
  getAllLiquidMarkets,
  getSportsMarkets,
  getMarketYesAsk,
  getMarketYesBid,
  getMarketNoAsk,
  getMarketYesPrice,
  getMarketVolume24h,
  getMarketLiquidity,
  isExcludedKalshiStructuralJunk,
  type KalshiMarket,
} from "../kalshi-client.js";
import { db, historicalMarketsTable } from "@workspace/db";
import { ne, desc } from "drizzle-orm";
import { batchGetPriceHistory, type PriceHistory } from "../price-history.js";
import { updateLiveTapeFlow } from "../live-tape-flow.js";
import { kalshiMarketBucket, kalshiSportBucket } from "@workspace/backtester";

/**
 * Scanner sizing (live paper + future live) — **no Odds API / sharp lines**.
 * - **Pool 500**: **80–100** Crypto + Politics + Other guaranteed when supply exists (backtest-aligned), up to **120**
 *   total non-sports including Economics; **sports fill remainder** (~380–420). Relaxed vol/liq **only** for
 *   Crypto/Politics/Other; Economics uses a tighter relaxed pass. **KXBTCD** boosted in score + series fetch.
 * - **Enrich top 250**: price-history only (DB, batched 20 tickers → ~13 rounds).
 *
 * **Cycle budget:** Kalshi ~12–22s; persist 500 rows; enrich ~13 DB batches; analyst 250 ~2–6s.
 * **Target: full trading cycle under 40s** when Kalshi is healthy.
 */
export const SCANNER_POOL_SIZE = 500;
export const SCANNER_ENRICH_TOP_N = 250;
/** Ranked candidates passed to rule-based analyst (same slice as price-history enrichment). */
export const SCANNER_ANALYSIS_SLICE = 250;

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
   * Strategies that depend on real volume flow (Whale Flow, Volume Imbalance)
   * must gate on this flag — synthetic numbers produce direction-blind noise signals.
   */
  hasLiveData: boolean;
  /** Price dip/surge signal from recent snapshot history (null if insufficient data) */
  priceHistory?: PriceHistory | null;
  /** Scan-to-scan signed flow proxy (replay-style); only meaningful with live API volume. */
  replayFlowImbalance?: number;
  replayWhalePrint?: boolean;
}

// Sports markets rarely list games > 2 weeks out; non-sports (politics, crypto,
// economics) can run 30-90 days. 720 h (30 days) lets both through. The vol/liq
// floor in buildCandidateFromKalshi; tape strategies gate on hasLiveData.
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

const NON_SPORTS_CATEGORIES = [
  "Politics",
  "Economics",
  "Financials",
  "Entertainment",
  "Weather",
  "Crypto",
  "Finance",
  "Digital",
];

function isNonSportsCategory(candidate: ScanCandidate): boolean {
  const cat = candidate.market.category || "";
  return NON_SPORTS_CATEGORIES.some((nc) => cat.includes(nc));
}

/** True when we should keep tight liquidity/price floors (game markets only). */
function isStrictSportsLikeMarket(m: KalshiMarket): boolean {
  const cat = (m.category || "").toLowerCase();
  if (cat.includes("politic") || cat.includes("crypto") || cat.includes("economic")) return false;
  if (cat.includes("financial") && !cat.includes("sport")) return false;
  if (cat.includes("entertainment") || cat.includes("weather") || cat.includes("science")) return false;
  if (cat.includes("sport")) return true;
  return kalshiMarketBucket(m) === "Sports";
}

/** Coarse bucket for diversity quotas — prefer Kalshi API category, then ticker. */
function diversityQuotaBucketFromMarket(m: KalshiMarket): "Politics" | "Crypto" | "Economics" | "Other" | "Sports" {
  const cat = (m.category || "").toLowerCase();
  if (cat.includes("sport")) return "Sports";
  if (cat.includes("politic")) return "Politics";
  if (cat.includes("crypto") || cat.includes("digital")) return "Crypto";
  if (cat.includes("economic") || cat.includes("financial") || cat.includes("finance")) return "Economics";
  const b = kalshiMarketBucket(m);
  if (b === "Politics" || b === "Crypto" || b === "Economics") return b;
  if (b === "Sports") return "Sports";
  return "Other";
}

function diversityQuotaBucket(c: ScanCandidate): "Politics" | "Crypto" | "Economics" | "Other" | "Sports" {
  return diversityQuotaBucketFromMarket(c.market);
}

/** Backtest priority slice: Crypto + Politics + Other (excludes Economics for the 80–100 floor). */
function isPriorityBacktestBucketFromMarket(m: KalshiMarket): boolean {
  const d = diversityQuotaBucketFromMarket(m);
  return d === "Crypto" || d === "Politics" || d === "Other";
}

function compositeScore(candidate: ScanCandidate): number {
  const volNorm = Math.min(1, candidate.volume24h / 10000);
  const liqNorm = Math.min(1, candidate.liquidity / 50000);
  const proximity = proximityScore(candidate.hoursToExpiry);
  // Spread quality: tighter spreads = more efficient market = better execution
  const spreadQuality = Math.max(0, 1 - candidate.spread / 0.2);
  // Bonus for dip/surge signals — bump these up in priority
  const dipBonus = candidate.priceHistory?.isDip || candidate.priceHistory?.isSurge ? 0.8 : 0;
  // Non-sports bonus: category + ticker bucket so politics/crypto compete in ranking.
  const dq = diversityQuotaBucket(candidate);
  const nonSportsBonus =
    dq !== "Sports" && (candidate.volume24h > 50 || candidate.liquidity > 200) ? 2.5 : 0;
  const categoryBonus =
    isNonSportsCategory(candidate) && candidate.volume24h > 30 ? 0.4 : 0;
  const priorityMacroBonus = dq === "Crypto" || dq === "Politics" || dq === "Other" ? 2.2 : 0;
  const kxbtcdBonus = candidate.market.ticker.toUpperCase().startsWith("KXBTCD") ? 7.0 : 0;
  // Backtest: Pure Value on KXBTCD ~13–21¢ YES
  const btcSweetSpot =
    candidate.market.ticker.toUpperCase().startsWith("KXBTCD") &&
    candidate.yesPrice >= 0.11 &&
    candidate.yesPrice <= 0.21
      ? 3.0
      : 0;
  return (
    proximity * 3 +
    volNorm * 1.5 +
    liqNorm * 0.5 +
    spreadQuality * 0.5 +
    dipBonus +
    nonSportsBonus +
    categoryBonus +
    priorityMacroBonus +
    kxbtcdBonus +
    btcSweetSpot
  );
}

function buildCandidateFromKalshi(market: KalshiMarket): ScanCandidate | null {
  if (isExcludedKalshiStructuralJunk(market)) return null;
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

  const { imbalance, whalePrint } = updateLiveTapeFlow(market.ticker, yesPrice, volume24h);
  return {
    market,
    yesPrice,
    noPrice,
    yesAsk,
    noAsk,
    spread,
    volume24h,
    liquidity,
    hoursToExpiry,
    hasLiveData: true,
    replayFlowImbalance: imbalance,
    replayWhalePrint: whalePrint,
  };
}

/**
 * Relaxed pass for **Crypto / Politics / Other** only — widest price band, no vol/liq floor (backtest-aligned thin books).
 */
function buildCandidateRelaxedPriorityMacro(market: KalshiMarket): ScanCandidate | null {
  if (isExcludedKalshiStructuralJunk(market)) return null;
  if (isStrictSportsLikeMarket(market)) return null;
  if (!isPriorityBacktestBucketFromMarket(market)) return null;

  const now = new Date();
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  const yesPrice = getMarketYesPrice(market);
  if (!yesPrice || yesPrice < 0.015 || yesPrice > 0.985) return null;

  const noPrice = 1 - yesPrice;
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

  if (hoursToExpiry < 3 && yesPrice < 0.06 && volume24h < 1) return null;

  const { imbalance, whalePrint } = updateLiveTapeFlow(market.ticker, yesPrice, volume24h);
  return {
    market,
    yesPrice,
    noPrice,
    yesAsk,
    noAsk,
    spread,
    volume24h,
    liquidity,
    hoursToExpiry,
    hasLiveData: volume24h > 0 || liquidity >= 50,
    replayFlowImbalance: imbalance,
    replayWhalePrint: whalePrint,
  };
}

/**
 * Tighter relaxed pass for **Economics** (and any remaining non-sports macro not in priority buckets).
 */
function buildCandidateRelaxedEconomicsMacro(market: KalshiMarket): ScanCandidate | null {
  if (isExcludedKalshiStructuralJunk(market)) return null;
  if (isStrictSportsLikeMarket(market)) return null;
  if (isPriorityBacktestBucketFromMarket(market)) return null;

  const now = new Date();
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  const yesPrice = getMarketYesPrice(market);
  if (!yesPrice || yesPrice < 0.02 || yesPrice > 0.98) return null;

  const noPrice = 1 - yesPrice;
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

  if (volume24h === 0 && liquidity < 28) return null;
  if (hoursToExpiry < 4 && volume24h < 8 && liquidity < 80) return null;

  const { imbalance, whalePrint } = updateLiveTapeFlow(market.ticker, yesPrice, volume24h);
  return {
    market,
    yesPrice,
    noPrice,
    yesAsk,
    noAsk,
    spread,
    volume24h,
    liquidity,
    hoursToExpiry,
    hasLiveData: volume24h > 0 || liquidity >= 80,
    replayFlowImbalance: imbalance,
    replayWhalePrint: whalePrint,
  };
}

function isSportsCandidate(c: ScanCandidate): boolean {
  return diversityQuotaBucket(c) === "Sports";
}

/**
 * After a global score sort, the top 250 would be almost all sports. Pin up to
 * `maxNonSports` non-sports at the front of the pool so analyst + opportunities
 * DB include crypto/politics/economics when the universe has them.
 */
function reorderPoolWithDiverseAnalysisHead(pool: ScanCandidate[], maxNonSports: number): ScanCandidate[] {
  const sorted = [...pool].sort((a, b) => compositeScore(b) - compositeScore(a));
  const slice = SCANNER_ANALYSIS_SLICE;

  const nonSportsSorted = sorted.filter((c) => !isSportsCandidate(c));
  const takeNon = nonSportsSorted.slice(0, Math.min(maxNonSports, nonSportsSorted.length, slice));
  const taken = new Set(takeNon.map((c) => c.market.ticker));

  const sportsSorted = sorted.filter((c) => isSportsCandidate(c) && !taken.has(c.market.ticker));
  const needSports = slice - takeNon.length;
  const takeSports = sportsSorted.slice(0, Math.max(0, needSports));

  const head: ScanCandidate[] = [...takeNon, ...takeSports];
  if (head.length < slice) {
    const headIds = new Set(head.map((c) => c.market.ticker));
    for (const c of sorted) {
      if (head.length >= slice) break;
      if (!headIds.has(c.market.ticker)) {
        head.push(c);
        headIds.add(c.market.ticker);
      }
    }
  }

  const headIds = new Set(head.map((c) => c.market.ticker));
  const tail = sorted.filter((c) => !headIds.has(c.market.ticker));
  return [...head, ...tail].slice(0, SCANNER_POOL_SIZE);
}

async function scanFromCachedDb(): Promise<{ candidates: ScanCandidate[]; totalScanned: number }> {
  const now = new Date();
  const maxClose = new Date(now.getTime() + MAX_HOURS_TO_EXPIRY * 60 * 60 * 1000);

  const rows = await db
    .select()
    .from(historicalMarketsTable)
    .where(ne(historicalMarketsTable.status, "settled"))
    .orderBy(desc(historicalMarketsTable.snapshotAt))
    .limit(500);

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

    if (isExcludedKalshiStructuralJunk(market)) continue;

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
      hasLiveData: false,
      replayFlowImbalance: 0,
      replayWhalePrint: false,
    });
  }

  candidates.sort((a, b) => compositeScore(b) - compositeScore(a));
  const cap = Math.min(SCANNER_POOL_SIZE, candidates.length);
  return { candidates: candidates.slice(0, cap), totalScanned: rows.length };
}

/**
 * Enrich top candidates with price history only (Dip Buy + ranking dip bonus).
 * No external odds APIs — keepers use rule-based model + live tape + asks.
 */
async function enrichCandidates(candidates: ScanCandidate[]): Promise<void> {
  const toEnrich = candidates.slice(0, SCANNER_ENRICH_TOP_N);
  const tickers = toEnrich.map((c) => c.market.ticker);
  const priceHistories = await batchGetPriceHistory(tickers, 24).catch(() => new Map<string, PriceHistory>());
  for (const candidate of toEnrich) {
    candidate.priceHistory = priceHistories.get(candidate.market.ticker) ?? null;
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

    let strictOk = 0;
    let relaxedAdded = 0;
    for (const market of markets) {
      const sportsLike = isStrictSportsLikeMarket(market);
      let candidate = buildCandidateFromKalshi(market);
      if (candidate) strictOk++;
      else if (!sportsLike) {
        candidate = buildCandidateRelaxedPriorityMacro(market) ?? buildCandidateRelaxedEconomicsMacro(market);
        if (candidate) relaxedAdded++;
      }
      if (candidate) candidates.push(candidate);
    }

    console.info(
      `[Scanner] candidates: ${strictOk} strict + ${relaxedAdded} relaxed macro/non-sports → ${candidates.length} total from ${markets.length} markets`,
    );

    candidates.sort((a, b) => compositeScore(b) - compositeScore(a));

    /** Backtest slice: Crypto + Politics + Other in pool (Economics uses separate slots). */
    const PRIORITY_MACRO_MIN = 80;
    const PRIORITY_MACRO_CAP = 100;
    const MAX_NON_SPORTS_IN_POOL = 120;
    const MIN_NON_SPORTS_IN_POOL = 100;

    function sortPriorityQuotaPool(arr: ScanCandidate[]): ScanCandidate[] {
      return [...arr].sort((a, b) => {
        const ak = a.market.ticker.toUpperCase().startsWith("KXBTCD") ? 1 : 0;
        const bk = b.market.ticker.toUpperCase().startsWith("KXBTCD") ? 1 : 0;
        if (bk !== ak) return bk - ak;
        return compositeScore(b) - compositeScore(a);
      });
    }

    const priorityPool = sortPriorityQuotaPool(
      candidates.filter((c) => {
        const d = diversityQuotaBucket(c);
        return d === "Crypto" || d === "Politics" || d === "Other";
      }),
    );
    const econPool = candidates
      .filter((c) => diversityQuotaBucket(c) === "Economics")
      .sort((a, b) => compositeScore(b) - compositeScore(a));
    const sportsOnly = candidates.filter(isSportsCandidate).sort((a, b) => compositeScore(b) - compositeScore(a));

    let priorityTake: number;
    if (priorityPool.length >= PRIORITY_MACRO_CAP) priorityTake = PRIORITY_MACRO_CAP;
    else if (priorityPool.length >= PRIORITY_MACRO_MIN) priorityTake = priorityPool.length;
    else priorityTake = priorityPool.length;

    const pickedPriority = priorityPool.slice(0, priorityTake);
    const pickedIds = new Set(pickedPriority.map((c) => c.market.ticker));

    const roomForEcon = Math.max(0, MAX_NON_SPORTS_IN_POOL - pickedPriority.length);
    const pickedEcon = econPool.filter((c) => !pickedIds.has(c.market.ticker)).slice(0, roomForEcon);
    for (const c of pickedEcon) pickedIds.add(c.market.ticker);

    let pickedNon: ScanCandidate[] = [...pickedPriority, ...pickedEcon];

    if (pickedNon.length < MIN_NON_SPORTS_IN_POOL) {
      const filler = candidates
        .filter((c) => !isSportsCandidate(c) && !pickedIds.has(c.market.ticker))
        .sort((a, b) => compositeScore(b) - compositeScore(a));
      for (const c of filler) {
        if (pickedNon.length >= MIN_NON_SPORTS_IN_POOL || pickedNon.length >= MAX_NON_SPORTS_IN_POOL) break;
        pickedNon.push(c);
        pickedIds.add(c.market.ticker);
      }
    }

    if (pickedNon.length > MAX_NON_SPORTS_IN_POOL) {
      pickedNon = pickedNon.slice(0, MAX_NON_SPORTS_IN_POOL);
      pickedIds.clear();
      for (const c of pickedNon) pickedIds.add(c.market.ticker);
    }

    const needSports = SCANNER_POOL_SIZE - pickedNon.length;
    const sportsPart: ScanCandidate[] = [];
    for (const c of sportsOnly) {
      if (sportsPart.length >= needSports) break;
      if (!pickedIds.has(c.market.ticker)) sportsPart.push(c);
    }

    if (sportsPart.length < needSports) {
      const shortfall = needSports - sportsPart.length;
      const used = new Set<string>([...pickedIds, ...sportsPart.map((c) => c.market.ticker)]);
      const backfill = candidates
        .filter((c) => !used.has(c.market.ticker))
        .sort((a, b) => compositeScore(b) - compositeScore(a));
      sportsPart.push(...backfill.slice(0, shortfall));
    }

    const topCandidates = [...pickedNon, ...sportsPart].slice(0, SCANNER_POOL_SIZE);

    const nsInPool = topCandidates.filter((c) => !isSportsCandidate(c)).length;
    const spInPool = topCandidates.length - nsInPool;
    const bucketCounts = new Map<string, number>();
    for (const c of pickedNon) {
      const d = diversityQuotaBucket(c);
      bucketCounts.set(d, (bucketCounts.get(d) ?? 0) + 1);
    }
    const bucketLog = [...bucketCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
    const kxbtcdInPool = pickedNon.filter((c) => c.market.ticker.toUpperCase().startsWith("KXBTCD")).length;
    console.info(
      `[Scanner] Pool ${topCandidates.length}: priority C/P/O=${pickedPriority.length}/${priorityPool.length} avail, KXBTCD_in_nonSports=${kxbtcdInPool}, non-sports=${nsInPool} (buckets ${bucketLog || "—"}) | sports=${spInPool}`,
    );

    // If API returned nothing usable, fall through to the DB cache
    if (topCandidates.length === 0) {
      console.warn("[Scanner] API returned 0 valid candidates — falling back to cached market data");
      const cached = await scanFromCachedDb();
      return { ...cached, source: "cached" };
    }

    console.info(
      `[Scanner] Top ${topCandidates.length} candidates (pool≤${SCANNER_POOL_SIZE} + diversity). Enriching top ${SCANNER_ENRICH_TOP_N} with price history only...`,
    );

    // Persist snapshots to DB in small batches (best-effort warm cache)
    console.info(`[Scanner] Persisting ${topCandidates.length} snapshots to DB...`);
    try {
      const snapshots = topCandidates.map((c) => {
        // Store only compact metadata in rawData — omit large text fields (rules, descriptions)
        const { rules_primary: _r1, rules_secondary: _r2, ...compactMarket } =
          c.market as unknown as Record<string, unknown>;
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

    console.info(`[Scanner] Enriching candidates...`);
    await enrichCandidates(topCandidates).catch((e) => {
      console.warn(`[Scanner] Enrichment failed (non-fatal):`, (e as Error).message?.slice(0, 80));
    });

    const enrichSample = topCandidates.slice(0, 10).map((c) => {
      const ph = c.priceHistory ? `dip=${c.priceHistory.isDip}` : "no-ph";
      return `${c.market.ticker}(${ph})`;
    });
    console.info(`[Scanner] Enrichment done. ${topCandidates.length} candidates | sample: ${enrichSample.join("; ")}`);

    // Re-sort after enrichment so dip/surge signals bubble up
    topCandidates.sort((a, b) => compositeScore(b) - compositeScore(a));
    const ANALYSIS_HEAD_NON_SPORTS_MAX = 120;
    const finalCandidates = reorderPoolWithDiverseAnalysisHead(topCandidates, ANALYSIS_HEAD_NON_SPORTS_MAX);
    const nsHead = finalCandidates.slice(0, SCANNER_ANALYSIS_SLICE).filter((c) => !isSportsCandidate(c)).length;
    console.info(
      `[Scanner] Analysis slice (first ${SCANNER_ANALYSIS_SLICE}): non-sports=${nsHead} (cap ${ANALYSIS_HEAD_NON_SPORTS_MAX}) after diverse reorder`,
    );

    return { candidates: finalCandidates, totalScanned: markets.length, source: "live" };
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
