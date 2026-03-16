import { Router, type IRouter } from "express";
import { db, tradesTable, positionsTable, tradingSettingsTable, paperTradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBalance, getPositions, getMarket } from "../lib/kalshi-client.js";
import { isPipelineActive } from "../lib/agents/pipeline.js";

const router: IRouter = Router();

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  const paperMode = settings?.paperTradingMode || false;

  const tradeSource = paperMode
    ? await db.select().from(paperTradesTable)
    : await db.select().from(tradesTable);

  const completedTrades = tradeSource.filter((t) => t.status === "won" || t.status === "lost");
  const totalTrades = completedTrades.length;
  const wins = completedTrades.filter((t) => t.status === "won").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = tradeSource.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTrades = tradeSource.filter((t) => new Date(t.createdAt) >= today);
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const openPositions = tradeSource.filter((t) => t.status === "open").length;

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

  const lastTrade = tradeSource.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  res.json({
    balance,
    balanceError,
    totalPnl,
    todayPnl,
    winRate,
    totalTrades,
    openPositions,
    pipelineActive: isPipelineActive(),
    lastRunAt: lastTrade?.createdAt?.toISOString() || null,
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

async function syncPositionsFromKalshi(): Promise<void> {
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
