import { Router, type IRouter } from "express";
import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  ListTradesQueryParams,
  ListTradesResponse,
  GetTradeStatsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

async function getPaperMode(): Promise<boolean> {
  const settings = await db.select().from(tradingSettingsTable).limit(1);
  return settings[0]?.paperTradingMode ?? true;
}

router.get("/trades", async (req, res): Promise<void> => {
  const params = ListTradesQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit || 50 : 50;
  const offset = params.success ? params.data.offset || 0 : 0;
  const statusFilter = params.success ? params.data.status : undefined;

  const paperMode = await getPaperMode();
  const source = paperMode ? paperTradesTable : tradesTable;

  const allTrades = await db.select().from(source).orderBy(desc(source.createdAt));

  const filtered = statusFilter ? allTrades.filter((t) => t.status === statusFilter) : allTrades;
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
        strategyName: t.strategyName,
        modelProbability: t.modelProbability,
        edge: t.edge,
        confidence: t.confidence,
        clv: t.clv,
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
  const paperMode = await getPaperMode();
  const source = paperMode ? paperTradesTable : tradesTable;

  const trades = await db.select().from(source);

  // Win rate only counts resolved trades (not open/pending/cancelled)
  const resolvedTrades = trades.filter((t) => t.status === "won" || t.status === "lost");
  const totalTrades = resolvedTrades.length;
  const wins = resolvedTrades.filter((t) => t.status === "won").length;
  const losses = resolvedTrades.filter((t) => t.status === "lost").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayPnl = trades
    .filter((t) => new Date(t.createdAt) >= today)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);

  const medianOf = (vals: number[]): number => {
    if (vals.length === 0) return 0;
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  };
  const edgeValues = trades.map((t) => t.edge);
  const avgEdge = medianOf(edgeValues);
  const confValues = trades.map((t) => t.confidence);
  const avgConfidence = medianOf(confValues);

  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
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

  const totalRisked = trades.reduce((sum, t) => {
    if (t.status === "won" || t.status === "lost") {
      return sum + t.quantity * t.entryPrice;
    }
    return sum;
  }, 0);
  const roi = totalRisked > 0 ? (totalPnl / totalRisked) * 100 : 0;

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
