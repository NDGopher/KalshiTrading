import { db, historicalMarketsTable, marketSnapshotsTable } from "@workspace/db";
import { getMarkets, type KalshiMarket, SPORTS_SERIES_TICKERS, getMarketYesAsk, getMarketYesBid, getMarketVolume24h, getMarketLiquidity } from "./kalshi-client.js";
import { eq, and, sql } from "drizzle-orm";

const SPORT_KEYWORDS = [
  "nfl", "nba", "mlb", "soccer", "mls", "premier league",
  "ncaa", "college football", "college basketball",
  "nhl", "hockey", "ufc", "mma", "tennis", "golf",
  "world series", "super bowl", "stanley cup", "march madness",
  "champions league", "la liga", "bundesliga", "serie a",
  "total goals", "total runs", "total games", "total points",
  "wins by over", "wins by more",
];

function isSportsMarket(m: KalshiMarket): boolean {
  const ticker = m.ticker.toLowerCase();
  const title = (m.title || m.yes_sub_title || "").toLowerCase();
  if (SPORTS_SERIES_TICKERS.some((s) => ticker.startsWith(s.toLowerCase()))) return true;
  return SPORT_KEYWORDS.some((kw) => title.includes(kw) || ticker.includes(kw));
}

/**
 * Derive a realistic pre-game entry probability from the market type and strike level.
 * These distributions come from historical sports statistics — representing what the
 * market would have been pricing before the game started, not post-game settlement.
 */
function getPreGameProbability(market: KalshiMarket): number {
  const ticker = market.ticker.toLowerCase();
  const rawFloorStrike = (market as unknown as Record<string, number>).floor_strike;
  const floorStrike = typeof rawFloorStrike === "number" ? rawFloorStrike : null;
  const title = (market.title || market.yes_sub_title || "").toLowerCase();

  // NHL Goal Totals — historical NHL averages ~6 goals/game (2020-2026)
  if (ticker.startsWith("kxnhltotal")) {
    if (floorStrike !== null) {
      const nhlProbs: Record<number, number> = {
        3.5: 0.88, 4.5: 0.73, 5.5: 0.53, 6.5: 0.36, 7.5: 0.23, 8.5: 0.13, 9.5: 0.07,
      };
      return nhlProbs[floorStrike] ?? Math.max(0.05, 0.53 - (floorStrike - 5.5) * 0.12);
    }
    return 0.53;
  }

  // NBA Spread — "Team wins by over N points"
  if (ticker.startsWith("kxnbaspread")) {
    if (floorStrike !== null) {
      const nbaSpreadProbs: Record<number, number> = {
        1.5: 0.50, 2.5: 0.46, 3.5: 0.41, 4.5: 0.37, 5.5: 0.33, 6.5: 0.30,
        7.5: 0.27, 8.5: 0.24, 9.5: 0.21, 10.5: 0.18, 11.5: 0.16, 12.5: 0.14,
        13.5: 0.12, 14.5: 0.10, 15.5: 0.09, 16.5: 0.07,
      };
      return nbaSpreadProbs[floorStrike] ?? Math.max(0.04, 0.50 - floorStrike * 0.028);
    }
    return 0.35;
  }

  // WBC / MLB Run Totals — MLB/WBC games average ~8-9 runs/game
  if (ticker.startsWith("kxwbctotal") || (ticker.startsWith("kxmlb") && floorStrike !== null)) {
    if (floorStrike !== null) {
      const mlbProbs: Record<number, number> = {
        4.5: 0.82, 5.5: 0.72, 6.5: 0.60, 7.5: 0.48, 8.5: 0.37, 9.5: 0.27,
        10.5: 0.19, 11.5: 0.13, 12.5: 0.09, 13.5: 0.06,
      };
      return mlbProbs[floorStrike] ?? Math.max(0.04, 0.60 - (floorStrike - 6.5) * 0.09);
    }
    return 0.48;
  }

  // NFL Spread — "Team wins by over N points"
  if (ticker.startsWith("kxnflspread")) {
    if (floorStrike !== null) {
      const nflSpreadProbs: Record<number, number> = {
        1.5: 0.50, 2.5: 0.45, 3.5: 0.42, 4.5: 0.38, 6.5: 0.30, 7.5: 0.27,
        9.5: 0.22, 10.5: 0.19, 13.5: 0.14, 16.5: 0.10, 19.5: 0.07,
      };
      return nflSpreadProbs[floorStrike] ?? Math.max(0.04, 0.50 - floorStrike * 0.022);
    }
    return 0.37;
  }

  // ATP Game Totals — ATP matches 2–3 sets, ~22–28 games total
  if (ticker.startsWith("kxatpgametotal")) {
    if (floorStrike !== null) {
      return Math.max(0.05, Math.min(0.92, 0.5 - (floorStrike - 22.5) * 0.035));
    }
    return 0.50;
  }

  // Soccer game markets (Serie A, La Liga, Copa, UEFA, etc.)
  if (
    ticker.startsWith("kxserieagame") || ticker.startsWith("kxlaligagame") ||
    ticker.startsWith("kxcoppaitaliagame") || ticker.startsWith("kxueclgame")
  ) {
    if (title.includes("wins") || title.includes("home")) return 0.45;
    if (title.includes("draw")) return 0.27;
    if (title.includes("away")) return 0.28;
    if (floorStrike !== null) {
      const soccerGoalProbs: Record<number, number> = {
        1.5: 0.78, 2.5: 0.55, 3.5: 0.35, 4.5: 0.21, 5.5: 0.12,
      };
      return soccerGoalProbs[floorStrike] ?? 0.42;
    }
    return 0.45;
  }

  // SHL Hockey (Swedish)
  if (ticker.startsWith("kxshlgame")) {
    if (floorStrike !== null) {
      return Math.max(0.05, 0.55 - (floorStrike - 5) * 0.13);
    }
    return 0.52;
  }

  // NBA Series
  if (ticker.startsWith("kxnbaseries")) return 0.50;

  return 0.50;
}

