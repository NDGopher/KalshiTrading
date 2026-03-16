import { Router } from "express";
import { db, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { runBacktest } from "../lib/backtester.js";
import { getStrategyNames } from "../lib/strategies/index.js";
import { ingestSettledMarkets, getIngestionStats } from "../lib/historical-ingestion.js";

const router = Router();

router.get("/backtest/strategies", (_req, res) => {
  res.json({ strategies: getStrategyNames() });
});

router.post("/backtest/run", async (req, res) => {
  try {
    const {
      strategyName = "Pure Value",
      startDate,
      endDate,
      initialBankroll = 5000,
      maxPositionPct = 5,
      kellyFraction = 0.25,
      minEdge = 5,
      minLiquidity = 0,
      useAiAnalysis = true,
    } = req.body;

    if (!startDate || !endDate) {
      res.status(400).json({ error: "startDate and endDate are required" });
      return;
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start >= end) {
      res.status(400).json({ error: "Invalid date range: startDate must be before endDate" });
      return;
    }

    const validStrategies = getStrategyNames();
    if (strategyName !== "All" && !validStrategies.includes(strategyName)) {
      res.status(400).json({ error: `Invalid strategy. Valid: All, ${validStrategies.join(", ")}` });
      return;
    }

    const strategiesToRun = strategyName === "All" ? validStrategies : [strategyName];
    const runIds: number[] = [];

    for (const strat of strategiesToRun) {
      const runId = await runBacktest({
        strategyName: strat,
        startDate,
        endDate,
        initialBankroll,
        maxPositionPct,
        kellyFraction,
        minEdge,
        minLiquidity,
        useAiAnalysis,
      });
      runIds.push(runId);
    }

    res.json({
      runIds,
      runId: runIds[0],
      message: strategiesToRun.length > 1
        ? `Backtest completed for ${strategiesToRun.length} strategies`
        : "Backtest completed",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

function computeStrategyAggregates(runs: (typeof backtestRunsTable.$inferSelect)[]) {
  const completed = runs.filter((r) => r.status === "completed");
  const strategyMap = new Map<string, {
    runs: number; totalPnl: number; totalWinRate: number; winRateCount: number;
    totalRoi: number; roiCount: number;
    totalClv: number; clvCount: number;
    totalSharpe: number; sharpeCount: number;
    totalTrades: number; dipCatchAttempts: number; dipCatchRate: number;
    bestRun: typeof completed[0] | null;
  }>();
  for (const run of completed) {
    const existing = strategyMap.get(run.strategyName) || {
      runs: 0, totalPnl: 0, totalWinRate: 0, winRateCount: 0, totalRoi: 0, roiCount: 0,
      totalClv: 0, clvCount: 0, totalSharpe: 0, sharpeCount: 0,
      totalTrades: 0, dipCatchAttempts: 0, dipCatchRate: 0, bestRun: null,
    };
    existing.runs++;
    existing.totalPnl += parseFloat(String(run.totalPnl)) || 0;
    if (run.tradesSimulated > 0) {
      existing.totalWinRate += parseFloat(String(run.winRate)) || 0;
      existing.winRateCount++;
    }
    existing.totalTrades += run.tradesSimulated;
    if (run.roi != null) { existing.totalRoi += parseFloat(String(run.roi)) || 0; existing.roiCount++; }
    if (run.avgClv != null) { existing.totalClv += parseFloat(String(run.avgClv)) || 0; existing.clvCount++; }
    if (run.sharpeRatio != null) { existing.totalSharpe += parseFloat(String(run.sharpeRatio)) || 0; existing.sharpeCount++; }
    if (run.dipCatchSuccessRate != null) { existing.dipCatchAttempts++; existing.dipCatchRate += parseFloat(String(run.dipCatchSuccessRate)) || 0; }
    if (!existing.bestRun || run.totalPnl > existing.bestRun.totalPnl) existing.bestRun = run;
    strategyMap.set(run.strategyName, existing);
  }
  return Array.from(strategyMap.entries()).map(([name, data]) => ({
    strategyName: name,
    totalRuns: data.runs,
    totalTrades: data.totalTrades,
    avgPnl: data.runs > 0 ? data.totalPnl / data.runs : 0,
    avgWinRate: data.winRateCount > 0 ? data.totalWinRate / data.winRateCount : 0,
    avgRoi: data.roiCount > 0 ? data.totalRoi / data.roiCount : null,
    avgClv: data.clvCount > 0 ? data.totalClv / data.clvCount : null,
    avgSharpe: data.sharpeCount > 0 ? data.totalSharpe / data.sharpeCount : null,
    dipCatchSuccessRate: data.dipCatchAttempts > 0 ? data.dipCatchRate / data.dipCatchAttempts : null,
    bestRunId: data.bestRun?.id ?? null,
    bestRunPnl: data.bestRun?.totalPnl ?? null,
  }));
}

router.get("/backtest/results", async (_req, res) => {
  try {
    const runs = await db
      .select()
      .from(backtestRunsTable)
      .orderBy(desc(backtestRunsTable.createdAt))
      .limit(50);
    const strategyAggregates = computeStrategyAggregates(runs);
    res.json({ runs, strategyAggregates });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/backtest/trades", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const offset = (page - 1) * limit;
    const runId = req.query.runId ? parseInt(req.query.runId as string, 10) : undefined;

    let query = db.select().from(backtestTradesTable);
    if (runId && !isNaN(runId)) {
      query = query.where(eq(backtestTradesTable.backtestRunId, runId)) as typeof query;
    }

    const trades = await query
      .orderBy(desc(backtestTradesTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({ trades, page, limit });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/backtest/trades/:runId", async (req, res) => {
  try {
    const runId = parseInt(req.params.runId, 10);
    if (isNaN(runId)) {
      res.status(400).json({ error: "Invalid runId" });
      return;
    }
    const trades = await db
      .select()
      .from(backtestTradesTable)
      .where(eq(backtestTradesTable.backtestRunId, runId))
      .orderBy(desc(backtestTradesTable.createdAt));
    res.json({ trades });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/backtest/strategy-summary", async (_req, res) => {
  try {
    const runs = await db
      .select()
      .from(backtestRunsTable)
      .orderBy(desc(backtestRunsTable.completedAt));
    const strategies = computeStrategyAggregates(runs);
    res.json({ strategies });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/backtest/ingest", async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) {
      res.status(400).json({ error: "startDate and endDate are required" });
      return;
    }
    const result = await ingestSettledMarkets(startDate, endDate);
    res.json({ message: "Ingestion complete", ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/backtest/ingestion-stats", async (_req, res) => {
  try {
    const stats = await getIngestionStats();
    res.json(stats);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
