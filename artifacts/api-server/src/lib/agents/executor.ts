import { createOrder, getOrder } from "../kalshi-client.js";
import { db, tradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { RiskDecision } from "./risk-manager.js";

export interface ExecutionResult {
  decision: RiskDecision;
  executed: boolean;
  orderId?: string;
  tradeId?: number;
  error?: string;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeTrade(decision: RiskDecision): Promise<ExecutionResult> {
  if (!decision.approved) {
    return {
      decision,
      executed: false,
      error: decision.rejectReason || "Not approved by risk manager",
    };
  }

  const { audit } = decision;
  const { analysis } = audit;
  const { candidate } = analysis;

  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const priceInCents = Math.round(
        (analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice) * 100
      );

      const orderParams: any = {
        ticker: candidate.market.ticker,
        action: "buy" as const,
        side: analysis.side,
        type: "limit" as const,
        count: decision.positionSize,
      };

      if (analysis.side === "yes") {
        orderParams.yes_price = priceInCents;
      } else {
        orderParams.no_price = priceInCents;
      }

      const [pendingTrade] = await db
        .insert(tradesTable)
        .values({
          kalshiTicker: candidate.market.ticker,
          title: candidate.market.title || candidate.market.ticker,
          side: analysis.side,
          entryPrice: analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice,
          quantity: decision.positionSize,
          status: "pending",
          modelProbability: analysis.modelProbability,
          edge: analysis.edge,
          confidence: audit.adjustedConfidence,
          analystReasoning: analysis.reasoning,
          auditorFlags: audit.flags,
          riskScore: decision.riskScore,
          kellyFraction: decision.kellyFraction,
        })
        .returning();

      const result = await createOrder(orderParams);

      await db
        .update(tradesTable)
        .set({ status: "open", kalshiOrderId: result.order.order_id })
        .where(eq(tradesTable.id, pendingTrade.id));

      return {
        decision,
        executed: true,
        orderId: result.order.order_id,
        tradeId: pendingTrade.id,
      };
    } catch (error: any) {
      lastError = error.message || "Unknown execution error";
      console.error(`Execution attempt ${attempt}/${MAX_RETRIES} failed:`, lastError);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  const [trade] = await db
    .insert(tradesTable)
    .values({
      kalshiTicker: candidate.market.ticker,
      title: candidate.market.title || candidate.market.ticker,
      side: analysis.side,
      entryPrice: analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice,
      quantity: decision.positionSize,
      status: "pending",
      modelProbability: analysis.modelProbability,
      edge: analysis.edge,
      confidence: audit.adjustedConfidence,
      analystReasoning: analysis.reasoning,
      auditorFlags: audit.flags,
      riskScore: decision.riskScore,
      kellyFraction: decision.kellyFraction,
    })
    .returning();

  return {
    decision,
    executed: false,
    tradeId: trade.id,
    error: `Failed after ${MAX_RETRIES} attempts: ${lastError}`,
  };
}
