import { Router, type IRouter } from "express";
import {
  db,
  tradesTable,
  positionsTable,
  tradingSettingsTable,
  paperTradesTable,
  withTransactionStatementTimeout,
  type DbClient,
} from "@workspace/db";
import { desc, sql, and, gte, inArray, isNotNull } from "drizzle-orm";
import { getBalance, getPositions, getMarket } from "../lib/kalshi-client.js";
import { isPipelineActive } from "../lib/agents/pipeline.js";

const router: IRouter = Router();

const DASH_DB_MS = Math.min(120_000, Number(process.env.DB_ROUTE_STATEMENT_TIMEOUT_MS) || 30_000);

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const settingsRows = await withTransactionStatementTimeout(DASH_DB_MS, async (tx: DbClient) =>
    tx.select().from(tradingSettingsTable).limit(1),
  );
  const [settings] = settingsRows;
  const paperMode = settings?.paperTradingMode || false;

  let totalTrades = 0;
  let wins = 0;
  let winRate = 0;
  let totalPnl = 0;
  let todayPnl = 0;
  let openPositions = 0;
  let lastRunAt: string | null = null;

  if (paperMode) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [agg] = await withTransactionStatementTimeout(DASH_DB_MS, async (tx: DbClient) =>
      tx
        .select({
          totalCompleted: sql<number>`count(*) filter (where ${paperTradesTable.status} in ('won','lost'))::int`,
          wins: sql<number>`count(*) filter (where ${paperTradesTable.status} = 'won')::int`,
          totalPnl: sql<string>`coalesce(sum(${paperTradesTable.pnl}) filter (where ${paperTradesTable.status} in ('won','lost')), 0)::text`,
          openPositions: sql<number>`count(*) filter (where ${paperTradesTable.status} = 'open')::int`,
        })
        .from(paperTradesTable),
    );

    totalTrades = Number(agg?.totalCompleted ?? 0);
    wins = Number(agg?.wins ?? 0);
    winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    totalPnl = parseFloat(String(agg?.totalPnl ?? "0")) || 0;
    openPositions = Number(agg?.openPositions ?? 0);

    const [tday] = await withTransactionStatementTimeout(DASH_DB_MS, async (tx: DbClient) =>
      tx
        .select({
          todayPnl: sql<string>`coalesce(sum(${paperTradesTable.pnl}), 0)::text`,
        })
        .from(paperTradesTable)
        .where(
          and(
            isNotNull(paperTradesTable.closedAt),
            gte(paperTradesTable.closedAt, today),
            inArray(paperTradesTable.status, ["won", "lost"]),
          ),
        ),
    );
    todayPnl = parseFloat(String(tday?.todayPnl ?? "0")) || 0;

    const [last] = await withTransactionStatementTimeout(DASH_DB_MS, async (tx: DbClient) =>
      tx
        .select({ createdAt: paperTradesTable.createdAt })
        .from(paperTradesTable)
        .orderBy(desc(paperTradesTable.createdAt))
        .limit(1),
    );
    lastRunAt = last?.createdAt?.toISOString() ?? null;
  } else {
    const tradeSource = await withTransactionStatementTimeout(DASH_DB_MS, async (tx: DbClient) =>
      tx.select().from(tradesTable),
    );

    const completedTrades = tradeSource.filter((t) => t.status === "won" || t.status === "lost");
    totalTrades = completedTrades.length;
    wins = completedTrades.filter((t) => t.status === "won").length;
    winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    totalPnl = tradeSource.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTrades = tradeSource.filter((t) => new Date(t.createdAt) >= today);
    todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    openPositions = tradeSource.filter((t) => t.status === "open").length;

    const lastTrade = tradeSource.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )[0];
    lastRunAt = lastTrade?.createdAt?.toISOString() || null;
  }

  let balance = 0;
  let balanceError = false;
  if (paperMode) {
    balance = settings?.paperBalance || 5000;
  } else {
    try {
      const balanceData = await getBalance();
      balance = balanceData.balance / 100;
    } catch {
      balance = 0;
      balanceError = true;
    }
  }

  res.json({
    balance,
    balanceError,
    totalPnl,
    todayPnl,
    winRate,
    totalTrades,
    openPositions,
    pipelineActive: isPipelineActive(),
    lastRunAt,
    paperTradingMode: paperMode,
  });
});

router.get("/portfolio/balance", async (_req, res): Promise<void> => {
  try {
    const balanceData = await getBalance();
    res.json({
      balance: balanceData.balance / 100,
      availableBalance: (balanceData.portfolio_value || balanceData.balance) / 100,
      error: false,
    });
  } catch {
    res.json({
      balance: 0,
      availableBalance: 0,
      error: true,
    });
  }
});

/** Skip further position sync attempts until this timestamp (ms) after a 429. */
let positionSyncSkipUntilMs = 0;

async function syncPositionsFromKalshi(): Promise<void> {
  if (Date.now() < positionSyncSkipUntilMs) {
    return;
  }
  try {
    const positionsData = await getPositions({ settlement_status: "unsettled" });

    await db.delete(positionsTable);

    for (const p of positionsData.market_positions) {
      let currentPrice = 0;
      let title = p.ticker;
      let marketStatus = "open";
      try {
        const marketData = await getMarket(p.ticker);
        currentPrice = parseFloat(String(marketData.market.last_price_dollars || "0"));
        title = marketData.market.title || p.ticker;
        marketStatus = marketData.market.status;
      } catch { /* use defaults */ }

      const avgPrice = p.total_traded > 0 && p.position > 0 ? (p.total_traded / p.position) / 100 : 0;
      const side = p.position > 0 ? "yes" : "no";
      const quantity = Math.abs(p.position);
      const unrealizedPnl = (currentPrice - avgPrice) * quantity;

      await db.insert(positionsTable).values({
        kalshiTicker: p.ticker,
        title,
        side: side as "yes" | "no",
        quantity,
        avgPrice,
        currentPrice,
        unrealizedPnl,
        marketStatus,
        lastSyncedAt: new Date(),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429") || msg.toLowerCase().includes("too_many")) {
      positionSyncSkipUntilMs = Date.now() + 60_000;
      console.warn("[Kalshi] Rate limited (429) — skipping position sync this cycle");
      return;
    }
    console.error("Position sync error:", err);
  }
}

router.get("/portfolio/positions", async (_req, res): Promise<void> => {
  await syncPositionsFromKalshi();

  const positions = await db.select().from(positionsTable);

  res.json(
    positions.map((p) => ({
      ticker: p.kalshiTicker,
      title: p.title,
      side: p.side,
      quantity: p.quantity,
      avgPrice: p.avgPrice,
      currentPrice: p.currentPrice,
      unrealizedPnl: p.unrealizedPnl,
      marketStatus: p.marketStatus,
    }))
  );
});

export default router;
