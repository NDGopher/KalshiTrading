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
import {
  kalshiIsMentionTicker,
  kalshiIsWeatherTicker,
  kalshiMarketBucket,
  kalshiSportBucket,
} from "@workspace/backtester";
import { rejectsWideBookForTrading } from "./execution-policy.js";

/**
 * Scanner sizing (live paper + future live) — **no Odds API / sharp lines**.
 * - **Pool 700**: **160–200** non-sports (Weather → Politics → Mention → Crypto, then other macro); **sports fill remainder**.
 * - **Analysis 400**: same high-priority category order at the front of the slice; then other non-sports; then sports.
 * - `isHighPriorityCategory`: explicit KXHIGH/mentions/WTI/gas + ticker/event/series keywords (incl. gas price); strict 10–90¢, $50 liq, ghost 4h/10vol/$100 for all; structural junk bypass = explicit macros **or** same keyword set (not category); **5¢ spread** unchanged.
 * - Relaxed vol/liq for Crypto/Politics/Mention/Weather/Other; Economics uses a tighter relaxed pass. **KXBTCD** boosted.
 * - **Enrich top 400**: price-history only (DB, batched 20 tickers).
 *
 * **Cycle budget:** wider universe + fast pipeline (~20s observed); target full cycle **under 40s**.
 */
export const SCANNER_POOL_SIZE = 700;
export const SCANNER_ENRICH_TOP_N = 400;
/** Ranked candidates passed to rule-based analyst (same slice as price-history enrichment). */
export const SCANNER_ANALYSIS_SLICE = 400;

/** DB-driven scanner weights (set at each `scanMarkets` entry). */
let scanPriorityCrypto = 3.2;
let scanPriorityWeather = 3.2;
let scanPriorityPolitics = 3.2;
let scanPriorityMention = 3.2;
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
  "Mentions",
  "Mention",
];

function mentionFromMarket(m: KalshiMarket): boolean {
  if (kalshiIsMentionTicker(m.ticker)) return true;
  const et = m.event_ticker;
  const st = m.series_ticker;
  if (et && kalshiIsMentionTicker(et)) return true;
  if (st && kalshiIsMentionTicker(st)) return true;
  const cat = (m.category || "").toLowerCase();
  if (cat.includes("mention")) return true;
  return false;
}

/** Uppercase ticker / event / series triple for prefix checks. */
function marketTickerTripleUpper(m: KalshiMarket): [string, string, string] {
  return [(m.ticker || "").toUpperCase(), (m.event_ticker || "").toUpperCase(), (m.series_ticker || "").toUpperCase()];
}

/** KXHIGH* climate bins (backtest-heavy); not matched by kalshiIsWeatherTicker alone. */
function isKxHighClimateSeries(m: KalshiMarket): boolean {
  return marketTickerTripleUpper(m).some((s) => s.startsWith("KXHIGH"));
}

/** Weather heuristics on market ticker, event_ticker, and series_ticker. */
function weatherSignalsMarket(m: KalshiMarket): boolean {
  if (isKxHighClimateSeries(m)) return true;
  if (kalshiIsWeatherTicker(m.ticker)) return true;
  const et = m.event_ticker || "";
  const st = m.series_ticker || "";
  if (et && kalshiIsWeatherTicker(et)) return true;
  if (st && kalshiIsWeatherTicker(st)) return true;
  return false;
}

/**
 * Backtest-style macro tickers: KXHIGH*, mentions, WTI, AAA gas.
 * Runs before bucket/category so opaque child tickers still get HP floors.
 */
function explicitHighVolumeMacroHp(m: KalshiMarket): HpClassification | null {
  const parts = marketTickerTripleUpper(m);
  if (parts.some((s) => s.startsWith("KXHIGH"))) return { hp: true, reason: "explicit_KXHIGH" };
  const mentionRoots = [
    "KXTRUMPMENTION",
    "KXMENTION",
    "KXINMENTION",
    "KXCORPMENTION",
    "KXSTOCKMENTION",
  ];
  for (const root of mentionRoots) {
    if (parts.some((s) => s.startsWith(root) || s.includes(root)))
      return { hp: true, reason: `explicit_${root}` };
  }
  if (parts.some((s) => s.startsWith("KXWTIW") || s.startsWith("KXWTI")))
    return { hp: true, reason: "explicit_KXWTI" };
  if (parts.some((s) => s.startsWith("KXAAAGASD"))) return { hp: true, reason: "explicit_KXAAAGASD" };
  return null;
}

