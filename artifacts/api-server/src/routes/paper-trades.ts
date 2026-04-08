import { Router } from "express";
import {
  paperTradesTable,
  tradingSettingsTable,
  withTransactionStatementTimeout,
  type DbClient,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { getMarket, getMarketYesAsk, getMarketYesBid } from "../lib/kalshi-client.js";
import { reconcilePaperTrades } from "../lib/agents/reconciler.js";

const router = Router();

const RESET_TIMEOUT_MS = Math.min(120_000, Number(process.env.DB_RESET_STATEMENT_TIMEOUT_MS) || 45_000);
const ROUTE_DB_TIMEOUT_MS = Math.min(120_000, Number(process.env.DB_ROUTE_STATEMENT_TIMEOUT_MS) || 60_000);
const LIVE_ENRICH_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.PAPER_LIVE_ENRICH_CONCURRENCY) || 4));

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
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask > 0 ? ask : bid > 0 ? bid : 0;
      if (mid > 0.005 && mid < 0.995) return { currentPrice: mid, priceSource: "live" };
    } else {
      const yesMid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ask > 0 ? ask : bid > 0 ? bid : 0;
      if (yesMid > 0.005 && yesMid < 0.995) return { currentPrice: 1 - yesMid, priceSource: "live" };
    }
  } catch {
    /* Kalshi slow / rate limit */
  }
  return { currentPrice: entryPrice, priceSource: "entry_fallback" };
}

async function enrichTradesWithLivePrices<T extends { status: string; kalshiTicker: string; side: string; entryPrice: number; quantity: number }>(
  trades: T[],
): Promise<Array<T & { currentPrice: number; priceSource: "live" | "entry_fallback" | "settled"; unrealizedPnl?: number }>> {
  const out: Array<T & { currentPrice: number; priceSource: "live" | "entry_fallback" | "settled"; unrealizedPnl?: number }> = [];
  for (let i = 0; i < trades.length; i += LIVE_ENRICH_CONCURRENCY) {
    const slice = trades.slice(i, i + LIVE_ENRICH_CONCURRENCY);
    const batch = await Promise.all(
      slice.map(async (t) => {
        if (t.status !== "open") {
          return {
            ...t,
            currentPrice: (t as { exitPrice?: number | null }).exitPrice ?? t.entryPrice,
            priceSource: "settled" as const,
          };
        }
        const lp = await fetchLivePrice(t.kalshiTicker, t.side, t.entryPrice);
        const cost = t.quantity * t.entryPrice;
        const currentValue = t.quantity * lp.currentPrice;
        const unrealizedPnl = currentValue - cost;
        return { ...t, currentPrice: lp.currentPrice, priceSource: lp.priceSource, unrealizedPnl };
      }),
    );
    out.push(...batch);
  }
  return out;
}

