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
import { kalshiIsWeatherTicker, kalshiMarketBucket, kalshiSportBucket } from "@workspace/backtester";
import { rejectsWideBookForTrading } from "./execution-policy.js";

/**
 * Scanner sizing (live paper + future live) — **no Odds API / sharp lines**.
 * - **Pool 500**: **120–160** non-sports (Crypto + Weather first, then other macro); **sports fill remainder**.
 * - **Analysis 250**: **every** qualifying Crypto + Weather in this pool ordered ahead of sports; then other non-sports; then sports.
 * - Relaxed vol/liq **only** for Crypto/Politics/Other/Weather; Economics uses a tighter relaxed pass. **KXBTCD** boosted.
 * - **Enrich top 250**: price-history only (DB, batched 20 tickers → ~13 rounds).
 *
 * **Cycle budget:** Kalshi ~12–22s; persist 500 rows; enrich ~13 DB batches; analyst 250 ~2–6s.
 * **Target: full trading cycle under 40s** when Kalshi is healthy.
 */
export const SCANNER_POOL_SIZE = 500;
export const SCANNER_ENRICH_TOP_N = 250;
/** Ranked candidates passed to rule-based analyst (same slice as price-history enrichment). */
export const SCANNER_ANALYSIS_SLICE = 250;

/** DB-driven scanner weights (set at each `scanMarkets` entry). */
let scanPriorityCrypto = 2.5;
let scanPriorityWeather = 2.5;
/** Max YES bid–ask width (dollars) for scanner pre-filter; from DB `max_spread_cents`. */
let scanMaxSpreadDollars = 0.05;

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

function isCryptoScanCandidate(c: ScanCandidate): boolean {
  return diversityQuotaBucket(c) === "Crypto" || kalshiSportBucket(c.market.ticker) === "Crypto";
}

function isWeatherScanCandidate(c: ScanCandidate): boolean {
  const cat = (c.market.category || "").toLowerCase();
  return cat.includes("weather") || kalshiIsWeatherTicker(c.market.ticker);
}

