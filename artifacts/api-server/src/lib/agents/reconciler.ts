import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getOrder, getMarket } from "../kalshi-client.js";

export interface ReconciliationResult {
  reconciled: number;
  settled: number;
  errors: number;
}

function computeClv(trade: typeof tradesTable.$inferSelect, closingYesPrice: number): number {
  if (trade.side === "yes") {
    return closingYesPrice - trade.entryPrice;
  } else {
    const entryNoPrice = 1 - trade.entryPrice;
    const closingNoPrice = 1 - closingYesPrice;
    return closingNoPrice - entryNoPrice;
  }
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

      if (market.result && market.result !== "") {
        const won =
          (trade.side === "yes" && market.result === "yes") ||
          (trade.side === "no" && market.result === "no");

        const payout = won ? trade.quantity * (1 - trade.entryPrice) : -trade.quantity * trade.entryPrice;

        const finalClosingLine = trade.closingLinePrice ?? (lastPrice > 0 ? lastPrice : (won ? 1.0 : 0.0));
        const closingClv = computeClv(trade, finalClosingLine);

        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            exitPrice: won ? 1.0 : 0.0,
            pnl: payout,
            closingLinePrice: finalClosingLine,
            clv: closingClv,
            closedAt: new Date(),
          })
          .where(eq(tradesTable.id, trade.id));

        settled++;
        reconciled++;
      } else if (lastPrice > 0) {
        const rawEventStart = (market as unknown as Record<string, unknown>).event_start_time;
        const eventStart = typeof rawEventStart === "string"
          ? new Date(rawEventStart).getTime()
          : null;
        const now = Date.now();
        const isEventStarted = eventStart ? now >= eventStart : false;

        if (!trade.closingLinePrice || isEventStarted) {
          const clv = computeClv(trade, lastPrice);
          await db
            .update(tradesTable)
            .set({ closingLinePrice: lastPrice, clv })
            .where(eq(tradesTable.id, trade.id));
        }
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

        const [settings] = await db.select().from(tradingSettingsTable).limit(1);
        if (settings) {
          const balanceChange = won
            ? trade.quantity * (1 - trade.entryPrice) + trade.quantity * trade.entryPrice
            : 0;
          if (balanceChange > 0) {
            await db
              .update(tradingSettingsTable)
              .set({ paperBalance: settings.paperBalance + balanceChange })
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
