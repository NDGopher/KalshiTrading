import { db, historicalMarketsTable } from "@workspace/db";
import { getMarkets, type KalshiMarket } from "./kalshi-client.js";
import { eq, and, gte, lte, sql } from "drizzle-orm";

export async function ingestSettledMarkets(startDate: string, endDate: string): Promise<{ ingested: number; skipped: number }> {
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 20;

  while (pages < maxPages) {
    try {
      const result = await getMarkets({
        limit: 100,
        cursor,
        status: "settled",
      });
      const filtered = result.markets.filter((m) => {
        const closeTime = new Date(m.close_time);
        return closeTime >= new Date(startDate) && closeTime <= new Date(endDate) && m.result;
      });
      allMarkets.push(...filtered);
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

    const openPrice = market.yes_ask > 0 ? market.yes_ask / 100 : null;

    await db.insert(historicalMarketsTable).values({
      kalshiTicker: market.ticker,
      title: market.title || market.ticker,
      category: market.category || null,
      openPrice,
      lastPrice: market.last_price / 100,
      yesAsk: market.yes_ask / 100,
      yesBid: market.yes_bid / 100,
      volume24h: market.volume_24h || 0,
      liquidity: market.liquidity || 0,
      status: "settled",
      result: market.result || null,
      closeTime: market.close_time ? new Date(market.close_time) : null,
      expirationTime: market.expiration_time ? new Date(market.expiration_time) : null,
      snapshotAt: new Date(),
      rawData: market as unknown as Record<string, unknown>,
    });
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
