import { Router, type IRouter } from "express";
import { db, agentRunsTable, tradingSettingsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  getAgentStatuses,
  runTradingCycle,
  startPipeline,
  stopPipeline,
  isPipelineActive,
  getLastCycleSummary,
  getNewsFetcherInfo,
} from "../lib/agents/pipeline.js";
import { runLearner, getLatestLearnings, getLearningHistory } from "../lib/agents/learner.js";
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

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (settings) {
    await db.update(tradingSettingsTable).set({ pipelineActive: parsed.data.active }).where(eq(tradingSettingsTable.id, settings.id));
  }

  if (parsed.data.active) {
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

router.get("/agents/last-cycle", (_req, res): void => {
  const summary = getLastCycleSummary();
  res.json(summary);
});

router.get("/agents/news-status", (_req, res): void => {
  res.json(getNewsFetcherInfo());
});

router.get("/agents/learnings", async (_req, res): Promise<void> => {
  const latest = await getLatestLearnings();
  const history = await getLearningHistory();
  res.json({ latest, history });
});

router.post("/agents/learnings/run", async (_req, res): Promise<void> => {
  try {
    const result = await runLearner();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
