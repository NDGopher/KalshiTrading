import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getOrder, getMarket } from "../kalshi-client.js";

// Kalshi taker fee formula: fee = ceil(0.07 × C × P × (1 − P))
// where C = contracts, P = entry price per contract (0–1 scale).
// This peaks at 3.5% effective rate around 50¢ and is much lower near extremes
// (e.g., 2.1% at 70¢, 1.4% at 80¢). The P×(1−P) term means high-priced contracts
// pay proportionally less in fees — important for NO bets near 70–80¢.
// Fee only applies to WINNING trades. Losses have no fee (stake is simply lost).
function kalshiTakerFee(contracts: number, entryPrice: number): number {
  return Math.ceil(0.07 * contracts * entryPrice * (1 - entryPrice) * 100) / 100;
}

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

      const lastPrice = parseFloat(String(market.last_price_dollars || "0"));

      if (market.result && market.result !== "") {
        const won =
          (trade.side === "yes" && market.result === "yes") ||
          (trade.side === "no" && market.result === "no");

        const grossProfit = trade.quantity * (1 - trade.entryPrice);
        const fee = won ? kalshiTakerFee(trade.quantity, trade.entryPrice) : 0;
        const payout = won ? grossProfit - fee : -trade.quantity * trade.entryPrice;

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

        const grossProfit = trade.quantity * (1 - trade.entryPrice);
        const fee = won ? kalshiTakerFee(trade.quantity, trade.entryPrice) : 0;
        const payout = won ? grossProfit - fee : -trade.quantity * trade.entryPrice;

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
        if (settings && won && payout > 0) {
          // Add back only the net profit (stake is never deducted when placing,
          // so only profit is added on win). This keeps balance = start + cumulative_profit.
          await db
            .update(tradingSettingsTable)
            .set({ paperBalance: settings.paperBalance + payout })
            .where(eq(tradingSettingsTable.id, settings.id));
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