/** Relaxed fetch: Crypto + Politics + Other (not Economics-only). */
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
  const cryptoW =
    (isCryptoScanCandidate(candidate) ? scanPriorityCrypto * 1.15 : 0) +
    (isWeatherScanCandidate(candidate) ? scanPriorityWeather * 1.15 : 0);
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
    btcSweetSpot +
    cryptoW
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
  const candidate: ScanCandidate = {
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
  if (rejectsWideBookForTrading(candidate, scanMaxSpreadDollars)) return null;
  return candidate;
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
  const candidate: ScanCandidate = {
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
  if (rejectsWideBookForTrading(candidate, scanMaxSpreadDollars)) return null;
  return candidate;
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
  const candidate: ScanCandidate = {
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
  if (rejectsWideBookForTrading(candidate, scanMaxSpreadDollars)) return null;
  return candidate;
}

function isSportsCandidate(c: ScanCandidate): boolean {
  return diversityQuotaBucket(c) === "Sports";
}

/**
 * First 250: all Crypto + Weather from this pool (score order), then other non-sports, then sports.
 * Tail: remaining tickers in score order (total length = SCANNER_POOL_SIZE).
 */
function reorderPoolCryptoWeatherAnalysisFirst(pool: ScanCandidate[]): ScanCandidate[] {
  const slice = SCANNER_ANALYSIS_SLICE;
  const byScore = (a: ScanCandidate, b: ScanCandidate) => compositeScore(b) - compositeScore(a);
  const sorted = [...pool].sort(byScore);

  const cw: ScanCandidate[] = [];
  const cwIds = new Set<string>();
  for (const c of sorted) {
    if (!isCryptoScanCandidate(c) && !isWeatherScanCandidate(c)) continue;
    if (cwIds.has(c.market.ticker)) continue;
    cw.push(c);
    cwIds.add(c.market.ticker);
  }
  cw.sort(byScore);

  const head: ScanCandidate[] = [];
  const seen = new Set<string>();
  for (const c of cw) {
    if (head.length >= slice) break;
    head.push(c);
    seen.add(c.market.ticker);
  }

  const restNonSports = sorted.filter((c) => !isSportsCandidate(c) && !seen.has(c.market.ticker));
  for (const c of restNonSports) {
    if (head.length >= slice) break;
    head.push(c);
    seen.add(c.market.ticker);
  }

  const sportsSorted = sorted.filter((c) => isSportsCandidate(c) && !seen.has(c.market.ticker));
  for (const c of sportsSorted) {
    if (head.length >= slice) break;
    head.push(c);
    seen.add(c.market.ticker);
  }

  if (head.length < slice) {
    for (const c of sorted) {
      if (head.length >= slice) break;
      if (seen.has(c.market.ticker)) continue;
      head.push(c);
      seen.add(c.market.ticker);
    }
  }

  const tail = sorted.filter((c) => !seen.has(c.market.ticker));
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
  const pool = candidates.slice(0, cap);
  return { candidates: reorderPoolCryptoWeatherAnalysisFirst(pool), totalScanned: rows.length };
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
export async function scanMarkets(
  _sportFilters?: string[],
  priorityWeights?: { crypto?: number; weather?: number; maxSpreadCents?: number },
): Promise<{
  candidates: ScanCandidate[];
  totalScanned: number;
  source: "live" | "cached";
}> {
  try {
    scanPriorityCrypto = Math.max(0.5, priorityWeights?.crypto ?? 2.5);
    scanPriorityWeather = Math.max(0.5, priorityWeights?.weather ?? 2.5);
    scanMaxSpreadDollars = Math.max(0.01, (priorityWeights?.maxSpreadCents ?? 5) / 100);

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

    const byScore = (a: ScanCandidate, b: ScanCandidate) => compositeScore(b) - compositeScore(a);
    candidates.sort(byScore);

    const MIN_NON_SPORTS_IN_POOL = 140;
    const MAX_NON_SPORTS_IN_POOL = 170;

    const cryptoList = candidates.filter(isCryptoScanCandidate).sort(byScore);
    const weatherOnly = candidates
      .filter((c) => isWeatherScanCandidate(c) && !isCryptoScanCandidate(c))
      .sort(byScore);
    const cwMerged: ScanCandidate[] = [];
    const cwSeen = new Set<string>();
    for (const c of [...cryptoList, ...weatherOnly]) {
      if (cwSeen.has(c.market.ticker)) continue;
      cwSeen.add(c.market.ticker);
      cwMerged.push(c);
    }
    cwMerged.sort(byScore);

    const pickedNon: ScanCandidate[] = [];
    const pickedIds = new Set<string>();
    for (const c of cwMerged) {
      if (pickedNon.length >= MAX_NON_SPORTS_IN_POOL) break;
      pickedNon.push(c);
      pickedIds.add(c.market.ticker);
    }

    const otherNon = candidates
      .filter((c) => !isSportsCandidate(c) && !pickedIds.has(c.market.ticker))
      .sort(byScore);

    if (pickedNon.length < MIN_NON_SPORTS_IN_POOL) {
      for (const c of otherNon) {
        if (pickedNon.length >= MIN_NON_SPORTS_IN_POOL || pickedNon.length >= MAX_NON_SPORTS_IN_POOL) break;
        pickedNon.push(c);
        pickedIds.add(c.market.ticker);
      }
    }

    for (const c of otherNon) {
      if (pickedNon.length >= MAX_NON_SPORTS_IN_POOL) break;
      if (pickedIds.has(c.market.ticker)) continue;
      pickedNon.push(c);
      pickedIds.add(c.market.ticker);
    }

    const sportsOnly = candidates.filter(isSportsCandidate).sort(byScore);
    const needSports = SCANNER_POOL_SIZE - pickedNon.length;
    const sportsPart: ScanCandidate[] = [];
    for (const c of sportsOnly) {
      if (sportsPart.length >= needSports) break;
      if (!pickedIds.has(c.market.ticker)) sportsPart.push(c);
    }

    if (sportsPart.length < needSports) {
      const shortfall = needSports - sportsPart.length;
      const used = new Set<string>([...pickedIds, ...sportsPart.map((x) => x.market.ticker)]);
      const backfill = candidates
        .filter((c) => !used.has(c.market.ticker))
        .sort((a, b) => compositeScore(b) - compositeScore(a));
      sportsPart.push(...backfill.slice(0, shortfall));
    }

    const topCandidates = [...pickedNon, ...sportsPart].slice(0, SCANNER_POOL_SIZE);

    const nCrypto = topCandidates.filter(isCryptoScanCandidate).length;
    const nWeather = topCandidates.filter((c) => isWeatherScanCandidate(c) && !isCryptoScanCandidate(c)).length;
    const nSp = topCandidates.filter(isSportsCandidate).length;
    console.info(
      `[Scanner] Priority inclusion: Crypto=${nCrypto} | Weather=${nWeather} | Sports=${nSp} | Total pool ${topCandidates.length}`,
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
    const finalCandidates = reorderPoolCryptoWeatherAnalysisFirst(topCandidates);
    const nsHead = finalCandidates.slice(0, SCANNER_ANALYSIS_SLICE).filter((c) => !isSportsCandidate(c)).length;
    const cwHead = finalCandidates
      .slice(0, SCANNER_ANALYSIS_SLICE)
      .filter((c) => isCryptoScanCandidate(c) || isWeatherScanCandidate(c)).length;
    console.info(
      `[Scanner] Analysis slice (first ${SCANNER_ANALYSIS_SLICE}): crypto+weather=${cwHead} | non-sports=${nsHead} (Crypto+Weather ordered before sports)`,
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