/** Ticker + event + series (lowercase) — macro keyword HP + junk bypass use the same surface. */
function macroTickerEventSeriesBlobLower(m: KalshiMarket): string {
  return `${m.ticker || ""} ${m.event_ticker || ""} ${m.series_ticker || ""}`.toLowerCase();
}

/** Substrings for backtest-style macro HP classification and structural-junk bypass (ticker/event/series only). */
const MACRO_HP_SUBSTRING_KEYWORDS = [
  "election",
  "president",
  "climate",
  "temperature",
  "forecast",
  "mention",
  "earnings",
  "gas price",
  "gasprice",
] as const;

/** Keyword macro HP — skipped for strict sports so NFL/NBA volume is unchanged. */
function politicsKeywordMacroBlob(m: KalshiMarket): boolean {
  if (isStrictSportsLikeMarket(m)) return false;
  const blob = macroTickerEventSeriesBlobLower(m);
  return blob.includes("election") || blob.includes("president");
}

/** TRUMPMENTION / corp mention series on opaque child tickers — Raw pass Mention tier. */
function explicitMentionTierBlob(m: KalshiMarket): boolean {
  const u = `${m.ticker || ""}${m.event_ticker || ""}${m.series_ticker || ""}`.toUpperCase();
  return (
    u.includes("TRUMPMENTION") ||
    u.includes("KXMENTION") ||
    u.includes("KXINMENTION") ||
    u.includes("KXCORPMENTION") ||
    u.includes("KXSTOCKMENTION")
  );
}

function keywordSubstringMacroHp(m: KalshiMarket): HpClassification | null {
  if (isStrictSportsLikeMarket(m)) return null;
  const blob = macroTickerEventSeriesBlobLower(m);
  for (const k of MACRO_HP_SUBSTRING_KEYWORDS) {
    if (blob.includes(k)) return { hp: true, reason: `keyword_${k.replace(/\s+/g, "_")}` };
  }
  return null;
}

/** Mention heuristics including explicit series/event ticker patterns. */
function mentionSignalsMarket(m: KalshiMarket): boolean {
  if (mentionFromMarket(m)) return true;
  const et = m.event_ticker || "";
  const st = m.series_ticker || "";
  if (et && kalshiIsMentionTicker(et)) return true;
  if (st && kalshiIsMentionTicker(st)) return true;
  return false;
}

function isNonSportsCategory(candidate: ScanCandidate): boolean {
  const cat = candidate.market.category || "";
  return NON_SPORTS_CATEGORIES.some((nc) => cat.includes(nc));
}

/** True when we should keep tight liquidity/price floors (game markets only). */
function isStrictSportsLikeMarket(m: KalshiMarket): boolean {
  const cat = (m.category || "").toLowerCase();
  if (kalshiIsWeatherTicker(m.ticker)) return false;
  if (mentionFromMarket(m)) return false;
  if (cat.includes("politic") || cat.includes("crypto") || cat.includes("economic")) return false;
  if (cat.includes("financial") && !cat.includes("sport")) return false;
  if (cat.includes("entertainment") || cat.includes("weather") || cat.includes("science")) return false;
  if (cat.includes("sport")) return true;
  return kalshiMarketBucket(m) === "Sports";
}

/** Coarse bucket for diversity quotas — prefer Kalshi API category, then ticker. */
function diversityQuotaBucketFromMarket(m: KalshiMarket): "Politics" | "Crypto" | "Economics" | "Mention" | "Other" | "Sports" {
  const cat = (m.category || "").toLowerCase();
  if (cat.includes("sport")) return "Sports";
  if (mentionFromMarket(m)) return "Mention";
  if (cat.includes("politic")) return "Politics";
  if (cat.includes("crypto") || cat.includes("digital")) return "Crypto";
  if (cat.includes("economic") || cat.includes("financial") || cat.includes("finance")) return "Economics";
  const b = kalshiMarketBucket(m);
  if (b === "Politics" || b === "Crypto" || b === "Economics" || b === "Mention") return b;
  if (b === "Sports") return "Sports";
  return "Other";
}

function diversityQuotaBucket(c: ScanCandidate): "Politics" | "Crypto" | "Economics" | "Mention" | "Other" | "Sports" {
  return diversityQuotaBucketFromMarket(c.market);
}

