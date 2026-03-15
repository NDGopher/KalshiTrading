import { Router, type IRouter } from "express";
import { db, tradesTable, positionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBalance, getPositions, getMarket } from "../lib/kalshi-client.js";
import { isPipelineActive } from "../lib/agents/pipeline.js";
import {
  GetDashboardOverviewResponse,
  GetPortfolioBalanceResponse,
  GetPositionsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/dashboard/overview", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable);

  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.status === "won").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTrades = trades.filter((t) => new Date(t.createdAt) >= today);
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const openPositions = trades.filter((t) => t.status === "open").length;

  let balance = 0;
  try {
    const balanceData = await getBalance();
    balance = balanceData.balance;
  } catch {
    balance = 0;
  }

  const lastTrade = trades.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];

  res.json(
    GetDashboardOverviewResponse.parse({
      balance,
      totalPnl,
      todayPnl,
      winRate,
      totalTrades,
      openPositions,
      pipelineActive: isPipelineActive(),
      lastRunAt: lastTrade?.createdAt?.toISOString() || null,
    })
  );
});

router.get("/portfolio/balance", async (_req, res): Promise<void> => {
  try {
    const balanceData = await getBalance();
    res.json(
      GetPortfolioBalanceResponse.parse({
        balance: balanceData.balance,
        availableBalance: balanceData.portfolio_value || balanceData.balance,
      })
    );
  } catch {
    res.json(
      GetPortfolioBalanceResponse.parse({
        balance: 0,
        availableBalance: 0,
      })
    );
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
        currentPrice = parseFloat(marketData.market.last_price_dollars || "0");
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
    GetPositionsResponse.parse(
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
    )
  );
});

export default router;
