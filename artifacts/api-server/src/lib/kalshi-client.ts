import { db, tradingSettingsTable } from "@workspace/db";

const DEFAULT_BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";

let sessionToken: string | null = null;
let tokenExpiresAt: number = 0;

async function loadCredentials(): Promise<{ apiKey: string; baseUrl: string }> {
  const apiKeyFromEnv = process.env.KALSHI_API_KEY;
  const baseUrlFromEnv = process.env.KALSHI_BASE_URL;

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);

  const apiKey = apiKeyFromEnv || settings?.kalshiApiKey;
  const baseUrl = baseUrlFromEnv || settings?.kalshiBaseUrl || DEFAULT_BASE_URL;

  if (!apiKey) {
    throw new Error("Kalshi API key not configured. Set KALSHI_API_KEY environment secret (preferred) or enter via Dashboard Settings.");
  }

  return { apiKey, baseUrl };
}

async function ensureAuth(): Promise<{ token: string; baseUrl: string }> {
  const { apiKey, baseUrl } = await loadCredentials();

  const email = process.env.KALSHI_EMAIL;
  const password = process.env.KALSHI_PASSWORD;

  if (email && password) {
    if (sessionToken && Date.now() < tokenExpiresAt) {
      return { token: sessionToken, baseUrl };
    }
    const loginRes = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!loginRes.ok) {
      throw new Error(`Kalshi login failed: ${loginRes.status} ${await loginRes.text()}`);
    }
    const loginData = (await loginRes.json()) as { token: string };
    sessionToken = loginData.token;
    tokenExpiresAt = Date.now() + 55 * 60 * 1000;
    return { token: sessionToken, baseUrl };
  }

  return { token: apiKey, baseUrl };
}

async function getHeaders(): Promise<{ headers: Record<string, string>; baseUrl: string }> {
  const { token, baseUrl } = await ensureAuth();
  return {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    baseUrl,
  };
}

async function kalshiFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const { headers, baseUrl } = await getHeaders();
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string> || {}) },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kalshi API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  series_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  liquidity: number;
  close_time: string;
  expiration_time: string;
  expected_expiration_time?: string;
  status: string;
  result?: string;
  category?: string;
  market_type: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  open_time?: string;
  last_price_dollars?: string | number;
  liquidity_dollars?: string | number;
  yes_ask_dollars?: string | number;
  yes_bid_dollars?: string | number;
  no_ask_dollars?: string | number;
  no_bid_dollars?: string | number;
  volume_24h_fp?: string | number;
  volume_fp?: string | number;
  open_interest_fp?: string | number;
  rules_primary?: string;
  rules_secondary?: string;
  early_close_condition?: string;
  price_ranges?: unknown;
  price_level_structure?: string;
  /** Prior-day last YES trade (API v2); used when book + last are empty. */
  previous_price_dollars?: string | number;
}

/**
 * Kalshi multivariate / extended multi-leg markets (KXMV*…, MULTIGAMEEXTENDED, etc.).
 * They flood unfiltered category pages but are usually illiquid, wide-spread, and unreliable to mark.
 */
export function isExcludedKalshiStructuralJunk(m: KalshiMarket): boolean {
  const mt = String(m.market_type ?? "").toLowerCase();
  if (mt.includes("multivariate")) return true;

  const t = m.ticker.toUpperCase();
  const blob = `${t} ${(m.title || "").toUpperCase()}`;
  if (t.startsWith("KXMV")) return true;
  if (blob.includes("MULTIGAMEEXTENDED")) return true;
  if (blob.includes("SPORTSMULTIGAME")) return true;

  return false;
}

/** Kalshi `_dollars` fields are fixed-point strings; "0.0000" means no level — treat as absent. */
function kalshiPositiveDollars(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) && n > 0 ? parseFloat(n.toFixed(6)) : 0;
}

/** Last / previous trade quotes: accept interior probabilities, reject 0/1 sentinels. */
function yesProbabilityFromDollarField(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v).trim());
  if (!Number.isFinite(n) || n <= 0.001 || n >= 0.999) return 0;
  return parseFloat(n.toFixed(4));
}

