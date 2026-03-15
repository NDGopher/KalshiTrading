import { Router } from "express";
import { db, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { desc, eq, sql, inArray } from "drizzle-orm";
import { getMarket } from "../lib/kalshi-client.js";

const router = Router();

router.get("/paper-trades", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const trades = await db
      .select()
      .from(paperTradesTable)
      .orderBy(desc(paperTradesTable.createdAt))
      .limit(limit);
    res.json({ trades });
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

    res.json({
      paperBalance: settings?.paperBalance || 5000,
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
    const openTrades = await db
      .select()
      .from(paperTradesTable)
      .where(eq(paperTradesTable.status, "open"));

    let settled = 0;
    let errors = 0;

    for (const trade of openTrades) {
      try {
        const { market } = await getMarket(trade.kalshiTicker);
        if (market.result && market.result !== "") {
          const won =
            (trade.side === "yes" && market.result === "yes") ||
            (trade.side === "no" && market.result === "no");

          const pnl = won
            ? trade.quantity * (1 - trade.entryPrice)
            : -trade.quantity * trade.entryPrice;

          await db
            .update(paperTradesTable)
            .set({
              status: won ? "won" : "lost",
              exitPrice: won ? 1.0 : 0.0,
              pnl,
              closedAt: new Date(),
            })
            .where(eq(paperTradesTable.id, trade.id));

          const [settings] = await db.select().from(tradingSettingsTable).limit(1);
          if (settings) {
            const balanceChange = won
              ? trade.quantity * (1 - trade.entryPrice) + trade.quantity * trade.entryPrice
              : 0;
            await db
              .update(tradingSettingsTable)
              .set({ paperBalance: settings.paperBalance + balanceChange })
              .where(eq(tradingSettingsTable.id, settings.id));
          }

          settled++;
        }
      } catch {
        errors++;
      }
    }

    res.json({ settled, errors, total: openTrades.length });
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