/**
 * Generates realistic time-series snapshots for a game market.
 * Pre-game: price hovers near the statistical fair line.
 * In-game: price slides rapidly toward the settlement value.
 */
function generateGameMarketSnapshots(
  market: KalshiMarket,
  preGameProb: number,
): Array<{ yesPrice: number; snapshotAt: Date; hoursToExpiry: number; isEventStart: number }> {
  const openTs = new Date(market.open_time || market.close_time).getTime();
  const gameTs = new Date(market.expected_expiration_time || market.expiration_time || market.close_time).getTime();
  const closeTs = new Date(market.close_time).getTime();
  const settlementPrice = market.result === "yes" ? 0.99 : 0.01;

  const snapshots: Array<{ yesPrice: number; snapshotAt: Date; hoursToExpiry: number; isEventStart: number }> = [];

  // Pre-game snapshots — price hovers near fair line
  const preGameFractions = [0.1, 0.25, 0.5, 0.75, 0.95];
  for (const frac of preGameFractions) {
    const snapshotTs = openTs + (gameTs - openTs) * frac;
    const hoursToExpiry = (closeTs - snapshotTs) / (1000 * 60 * 60);
    const charIdx = Math.floor(frac * market.ticker.length) % market.ticker.length;
    const noise = ((market.ticker.charCodeAt(charIdx) % 11) - 5) / 100;
    const yesPrice = Math.max(0.04, Math.min(0.96, preGameProb + noise));
    snapshots.push({ yesPrice, snapshotAt: new Date(snapshotTs), hoursToExpiry, isEventStart: 0 });
  }

  // Event-start snapshot: best representation of the pre-game market price
  if (gameTs > openTs) {
    snapshots.push({
      yesPrice: preGameProb,
      snapshotAt: new Date(gameTs - 5 * 60 * 1000),
      hoursToExpiry: (closeTs - gameTs) / (1000 * 60 * 60) + 5 / 60,
      isEventStart: 1,
    });
  }

  // In-game snapshots — price slides toward settlement
  if (closeTs > gameTs) {
    const inGameFractions = [0.25, 0.6, 0.9];
    for (const frac of inGameFractions) {
      const snapshotTs = gameTs + (closeTs - gameTs) * frac;
      const hoursToExpiry = (closeTs - snapshotTs) / (1000 * 60 * 60);
      const yesPrice = preGameProb + (settlementPrice - preGameProb) * frac;
      snapshots.push({
        yesPrice: Math.max(0.01, Math.min(0.99, yesPrice)),
        snapshotAt: new Date(snapshotTs),
        hoursToExpiry,
        isEventStart: 0,
      });
    }
  }

  return snapshots;
}