export function getMarketYesAsk(m: KalshiMarket): number {
  if (m.yes_ask != null && m.yes_ask > 0) return m.yes_ask / 100;
  const d = kalshiPositiveDollars(m.yes_ask_dollars);
  return d > 0 ? d : 0;
}

export function getMarketYesBid(m: KalshiMarket): number {
  if (m.yes_bid != null && m.yes_bid > 0) return m.yes_bid / 100;
  const d = kalshiPositiveDollars(m.yes_bid_dollars);
  return d > 0 ? d : 0;
}

export function getMarketNoAsk(m: KalshiMarket): number {
  if (m.no_ask != null && m.no_ask > 0) return m.no_ask / 100;
  if (m.no_ask_dollars != null) return parseFloat(String(m.no_ask_dollars));
  // Derive from yes bid: NO ask = 1 - YES bid
  const yesBid = getMarketYesBid(m);
  if (yesBid > 0 && yesBid < 1) return parseFloat((1 - yesBid).toFixed(4));
  return 0;
}

/** Best bid for NO contracts; fallback 1 − YES ask when API omits no_bid. */
export function getMarketNoBid(m: KalshiMarket): number {
  if (m.no_bid != null && m.no_bid > 0) return m.no_bid / 100;
  const d = kalshiPositiveDollars(m.no_bid_dollars);
  if (d > 0) return d;
  const yesAsk = getMarketYesAsk(m);
  if (yesAsk > 0 && yesAsk < 1) return parseFloat((1 - yesAsk).toFixed(4));
  return 0;
}

export function getMarketYesPrice(m: KalshiMarket): number {
  // Live order book midpoint takes priority over stale last_price.
  // last_price is the most-recent TRADE price, which can be hours or days
  // old and will wildly misprice markets with no recent activity.
  const ask = getMarketYesAsk(m);
  const bid = getMarketYesBid(m);
  if (ask > 0 && bid > 0) return parseFloat(((ask + bid) / 2).toFixed(4));
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  // Fall back to last traded price only when order book is empty
  if (m.last_price != null && m.last_price > 0) {
    const lp = m.last_price / 100;
    if (lp > 0.001 && lp < 0.999) return parseFloat(lp.toFixed(4));
  }
  const lastD = yesProbabilityFromDollarField(m.last_price_dollars);
  if (lastD > 0) return lastD;
  const prevD = yesProbabilityFromDollarField(m.previous_price_dollars);
  if (prevD > 0) return prevD;
  return 0;
}

export function getMarketVolume24h(m: KalshiMarket): number {
  if (m.volume_24h != null && m.volume_24h > 0) return m.volume_24h;
  if (m.volume_24h_fp != null && parseFloat(String(m.volume_24h_fp)) > 0) return parseFloat(String(m.volume_24h_fp));
  if (m.volume_fp != null && parseFloat(String(m.volume_fp)) > 0) return parseFloat(String(m.volume_fp)) / 100;
  if (m.open_interest_fp != null && parseFloat(String(m.open_interest_fp)) > 0) return parseFloat(String(m.open_interest_fp)) / 100;
  return 0;
}

export function getMarketLiquidity(m: KalshiMarket): number {
  if (m.liquidity != null && m.liquidity > 0) return m.liquidity;
  if (m.liquidity_dollars != null && parseFloat(String(m.liquidity_dollars)) > 0) return parseFloat(String(m.liquidity_dollars));
  // open_interest_fp is already in dollar terms — use as liquidity proxy
  if (m.open_interest_fp != null && parseFloat(String(m.open_interest_fp)) > 0) return parseFloat(String(m.open_interest_fp));
  return 0;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  sub_title?: string;
  markets: KalshiMarket[];
}

export interface KalshiBalance {
  balance: number;
  portfolio_value?: number;
}

export interface KalshiOrder {
  order_id: string;
  ticker: string;
  side: string;
  action: string;
  type: string;
  yes_price: number;
  no_price: number;
  count: number;
  status: string;
  created_time: string;
}

