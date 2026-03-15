import { Router } from "express";
import { db, apiCostsTable, tradingSettingsTable } from "@workspace/db";
import { sql, gte, desc } from "drizzle-orm";

const router = Router();

router.get("/costs", async (_req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

    const [dailyResult] = await db
      .select({
        total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${apiCostsTable.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${apiCostsTable.outputTokens}), 0)`,
      })
      .from(apiCostsTable)
      .where(gte(apiCostsTable.createdAt, startOfDay));

    const [monthlyResult] = await db
      .select({
        total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${apiCostsTable.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${apiCostsTable.outputTokens}), 0)`,
      })
      .from(apiCostsTable)
      .where(gte(apiCostsTable.createdAt, startOfMonth));

    const [allTimeResult] = await db
      .select({
        total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
      })
      .from(apiCostsTable);

    const byAgent = await db
      .select({
        agentName: apiCostsTable.agentName,
        costUsd: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)`,
        calls: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${apiCostsTable.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${apiCostsTable.outputTokens}), 0)`,
      })
      .from(apiCostsTable)
      .where(gte(apiCostsTable.createdAt, startOfMonth))
      .groupBy(apiCostsTable.agentName);

    const monthlySpend = Number(monthlyResult?.total || 0);
    const projectedMonthly = dayOfMonth > 0
      ? (monthlySpend / dayOfMonth) * daysInMonth
      : 0;

    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    const dailyBudget = settings?.dailyBudgetUsd || 0;
    const monthlyBudget = settings?.monthlyBudgetUsd || 0;
    const dailySpend = Number(dailyResult?.total || 0);
    const dailyExceeded = dailyBudget > 0 && dailySpend >= dailyBudget;
    const monthlyExceeded = monthlyBudget > 0 && monthlySpend >= monthlyBudget;

    const recentCalls = await db
      .select()
      .from(apiCostsTable)
      .orderBy(desc(apiCostsTable.createdAt))
      .limit(20);

    res.json({
      daily: {
        costUsd: dailySpend,
        calls: Number(dailyResult?.calls || 0),
        inputTokens: Number(dailyResult?.inputTokens || 0),
        outputTokens: Number(dailyResult?.outputTokens || 0),
        budgetUsd: dailyBudget,
        exceeded: dailyExceeded,
      },
      monthly: {
        costUsd: monthlySpend,
        calls: Number(monthlyResult?.calls || 0),
        inputTokens: Number(monthlyResult?.inputTokens || 0),
        outputTokens: Number(monthlyResult?.outputTokens || 0),
        budgetUsd: monthlyBudget,
        exceeded: monthlyExceeded,
        projectedUsd: projectedMonthly,
      },
      allTime: {
        costUsd: Number(allTimeResult?.total || 0),
        calls: Number(allTimeResult?.calls || 0),
      },
      byAgent: byAgent.map((a) => ({
        agentName: a.agentName,
        costUsd: Number(a.costUsd),
        calls: Number(a.calls),
        inputTokens: Number(a.inputTokens),
        outputTokens: Number(a.outputTokens),
      })),
      budgetPaused: dailyExceeded || monthlyExceeded,
      recentCalls,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
