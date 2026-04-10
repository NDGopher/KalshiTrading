/**
 * Market analysis for the trading pipeline — **keeper-only / rule-based**.
 * No Anthropic or other LLM calls (see `analyzeMarketRuleBased`).
 */
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

/** Conservative execution cushion on every edge / Kelly sizing (backtest-aligned). */
export const EDGE_EXECUTION_SLIPPAGE = 0.01;

/** Legacy hook — API cost tracking removed; pipeline always allowed. */
async function checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
  return { allowed: true };
}

/** YES taker: ask + 1¢ (capped). */
export function effectiveYesBuyPrice(candidate: ScanCandidate): number {
  const base = candidate.yesAsk ?? candidate.yesPrice;
  return Math.min(0.99, base + EDGE_EXECUTION_SLIPPAGE);
}

/**
 * NO taker: spec YES +1¢ / NO −1¢ on edge math — use ask − 1¢ when comparing NO probability
 * (slightly optimistic NO fill vs ask-only; still bounded).
 */
export function effectiveNoBuyPrice(candidate: ScanCandidate): number {
  const base = candidate.noAsk ?? 1 - candidate.yesPrice;
  return Math.min(0.99, Math.max(0.01, base - EDGE_EXECUTION_SLIPPAGE));
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
  const pNo = 1 - modelProb;
  const edge =
    side === "yes"
      ? Math.abs(modelProb - effectiveYesBuyPrice(candidate)) * 100
      : Math.abs(pNo - effectiveNoBuyPrice(candidate)) * 100;
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
