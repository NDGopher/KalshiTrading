/**
 * Market analysis for the trading pipeline — **keeper-only / rule-based**.
 * No Anthropic or other LLM calls (see `analyzeMarketRuleBased`).
 */
import {
  apiCostsTable,
  tradingSettingsTable,
  withTransactionStatementTimeout,
  type DbClient,
} from "@workspace/db";
import { sql, gte } from "drizzle-orm";
import type { ScanCandidate } from "./scanner.js";

export interface AnalysisResult {
  candidate: ScanCandidate;
  modelProbability: number;
  edge: number;
  confidence: number;
  side: "yes" | "no";
  reasoning: string;
}

function deterministicHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export { checkBudget };

const BUDGET_DB_MS = Math.min(60_000, Number(process.env.DB_BUDGET_STATEMENT_TIMEOUT_MS) || 15_000);

async function checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
  try {
    return await withTransactionStatementTimeout(BUDGET_DB_MS, async (tx: DbClient) => {
      const [settings] = await tx.select().from(tradingSettingsTable).limit(1);
      if (!settings) return { allowed: true };

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const [dailyResult] = await tx
        .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
        .from(apiCostsTable)
        .where(gte(apiCostsTable.createdAt, startOfDay));
      const dailySpend = Number(dailyResult?.total || 0);

      const [monthlyResult] = await tx
        .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
        .from(apiCostsTable)
        .where(gte(apiCostsTable.createdAt, startOfMonth));
      const monthlySpend = Number(monthlyResult?.total || 0);

      if (settings.dailyBudgetUsd > 0 && dailySpend >= settings.dailyBudgetUsd) {
        return { allowed: false, reason: `Daily API budget exceeded: $${dailySpend.toFixed(2)} / $${settings.dailyBudgetUsd}` };
      }
      if (settings.monthlyBudgetUsd > 0 && monthlySpend >= settings.monthlyBudgetUsd) {
        return { allowed: false, reason: `Monthly API budget exceeded: $${monthlySpend.toFixed(2)} / $${settings.monthlyBudgetUsd}` };
      }

      return { allowed: true };
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[Analyst] checkBudget DB timed out or failed — allowing cycle:", msg);
    return { allowed: true };
  }
}

/** Blind pricing math aligned with JBecker replay (`blindReplayAnalysisForTick`). No LLM. */
export function analyzeMarketRuleBased(candidate: ScanCandidate): AnalysisResult {
  const yesPrice = candidate.yesPrice;
  const ph = candidate.priceHistory;
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const hash = deterministicHash(candidate.market.ticker + String(hourBucket));
  const hashFrac = (hash % 1000) / 1000;

  let skew = 0;
  if (ph) {
    skew = -(ph.currentVsMeanPct / 100) * 0.12;
  }
  const noise = ((hash % 100) - 50) / 2200;
  const modelProb = Math.max(0.04, Math.min(0.96, yesPrice + skew + noise + (hashFrac - 0.5) * 0.06));
  const side: "yes" | "no" = modelProb > yesPrice ? "yes" : "no";
  const edge = Math.abs(modelProb - yesPrice) * 100;
  const volumeBoost = Math.min(0.1, Math.max(0, candidate.volume24h) / 7000);
  const confidence = Math.min(0.88, 0.34 + edge / 110 + volumeBoost + hashFrac * 0.05);

  return {
    candidate,
    modelProbability: modelProb,
    edge,
    confidence,
    side,
    reasoning: `RB: ${edge.toFixed(1)}pp, ${(confidence * 100).toFixed(0)}% conf, mid=${(yesPrice * 100).toFixed(1)}¢`,
  };
}

/** One line for logs / API — prefer strategy line when present (keepers only). */
export function compactKeeperReasoning(analysis: AnalysisResult, strategyReason?: string | null): string {
  const s = strategyReason?.trim();
  if (s && s.length <= 160) return s;
  return `RB: ${analysis.edge.toFixed(1)}pp, ${(analysis.confidence * 100).toFixed(0)}% conf`;
}

export function analyzeMarketsRuleBased(candidates: ScanCandidate[]): AnalysisResult[] {
  return candidates.map(analyzeMarketRuleBased);
}

function createDefaultResult(candidate: ScanCandidate): AnalysisResult {
  return {
    candidate,
    modelProbability: candidate.yesPrice,
    edge: 0,
    confidence: 0,
    side: "yes",
    reasoning: "Analysis failed - using market price as default",
  };
}

/** Always rule-based (keeper stack). Async shape kept for pipeline compatibility. */
export async function analyzeMarkets(candidates: ScanCandidate[]): Promise<AnalysisResult[]> {
  return analyzeMarketsRuleBased(candidates);
}

export async function analyzeMarketsSimulated(candidates: ScanCandidate[]): Promise<AnalysisResult[]> {
  return analyzeMarketsRuleBased(candidates);
}

export async function analyzeMarket(candidate: ScanCandidate): Promise<AnalysisResult> {
  const budgetCheck = await checkBudget();
  if (!budgetCheck.allowed) {
    console.warn(`[Analyst] ${budgetCheck.reason}`);
    return createDefaultResult(candidate);
  }
  return analyzeMarketRuleBased(candidate);
}