/**
 * Per-market HP decision + stable reason string (for `[Scanner] HP classify` logs).
 * Spread cap (`rejectsWideBookForTrading`) stays strict for every market.
 */
export type HpClassification = { hp: boolean; reason: string };

/** Cleared after each `scanMarkets` live pass so `classifyHpMarket` stays O(1) per ticker. */
let hpClassifyCache: Map<string, HpClassification> | null = null;

function classifyHpMarketImpl(market: KalshiMarket): HpClassification {
  const ex = explicitHighVolumeMacroHp(market);
  if (ex) return ex;
  const kw = keywordSubstringMacroHp(market);
  if (kw) return kw;

  if (weatherSignalsMarket(market)) return { hp: true, reason: "weather_ticker_or_series" };
  if (mentionSignalsMarket(market)) return { hp: true, reason: "mention_market" };

  const mb = kalshiMarketBucket(market);
  if (mb === "Politics") return { hp: true, reason: "kalshiMarketBucket_politics" };
  if (mb === "Crypto") return { hp: true, reason: "kalshiMarketBucket_crypto" };
  if (mb === "Mention") return { hp: true, reason: "kalshiMarketBucket_mention" };

  const cat = (market.category || "").toLowerCase();
  if (
    cat.includes("weather") ||
    cat.includes("climate") ||
    cat.includes("temperature") ||
    cat.includes("forecast")
  ) {
    return { hp: true, reason: "category_weather" };
  }
  if (cat.includes("politic")) return { hp: true, reason: "category_politics" };
  if (cat.includes("mention")) return { hp: true, reason: "category_mention" };
  if (cat.includes("crypto") || cat.includes("digital")) return { hp: true, reason: "category_crypto" };

  if (isStrictSportsLikeMarket(market)) return { hp: false, reason: "sports_like_excluded" };

  const d = diversityQuotaBucketFromMarket(market);
  if (d === "Politics") return { hp: true, reason: "diversityQuota_politics" };
  if (d === "Mention") return { hp: true, reason: "diversityQuota_mention" };
  if (d === "Crypto") return { hp: true, reason: "diversityQuota_crypto" };
  return { hp: false, reason: `not_hp_diversity=${d}` };
}

export function classifyHpMarket(market: KalshiMarket): HpClassification {
  const key = market.ticker;
  if (hpClassifyCache) {
    const hit = hpClassifyCache.get(key);
    if (hit) return hit;
    const v = classifyHpMarketImpl(market);
    hpClassifyCache.set(key, v);
    return v;
  }
  return classifyHpMarketImpl(market);
}

export function isHighPriorityCategory(market: KalshiMarket): boolean {
  return classifyHpMarket(market).hp;
}

/**
 * Structural junk bypass: explicit KXHIGH/mentions/WTI/gas tickers **or** same macro substring keywords
 * on ticker/event/series (not category). Strict sports unchanged — no bypass.
 */
function scannerStructuralJunkBypassKnownGoodMacros(m: KalshiMarket): boolean {
  if (explicitHighVolumeMacroHp(m) != null) return true;
  if (isStrictSportsLikeMarket(m)) return false;
  const blob = macroTickerEventSeriesBlobLower(m);
  return MACRO_HP_SUBSTRING_KEYWORDS.some((k) => blob.includes(k));
}

function isStructuralJunkForScanner(m: KalshiMarket): boolean {
  if (scannerStructuralJunkBypassKnownGoodMacros(m)) return false;
  return isExcludedKalshiStructuralJunk(m);
}

/** Per-scan counters: HP markets surviving each strict-path gate (aggregate over universe). */
interface HpStrictFunnelSnapshot {
  attempts: number;
  afterJunk: number;
  afterBand: number;
  afterExpiry: number;
  afterLowLiq: number;
  afterGhost: number;
  afterSpread: number;
}

function createHpStrictFunnel(): HpStrictFunnelSnapshot {
  return {
    attempts: 0,
    afterJunk: 0,
    afterBand: 0,
    afterExpiry: 0,
    afterLowLiq: 0,
    afterGhost: 0,
    afterSpread: 0,
  };
}

