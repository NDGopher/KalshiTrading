import { Router } from "express";
import { db, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { runBacktest } from "../lib/backtester.js";
import { getStrategyNames } from "../lib/strategies/index.js";

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
      minLiquidity = 100,
      useAiAnalysis = false,
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
    if (!validStrategies.includes(strategyName)) {
      res.status(400).json({ error: `Invalid strategy. Valid: ${validStrategies.join(", ")}` });
      return;
    }

    const runId = await runBacktest({
      strategyName,
      startDate,
      endDate,
      initialBankroll,
      maxPositionPct,
      kellyFraction,
      minEdge,
      minLiquidity,
      useAiAnalysis,
    });

    res.json({ runId, message: "Backtest completed" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/backtest/results", async (_req, res) => {
  try {
    const runs = await db
      .select()
      .from(backtestRunsTable)
      .orderBy(desc(backtestRunsTable.createdAt))
      .limit(20);
    res.json({ runs });
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

export default router;
