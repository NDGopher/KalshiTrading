import { kalshiCoarseMacroGroup, kalshiSportLabel } from "@workspace/backtester";
import { createOrder } from "../kalshi-client.js";
import { db, tradesTable, paperTradesTable, tradingSettingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import type { RiskDecision } from "./risk-manager.js";
import { compactKeeperReasoning } from "./analyst.js";
import { spreadCentsFromDollars, takerSpreadDollars } from "./execution-policy.js";

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

/** Postgres / Drizzle errors often hide `code` on the Error object — surface it for logs. */
function formatDbError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const any = err as Error & { code?: string; detail?: string; column?: string; hint?: string };
  const parts = [err.message];
  if (any.code) parts.push(`pg_code=${any.code}`);
  if (any.column) parts.push(`column=${any.column}`);
  if (any.detail) parts.push(`detail=${any.detail}`);
  if (any.hint) parts.push(`hint=${any.hint}`);
  return parts.join(" | ");
}

function finiteOr(n: unknown, fallback: number): number {
  if (typeof n === "number" && Number.isFinite(n)) return n;
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

async function executePaperTrade(decision: RiskDecision): Promise<ExecutionResult> {
  const { audit } = decision;
  const { analysis } = audit;
  const { candidate } = analysis;

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (!settings?.id) {
    return {
      decision,
      executed: false,
      error:
        "No trading_settings row — open Settings in the dashboard and save once (required for paper balance).",
      paper: true,
    };
  }
  const currentBalance = settings.paperBalance ?? 5000;
  const entryPrice = analysis.side === "yes" ? candidate.yesAsk : candidate.noAsk;
  if (entryPrice == null || entryPrice < 0.01 || entryPrice > 0.99) {
    return {
      decision,
      executed: false,
      error: `Paper trade blocked: no valid taker ask for ${analysis.side.toUpperCase()} on ${candidate.market.ticker}`,
      paper: true,
    };
  }
  const cost = decision.positionSize * entryPrice;
  const keeperReason = compactKeeperReasoning(analysis, decision.strategyReason ?? null);

  const [existingOpen] = await db
    .select({ id: paperTradesTable.id })
    .from(paperTradesTable)
    .where(and(eq(paperTradesTable.kalshiTicker, candidate.market.ticker), eq(paperTradesTable.status, "open")))
    .limit(1);

  if (existingOpen) {
    return {
      decision,
      executed: false,
      error: `Already have open paper position in ${candidate.market.ticker}`,
      paper: true,
    };
  }

  if (cost > currentBalance) {
    return {
      decision,
      executed: false,
      error: `Insufficient paper balance: need $${cost.toFixed(2)}, have $${currentBalance.toFixed(2)}`,
      paper: true,
    };
  }

  const quantity = Math.max(1, Math.min(10_000_000, Math.round(finiteOr(decision.positionSize, 0))));
  if (!Number.isFinite(entryPrice) || quantity < 1) {
    return {
      decision,
      executed: false,
      error: "Paper trade blocked: invalid entry price or contract count",
      paper: true,
    };
  }

  const flags = Array.isArray(audit.flags) ? audit.flags : [];
  const spreadCents = spreadCentsFromDollars(takerSpreadDollars(candidate, analysis.side));

  let paperTrade: { id: number };
  try {
    const [row] = await db
      .insert(paperTradesTable)
      .values({
        kalshiTicker: candidate.market.ticker,
        title: candidate.market.title || candidate.market.ticker,
        side: analysis.side,
        entryPrice,
        entrySpreadCents: spreadCents,
        quantity,
        status: "open",
        strategyName: decision.strategyName || null,
        modelProbability: finiteOr(analysis.modelProbability, 0),
        edge: finiteOr(analysis.edge, 0),
        confidence: finiteOr(audit.adjustedConfidence, 0),
        analystReasoning: keeperReason,
        auditorFlags: flags,
        riskScore: finiteOr(decision.riskScore, 0),
        kellyFraction: finiteOr(decision.kellyFraction, 0),
        simulatedBalance: finiteOr(currentBalance - cost, 0),
      })
      .returning();
    if (!row) {
      return { decision, executed: false, error: "Paper insert returned no row", paper: true };
    }
    paperTrade = row;

    await db
      .update(tradingSettingsTable)
      .set({ paperBalance: currentBalance - cost })
      .where(eq(tradingSettingsTable.id, settings.id));
  } catch (e: unknown) {
    const msg = formatDbError(e);
    console.error(`[PAPER_TRADE] DB error for ${candidate.market.ticker}:`, msg);
    const any = e as { code?: string };
    const hint42703 =
      msg.includes("42703") || /column .* does not exist/i.test(msg)
        ? " Database schema may be behind the app: run `pnpm db:push` from the repo root (uses DATABASE_URL)."
        : "";
    const hintDisk =
      any.code === "53100" || /project size limit|max_cluster_size|disk full/i.test(msg)
        ? " Hosted Postgres cluster is full (e.g. Neon 512MB free tier). Prune old rows (historical_markets, market_opportunities), upgrade plan, or use a larger instance."
        : "";
    return {
      decision,
      executed: false,
      error: `${msg}${hint42703}${hintDisk}`,
      paper: true,
    };
  }

  const sport = kalshiSportLabel(candidate.market.ticker);
  const coarse = kalshiCoarseMacroGroup(candidate.market);
  const winProb = analysis.side === "yes" ? analysis.modelProbability : 1 - analysis.modelProbability;
  const expectedEdgePerContract = winProb - entryPrice;
  const expectedPnlUsdApprox = expectedEdgePerContract * decision.positionSize;
  const dollarSize = cost;
  console.info(
    `[PAPER_TRADE] strategy=${decision.strategyName ?? "?"} ticker=${candidate.market.ticker} sport=${sport} bucket=${coarse} ask=${entryPrice.toFixed(4)} contracts=${decision.positionSize} dollars=$${dollarSize.toFixed(2)} spreadCents=${spreadCents} | ${keeperReason}`,
  );
  console.info(
    "[PAPER_TRADE_JSON]",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ticker: candidate.market.ticker,
      sport,
      bucket: coarse,
      side: analysis.side,
      entryAsk: entryPrice,
      spreadCents,
      contracts: decision.positionSize,
      dollarNotional: dollarSize,
      strategyName: decision.strategyName ?? null,
      edgeReason: keeperReason,
      edgePp: analysis.edge,
      expectedPnlUsdApprox,
      actualFillPrice: entryPrice,
    }),
  );

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
  const liveKeeperReason = compactKeeperReasoning(analysis, decision.strategyReason ?? null);

  const liveAsk = analysis.side === "yes" ? candidate.yesAsk : candidate.noAsk;
  if (liveAsk == null || liveAsk < 0.01 || liveAsk > 0.99) {
    return {
      decision,
      executed: false,
      error: `Live order blocked: missing taker ask for ${analysis.side} on ${candidate.market.ticker}`,
    };
  }

  const [pendingTrade] = await db
    .insert(tradesTable)
    .values({
      kalshiTicker: candidate.market.ticker,
      title: candidate.market.title || candidate.market.ticker,
      side: analysis.side,
      entryPrice: liveAsk,
      quantity: decision.positionSize,
      status: "pending",
      strategyName: decision.strategyName || null,
      modelProbability: analysis.modelProbability,
      edge: analysis.edge,
      confidence: audit.adjustedConfidence,
      analystReasoning: liveKeeperReason,
      auditorFlags: audit.flags,
      riskScore: decision.riskScore,
      kellyFraction: decision.kellyFraction,
    })
    .returning();

  let lastError: string = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const priceInCents = Math.round(liveAsk * 100);

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