router.get("/paper-trades", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    // Default: DB-only (fast). Pass enrichLive=1 for Kalshi mark-to-market on open rows.
    const enrichLive = req.query.enrichLive === "1" || req.query.enrichLive === "true";

    const trades = await withTransactionStatementTimeout(ROUTE_DB_TIMEOUT_MS, async (tx: DbClient) =>
      tx
        .select()
        .from(paperTradesTable)
        .orderBy(desc(paperTradesTable.createdAt))
        .limit(limit),
    );

    if (!enrichLive) {
      const slim = trades.map((t) => {
        if (t.status !== "open") {
          return { ...t, currentPrice: t.exitPrice ?? t.entryPrice, priceSource: "settled" as const };
        }
        return { ...t, currentPrice: t.entryPrice, priceSource: "entry_fallback" as const, unrealizedPnl: 0 };
      });
      return res.json({ trades: slim, enrichLive: false });
    }

    const enriched = await enrichTradesWithLivePrices(trades);
    return res.json({ trades: enriched, enrichLive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

router.get("/paper-trades/stats", async (req, res) => {
  try {
    let skipLive =
      req.query.skipLive === "1" ||
      req.query.skipLive === "true" ||
      req.query.fast === "1";
    const forceLiveOpen = req.query.liveOpen === "1" || req.query.liveOpen === "true";

    const [agg] = await withTransactionStatementTimeout(ROUTE_DB_TIMEOUT_MS, async (tx: DbClient) =>
      tx
        .select({
          totalTrades: sql<number>`count(*)::int`,
          openTrades: sql<number>`count(*) filter (where ${paperTradesTable.status} = 'open')::int`,
          closedTrades: sql<number>`count(*) filter (where ${paperTradesTable.status} in ('won','lost'))::int`,
          wins: sql<number>`count(*) filter (where ${paperTradesTable.status} = 'won')::int`,
          totalPnl: sql<string>`coalesce(sum(${paperTradesTable.pnl}) filter (where ${paperTradesTable.status} in ('won','lost')), 0)::text`,
        })
        .from(paperTradesTable),
    );

    const totalTrades = Number(agg?.totalTrades ?? 0);
    const openCount = Number(agg?.openTrades ?? 0);
    const closedCount = Number(agg?.closedTrades ?? 0);
    const wins = Number(agg?.wins ?? 0);
    const totalPnl = parseFloat(String(agg?.totalPnl ?? "0")) || 0;
    const winRate = closedCount > 0 ? wins / closedCount : 0;

    const START_BALANCE = 5000;

    let openPositionValue = 0;
    let openCostBasis = 0;
    let livePricesAvailable = true;

    // Many open legs → skip sequential Kalshi calls so /stats stays fast and does not hold the pool.
    const OPEN_LIVE_MAX = Math.min(100, Math.max(5, Number(process.env.PAPER_STATS_OPEN_LIVE_MAX) || 25));
    if (!forceLiveOpen && openCount > OPEN_LIVE_MAX) {
      skipLive = true;
    }

    if (!skipLive && openCount > 0) {
      const openRows = await withTransactionStatementTimeout(ROUTE_DB_TIMEOUT_MS, async (tx: DbClient) =>
        tx
          .select({
            kalshiTicker: paperTradesTable.kalshiTicker,
            side: paperTradesTable.side,
            entryPrice: paperTradesTable.entryPrice,
            quantity: paperTradesTable.quantity,
          })
          .from(paperTradesTable)
          .where(eq(paperTradesTable.status, "open"))
          .limit(500),
      );

      for (let i = 0; i < openRows.length; i += LIVE_ENRICH_CONCURRENCY) {
        const slice = openRows.slice(i, i + LIVE_ENRICH_CONCURRENCY);
        await Promise.all(
          slice.map(async (t) => {
            const lp = await fetchLivePrice(t.kalshiTicker, t.side, t.entryPrice);
            openPositionValue += t.quantity * lp.currentPrice;
            openCostBasis += t.quantity * t.entryPrice;
            if (lp.priceSource === "entry_fallback") livePricesAvailable = false;
          }),
        );
      }
    } else if (skipLive && openCount > 0) {
      const [costRow] = await withTransactionStatementTimeout(ROUTE_DB_TIMEOUT_MS, async (tx: DbClient) =>
        tx
          .select({
            openCost: sql<string>`coalesce(sum((${paperTradesTable.entryPrice} * ${paperTradesTable.quantity})::double precision), 0)::text`,
          })
          .from(paperTradesTable)
          .where(eq(paperTradesTable.status, "open")),
      );
      openCostBasis = parseFloat(String(costRow?.openCost ?? "0")) || 0;
      openPositionValue = openCostBasis;
      livePricesAvailable = false;
    }

    const unrealizedPnl = openPositionValue - openCostBasis;
    const totalPortfolioValue = START_BALANCE + totalPnl + unrealizedPnl;
    const cashBalance = START_BALANCE + totalPnl - openCostBasis;

    return res.json({
      paperBalance: cashBalance,
      totalPortfolioValue,
      unrealizedPnl,
      openPositionValue,
      livePricesAvailable,
      totalTrades,
      openTrades: openCount,
      closedTrades: closedCount,
      wins,
      losses: closedCount - wins,
      totalPnl,
      winRate,
      skipLive: !!skipLive,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

router.post("/paper-trades/reconcile", async (_req, res) => {
  try {
    const result = await reconcilePaperTrades();
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

router.get("/paper-trades/equity", async (_req, res) => {
  try {
    const allTrades = await withTransactionStatementTimeout(ROUTE_DB_TIMEOUT_MS * 2, async (tx: DbClient) =>
      tx.select().from(paperTradesTable).orderBy(paperTradesTable.createdAt),
    );

    const START_BALANCE = 5000;

    interface CfEvent {
      ts: number;
      label: string;
      delta: number;
      tradeId: number;
      type: "open" | "close";
    }

    const events: CfEvent[] = [];

    for (const t of allTrades) {
      const cost = t.entryPrice * t.quantity;
      events.push({
        ts: new Date(t.createdAt).getTime(),
        label: `${t.side.toUpperCase()} ${t.quantity}ct @ $${t.entryPrice.toFixed(2)} — ${t.title.slice(0, 40)}`,
        delta: -cost,
        tradeId: t.id,
        type: "open",
      });
      if ((t.status === "won" || t.status === "lost") && t.closedAt) {
        const netPnl = t.pnl ?? 0;
        const payout = t.status === "won" ? cost + netPnl : 0;
        events.push({
          ts: new Date(t.closedAt).getTime(),
          label:
            t.status === "won"
              ? `WON +$${netPnl.toFixed(2)} — ${t.title.slice(0, 40)}`
              : `LOST -$${cost.toFixed(2)} — ${t.title.slice(0, 40)}`,
          delta: payout,
          tradeId: t.id,
          type: "close",
        });
      }
    }

    events.sort((a, b) => a.ts - b.ts);

    const openSet = new Map<number, number>();
    let cash = START_BALANCE;
    const points: { date: string; portfolioValue: number; cashBalance: number; pnl: number; label: string }[] = [
      { date: "Start", portfolioValue: START_BALANCE, cashBalance: START_BALANCE, pnl: 0, label: "Starting balance" },
    ];

    for (const ev of events) {
      cash += ev.delta;
      if (ev.type === "open") {
        openSet.set(ev.tradeId, -ev.delta);
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

    const closed = allTrades.filter((t) => t.status === "won" || t.status === "lost");

    const median = (vals: number[]): number => {
      if (vals.length === 0) return 0;
      const sorted = [...vals].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    };

    interface StrategyAgg {
      name: string;
      trades: number;
      wins: number;
      edges: number[];
      totalPnl: number;
      invested: number;
    }
    const stratMap = new Map<string, StrategyAgg>();
    for (const t of allTrades) {
      const k = t.strategyName || "Unknown";
      if (!stratMap.has(k)) stratMap.set(k, { name: k, trades: 0, wins: 0, edges: [], totalPnl: 0, invested: 0 });
      const s = stratMap.get(k)!;
      s.trades++;
      s.invested += t.entryPrice * t.quantity;
      if (t.edge != null) s.edges.push(t.edge);
      if (t.pnl != null) s.totalPnl += t.pnl;
      if (t.status === "won") s.wins++;
    }
    const strategyStats = Array.from(stratMap.values()).map((s) => ({
      name: s.name,
      trades: s.trades,
      wins: s.wins,
      totalPnl: s.totalPnl,
      invested: s.invested,
      winRate: s.trades > 0 ? s.wins / s.trades : 0,
      medianEdge: median(s.edges),
      roi: s.invested > 0 ? s.totalPnl / s.invested : 0,
    }));

    const edgeBuckets: { bucket: string; count: number; wins: number; medianEdge: number; winRate: number }[] = [];
    const buckets = [
      [0, 5],
      [5, 10],
      [10, 15],
      [15, 20],
      [20, 30],
      [30, 50],
      [50, 999],
    ];
    for (const [lo, hi] of buckets) {
      const b = closed.filter((t) => (t.edge ?? 0) >= lo && (t.edge ?? 0) < hi);
      if (b.length === 0) continue;
      edgeBuckets.push({
        bucket: lo === 50 ? `50pp+` : `${lo}–${hi}pp`,
        count: b.length,
        wins: b.filter((t) => t.status === "won").length,
        medianEdge: median(b.map((t) => t.edge ?? 0)),
        winRate: b.filter((t) => t.status === "won").length / b.length,
      });
    }

    const confBuckets: { bucket: string; count: number; wins: number; winRate: number }[] = [];
    const confRanges = [
      [0, 40],
      [40, 60],
      [60, 75],
      [75, 90],
      [90, 100],
    ];
    for (const [lo, hi] of confRanges) {
      const b = closed.filter((t) => ((t.confidence ?? 0) * 100) >= lo && ((t.confidence ?? 0) * 100) < hi);
      if (b.length === 0) continue;
      confBuckets.push({
        bucket: `${lo}–${hi}%`,
        count: b.length,
        wins: b.filter((t) => t.status === "won").length,
        winRate: b.filter((t) => t.status === "won").length / b.length,
      });
    }

    return res.json({ points, strategyStats, edgeBuckets, confBuckets, startBalance: START_BALANCE });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

router.post("/paper-trades/reset", async (req, res) => {
  const asyncMode = req.query.async === "1" || req.query.async === "true";

  const runReset = () =>
    withTransactionStatementTimeout(RESET_TIMEOUT_MS, async (tx: DbClient) => {
      await tx.execute(sql`TRUNCATE TABLE paper_trades RESTART IDENTITY`);
      const [settings] = await tx.select().from(tradingSettingsTable).limit(1);
      if (settings) {
        await tx
          .update(tradingSettingsTable)
          .set({ paperBalance: 5000 })
          .where(eq(tradingSettingsTable.id, settings.id));
      }
    });

  if (asyncMode) {
    void runReset().catch((err: unknown) => console.error("[paper-trades/reset async]", err));
    return res.status(202).json({
      message: "Paper reset queued (async). TRUNCATE + balance update run in background.",
      async: true,
    });
  }

  try {
    await runReset();
    return res.json({ message: "Paper trading reset. Balance restored to $5,000." });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: msg });
  }
});

export default router;
