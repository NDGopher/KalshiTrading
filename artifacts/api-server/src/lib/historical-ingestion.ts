import { db, historicalMarketsTable, marketSnapshotsTable } from "@workspace/db";
import { getMarkets, type KalshiMarket, SPORTS_SERIES_TICKERS, getMarketYesPrice, getMarketYesAsk, getMarketYesBid, getMarketVolume24h, getMarketLiquidity } from "./kalshi-client.js";
import { eq, and, gte, lte, sql } from "drizzle-orm";

const SPORT_KEYWORDS = [
  "nfl", "nba", "mlb", "soccer", "mls", "premier league",
  "ncaa", "college football", "college basketball",
  "nhl", "hockey", "ufc", "mma", "tennis", "golf",
  "world series", "super bowl", "stanley cup", "march madness",
  "champions league", "la liga", "bundesliga", "serie a",
];

function isSportsMarket(m: KalshiMarket): boolean {
  const ticker = m.ticker.toLowerCase();
  const title = (m.title || "").toLowerCase();
  if (SPORTS_SERIES_TICKERS.some((s) => ticker.startsWith(s.toLowerCase()))) return true;
  return SPORT_KEYWORDS.some((kw) => title.includes(kw) || ticker.includes(kw));
}

export async function ingestSettledMarkets(startDate: string, endDate: string): Promise<{ ingested: number; skipped: number }> {
  const allMarkets: KalshiMarket[] = [];

  const startTime = new Date(startDate).getTime();
  const endTime = new Date(endDate).getTime();
  const MAX_PAGES = 50;

  for (const seriesTicker of SPORTS_SERIES_TICKERS) {
    let cursor: string | undefined;
    let pages = 0;
    let pastRange = false;
    while (pages < MAX_PAGES && !pastRange) {
      try {
        const result = await getMarkets({
          limit: 100,
          cursor,
          status: "settled",
          series_ticker: seriesTicker,
        });
        for (const m of result.markets) {
          const closeTime = new Date(m.close_time).getTime();
          if (closeTime < startTime) { pastRange = true; break; }
          if (closeTime <= endTime && m.result) allMarkets.push(m);
        }
        cursor = result.cursor;
        pages++;
        if (!cursor || result.markets.length < 100) break;
      } catch {
        break;
      }
    }
  }

  const seenTickers = new Set(allMarkets.map((m) => m.ticker));
  let cursor: string | undefined;
  let pages = 0;
  let pastRange = false;
  while (pages < MAX_PAGES && !pastRange) {
    try {
      const result = await getMarkets({
        limit: 100,
        cursor,
        status: "settled",
      });
      for (const m of result.markets) {
        const closeTime = new Date(m.close_time).getTime();
        if (closeTime < startTime) { pastRange = true; break; }
        if (closeTime <= endTime && m.result && !seenTickers.has(m.ticker) && isSportsMarket(m)) {
          allMarkets.push(m);
          seenTickers.add(m.ticker);
        }
      }
      cursor = result.cursor;
      pages++;
      if (!cursor || result.markets.length < 100) break;
    } catch (err) {
      console.error("Error fetching settled markets for ingestion:", err);
      break;
    }
  }

  let ingested = 0;
  let skipped = 0;

  for (const market of allMarkets) {
    const existing = await db.select({ id: historicalMarketsTable.id })
      .from(historicalMarketsTable)
      .where(
        and(
          eq(historicalMarketsTable.kalshiTicker, market.ticker),
          eq(historicalMarketsTable.status, "settled")
        )
      )
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const lastPrice = getMarketYesPrice(market);
    const yesAsk = getMarketYesAsk(market);
    const yesBid = getMarketYesBid(market);
    const volume24h = getMarketVolume24h(market);
    const liquidity = getMarketLiquidity(market);

    const openTime = new Date(market.open_time || market.close_time).getTime();
    const closeTime = new Date(market.close_time).getTime();
    const duration = closeTime - openTime;

    const openPriceRaw = yesAsk > 0 && yesAsk < 0.99 ? yesAsk : null;

    await db.insert(historicalMarketsTable).values({
      kalshiTicker: market.ticker,
      title: market.title || market.ticker,
      category: market.category || null,
      openPrice: openPriceRaw,
      lastPrice,
      yesAsk,
      yesBid,
      volume24h,
      liquidity,
      status: "settled",
      result: market.result || null,
      closeTime: market.close_time ? new Date(market.close_time) : null,
      expirationTime: market.expiration_time ? new Date(market.expiration_time) : null,
      snapshotAt: new Date(),
      rawData: market as unknown as Record<string, unknown>,
    });

    if (duration > 0) {
      const entryFractions = [0.3, 0.5, 0.7, 0.9];
      for (const frac of entryFractions) {
        const snapshotTime = openTime + duration * frac;
        const hoursToExpiry = (closeTime - snapshotTime) / (1000 * 60 * 60);

        const wonYes = market.result === "yes";
        const trueOpenPrice = 0.5;
        const trueClosePrice = wonYes ? 0.99 : 0.01;
        const yesPriceAtFrac = openPriceRaw != null && openPriceRaw > 0.01 && openPriceRaw < 0.99
          ? openPriceRaw + (trueClosePrice - openPriceRaw) * frac
          : trueOpenPrice + (trueClosePrice - trueOpenPrice) * frac;

        await db.insert(marketSnapshotsTable).values({
          kalshiTicker: market.ticker,
          yesPrice: yesPriceAtFrac,
          noPrice: 1 - yesPriceAtFrac,
          yesAsk: yesAsk > 0 ? yesAsk : null,
          yesBid: yesBid > 0 ? yesBid : null,
          volume: volume24h,
          snapshotAt: new Date(snapshotTime),
          hoursToExpiry,
          isEventStart: frac >= 0.9 ? 1 : 0,
        });
      }
    }

    ingested++;
  }

  return { ingested, skipped };
}

export async function getIngestionStats(): Promise<{
  totalMarkets: number;
  settledMarkets: number;
  dateRange: { earliest: string | null; latest: string | null };
}> {
  const total = await db.select({ count: sql<number>`count(*)` }).from(historicalMarketsTable);
  const settled = await db.select({ count: sql<number>`count(*)` })
    .from(historicalMarketsTable)
    .where(eq(historicalMarketsTable.status, "settled"));

  const earliest = await db.select({ dt: sql<string>`min(close_time)` }).from(historicalMarketsTable);
  const latest = await db.select({ dt: sql<string>`max(close_time)` }).from(historicalMarketsTable);

  return {
    totalMarkets: Number(total[0]?.count || 0),
    settledMarkets: Number(settled[0]?.count || 0),
    dateRange: {
      earliest: earliest[0]?.dt || null,
      latest: latest[0]?.dt || null,
    },
  };
}
