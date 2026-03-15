import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getOrder, getMarket } from "../kalshi-client.js";

export interface ReconciliationResult {
  reconciled: number;
  settled: number;
  errors: number;
}

function computeClv(trade: typeof tradesTable.$inferSelect, closingPrice: number): number {
  const impliedEntryProb = trade.side === "yes" ? trade.entryPrice : 1 - trade.entryPrice;
  const impliedClosingProb = trade.side === "yes" ? closingPrice : 1 - closingPrice;
  return impliedClosingProb - impliedEntryProb;
}

export async function reconcileOpenTrades(): Promise<ReconciliationResult> {
  const openTrades = await db
    .select()
    .from(tradesTable)
    .where(inArray(tradesTable.status, ["open"]));

  let reconciled = 0;
  let settled = 0;
  let errors = 0;

  for (const trade of openTrades) {
    if (!trade.kalshiOrderId) {
      continue;
    }

    try {
      const { order } = await getOrder(trade.kalshiOrderId);

      if (order.status === "canceled" || order.status === "cancelled") {
        await db
          .update(tradesTable)
          .set({ status: "cancelled", pnl: 0, closedAt: new Date() })
          .where(eq(tradesTable.id, trade.id));
        reconciled++;
        continue;
      }

      const { market } = await getMarket(trade.kalshiTicker);

      const lastPrice = parseFloat(market.last_price_dollars || "0");
      const clv = lastPrice > 0 ? computeClv(trade, lastPrice) : null;

      if (market.result && market.result !== "") {
        const won =
          (trade.side === "yes" && market.result === "yes") ||
          (trade.side === "no" && market.result === "no");

        const payout = won ? trade.quantity * (1 - trade.entryPrice) : -trade.quantity * trade.entryPrice;

        const closingClv = computeClv(trade, won ? 1.0 : 0.0);

        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            exitPrice: won ? 1.0 : 0.0,
            pnl: payout,
            clv: closingClv,
            closedAt: new Date(),
          })
          .where(eq(tradesTable.id, trade.id));

        settled++;
        reconciled++;
      } else if (clv !== null && trade.clv === null) {
        await db
          .update(tradesTable)
          .set({ clv })
          .where(eq(tradesTable.id, trade.id));
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Reconciliation error for trade ${trade.id}:`, errMsg);
      errors++;
    }
  }

  return { reconciled, settled, errors };
}

export async function reconcilePaperTrades(): Promise<{ settled: number; errors: number }> {
  const openPaperTrades = await db
    .select()
    .from(paperTradesTable)
    .where(eq(paperTradesTable.status, "open"));

  let settled = 0;
  let errors = 0;

  for (const trade of openPaperTrades) {
    try {
      const { market } = await getMarket(trade.kalshiTicker);

      if (market.result && market.result !== "") {
        const won =
          (trade.side === "yes" && market.result === "yes") ||
          (trade.side === "no" && market.result === "no");

        const payout = won ? trade.quantity * (1 - trade.entryPrice) : -trade.quantity * trade.entryPrice;

        await db
          .update(paperTradesTable)
          .set({
            status: won ? "won" : "lost",
            exitPrice: won ? 1.0 : 0.0,
            pnl: payout,
            closedAt: new Date(),
          })
          .where(eq(paperTradesTable.id, trade.id));

        if (won) {
          const [settings] = await db.select().from(tradingSettingsTable).limit(1);
          if (settings) {
            const refund = trade.quantity * trade.entryPrice + payout;
            await db
              .update(tradingSettingsTable)
              .set({ paperBalance: settings.paperBalance + refund })
              .where(eq(tradingSettingsTable.id, settings.id));
          }
        }

        settled++;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Paper trade reconciliation error for ${trade.id}:`, errMsg);
      errors++;
    }
  }

  return { settled, errors };
}
