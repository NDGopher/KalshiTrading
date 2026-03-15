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
  last_price_dollars?: string;
  liquidity_dollars?: string;
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
