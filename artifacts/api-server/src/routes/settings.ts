import { Router, type IRouter } from "express";
import { tradingSettingsTable, withTransactionStatementTimeout, type DbClient } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBalance } from "../lib/kalshi-client.js";
import { startPipeline, stopPipeline } from "../lib/agents/pipeline.js";

const router: IRouter = Router();

const SETTINGS_DB_MS = Math.min(120_000, Number(process.env.DB_ROUTE_STATEMENT_TIMEOUT_MS) || 30_000);

async function ensureSettings() {
  return withTransactionStatementTimeout(SETTINGS_DB_MS, async (tx: DbClient) => {
    const [existing] = await tx.select().from(tradingSettingsTable).limit(1);
    if (existing) return existing;

    const [created] = await tx.insert(tradingSettingsTable).values({}).returning();
    return created;
  });
}

async function settingsToResponse(settings: typeof tradingSettingsTable.$inferSelect) {
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
    enabledStrategies:
      (settings.enabledStrategies as string[] | null) ?? [
        "Whale Flow",
        "Volume Imbalance",
        "Dip Buy",
        "Pure Value",
      ],
    targetBetUsd: settings.targetBetUsd ?? 15,
    cryptoPriorityWeight: settings.cryptoPriorityWeight ?? 2.5,
    weatherPriorityWeight: settings.weatherPriorityWeight ?? 2.5,
    kalshiApiKeySet: !!(settings.kalshiApiKey || process.env.KALSHI_API_KEY),
    kalshiBaseUrl: settings.kalshiBaseUrl || null,
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
    updateData.scanIntervalMinutes = clampNum(body.scanIntervalMinutes, 1, 1440, current.scanIntervalMinutes);
  if (body.pipelineActive !== undefined && typeof body.pipelineActive === "boolean")
    updateData.pipelineActive = body.pipelineActive;
  if (body.paperTradingMode !== undefined && typeof body.paperTradingMode === "boolean")
    updateData.paperTradingMode = body.paperTradingMode;
  if (body.paperBalance !== undefined)
    updateData.paperBalance = clampNum(body.paperBalance, 0, 1000000, current.paperBalance);
  if (body.enabledStrategies !== undefined && Array.isArray(body.enabledStrategies))
    updateData.enabledStrategies = body.enabledStrategies.filter((s: unknown) => typeof s === "string");
  if (body.targetBetUsd !== undefined)
    updateData.targetBetUsd = clampNum(body.targetBetUsd, 5, 50, current.targetBetUsd ?? 15);
  if (body.cryptoPriorityWeight !== undefined)
    updateData.cryptoPriorityWeight = clampNum(body.cryptoPriorityWeight, 0.5, 10, current.cryptoPriorityWeight ?? 2.5);
  if (body.weatherPriorityWeight !== undefined)
    updateData.weatherPriorityWeight = clampNum(body.weatherPriorityWeight, 0.5, 10, current.weatherPriorityWeight ?? 2.5);
  if (body.kalshiApiKey !== undefined && typeof body.kalshiApiKey === "string")
    updateData.kalshiApiKey = body.kalshiApiKey;
  if (body.kalshiBaseUrl !== undefined)
    updateData.kalshiBaseUrl = typeof body.kalshiBaseUrl === "string" ? body.kalshiBaseUrl : null;

  const [updated] = await withTransactionStatementTimeout(SETTINGS_DB_MS, async (tx: DbClient) =>
    tx
      .update(tradingSettingsTable)
      .set(updateData)
      .where(eq(tradingSettingsTable.id, current.id))
      .returning(),
  );

  if (updated.pipelineActive) {
    stopPipeline();
    startPipeline(updated.scanIntervalMinutes ?? 3);
    console.log(`[Settings] Pipeline restarted from PUT: ${updated.scanIntervalMinutes ?? 3} min, keepers=${JSON.stringify(updated.enabledStrategies)}`);
  } else {
    stopPipeline();
  }

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