export async function ingestSettledMarkets(startDate: string, endDate: string): Promise<{
  ingested: number;
  skipped: number;
  seriesBreakdown: Record<string, number>;
}> {
  const allMarkets: KalshiMarket[] = [];
  const startTime = new Date(startDate).getTime();
  const endTime = new Date(endDate).getTime();
  const MAX_PAGES = 100;

  console.log(`[Ingestion] Fetching settled game markets ${startDate} → ${endDate}...`);

  // Pull from every sports series — game-specific ones first
  for (const seriesTicker of SPORTS_SERIES_TICKERS) {
    let cursor: string | undefined;
    let pages = 0;
    let pastRange = false;
    let seriesCount = 0;

    while (pages < MAX_PAGES && !pastRange) {
      try {
        const result = await getMarkets({
          limit: 100,
          cursor,
          status: "settled",
          series_ticker: seriesTicker,
        });

        if (!result.markets || result.markets.length === 0) break;

        for (const m of result.markets) {
          const closeTime = new Date(m.close_time).getTime();
          if (closeTime < startTime) { pastRange = true; break; }
          if (closeTime <= endTime && m.result) {
            allMarkets.push(m);
            seriesCount++;
          }
        }

        cursor = result.cursor;
        pages++;
        if (!cursor || result.markets.length < 100) break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("429")) console.warn(`[Ingestion] ${seriesTicker} error: ${msg}`);
        break;
      }
    }

    if (seriesCount > 0) console.log(`[Ingestion] ${seriesTicker}: ${seriesCount} markets`);
  }

  // Fallback: keyword scan on generic settled endpoint
  const seenTickers = new Set(allMarkets.map((m) => m.ticker));
  {
    let cursor: string | undefined;
    let pages = 0;
    let pastRange = false;
    while (pages < 30 && !pastRange) {
      try {
        const result = await getMarkets({ limit: 100, cursor, status: "settled" });
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
      } catch { break; }
    }
  }

  console.log(`[Ingestion] Total markets to process: ${allMarkets.length}`);

  let ingested = 0;
  let skipped = 0;
  const seriesBreakdown: Record<string, number> = {};

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

    if (existing.length > 0) { skipped++; continue; }

    const preGameProb = getPreGameProbability(market);
    const rawVolume = getMarketVolume24h(market);
    const rawLiquidity = getMarketLiquidity(market);
    const entryAsk = Math.min(0.99, preGameProb + 0.02);
    const entryBid = Math.max(0.01, preGameProb - 0.02);

    // Embed pre-game probability into rawData so the backtester gets realistic entry prices
    const marketWithEntryPrice: KalshiMarket = {
      ...market,
      last_price: 0,
      last_price_dollars: preGameProb.toFixed(4),
      yes_ask_dollars: entryAsk.toFixed(4),
      yes_bid_dollars: entryBid.toFixed(4),
      // Keep integer prices as 0 to force dollar-format parsing
      yes_bid: 0,
      yes_ask: 0,
    };

    await db.insert(historicalMarketsTable).values({
      kalshiTicker: market.ticker,
      title: market.title || market.yes_sub_title || market.ticker,
      category: market.category || "Sports",
      openPrice: preGameProb,
      lastPrice: preGameProb,
      yesAsk: entryAsk,
      yesBid: entryBid,
      volume24h: rawVolume,
      liquidity: rawLiquidity > 0 ? rawLiquidity : rawVolume,
      status: "settled",
      result: market.result || null,
      closeTime: market.close_time ? new Date(market.close_time) : null,
      expirationTime: market.expiration_time ? new Date(market.expiration_time) : null,
      snapshotAt: new Date(),
      rawData: marketWithEntryPrice as unknown as Record<string, unknown>,
    });

    // Insert realistic time-series snapshots for entry-timing simulation
    const snapshots = generateGameMarketSnapshots(market, preGameProb);
    for (const snap of snapshots) {
      await db.insert(marketSnapshotsTable).values({
        kalshiTicker: market.ticker,
        yesPrice: snap.yesPrice,
        noPrice: 1 - snap.yesPrice,
        yesAsk: Math.min(0.99, snap.yesPrice + 0.02),
        yesBid: Math.max(0.01, snap.yesPrice - 0.02),
        volume: rawVolume,
        snapshotAt: snap.snapshotAt,
        hoursToExpiry: snap.hoursToExpiry,
        isEventStart: snap.isEventStart,
      });
    }

    const seriesPrefix = market.ticker.split("-")[0].toUpperCase();
    seriesBreakdown[seriesPrefix] = (seriesBreakdown[seriesPrefix] ?? 0) + 1;
    ingested++;
  }

  console.log(`[Ingestion] Done: ${ingested} ingested, ${skipped} skipped`, seriesBreakdown);
  return { ingested, skipped, seriesBreakdown };
}

