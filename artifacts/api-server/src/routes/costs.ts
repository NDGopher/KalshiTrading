import { Router } from "express";
import { db, apiCostsTable } from "@workspace/db";
import { sql, gte, desc } from "drizzle-orm";

const router = Router();

router.get("/costs", async (_req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

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

    const recentCalls = await db
      .select()
      .from(apiCostsTable)
      .orderBy(desc(apiCostsTable.createdAt))
      .limit(20);

    res.json({
      daily: {
        costUsd: Number(dailyResult?.total || 0),
        calls: Number(dailyResult?.calls || 0),
        inputTokens: Number(dailyResult?.inputTokens || 0),
        outputTokens: Number(dailyResult?.outputTokens || 0),
      },
      monthly: {
        costUsd: Number(monthlyResult?.total || 0),
        calls: Number(monthlyResult?.calls || 0),
        inputTokens: Number(monthlyResult?.inputTokens || 0),
        outputTokens: Number(monthlyResult?.outputTokens || 0),
      },
      allTime: {
        costUsd: Number(allTimeResult?.total || 0),
        calls: Number(allTimeResult?.calls || 0),
      },
      recentCalls,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
