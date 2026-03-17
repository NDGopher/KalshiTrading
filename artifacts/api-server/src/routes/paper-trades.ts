import { Router } from "express";
import { db, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { getMarket, getMarketYesAsk, getMarketYesBid } from "../lib/kalshi-client.js";
import { reconcilePaperTrades } from "../lib/agents/reconciler.js";

const router = Router();

interface LivePrice {
  currentPrice: number;
  priceSource: "live" | "entry_fallback";
}

async function fetchLivePrice(ticker: string, side: string, entryPrice: number): Promise<LivePrice> {
  try {
    const { market } = await getMarket(ticker);
    const bid = getMarketYesBid(market);
    const ask = getMarketYesAsk(market);
    if (side === "yes") {
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask > 0 ? ask : bid > 0 ? bid : 0);
      if (mid > 0.005 && mid < 0.995) return { currentPrice: mid, priceSource: "live" };
    } else {
      const yesMid = bid > 0 && ask > 0 ? (bid + ask) / 2 : (ask > 0 ? ask : bid > 0 ? bid : 0);
      if (yesMid > 0.005 && yesMid < 0.995) return { currentPrice: 1 - yesMid, priceSource: "live" };
    }
  } catch {
  }
  return { currentPrice: entryPrice, priceSource: "entry_fallback" };
}

router.get("/paper-trades", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const trades = await db
      .select()
      .from(paperTradesTable)
      .orderBy(desc(paperTradesTable.createdAt))
      .limit(limit);

    const enriched = await Promise.all(
      trades.map(async (t) => {
        if (t.status !== "open") {
          return { ...t, currentPrice: t.exitPrice ?? t.entryPrice, priceSource: "settled" as const };
        }
        const lp = await fetchLivePrice(t.kalshiTicker, t.side, t.entryPrice);
        const cost = t.quantity * t.entryPrice;
        const currentValue = t.quantity * lp.currentPrice;
        const unrealizedPnl = currentValue - cost;
        return { ...t, currentPrice: lp.currentPrice, priceSource: lp.priceSource, unrealizedPnl };
      })
    );

    res.json({ trades: enriched });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/paper-trades/stats", async (_req, res) => {
  try {
    const allTrades = await db.select().from(paperTradesTable);
    const closed = allTrades.filter((t) => t.status === "won" || t.status === "lost");
    const open = allTrades.filter((t) => t.status === "open");
    const wins = closed.filter((t) => t.status === "won");
    const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const winRate = closed.length > 0 ? wins.length / closed.length : 0;

    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    const cashBalance = settings?.paperBalance || 5000;

    let openPositionValue = 0;
    let openCostBasis = 0;
    let livePricesAvailable = true;

    for (const t of open) {
      const lp = await fetchLivePrice(t.kalshiTicker, t.side, t.entryPrice);
      openPositionValue += t.quantity * lp.currentPrice;
      openCostBasis += t.quantity * t.entryPrice;
      if (lp.priceSource === "entry_fallback") livePricesAvailable = false;
    }

    const unrealizedPnl = openPositionValue - openCostBasis;
    const totalPortfolioValue = cashBalance + openPositionValue;

    res.json({
      paperBalance: cashBalance,
      totalPortfolioValue,
      unrealizedPnl,
      openPositionValue,
      livePricesAvailable,
      totalTrades: allTrades.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: closed.length - wins.length,
      totalPnl,
      winRate,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/paper-trades/reconcile", async (_req, res) => {
  try {
    const result = await reconcilePaperTrades();
    res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/paper-trades/reset", async (_req, res) => {
  try {
    await db.delete(paperTradesTable);
    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    if (settings) {
      await db
        .update(tradingSettingsTable)
        .set({ paperBalance: 5000 })
        .where(eq(tradingSettingsTable.id, settings.id));
    }
    res.json({ message: "Paper trading reset. Balance restored to $5,000." });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
