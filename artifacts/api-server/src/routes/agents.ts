import { Router, type IRouter } from "express";
import { db, agentRunsTable, tradingSettingsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  getAgentStatuses,
  runTradingCycle,
  startPipeline,
  stopPipeline,
  isPipelineActive,
} from "../lib/agents/pipeline.js";
import {
  GetAgentStatusResponse,
  ListAgentRunsQueryParams,
  ListAgentRunsResponse,
  ToggleAgentPipelineBody,
  ToggleAgentPipelineResponse,
  RunTradingCycleResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/agents/status", async (_req, res): Promise<void> => {
  const statuses = getAgentStatuses();
  res.json(GetAgentStatusResponse.parse(statuses));
});

router.get("/agents/runs", async (req, res): Promise<void> => {
  const params = ListAgentRunsQueryParams.safeParse(req.query);
  const limit = params.success ? params.data.limit || 20 : 20;

  const runs = await db
    .select()
    .from(agentRunsTable)
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(limit);

  res.json(
    ListAgentRunsResponse.parse(
      runs.map((r) => ({
        id: r.id,
        agentName: r.agentName,
        status: r.status,
        duration: r.duration,
        details: r.details,
        createdAt: r.createdAt.toISOString(),
      }))
    )
  );
});

router.post("/agents/toggle", async (req, res): Promise<void> => {
  const parsed = ToggleAgentPipelineBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  if (parsed.data.active) {
    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    const interval = settings?.scanIntervalMinutes || 60;
    startPipeline(interval);
    res.json(
      ToggleAgentPipelineResponse.parse({
        active: true,
        message: `Pipeline started with ${interval} minute interval`,
      })
    );
  } else {
    stopPipeline();
    res.json(
      ToggleAgentPipelineResponse.parse({
        active: false,
        message: "Pipeline stopped",
      })
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
    })
  );
});

export default router;
