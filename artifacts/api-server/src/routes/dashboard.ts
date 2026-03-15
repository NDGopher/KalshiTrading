import { Router, type IRouter } from "express";
import { db, tradesTable, tradingSettingsTable, marketOpportunitiesTable } from "@workspace/db";
import { sql, eq, desc } from "drizzle-orm";
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
  } catch (err: any) {
    res.json(
      GetPortfolioBalanceResponse.parse({
        balance: 0,
        availableBalance: 0,
      })
    );
  }
});

router.get("/portfolio/positions", async (_req, res): Promise<void> => {
  try {
    const positionsData = await getPositions({ settlement_status: "unsettled" });
    const positions = await Promise.all(
      positionsData.market_positions.map(async (p) => {
        let currentPrice = 0;
        let title = p.ticker;
        let marketStatus = "open";
        try {
          const marketData = await getMarket(p.ticker);
          currentPrice = parseFloat(marketData.market.last_price_dollars || "0");
          title = marketData.market.title || p.ticker;
          marketStatus = marketData.market.status;
        } catch {}

        const avgPrice = p.total_traded > 0 && p.position > 0 ? p.total_traded / p.position : 0;
        const side = p.position > 0 ? "yes" : "no";

        return {
          ticker: p.ticker,
          title,
          side,
          quantity: Math.abs(p.position),
          avgPrice: avgPrice / 100,
          currentPrice,
          unrealizedPnl: (currentPrice - avgPrice / 100) * Math.abs(p.position),
          marketStatus,
        };
      })
    );

    res.json(GetPositionsResponse.parse(positions));
  } catch (err: any) {
    res.json(GetPositionsResponse.parse([]));
  }
});

export default router;