/** Every strict-path failure for an HP market (no sports noise). */
function logScannerDroppedEarly(market: KalshiMarket, reason: string): void {
  if (!classifyHpMarket(market).hp) return;
  const cat = market.category ?? "";
  const dq = diversityQuotaBucketFromMarket(market);
  const kb = kalshiMarketBucket(market);
  console.info(
    `[Scanner] Dropped early: ticker=${market.ticker} category=${cat} bucket=${dq}/${kb} reason=${reason}`,
  );
}

function isCryptoScanCandidate(c: ScanCandidate): boolean {
  return diversityQuotaBucket(c) === "Crypto" || kalshiSportBucket(c.market.ticker) === "Crypto";
}

function isWeatherScanCandidate(c: ScanCandidate): boolean {
  const cat = (c.market.category || "").toLowerCase();
  return (
    cat.includes("weather") ||
    cat.includes("climate") ||
    cat.includes("temperature") ||
    cat.includes("forecast") ||
    weatherSignalsMarket(c.market)
  );
}

/** Relaxed fetch: Crypto + Politics + Mention + Weather + Other (not Economics-only). */
function isPriorityBacktestBucketFromMarket(m: KalshiMarket): boolean {
  if (explicitHighVolumeMacroHp(m) != null) return true;
  if (weatherSignalsMarket(m)) return true;
  const cat = (m.category || "").toLowerCase();
  if (
    cat.includes("weather") ||
    cat.includes("climate") ||
    cat.includes("temperature") ||
    cat.includes("forecast")
  ) {
    return true;
  }
  if (mentionFromMarket(m)) return true;
  const d = diversityQuotaBucketFromMarket(m);
  return d === "Crypto" || d === "Politics" || d === "Mention" || d === "Other";
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
  const priorityMacroBonus =
    dq === "Crypto" || dq === "Politics" || dq === "Mention" || dq === "Other" ? 2.2 : 0;
  const politicsW = dq === "Politics" ? scanPriorityPolitics * 1.18 : 0;
  const mentionW =
    dq === "Mention" || mentionFromMarket(candidate.market) ? scanPriorityMention * 1.22 : 0;
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
    (isWeatherScanCandidate(candidate) ? scanPriorityWeather * 1.2 : 0);
  /** Large ranking boost so macro markets survive the 700 pool vs sports volume. */
  const tierRankBoost =
    (isWeatherPriorityCandidate(candidate) ? 32 : 0) +
    (isPoliticsPriorityCandidate(candidate) ? 28 : 0) +
    (isMentionPriorityCandidate(candidate) ? 28 : 0) +
    (isCryptoPriorityCandidate(candidate) ? 22 : 0);
  return (
    proximity * 3 +
    volNorm * 1.5 +
    liqNorm * 0.5 +
    spreadQuality * 0.5 +
    dipBonus +
    nonSportsBonus +
    categoryBonus +
    priorityMacroBonus +
    politicsW +
    mentionW +
    kxbtcdBonus +
    btcSweetSpot +
    cryptoW +
    tierRankBoost
  );
}

