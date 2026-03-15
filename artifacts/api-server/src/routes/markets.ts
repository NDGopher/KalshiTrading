import { Router, type IRouter } from "express";
import { db, marketOpportunitiesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { runTradingCycle } from "../lib/agents/pipeline.js";
import {
  TriggerMarketScanResponse,
  GetMarketOpportunitiesResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/markets/scan", async (_req, res): Promise<void> => {
  const start = Date.now();
  try {
    const result = await runTradingCycle();
    const duration = (Date.now() - start) / 1000;

    res.json(
      TriggerMarketScanResponse.parse({
        marketsScanned: result.marketsScanned,
        opportunitiesFound: result.opportunitiesFound,
        scanDuration: duration,
        timestamp: new Date().toISOString(),
      })
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

router.get("/markets/opportunities", async (_req, res): Promise<void> => {
  const opportunities = await db
    .select()
    .from(marketOpportunitiesTable)
    .orderBy(desc(marketOpportunitiesTable.edge));

  res.json(
    GetMarketOpportunitiesResponse.parse(
      opportunities.map((o) => ({
        id: o.id,
        kalshiTicker: o.kalshiTicker,
        title: o.title,
        category: o.category,
        currentYesPrice: o.currentYesPrice,
        modelProbability: o.modelProbability,
        edge: o.edge,
        confidence: o.confidence,
        side: o.side,
        volume24h: o.volume24h,
        expiresAt: o.expiresAt.toISOString(),
        createdAt: o.createdAt.toISOString(),
      }))
    )
  );
});

export default router;