export interface KalshiPosition {
  ticker: string;
  event_ticker: string;
  market_result?: string;
  position: number;
  total_traded: number;
  resting_orders_count: number;
  fees_paid: number;
}

export async function getMarkets(params: {
  limit?: number;
  cursor?: string;
  event_ticker?: string;
  series_ticker?: string;
  status?: string;
  category?: string;
} = {}): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.event_ticker) searchParams.set("event_ticker", params.event_ticker);
  if (params.series_ticker) searchParams.set("series_ticker", params.series_ticker);
  if (params.status) searchParams.set("status", params.status);
  if (params.category) searchParams.set("category", params.category);
  const qs = searchParams.toString();
  return kalshiFetch(`/markets${qs ? `?${qs}` : ""}`);
}

export async function getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
  return kalshiFetch(`/markets/${encodeURIComponent(ticker)}`);
}

export async function getEvents(params: {
  limit?: number;
  cursor?: string;
  series_ticker?: string;
  status?: string;
  with_nested_markets?: boolean;
} = {}): Promise<{ events: KalshiEvent[]; cursor?: string }> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.series_ticker) searchParams.set("series_ticker", params.series_ticker);
  if (params.status) searchParams.set("status", params.status);
  if (params.with_nested_markets) searchParams.set("with_nested_markets", "true");
  const qs = searchParams.toString();
  return kalshiFetch(`/events${qs ? `?${qs}` : ""}`);
}

export async function getEvent(eventTicker: string): Promise<{ event: KalshiEvent }> {
  return kalshiFetch(`/events/${eventTicker}?with_nested_markets=true`);
}

/** Kalshi v2 orderbook (current); legacy cent arrays may still appear in older responses. */
export type KalshiOrderbookPayload = {
  orderbook?: { yes: number[][]; no: number[][] };
  orderbook_fp?: {
    yes_dollars?: [unknown, unknown][];
    no_dollars?: [unknown, unknown][];
  };
};

export async function getOrderbook(ticker: string): Promise<KalshiOrderbookPayload> {
  return kalshiFetch(`/markets/${encodeURIComponent(ticker)}/orderbook`);
}

/**
 * Best-effort YES probability for mark-to-market when GET /market quote fields are all "0.0000"
 * but the book still has bids (common after Kalshi's orderbook_fp migration).
 */
/** Best YES ask from orderbook_fp: YES ask = 1 − (best NO bid). */
export function bestYesAskFromOrderbookPayload(data: KalshiOrderbookPayload): number {
  const fp = data.orderbook_fp;
  if (fp?.no_dollars?.[0]?.[0] != null) {
    const bestNoBid = kalshiPositiveDollars(fp.no_dollars[0][0]);
    if (bestNoBid > 0 && bestNoBid < 1) return parseFloat((1 - bestNoBid).toFixed(6));
  }
  const leg = data.orderbook;
  if (leg?.no?.[0]?.[0] != null) {
    const nc = leg.no[0][0];
    const nb = nc != null && nc > 0 ? nc / 100 : 0;
    if (nb > 0 && nb < 1) return parseFloat((1 - nb).toFixed(6));
  }
  return 0;
}

/** Best NO ask from orderbook_fp: NO ask = 1 − (best YES bid). */
export function bestNoAskFromOrderbookPayload(data: KalshiOrderbookPayload): number {
  const fp = data.orderbook_fp;
  if (fp?.yes_dollars?.[0]?.[0] != null) {
    const bestYesBid = kalshiPositiveDollars(fp.yes_dollars[0][0]);
    if (bestYesBid > 0 && bestYesBid < 1) return parseFloat((1 - bestYesBid).toFixed(6));
  }
  const leg = data.orderbook;
  if (leg?.yes?.[0]?.[0] != null) {
    const yc = leg.yes[0][0];
    const yb = yc != null && yc > 0 ? yc / 100 : 0;
    if (yb > 0 && yb < 1) return parseFloat((1 - yb).toFixed(6));
  }
  return 0;
}

