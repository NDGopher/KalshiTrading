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

/**
 * GET /paper-trades/equity
 * Returns a time-ordered equity curve built from actual trade open/close events.
 * Two cash-flow events per closed trade (debit at open, credit at close).
 * Open positions are held at cost-basis (no mark-to-market since we lack historical prices).
 */
router.get("/paper-trades/equity", async (_req, res) => {
  try {
    const START_BALANCE = 5000;
    const allTrades = await db
      .select()
      .from(paperTradesTable)
      .orderBy(paperTradesTable.createdAt);

    // Build a flat list of cash-flow events
    interface CfEvent {
      ts: number;
      label: string;
      delta: number; // positive = cash in, negative = cash out
      tradeId: number;
      type: "open" | "close";
    }

    const events: CfEvent[] = [];

    for (const t of allTrades) {
      const cost = t.entryPrice * t.quantity;
      // Opening event: cash goes out
      events.push({
        ts: new Date(t.createdAt).getTime(),
        label: `${t.side.toUpperCase()} ${t.quantity}ct @ $${t.entryPrice.toFixed(2)} — ${t.title.slice(0, 40)}`,
        delta: -cost,
        tradeId: t.id,
        type: "open",
      });
      // Closing event (if resolved): cash comes back in based on result
      if ((t.status === "won" || t.status === "lost") && t.closedAt) {
        const payout = t.status === "won" ? t.quantity * 1.0 : 0;
        events.push({
          ts: new Date(t.closedAt).getTime(),
          label: t.status === "won"
            ? `WON +$${((payout - cost)).toFixed(2)} — ${t.title.slice(0, 40)}`
            : `LOST -$${cost.toFixed(2)} — ${t.title.slice(0, 40)}`,
          delta: payout,
          tradeId: t.id,
          type: "close",
        });
      }
    }

    // Sort all events by timestamp
    events.sort((a, b) => a.ts - b.ts);

    // Build equity curve — track which trades are "open" at each event
    // for a more accurate portfolio value (cash + cost-basis of open positions)
    const openSet = new Map<number, number>(); // tradeId → cost

    let cash = START_BALANCE;
    const points: { date: string; portfolioValue: number; cashBalance: number; pnl: number; label: string }[] = [
      { date: "Start", portfolioValue: START_BALANCE, cashBalance: START_BALANCE, pnl: 0, label: "Starting balance" },
    ];

    for (const ev of events) {
      cash += ev.delta;
      if (ev.type === "open") {
        openSet.set(ev.tradeId, -ev.delta); // cost = |delta|
      } else {
        openSet.delete(ev.tradeId);
      }
      const openValue = Array.from(openSet.values()).reduce((s, c) => s + c, 0);
      const portfolioValue = cash + openValue;
      points.push({
        date: new Date(ev.ts).toISOString(),
        portfolioValue: Math.round(portfolioValue * 100) / 100,
        cashBalance: Math.round(cash * 100) / 100,
        pnl: Math.round((portfolioValue - START_BALANCE) * 100) / 100,
        label: ev.label,
      });
    }

    // Analytics: category and edge-vs-outcome
    const closed = allTrades.filter(t => t.status === "won" || t.status === "lost");

    interface StrategyAgg {
      name: string;
      trades: number;
      wins: number;
      totalEdge: number;
      totalPnl: number;
      invested: number;
    }
    const stratMap = new Map<string, StrategyAgg>();
    for (const t of allTrades) {
      const k = t.strategyName || "Unknown";
      if (!stratMap.has(k)) stratMap.set(k, { name: k, trades: 0, wins: 0, totalEdge: 0, totalPnl: 0, invested: 0 });
      const s = stratMap.get(k)!;
      s.trades++;
      s.invested += t.entryPrice * t.quantity;
      if (t.edge != null) s.totalEdge += t.edge;
      if (t.pnl != null) s.totalPnl += t.pnl;
      if (t.status === "won") s.wins++;
    }
    const strategyStats = Array.from(stratMap.values()).map(s => ({
      ...s,
      winRate: s.trades > 0 ? s.wins / s.trades : 0,
      avgEdge: s.trades > 0 ? s.totalEdge / s.trades : 0,
      roi: s.invested > 0 ? s.totalPnl / s.invested : 0,
    }));

    // Edge buckets for calibration
    const edgeBuckets: { bucket: string; count: number; wins: number; avgEdge: number; winRate: number }[] = [];
    const buckets = [[0,5],[5,10],[10,15],[15,20],[20,30],[30,50],[50,100]];
    for (const [lo, hi] of buckets) {
      const b = closed.filter(t => (t.edge ?? 0) >= lo && (t.edge ?? 0) < hi);
      if (b.length === 0) continue;
      edgeBuckets.push({
        bucket: `${lo}–${hi}%`,
        count: b.length,
        wins: b.filter(t => t.status === "won").length,
        avgEdge: b.reduce((s, t) => s + (t.edge ?? 0), 0) / b.length,
        winRate: b.filter(t => t.status === "won").length / b.length,
      });
    }

    // Confidence buckets
    const confBuckets: { bucket: string; count: number; wins: number; winRate: number }[] = [];
    const confRanges = [[0,40],[40,60],[60,75],[75,90],[90,100]];
    for (const [lo, hi] of confRanges) {
      const b = closed.filter(t => ((t.confidence ?? 0) * 100) >= lo && ((t.confidence ?? 0) * 100) < hi);
      if (b.length === 0) continue;
      confBuckets.push({
        bucket: `${lo}–${hi}%`,
        count: b.length,
        wins: b.filter(t => t.status === "won").length,
        winRate: b.filter(t => t.status === "won").length / b.length,
      });
    }

    res.json({ points, strategyStats, edgeBuckets, confBuckets, startBalance: START_BALANCE });
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