function buildCandidateFromKalshi(
  market: KalshiMarket,
  hpFunnel?: HpStrictFunnelSnapshot,
): ScanCandidate | null {
  const hp = isHighPriorityCategory(market);
  if (hp && hpFunnel) hpFunnel.attempts++;

  if (isStructuralJunkForScanner(market)) {
    logScannerDroppedEarly(market, "excluded");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterJunk++;

  const now = new Date();
  const rawAsk = getMarketYesAsk(market);
  const rawBid = getMarketYesBid(market);
  // Live order book midpoint — NOT stale last_price
  const yesPrice = getMarketYesPrice(market);
  // Hard floor: < 10¢ or > 90¢ means the market has already priced in the outcome
  // (or the game is over and we'd be betting into near-certain settled contracts).
  // We have zero information advantage at the extremes — skip entirely.
  // Same interior YES band for all markets (HP = classification + pool order only, not looser quotes).
  const yesLo = 0.1;
  const yesHi = 0.9;
  if (!yesPrice || yesPrice < yesLo || yesPrice > yesHi) {
    logScannerDroppedEarly(market, "narrow_band");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterBand++;

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

  if (hoursToExpiry < 0.5) {
    logScannerDroppedEarly(market, "expiry");
    return null;
  }
  if (hoursToExpiry > MAX_HOURS_TO_EXPIRY) {
    logScannerDroppedEarly(market, "expiry");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterExpiry++;

  // Liquidity floor: markets with zero volume AND under $50 liquidity have no
  // real price discovery signal — skip them regardless of category (same for HP).
  if (volume24h === 0 && liquidity < 50) {
    logScannerDroppedEarly(market, "low_liquidity");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterLowLiq++;

  // Near-expiry illiquid ghost markets — same threshold for HP and non-HP.
  if (hoursToExpiry < 4 && volume24h < 10 && liquidity < 100) {
    logScannerDroppedEarly(market, "ghost");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterGhost++;

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
  if (rejectsWideBookForTrading(candidate, scanMaxSpreadDollars)) {
    logScannerDroppedEarly(market, "spread");
    return null;
  }
  if (hp && hpFunnel) hpFunnel.afterSpread++;
  return candidate;
}

/**
 * Relaxed pass for **Crypto / Politics / Other** only — widest price band, no vol/liq floor (backtest-aligned thin books).
 */
function buildCandidateRelaxedPriorityMacro(market: KalshiMarket): ScanCandidate | null {
  if (isStructuralJunkForScanner(market)) return null;
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
  if (isStructuralJunkForScanner(market)) return null;
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

function isWeatherPriorityCandidate(c: ScanCandidate): boolean {
  return !isSportsCandidate(c) && isWeatherScanCandidate(c);
}

function isPoliticsPriorityCandidate(c: ScanCandidate): boolean {
  if (isSportsCandidate(c)) return false;
  if (diversityQuotaBucket(c) === "Politics") return true;
  if (kalshiMarketBucket(c.market) === "Politics") return true;
  return politicsKeywordMacroBlob(c.market);
}

function isMentionPriorityCandidate(c: ScanCandidate): boolean {
  if (isSportsCandidate(c)) return false;
  if (diversityQuotaBucket(c) === "Mention") return true;
  if (mentionFromMarket(c.market)) return true;
  return explicitMentionTierBlob(c.market);
}

function isCryptoPriorityCandidate(c: ScanCandidate): boolean {
  return isCryptoScanCandidate(c) && !isSportsCandidate(c);
}

/** Lower auditor / keeper edge floor (pp) for Weather, Politics, Mention, Crypto only — sports stay at DB minEdge. */
export const PRIORITY_MACRO_AUDIT_MIN_EDGE_PP = 4.5;

const MIN_WEATHER_ANALYSIS_SLICE = 60;
const MIN_POLITICS_ANALYSIS_SLICE = 40;
const MIN_MENTION_ANALYSIS_SLICE = 30;
const MIN_CRYPTO_ANALYSIS_SLICE = 50;

export function isPriorityMacroAuditEdgeCandidate(c: ScanCandidate): boolean {
  if (isSportsCandidate(c)) return false;
  return (
    isWeatherPriorityCandidate(c) ||
    isPoliticsPriorityCandidate(c) ||
    isMentionPriorityCandidate(c) ||
    isCryptoPriorityCandidate(c)
  );
}

/**
 * Analysis slice: reserve up to 60/40/30/50 (when available) for Weather / Politics / Mention / Crypto by score,
 * then fill remaining slots in tier order, then other non-sports, then sports. Tail = rest of pool.
 */
function reorderPoolHighPriorityCategoriesFirst(pool: ScanCandidate[]): ScanCandidate[] {
  const slice = SCANNER_ANALYSIS_SLICE;
  const byScore = (a: ScanCandidate, b: ScanCandidate) => compositeScore(b) - compositeScore(a);
  const sorted = [...pool].sort(byScore);

  const weatherAll = pool.filter(isWeatherPriorityCandidate).sort(byScore);
  const politicsAll = pool.filter(isPoliticsPriorityCandidate).sort(byScore);
  const mentionAll = pool.filter(isMentionPriorityCandidate).sort(byScore);
  const cryptoAll = pool.filter(isCryptoPriorityCandidate).sort(byScore);

  const head: ScanCandidate[] = [];
  const seen = new Set<string>();

  const pushMinFromTier = (tier: ScanCandidate[], minWant: number) => {
    let taken = 0;
    for (const c of tier) {
      if (head.length >= slice) return;
      if (taken >= minWant) break;
      if (seen.has(c.market.ticker)) continue;
      head.push(c);
      seen.add(c.market.ticker);
      taken++;
    }
  };

  pushMinFromTier(weatherAll, MIN_WEATHER_ANALYSIS_SLICE);
  pushMinFromTier(politicsAll, MIN_POLITICS_ANALYSIS_SLICE);
  pushMinFromTier(mentionAll, MIN_MENTION_ANALYSIS_SLICE);
  pushMinFromTier(cryptoAll, MIN_CRYPTO_ANALYSIS_SLICE);

  const fillRestOfMacroTiers = () => {
    for (const tier of [weatherAll, politicsAll, mentionAll, cryptoAll]) {
      for (const c of tier) {
        if (head.length >= slice) return;
        if (seen.has(c.market.ticker)) continue;
        head.push(c);
        seen.add(c.market.ticker);
      }
    }
  };
  fillRestOfMacroTiers();

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
    .limit(1200);

  const seen = new Set<string>();
  const candidates: ScanCandidate[] = [];

  for (const row of rows) {
    if (seen.has(row.kalshiTicker)) continue;
    seen.add(row.kalshiTicker);

    const price = row.lastPrice || 0;
    if (!price) continue;

    const marketForHp: KalshiMarket = {
      ...(row.rawData as object),
      ticker: row.kalshiTicker,
      title: row.title || row.kalshiTicker,
      category: row.category || "Unknown",
    } as KalshiMarket;
    if (price < 0.1 || price > 0.9) continue;

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
      ...marketForHp,
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

    if (isStructuralJunkForScanner(market)) continue;

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
  return { candidates: reorderPoolHighPriorityCategoriesFirst(pool), totalScanned: rows.length };
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
  priorityWeights?: {
    crypto?: number;
    weather?: number;
    politics?: number;
    mention?: number;
    maxSpreadCents?: number;
  },
): Promise<{
  candidates: ScanCandidate[];
  totalScanned: number;
  source: "live" | "cached";
}> {
  try {
    scanPriorityCrypto = Math.max(0.5, priorityWeights?.crypto ?? 3.2);
    scanPriorityWeather = Math.max(0.5, priorityWeights?.weather ?? 3.2);
    scanPriorityPolitics = Math.max(0.5, priorityWeights?.politics ?? 3.2);
    scanPriorityMention = Math.max(0.5, priorityWeights?.mention ?? 3.2);
    scanMaxSpreadDollars = Math.max(0.01, (priorityWeights?.maxSpreadCents ?? 5) / 100);

    // Fetch all markets across ALL categories — no volume pre-filter
    const markets = await getAllLiquidMarkets(10);
    hpClassifyCache = new Map();
    const candidates: ScanCandidate[] = [];
    const hpFunnel = createHpStrictFunnel();
    const hpUniverse = markets.filter((m) => isHighPriorityCategory(m)).length;

    let strictOk = 0;
    let relaxedAdded = 0;
    let hpStrictPass = 0;
    let hpRelaxedPass = 0;
    for (const market of markets) {
      const cl = classifyHpMarket(market);
      const ev = (market.event_ticker ?? "").replace(/\|/g, "/").slice(0, 120);
      const se = (market.series_ticker ?? "").replace(/\|/g, "/").slice(0, 120);
      const catLog = (market.category ?? "").slice(0, 100);
      console.info(
        `[Scanner] HP classify: ticker=${market.ticker} event=${ev} series=${se} category=${catLog} classified_as_HP=${cl.hp} reason=${cl.reason}`,
      );
      const sportsLike = isStrictSportsLikeMarket(market);
      const hpM = cl.hp;
      let candidate = buildCandidateFromKalshi(market, hpFunnel);
      if (candidate) {
        strictOk++;
        if (hpM) hpStrictPass++;
      } else if (!sportsLike) {
        candidate = buildCandidateRelaxedPriorityMacro(market) ?? buildCandidateRelaxedEconomicsMacro(market);
        if (candidate) {
          relaxedAdded++;
          if (hpM) hpRelaxedPass++;
        }
      }
      if (candidate) candidates.push(candidate);
    }

    const hpInPool = candidates.filter((c) => isHighPriorityCategory(c.market)).length;
    console.info(
      `[Scanner] HP strict funnel: universe=${hpUniverse} attempts=${hpFunnel.attempts} afterJunk=${hpFunnel.afterJunk} afterBand=${hpFunnel.afterBand} afterExpiry=${hpFunnel.afterExpiry} afterLowLiq=${hpFunnel.afterLowLiq} afterGhost=${hpFunnel.afterGhost} afterSpread=${hpFunnel.afterSpread}`,
    );
    console.info(
      `[Scanner] HP candidates: strict_ok=${hpStrictPass} relaxed_ok=${hpRelaxedPass} in_raw_pool=${hpInPool}`,
    );

    console.info(
      `[Scanner] candidates: ${strictOk} strict + ${relaxedAdded} relaxed macro/non-sports → ${candidates.length} total from ${markets.length} markets`,
    );
    const rawW = candidates.filter(isWeatherPriorityCandidate).length;
    const rawP = candidates.filter(isPoliticsPriorityCandidate).length;
    const rawM = candidates.filter(isMentionPriorityCandidate).length;
    const rawC = candidates.filter(isCryptoPriorityCandidate).length;
    const rawS = candidates.filter(isSportsCandidate).length;
    console.info(
      `[Scanner] Raw pass (pre-pool): Weather=${rawW} | Politics=${rawP} | Mention=${rawM} | Crypto=${rawC} | Sports=${rawS} | Total candidates=${candidates.length} | Scanned markets=${markets.length}`,
    );

    const byScore = (a: ScanCandidate, b: ScanCandidate) => compositeScore(b) - compositeScore(a);
    candidates.sort(byScore);

    const MIN_NON_SPORTS_IN_POOL = 160;
    const MAX_NON_SPORTS_IN_POOL = 200;

    const weatherList = candidates.filter(isWeatherPriorityCandidate).sort(byScore);
    const politicsList = candidates.filter(isPoliticsPriorityCandidate).sort(byScore);
    const mentionList = candidates.filter(isMentionPriorityCandidate).sort(byScore);
    const cryptoList = candidates.filter(isCryptoPriorityCandidate).sort(byScore);

    const pickedNon: ScanCandidate[] = [];
    const pickedIds = new Set<string>();
    const pickTier = (list: ScanCandidate[]) => {
      for (const c of list) {
        if (pickedNon.length >= MAX_NON_SPORTS_IN_POOL) return;
        if (pickedIds.has(c.market.ticker)) continue;
        pickedNon.push(c);
        pickedIds.add(c.market.ticker);
      }
    };
    pickTier(weatherList);
    pickTier(politicsList);
    pickTier(mentionList);
    pickTier(cryptoList);

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

    const nWeather = topCandidates.filter(isWeatherPriorityCandidate).length;
    const nPolitics = topCandidates.filter(isPoliticsPriorityCandidate).length;
    const nMention = topCandidates.filter(isMentionPriorityCandidate).length;
    const nCrypto = topCandidates.filter(isCryptoPriorityCandidate).length;
    const nSp = topCandidates.filter(isSportsCandidate).length;
    console.info(
      `[Scanner] Priority inclusion: Weather=${nWeather} | Politics=${nPolitics} | Mention=${nMention} | Crypto=${nCrypto} | Sports=${nSp} | Pool size=${topCandidates.length} | Pre-pool candidates=${candidates.length}`,
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
    const finalCandidates = reorderPoolHighPriorityCategoriesFirst(topCandidates);
    const head = finalCandidates.slice(0, SCANNER_ANALYSIS_SLICE);
    const nsHead = head.filter((c) => !isSportsCandidate(c)).length;
    const sliceLine = `Weather=${head.filter(isWeatherPriorityCandidate).length} | Politics=${head.filter(isPoliticsPriorityCandidate).length} | Mention=${head.filter(isMentionPriorityCandidate).length} | Crypto=${head.filter(isCryptoPriorityCandidate).length} | Sports=${head.filter(isSportsCandidate).length}`;
    console.info(
      `[Scanner] Analysis slice (first ${SCANNER_ANALYSIS_SLICE}): ${sliceLine} | non-sports total=${nsHead} | targets W≥${MIN_WEATHER_ANALYSIS_SLICE} P≥${MIN_POLITICS_ANALYSIS_SLICE} M≥${MIN_MENTION_ANALYSIS_SLICE} C≥${MIN_CRYPTO_ANALYSIS_SLICE} (when available)`,
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
        cached.candidates = reorderPoolHighPriorityCategoriesFirst(
          cached.candidates.slice(0, Math.min(SCANNER_POOL_SIZE, cached.candidates.length)),
        );
        cached.totalScanned += sportsMarkets.length;
      } catch {}

      return { ...cached, source: "cached" };
    }

    throw err;
  } finally {
    hpClassifyCache = null;
  }
}
