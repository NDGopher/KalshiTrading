import { Router, type IRouter } from "express";
import { db, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetSettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import { getBalance } from "../lib/kalshi-client.js";

const router: IRouter = Router();

async function ensureSettings() {
  const [existing] = await db.select().from(tradingSettingsTable).limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(tradingSettingsTable)
    .values({
      maxPositionPct: 10,
      kellyFraction: 0.25,
      maxConsecutiveLosses: 3,
      maxDrawdownPct: 15,
      minEdge: 5,
      minLiquidity: 100,
      minTimeToExpiry: 10,
      confidencePenaltyPct: 8,
      sportFilters: ["NFL", "NBA", "MLB", "Soccer"],
      scanIntervalMinutes: 60,
      pipelineActive: false,
    })
    .returning();
  return created;
}

function settingsToResponse(settings: typeof tradingSettingsTable.$inferSelect) {
  return {
    id: settings.id,
    maxPositionPct: settings.maxPositionPct,
    kellyFraction: settings.kellyFraction,
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    maxDrawdownPct: settings.maxDrawdownPct,
    minEdge: settings.minEdge,
    minLiquidity: settings.minLiquidity,
    minTimeToExpiry: settings.minTimeToExpiry,
    confidencePenaltyPct: settings.confidencePenaltyPct,
    sportFilters: settings.sportFilters as string[],
    scanIntervalMinutes: settings.scanIntervalMinutes,
    pipelineActive: settings.pipelineActive,
    kalshiApiKeySet: !!(settings.kalshiApiKey || process.env.KALSHI_API_KEY),
    kalshiBaseUrl: settings.kalshiBaseUrl || null,
  };
}

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await ensureSettings();
  res.json(GetSettingsResponse.parse(settingsToResponse(settings)));
});

router.put("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const current = await ensureSettings();

  const updateData: Partial<typeof tradingSettingsTable.$inferInsert> = {};
  if (parsed.data.maxPositionPct !== undefined) updateData.maxPositionPct = parsed.data.maxPositionPct;
  if (parsed.data.kellyFraction !== undefined) updateData.kellyFraction = parsed.data.kellyFraction;
  if (parsed.data.maxConsecutiveLosses !== undefined) updateData.maxConsecutiveLosses = parsed.data.maxConsecutiveLosses;
  if (parsed.data.maxDrawdownPct !== undefined) updateData.maxDrawdownPct = parsed.data.maxDrawdownPct;
  if (parsed.data.minEdge !== undefined) updateData.minEdge = parsed.data.minEdge;
  if (parsed.data.minLiquidity !== undefined) updateData.minLiquidity = parsed.data.minLiquidity;
  if (parsed.data.minTimeToExpiry !== undefined) updateData.minTimeToExpiry = parsed.data.minTimeToExpiry;
  if (parsed.data.confidencePenaltyPct !== undefined) updateData.confidencePenaltyPct = parsed.data.confidencePenaltyPct;
  if (parsed.data.sportFilters !== undefined) updateData.sportFilters = parsed.data.sportFilters;
  if (parsed.data.scanIntervalMinutes !== undefined) updateData.scanIntervalMinutes = parsed.data.scanIntervalMinutes;
  if (parsed.data.pipelineActive !== undefined) updateData.pipelineActive = parsed.data.pipelineActive;
  if (parsed.data.kalshiApiKey !== undefined) updateData.kalshiApiKey = parsed.data.kalshiApiKey;
  if (parsed.data.kalshiBaseUrl !== undefined) updateData.kalshiBaseUrl = parsed.data.kalshiBaseUrl;

  const [updated] = await db
    .update(tradingSettingsTable)
    .set(updateData)
    .where(eq(tradingSettingsTable.id, current.id))
    .returning();

  res.json(UpdateSettingsResponse.parse(settingsToResponse(updated)));
});

router.post("/settings/test-connection", async (_req, res): Promise<void> => {
  try {
    const balance = await getBalance();
    res.json({ success: true, balance: balance.balance });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.json({ success: false, error: message });
  }
});

export default router;
