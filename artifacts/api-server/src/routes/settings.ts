import { Router, type IRouter } from "express";
import { db, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetSettingsResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";

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

router.get("/settings", async (_req, res): Promise<void> => {
  const settings = await ensureSettings();
  res.json(
    GetSettingsResponse.parse({
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
    })
  );
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

  const [updated] = await db
    .update(tradingSettingsTable)
    .set(updateData)
    .where(eq(tradingSettingsTable.id, current.id))
    .returning();

  res.json(
    UpdateSettingsResponse.parse({
      id: updated.id,
      maxPositionPct: updated.maxPositionPct,
      kellyFraction: updated.kellyFraction,
      maxConsecutiveLosses: updated.maxConsecutiveLosses,
      maxDrawdownPct: updated.maxDrawdownPct,
      minEdge: updated.minEdge,
      minLiquidity: updated.minLiquidity,
      minTimeToExpiry: updated.minTimeToExpiry,
      confidencePenaltyPct: updated.confidencePenaltyPct,
      sportFilters: updated.sportFilters as string[],
      scanIntervalMinutes: updated.scanIntervalMinutes,
      pipelineActive: updated.pipelineActive,
    })
  );
});

export default router;
