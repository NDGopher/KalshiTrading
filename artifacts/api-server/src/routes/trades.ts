import { Router, type IRouter } from "express";
import { db, tradesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import {
  ListTradesQueryParams,
  ListTradesResponse,
  GetTradeStatsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/trades", async (req, res): Promise<void> => {
  const params = ListTradesQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit || 50 : 50;
  const offset = params.success ? params.data.offset || 0 : 0;
  const statusFilter = params.success ? params.data.status : undefined;

  let query = db.select().from(tradesTable).orderBy(desc(tradesTable.createdAt));

  const allTrades = await query;

  let filtered = allTrades;
  if (statusFilter) {
    filtered = allTrades.filter((t) => t.status === statusFilter);
  }

  const total = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  res.json(
    ListTradesResponse.parse({
      trades: paginated.map((t) => ({
        id: t.id,
        kalshiTicker: t.kalshiTicker,
        title: t.title,
        side: t.side,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        quantity: t.quantity,
        pnl: t.pnl,
        status: t.status,
        modelProbability: t.modelProbability,
        edge: t.edge,
        confidence: t.confidence,
        analystReasoning: t.analystReasoning,
        auditorFlags: (t.auditorFlags as string[]) || [],
        riskScore: t.riskScore,
        kellyFraction: t.kellyFraction,
        createdAt: t.createdAt.toISOString(),
        closedAt: t.closedAt?.toISOString() || null,
      })),
      total,
    })
  );
});

router.get("/trades/stats", async (_req, res): Promise<void> => {
  const trades = await db.select().from(tradesTable);

  const completedTrades = trades.filter((t) => t.status !== "cancelled" && t.status !== "pending");
  const totalTrades = completedTrades.length;
  const wins = completedTrades.filter((t) => t.status === "won").length;
  const losses = completedTrades.filter((t) => t.status === "lost").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayPnl = trades
    .filter((t) => new Date(t.createdAt) >= today)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);

  const edgeValues = trades.map((t) => t.edge);
  const avgEdge = edgeValues.length > 0 ? edgeValues.reduce((a, b) => a + b, 0) / edgeValues.length : 0;
  const confValues = trades.map((t) => t.confidence);
  const avgConfidence = confValues.length > 0 ? confValues.reduce((a, b) => a + b, 0) / confValues.length : 0;

  const sortedTrades = [...trades].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  let currentStreak = 0;
  let bestStreak = 0;
  let worstStreak = 0;
  let streak = 0;
  let lastStatus = "";

  for (const t of sortedTrades) {
    if (t.status === "won") {
      if (lastStatus === "won") streak++;
      else streak = 1;
      bestStreak = Math.max(bestStreak, streak);
    } else if (t.status === "lost") {
      if (lastStatus === "lost") streak++;
      else streak = 1;
      worstStreak = Math.max(worstStreak, streak);
    }
    lastStatus = t.status;
  }

  if (lastStatus === "won") currentStreak = streak;
  else if (lastStatus === "lost") currentStreak = -streak;

  const initialBankroll = 100;
  const roi = initialBankroll > 0 ? (totalPnl / initialBankroll) * 100 : 0;

  res.json(
    GetTradeStatsResponse.parse({
      totalTrades,
      wins,
      losses,
      winRate,
      totalPnl,
      todayPnl,
      avgEdge,
      avgConfidence,
      currentStreak,
      bestStreak,
      worstStreak,
      roi,
    })
  );
});

export default router;
