import { db, tradesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getOrder, getMarket } from "../kalshi-client.js";

export interface ReconciliationResult {
  reconciled: number;
  settled: number;
  errors: number;
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

      if (market.result && market.result !== "") {
        const won =
          (trade.side === "yes" && market.result === "yes") ||
          (trade.side === "no" && market.result === "no");

        const payout = won ? trade.quantity * (1 - trade.entryPrice) : -trade.quantity * trade.entryPrice;

        await db
          .update(tradesTable)
          .set({
            status: won ? "won" : "lost",
            exitPrice: won ? 1.0 : 0.0,
            pnl: payout,
            closedAt: new Date(),
          })
          .where(eq(tradesTable.id, trade.id));

        settled++;
        reconciled++;
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Reconciliation error for trade ${trade.id}:`, errMsg);
      errors++;
    }
  }

  return { reconciled, settled, errors };
}