export function midYesPriceFromOrderbookPayload(data: KalshiOrderbookPayload): number {
  const fp = data.orderbook_fp;
  if (fp && ((fp.yes_dollars?.length ?? 0) > 0 || (fp.no_dollars?.length ?? 0) > 0)) {
    const bestYesBid = fp.yes_dollars?.[0]?.[0] != null ? kalshiPositiveDollars(fp.yes_dollars[0][0]) : 0;
    const bestNoBid = fp.no_dollars?.[0]?.[0] != null ? kalshiPositiveDollars(fp.no_dollars[0][0]) : 0;
    const impliedYesAsk = bestNoBid > 0 && bestNoBid < 1 ? parseFloat((1 - bestNoBid).toFixed(6)) : 0;
    if (bestYesBid > 0 && impliedYesAsk > 0) return parseFloat(((bestYesBid + impliedYesAsk) / 2).toFixed(4));
    if (bestYesBid > 0) return bestYesBid;
    if (impliedYesAsk > 0) return impliedYesAsk;
  }
  const leg = data.orderbook;
  if (leg && ((leg.yes?.length ?? 0) > 0 || (leg.no?.length ?? 0) > 0)) {
    const yc = leg.yes?.[0]?.[0];
    const nc = leg.no?.[0]?.[0];
    const yb = yc != null && yc > 0 ? yc / 100 : 0;
    const nb = nc != null && nc > 0 ? nc / 100 : 0;
    const implied = nb > 0 && nb < 1 ? 1 - nb : 0;
    if (yb > 0 && implied > 0) return parseFloat(((yb + implied) / 2).toFixed(4));
    if (yb > 0) return yb;
    if (implied > 0) return implied;
  }
  return 0;
}

/** YES ask for paper marks / execution display — snapshot first, then list, then orderbook_fp. */
export async function getBestYesAskPrice(ticker: string): Promise<number> {
  try {
    const { market } = await getMarket(ticker);
    const a = getMarketYesAsk(market);
    if (a > 0.005 && a < 0.995) return a;
  } catch {
    /* 404 / auth */
  }
  try {
    const q = new URLSearchParams({ ticker, limit: "1", status: "open" });
    const { markets } = await kalshiFetch<{ markets?: KalshiMarket[] }>(`/markets?${q.toString()}`);
    const m = markets?.find((x) => x.ticker === ticker) ?? markets?.[0];
    if (m?.ticker === ticker) {
      const a = getMarketYesAsk(m);
      if (a > 0.005 && a < 0.995) return a;
    }
  } catch {
    /* bad filter */
  }
  try {
    const ob = await getOrderbook(ticker);
    const a = bestYesAskFromOrderbookPayload(ob);
    if (a > 0.005 && a < 0.995) return a;
  } catch {
    /* rate limit */
  }
  return 0;
}

/** NO ask — snapshot / list / orderbook_fp (1 − best YES bid). */
export async function getBestNoAskPrice(ticker: string): Promise<number> {
  try {
    const { market } = await getMarket(ticker);
    const a = getMarketNoAsk(market);
    if (a > 0.005 && a < 0.995) return a;
  } catch {
    /* 404 / auth */
  }
  try {
    const q = new URLSearchParams({ ticker, limit: "1", status: "open" });
    const { markets } = await kalshiFetch<{ markets?: KalshiMarket[] }>(`/markets?${q.toString()}`);
    const m = markets?.find((x) => x.ticker === ticker) ?? markets?.[0];
    if (m?.ticker === ticker) {
      const a = getMarketNoAsk(m);
      if (a > 0.005 && a < 0.995) return a;
    }
  } catch {
    /* bad filter */
  }
  try {
    const ob = await getOrderbook(ticker);
    const a = bestNoAskFromOrderbookPayload(ob);
    if (a > 0.005 && a < 0.995) return a;
  } catch {
    /* rate limit */
  }
  return 0;
}