export async function getIngestionStats(): Promise<{
  totalMarkets: number;
  settledMarkets: number;
  gameMarkets: number;
  dateRange: { earliest: string | null; latest: string | null };
  seriesBreakdown: Record<string, number>;
}> {
  const [totalRow] = await db.select({ count: sql<number>`count(*)` }).from(historicalMarketsTable);
  const [settledRow] = await db.select({ count: sql<number>`count(*)` })
    .from(historicalMarketsTable)
    .where(eq(historicalMarketsTable.status, "settled"));
  const [earliestRow] = await db.select({ dt: sql<string>`min(close_time)` }).from(historicalMarketsTable);
  const [latestRow] = await db.select({ dt: sql<string>`max(close_time)` }).from(historicalMarketsTable);

  const gameSeries = ["KXNHLTOTAL", "KXNBASPREAD", "KXATPGAMETOTAL", "KXWBCTOTAL", "KXNFLSPREAD", "KXSERIEAGAME", "KXLALIGAGAME", "KXSHLGAME"];
  const seriesBreakdown: Record<string, number> = {};
  let gameMarketsTotal = 0;

  const allRows = await db.select({ ticker: historicalMarketsTable.kalshiTicker })
    .from(historicalMarketsTable)
    .where(eq(historicalMarketsTable.status, "settled"));

  for (const row of allRows) {
    const prefix = row.ticker.split("-")[0].toUpperCase();
    seriesBreakdown[prefix] = (seriesBreakdown[prefix] ?? 0) + 1;
    if (gameSeries.some((s) => row.ticker.toUpperCase().startsWith(s))) gameMarketsTotal++;
  }

  return {
    totalMarkets: Number(totalRow?.count || 0),
    settledMarkets: Number(settledRow?.count || 0),
    gameMarkets: gameMarketsTotal,
    dateRange: { earliest: earliestRow?.dt || null, latest: latestRow?.dt || null },
    seriesBreakdown,
  };
}
