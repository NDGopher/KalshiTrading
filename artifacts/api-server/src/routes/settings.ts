import { Router, type IRouter } from "express";
import { db, tradingSettingsTable, apiCostsTable } from "@workspace/db";
import { eq, gte, sql } from "drizzle-orm";
import { getBalance } from "../lib/kalshi-client.js";

const router: IRouter = Router();

async function ensureSettings() {
  const [existing] = await db.select().from(tradingSettingsTable).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(tradingSettingsTable)
    .values({})
    .returning();
  return created;
}

async function computeBudgetStatus(settings: typeof tradingSettingsTable.$inferSelect) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dailyResult] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
    .from(apiCostsTable)
    .where(gte(apiCostsTable.createdAt, startOfDay));
  const dailySpend = Number(dailyResult?.total || 0);

  const [monthlyResult] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
    .from(apiCostsTable)
    .where(gte(apiCostsTable.createdAt, startOfMonth));
  const monthlySpend = Number(monthlyResult?.total || 0);

  const dailyExceeded = settings.dailyBudgetUsd > 0 && dailySpend >= settings.dailyBudgetUsd;
  const monthlyExceeded = settings.monthlyBudgetUsd > 0 && monthlySpend >= settings.monthlyBudgetUsd;

  return {
    dailySpend,
    monthlySpend,
    dailyExceeded,
    monthlyExceeded,
    budgetPaused: dailyExceeded || monthlyExceeded,
  };
}

async function settingsToResponse(settings: typeof tradingSettingsTable.$inferSelect) {
  const budgetStatus = await computeBudgetStatus(settings);

  return {
    id: settings.id,
    maxPositionPct: settings.maxPositionPct,
    kellyFraction: settings.kellyFraction,
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    maxDrawdownPct: settings.maxDrawdownPct,
    maxSimultaneousPositions: settings.maxSimultaneousPositions,
    minEdge: settings.minEdge,
    minLiquidity: settings.minLiquidity,
    minTimeToExpiry: settings.minTimeToExpiry,
    confidencePenaltyPct: settings.confidencePenaltyPct,
    sportFilters: settings.sportFilters as string[],
    scanIntervalMinutes: settings.scanIntervalMinutes,
    pipelineActive: settings.pipelineActive,
    paperTradingMode: settings.paperTradingMode,
    paperBalance: settings.paperBalance,
    dailyBudgetUsd: settings.dailyBudgetUsd,
    monthlyBudgetUsd: settings.monthlyBudgetUsd,
    enabledStrategies:
      (settings.enabledStrategies as string[] | null) ?? [
        "Whale Flow",
        "Volume Imbalance",
        "Dip Buy",
        "Pure Value",
      ],
    targetBetUsd: settings.targetBetUsd ?? 15,
    kalshiApiKeySet: !!(settings.kalshiApiKey || process.env.KALSHI_API_KEY),
    kalshiBaseUrl: settings.kalshiBaseUrl || null,
    budgetStatus,
  };
}

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await ensureSettings();
  res.json(await settingsToResponse(settings));
});

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (isNaN(n) || !isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

router.put("/settings", async (req, res): Promise<void> => {
  const current = await ensureSettings();

  const updateData: Partial<typeof tradingSettingsTable.$inferInsert> = {};
  const body = req.body;
  if (body.maxPositionPct !== undefined)
    updateData.maxPositionPct = clampNum(body.maxPositionPct, 1, 50, current.maxPositionPct);
  if (body.kellyFraction !== undefined)
    updateData.kellyFraction = clampNum(body.kellyFraction, 0.05, 1.0, current.kellyFraction);
  if (body.maxConsecutiveLosses !== undefined)
    updateData.maxConsecutiveLosses = clampNum(body.maxConsecutiveLosses, 1, 20, current.maxConsecutiveLosses);
  if (body.maxDrawdownPct !== undefined)
    updateData.maxDrawdownPct = clampNum(body.maxDrawdownPct, 5, 100, current.maxDrawdownPct);
  if (body.maxSimultaneousPositions !== undefined)
    updateData.maxSimultaneousPositions = clampNum(body.maxSimultaneousPositions, 0, 10000, current.maxSimultaneousPositions);
  if (body.minEdge !== undefined)
    updateData.minEdge = clampNum(body.minEdge, 1, 50, current.minEdge);
  if (body.minLiquidity !== undefined)
    updateData.minLiquidity = clampNum(body.minLiquidity, 10, 100000, current.minLiquidity);
  if (body.minTimeToExpiry !== undefined)
    updateData.minTimeToExpiry = clampNum(body.minTimeToExpiry, 1, 10080, current.minTimeToExpiry);
  if (body.confidencePenaltyPct !== undefined)
    updateData.confidencePenaltyPct = clampNum(body.confidencePenaltyPct, 0, 50, current.confidencePenaltyPct);
  if (body.sportFilters !== undefined && Array.isArray(body.sportFilters))
    updateData.sportFilters = body.sportFilters.filter((s: unknown) => typeof s === "string");
  if (body.scanIntervalMinutes !== undefined)
    updateData.scanIntervalMinutes = clampNum(body.scanIntervalMinutes, 5, 1440, current.scanIntervalMinutes);
  if (body.pipelineActive !== undefined && typeof body.pipelineActive === "boolean")
    updateData.pipelineActive = body.pipelineActive;
  if (body.paperTradingMode !== undefined && typeof body.paperTradingMode === "boolean")
    updateData.paperTradingMode = body.paperTradingMode;
  if (body.paperBalance !== undefined)
    updateData.paperBalance = clampNum(body.paperBalance, 0, 1000000, current.paperBalance);
  if (body.dailyBudgetUsd !== undefined)
    updateData.dailyBudgetUsd = clampNum(body.dailyBudgetUsd, 0, 10000, current.dailyBudgetUsd);
  if (body.monthlyBudgetUsd !== undefined)
    updateData.monthlyBudgetUsd = clampNum(body.monthlyBudgetUsd, 0, 100000, current.monthlyBudgetUsd);
  if (body.enabledStrategies !== undefined && Array.isArray(body.enabledStrategies))
    updateData.enabledStrategies = body.enabledStrategies.filter((s: unknown) => typeof s === "string");
  if (body.targetBetUsd !== undefined)
    updateData.targetBetUsd = clampNum(body.targetBetUsd, 5, 50, current.targetBetUsd ?? 15);
  if (body.kalshiApiKey !== undefined && typeof body.kalshiApiKey === "string")
    updateData.kalshiApiKey = body.kalshiApiKey;
  if (body.kalshiBaseUrl !== undefined)
    updateData.kalshiBaseUrl = typeof body.kalshiBaseUrl === "string" ? body.kalshiBaseUrl : null;

  const [updated] = await db
    .update(tradingSettingsTable)
    .set(updateData)
    .where(eq(tradingSettingsTable.id, current.id))
    .returning();

  res.json(await settingsToResponse(updated));
});

router.post("/settings/test-connection", async (_req, res): Promise<void> => {
  try {
    const balance = await getBalance();
    res.json({ success: true, balance: balance.balance / 100 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.json({ success: false, error: message });
  }
});

export default router;