/** Resolve a tradable YES mark: market snapshot first, then orderbook_fp / legacy orderbook. */
export async function getBestYesMarkPrice(ticker: string): Promise<number> {
  try {
    const { market } = await getMarket(ticker);
    const p = getMarketYesPrice(market);
    if (p > 0.005 && p < 0.995) return p;
  } catch {
    /* auth, 404, network */
  }
  // Some multivariate / long tickers 404 on GET /markets/{ticker} but appear in the list endpoint.
  try {
    const q = new URLSearchParams({ ticker, limit: "1", status: "open" });
    const { markets } = await kalshiFetch<{ markets?: KalshiMarket[] }>(`/markets?${q.toString()}`);
    const m = markets?.find((x) => x.ticker === ticker) ?? markets?.[0];
    if (m?.ticker === ticker) {
      const p = getMarketYesPrice(m);
      if (p > 0.005 && p < 0.995) return p;
    }
  } catch {
    /* bad filter combo */
  }
  try {
    const ob = await getOrderbook(ticker);
    const ask = bestYesAskFromOrderbookPayload(ob);
    if (ask > 0.005 && ask < 0.995) return ask;
    const m = midYesPriceFromOrderbookPayload(ob);
    if (m > 0.005 && m < 0.995) return m;
  } catch {
    /* rate limit, 404 */
  }
  return 0;
}

export async function getBalance(): Promise<KalshiBalance> {
  return kalshiFetch("/portfolio/balance");
}

export async function getPositions(params: {
  limit?: number;
  cursor?: string;
  settlement_status?: string;
  event_ticker?: string;
} = {}): Promise<{ market_positions: KalshiPosition[]; cursor?: string }> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  if (params.settlement_status) searchParams.set("settlement_status", params.settlement_status);
  if (params.event_ticker) searchParams.set("event_ticker", params.event_ticker);
  const qs = searchParams.toString();
  return kalshiFetch(`/portfolio/positions${qs ? `?${qs}` : ""}`);
}

export async function createOrder(params: {
  ticker: string;
  action: "buy" | "sell";
  side: "yes" | "no";
  type: "market" | "limit";
  count: number;
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number;
}): Promise<{ order: KalshiOrder }> {
  return kalshiFetch("/portfolio/orders", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getOrder(orderId: string): Promise<{ order: KalshiOrder }> {
  return kalshiFetch(`/portfolio/orders/${orderId}`);
}

export async function cancelOrder(orderId: string): Promise<{ order: KalshiOrder }> {
  return kalshiFetch(`/portfolio/orders/${orderId}`, {
    method: "DELETE",
  });
}

export interface KalshiSeries {
  ticker: string;
  frequency: string;
  title: string;
  category: string;
  tags: string[];
}

export async function getSeries(params: {
  limit?: number;
  cursor?: string;
} = {}): Promise<{ series: KalshiSeries[]; cursor?: string }> {
  const searchParams = new URLSearchParams();
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.cursor) searchParams.set("cursor", params.cursor);
  const qs = searchParams.toString();
  return kalshiFetch(`/series${qs ? `?${qs}` : ""}`);
}

export const SPORTS_SERIES_TICKERS = [
  // ── Game-day markets first (have real pre-game prices: 20-80¢) ──────────────
  "KXUECLGAME",     // UEFA Conference League — "Team A vs Team B Winner?"
  "KXSERIEAGAME",   // Serie A soccer
  "KXLALIGAGAME",   // La Liga soccer
  "KXCOPPAITALIAGAME", // Coppa Italia
  "KXSHLGAME",      // SHL (Swedish) Hockey
  "KXNHLTOTAL",     // NHL game goal totals — "Total Goals Over X.5?"
  "KXNBASPREAD",    // NBA game spread — "Team wins by over N.5 points?"
  "KXATPGAMETOTAL", // ATP tennis game totals
  "KXWBCTOTAL",     // WBC/MLB run totals
  "KXNFLSPREAD",    // NFL game spreads
  "KXNBASERIES",    // NBA series results
  // ── Season/championship futures (settle near 0¢/100¢ — lower priority) ────
  "KXNFL", "KXNBA", "KXMLB", "KXNHL", "KXSOC", "KXNCAA",
  "KXSPORT", "KXMVE",
];

export async function getSportsMarkets(sportKeywords: string[]): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];

  for (const seriesTicker of SPORTS_SERIES_TICKERS) {
    let cursor: string | undefined;
    let pages = 0;
    while (pages < 3) {
      try {
        const result = await getMarkets({ limit: 100, cursor, status: "open", series_ticker: seriesTicker });
        allMarkets.push(...result.markets);
        cursor = result.cursor;
        pages++;
        if (!cursor || result.markets.length < 100) break;
      } catch {
        break;
      }
    }
  }

  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 5;

  while (pages < maxPages) {
    const result = await getMarkets({ limit: 100, cursor, status: "open" });
    const filtered = result.markets.filter((m) => {
      if (allMarkets.some((e) => e.ticker === m.ticker)) return false;
      const title = (m.title || m.yes_sub_title || m.ticker).toLowerCase();
      const ticker = m.ticker.toLowerCase();
      return sportKeywords.some((kw) => {
        const lkw = kw.toLowerCase();
        return title.includes(lkw) || ticker.includes(lkw);
      });
    });
    allMarkets.push(...filtered);
    cursor = result.cursor;
    pages++;
    if (!cursor || result.markets.length < 100) break;
  }

  return allMarkets;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetches one page of markets for a given category (or no filter if category is empty).
 * Returns empty array on any error (rate limit, bad category name, etc.).
 */
