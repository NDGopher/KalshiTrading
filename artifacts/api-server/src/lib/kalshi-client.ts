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
}

export function getMarketYesAsk(m: KalshiMarket): number {
  if (m.yes_ask != null && m.yes_ask > 0) return m.yes_ask / 100;
  if (m.yes_ask_dollars != null) return parseFloat(String(m.yes_ask_dollars));
  return 0;
}

export function getMarketYesBid(m: KalshiMarket): number {
  if (m.yes_bid != null && m.yes_bid > 0) return m.yes_bid / 100;
  if (m.yes_bid_dollars != null) return parseFloat(String(m.yes_bid_dollars));
  return 0;
}

export function getMarketNoAsk(m: KalshiMarket): number {
  if (m.no_ask != null && m.no_ask > 0) return m.no_ask / 100;
  if (m.no_ask_dollars != null) return parseFloat(String(m.no_ask_dollars));
  // Derive from yes bid: NO ask = 1 - YES bid
  const yesBid = getMarketYesBid(m);
  if (yesBid > 0 && yesBid < 1) return parseFloat((1 - yesBid).toFixed(4));
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
  if (m.last_price != null && m.last_price > 0) return m.last_price / 100;
  if (m.last_price_dollars != null) return parseFloat(String(m.last_price_dollars));
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
  return kalshiFetch(`/markets/${ticker}`);
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

export async function getOrderbook(ticker: string): Promise<{
  orderbook: { yes: number[][]; no: number[][] };
}> {
  return kalshiFetch(`/markets/${ticker}/orderbook`);
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
 * Result: diverse mix of game-day sports, politics, economics, financials + KXMVE parlays.
 */
export async function getAllLiquidMarkets(_maxPages = 10): Promise<KalshiMarket[]> {
  // Kalshi category strings — each maps to a distinct set of events
  const CATEGORIES = [
    "",           // unfiltered default feed (highest-volume markets first)
    "Politics",
    "Economics",
    "Financials",
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
  ];

  const allMarketsRaw: KalshiMarket[] = [];

  // Phase 1: Category sweep
  for (const category of CATEGORIES) {
    let cursor: string | undefined;
    for (let page = 0; page < 2; page++) {
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

  // Deduplicate by ticker (same market can appear in category and series results)
  const seen = new Set<string>();
  const allMarkets: KalshiMarket[] = [];
  for (const m of allMarketsRaw) {
    if (!seen.has(m.ticker)) {
      seen.add(m.ticker);
      allMarkets.push(m);
    }
  }

  console.log(`[Scanner] getAllLiquidMarkets: ${allMarkets.length} unique markets total`);

  // Only filter out extreme prices — scoring is done downstream by compositeScore()
  return allMarkets.filter((m) => {
    const price = parseFloat(String(m.last_price_dollars || "0"));
    return price > 0.02 && price < 0.98;
  });
}
