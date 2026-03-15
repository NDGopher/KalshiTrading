import { createOrder, getOrder } from "../kalshi-client.js";
import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { RiskDecision } from "./risk-manager.js";

export interface ExecutionResult {
  decision: RiskDecision;
  executed: boolean;
  orderId?: string;
  tradeId?: number;
  error?: string;
  paper?: boolean;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executePaperTrade(decision: RiskDecision): Promise<ExecutionResult> {
  const { audit } = decision;
  const { analysis } = audit;
  const { candidate } = analysis;

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  const currentBalance = settings?.paperBalance || 5000;
  const entryPrice = analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice;
  const cost = decision.positionSize * entryPrice;

  if (cost > currentBalance) {
    return {
      decision,
      executed: false,
      error: `Insufficient paper balance: need $${cost.toFixed(2)}, have $${currentBalance.toFixed(2)}`,
      paper: true,
    };
  }

  const [paperTrade] = await db
    .insert(paperTradesTable)
    .values({
      kalshiTicker: candidate.market.ticker,
      title: candidate.market.title || candidate.market.ticker,
      side: analysis.side,
      entryPrice,
      quantity: decision.positionSize,
      status: "open",
      strategyName: decision.strategyName || null,
      modelProbability: analysis.modelProbability,
      edge: analysis.edge,
      confidence: audit.adjustedConfidence,
      analystReasoning: analysis.reasoning,
      auditorFlags: audit.flags,
      riskScore: decision.riskScore,
      kellyFraction: decision.kellyFraction,
      simulatedBalance: currentBalance - cost,
    })
    .returning();

  await db
    .update(tradingSettingsTable)
    .set({ paperBalance: currentBalance - cost })
    .where(eq(tradingSettingsTable.id, settings!.id));

  return {
    decision,
    executed: true,
    tradeId: paperTrade.id,
    paper: true,
  };
}

export async function executeTrade(decision: RiskDecision, paperMode?: boolean): Promise<ExecutionResult> {
  if (!decision.approved) {
    return {
      decision,
      executed: false,
      error: decision.rejectReason || "Not approved by risk manager",
    };
  }

  if (paperMode) {
    return executePaperTrade(decision);
  }

  const { audit } = decision;
  const { analysis } = audit;
  const { candidate } = analysis;

  const [pendingTrade] = await db
    .insert(tradesTable)
    .values({
      kalshiTicker: candidate.market.ticker,
      title: candidate.market.title || candidate.market.ticker,
      side: analysis.side,
      entryPrice: analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice,
      quantity: decision.positionSize,
      status: "pending",
      strategyName: decision.strategyName || null,
      modelProbability: analysis.modelProbability,
      edge: analysis.edge,
      confidence: audit.adjustedConfidence,
      analystReasoning: analysis.reasoning,
      auditorFlags: audit.flags,
      riskScore: decision.riskScore,
      kellyFraction: decision.kellyFraction,
    })
    .returning();

  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const priceInCents = Math.round(
        (analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice) * 100
      );

      const orderParams: Parameters<typeof createOrder>[0] = {
        ticker: candidate.market.ticker,
        action: "buy",
        side: analysis.side as "yes" | "no",
        type: "limit",
        count: decision.positionSize,
      };

      if (analysis.side === "yes") {
        orderParams.yes_price = priceInCents;
      } else {
        orderParams.no_price = priceInCents;
      }

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
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : "Unknown execution error";
      console.error(`Execution attempt ${attempt}/${MAX_RETRIES} failed:`, lastError);

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  await db
    .update(tradesTable)
    .set({ status: "failed" })
    .where(eq(tradesTable.id, pendingTrade.id));

  return {
    decision,
    executed: false,
    tradeId: pendingTrade.id,
    error: `Failed after ${MAX_RETRIES} attempts: ${lastError}`,
  };
}
