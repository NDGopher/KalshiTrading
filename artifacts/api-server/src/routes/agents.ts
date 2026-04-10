import { Router, type IRouter } from "express";
import { db, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  runTradingCycle,
  startPipeline,
  stopPipeline,
} from "../lib/agents/pipeline.js";
import {
  ToggleAgentPipelineBody,
  ToggleAgentPipelineResponse,
  RunTradingCycleResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/agents/toggle", async (req, res): Promise<void> => {
  const parsed = ToggleAgentPipelineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (settings) {
    await db
      .update(tradingSettingsTable)
      .set({ pipelineActive: parsed.data.active })
      .where(eq(tradingSettingsTable.id, settings.id));
  }

  if (parsed.data.active) {
    const interval = settings?.scanIntervalMinutes ?? 2;
    startPipeline(interval);
    res.json(
      ToggleAgentPipelineResponse.parse({
        active: true,
        message: `Pipeline started with ${interval} minute interval`,
      }),
    );
  } else {
    stopPipeline();
    res.json(
      ToggleAgentPipelineResponse.parse({
        active: false,
        message: "Pipeline stopped",
      }),
    );
  }
});

router.post("/agents/run-cycle", async (_req, res): Promise<void> => {
  const result = await runTradingCycle();
  res.json(
    RunTradingCycleResponse.parse({
      marketsScanned: result.marketsScanned,
      opportunitiesFound: result.opportunitiesFound,
      tradesExecuted: result.tradesExecuted,
      tradesSkipped: result.tradesSkipped,
      totalDuration: result.totalDuration,
      agentResults: result.agentResults.map((r) => ({
        id: 0,
        agentName: r.agentName,
        status: r.status,
        duration: r.duration,
        details: r.details,
        createdAt: new Date().toISOString(),
      })),
    }),
  );
});

export default router;