async function fetchOnePage(category: string, cursor?: string): Promise<{ markets: KalshiMarket[]; cursor?: string }> {
  try {
    const params: Parameters<typeof getMarkets>[0] = { limit: 100, status: "open" };
    if (category) params.category = category;
    if (cursor) params.cursor = cursor;
    return await getMarkets(params);
  } catch {
    return { markets: [] };
  }
}

/**
 * Fetches markets across ALL useful Kalshi categories SEQUENTIALLY to avoid rate limits.
 * Each category gets up to 2 pages (200 markets). Also sweeps specific game-day series
 * (soccer, NBA spreads, etc.) that are proven to trade at real prices.
 *
 * Multivariate / extended combo tickers are stripped after fetch (see isExcludedKalshiStructuralJunk).
 */
export async function getAllLiquidMarkets(_maxPages = 10): Promise<KalshiMarket[]> {
  // Kalshi category strings — each maps to a distinct set of events
  const CATEGORIES = [
    "",           // unfiltered default feed (highest-volume markets first)
    "Politics",
    "Economics",
    "Financials",
    "Crypto",     // BTC/ETH/etc. — backtest-heavy bucket; sequential fetch stays rate-limit safe
    "Sports",
    "Entertainment",
    "Weather",
  ];

  // Game-day series with REAL pre-game prices (20-80¢), proven in backtests.
  // Fetch first page of each — most series have < 100 active games at once.
  const GAME_SERIES = [
    // Soccer — active Mar–May
    "KXLALIGAGAME",      // La Liga
    "KXSERIEAGAME",      // Serie A
    "KXUECLGAME",        // UEFA Conference League
    "KXUELAGAME",        // UEFA Europa League
    "KXUCL",             // UEFA Champions League (knockout rounds Mar–May)
    "KXCOPPAITALIAGAME", // Coppa Italia
    // NBA
    "KXNBASERIES",       // NBA playoff series
    "KXNBASPREAD",       // NBA game spreads
    // NHL
    "KXNHLTOTAL",        // NHL goal totals
    "KXNHLSPREAD",       // NHL game spreads
    "KXNHLGAME",         // NHL game winner
    // College basketball — NCAA tournament active Mar–Apr
    "KXNCAAB",           // NCAA men's basketball
    "KXNCAABGAME",       // NCAA game-level markets
    "KXMARCH",           // March Madness bracket markets
    // MLB — season opens late March / April
    "KXMLBSPREAD",       // MLB run-line spreads
    "KXMLBTOTAL",        // MLB run totals
    "KXMLBGAME",         // MLB game winner
    // Other
    "KXNFLSPREAD",       // NFL spreads (off-season until Sep — will return 0)
    "KXATPGAMETOTAL",    // ATP tennis
    "KXWBCTOTAL",        // WBC/MLB run totals
    "KXBTCD",            // Bitcoin daily binary — primary backtest (Pure Value) series
    "KXETHD",            // ETH daily binaries
    "KXDOGE",            // DOGE binaries
    "KXBTCE",            // BTC strike/expiry binaries
  ];

  const allMarketsRaw: KalshiMarket[] = [];

  const HIGH_VALUE_CATEGORIES = new Set(["Politics", "Economics", "Financials", "Crypto", "Entertainment"]);

  // Earnings / pop-culture mention series (often thin in generic category pages).
  const MENTION_SERIES = ["KXMENTION", "KXINMENTION", "KXCORPMENTION", "KXSTOCKMENTION"];

  // Phase 1: Category sweep (extra page for politics/crypto/economics — backtest-heavy buckets)
  for (const category of CATEGORIES) {
    let cursor: string | undefined;
    const maxPages =
      category === ""
        ? 2
        : category === "Crypto"
          ? 4
          : category === "Weather"
            ? 4
            : category === "Politics"
              ? 4
              : HIGH_VALUE_CATEGORIES.has(category)
                ? 3
                : 2;
    for (let page = 0; page < maxPages; page++) {
      await delay(300);
      const result = await fetchOnePage(category, cursor);
      if (!result.markets || result.markets.length === 0) break;
      allMarketsRaw.push(...result.markets);
      console.log(`[Scanner] category=${category || "default"} page ${page}: +${result.markets.length} markets`);
      cursor = result.cursor;
      if (!cursor || result.markets.length < 100) break;
    }
  }

  // Phase 2: Game-day series sweep — 1 page each (series rarely exceed 100 active markets)
  let seriesCount = 0;
  for (const seriesTicker of GAME_SERIES) {
    await delay(300);
    try {
      const params: Parameters<typeof getMarkets>[0] = { limit: 100, status: "open", series_ticker: seriesTicker };
      const result = await getMarkets(params);
      if (result.markets && result.markets.length > 0) {
        allMarketsRaw.push(...result.markets);
        seriesCount += result.markets.length;
        console.log(`[Scanner] series=${seriesTicker}: +${result.markets.length} game markets`);
      }
    } catch {
      // Series not found or rate limited — skip silently
    }
  }

  if (seriesCount > 0) {
    console.log(`[Scanner] Game-series sweep: +${seriesCount} game-day markets`);
  }

  let mentionSeriesCount = 0;
  for (const seriesTicker of MENTION_SERIES) {
    await delay(300);
    try {
      const params: Parameters<typeof getMarkets>[0] = { limit: 100, status: "open", series_ticker: seriesTicker };
      const result = await getMarkets(params);
      if (result.markets && result.markets.length > 0) {
        allMarketsRaw.push(...result.markets);
        mentionSeriesCount += result.markets.length;
        console.log(`[Scanner] series=${seriesTicker}: +${result.markets.length} mention-style markets`);
      }
    } catch {
      // Series absent or rate limited
    }
  }
  if (mentionSeriesCount > 0) {
    console.log(`[Scanner] Mention-series sweep: +${mentionSeriesCount} markets`);
  }

  // Deduplicate by ticker (same market can appear in category and series results)
  const seen = new Set<string>();
  const allMarkets: KalshiMarket[] = [];
  for (const m of allMarketsRaw) {
    if (!seen.has(m.ticker)) {
      seen.add(m.ticker);
      allMarkets.push(m);
    }
  }

  const preJunk = allMarkets.length;
  const noJunk = allMarkets.filter((m) => !isExcludedKalshiStructuralJunk(m));
  const junkDropped = preJunk - noJunk.length;
  if (junkDropped > 0) {
    console.log(`[Scanner] getAllLiquidMarkets: dropped ${junkDropped} multivariate/extended-combo tickers`);
  }
  console.log(`[Scanner] getAllLiquidMarkets: ${noJunk.length} unique markets after structural filter`);

  // Only filter out extreme prices — use full quote (bid/ask/last), not last_price_dollars alone,
  // or we drop active books with no recent trade (common on crypto/politics).
  return noJunk.filter((m) => {
    const price = getMarketYesPrice(m);
    // Inclusive-ish band so near-the-floor politics/crypto longshots still reach the scanner
    return price >= 0.015 && price <= 0.985;
  });
}
