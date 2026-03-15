import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, apiCostsTable, tradingSettingsTable } from "@workspace/db";
import { sql, gte, and } from "drizzle-orm";
import type { ScanCandidate } from "./scanner.js";

export interface AnalysisResult {
  candidate: ScanCandidate;
  modelProbability: number;
  edge: number;
  confidence: number;
  side: "yes" | "no";
  reasoning: string;
}

const HAIKU_INPUT_COST_PER_M = 0.25;
const HAIKU_OUTPUT_COST_PER_M = 0.80;

export { checkBudget };

async function checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (!settings) return { allowed: true };

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dailyResult] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
    .from(apiCostsTable)
    .where(gte(apiCostsTable.createdAt, startOfDay));
  const dailySpend = Number(dailyResult?.total || 0);

  const [monthlyResult] = await db
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
}

async function logApiCost(model: string, inputTokens: number, outputTokens: number, agentName: string, marketTicker?: string): Promise<void> {
  const costUsd = (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M + (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
  await db.insert(apiCostsTable).values({
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    costUsd,
    agentName,
    marketTicker,
  });
}

function deriveMarketSignals(candidate: ScanCandidate) {
  const { yesPrice, volume24h, liquidity, hoursToExpiry, spread } = candidate;
  const impliedProb = yesPrice * 100;
  const spreadPct = yesPrice > 0 ? (spread / yesPrice) * 100 : 0;
  const volumeToLiquidity = liquidity > 0 ? volume24h / liquidity : 0;
  const isHighVolume = volume24h > 500;
  const isNarrowSpread = spreadPct < 5;
  const timeCategory = hoursToExpiry < 2 ? "imminent" : hoursToExpiry < 12 ? "near-term" : hoursToExpiry < 48 ? "medium-term" : "long-term";
  const priceRegion = impliedProb < 20 ? "heavy-underdog" : impliedProb < 40 ? "underdog" : impliedProb < 60 ? "toss-up" : impliedProb < 80 ? "favorite" : "heavy-favorite";
  const marketEfficiency = isHighVolume && isNarrowSpread ? "high" : isHighVolume || isNarrowSpread ? "medium" : "low";

  return { impliedProb, spreadPct, volumeToLiquidity, timeCategory, priceRegion, marketEfficiency };
}

export async function analyzeMarket(candidate: ScanCandidate): Promise<AnalysisResult> {
  const budgetCheck = await checkBudget();
  if (!budgetCheck.allowed) {
    console.warn(`[Analyst] ${budgetCheck.reason}`);
    return createDefaultResult(candidate);
  }

  const { market, yesPrice, volume24h, liquidity, hoursToExpiry, spread } = candidate;
  const signals = deriveMarketSignals(candidate);

  const prompt = `You are a quantitative sports prediction market analyst specializing in NFL, NBA, MLB, and Soccer markets. Analyze this Kalshi prediction market using multiple analytical lenses.

## Market Data
- Title: ${market.title || market.ticker}
- Ticker: ${market.ticker}
- Category: ${market.category || "Sports"}
- Yes Price: $${yesPrice.toFixed(4)} (implied probability: ${signals.impliedProb.toFixed(1)}%)
- Spread: $${spread.toFixed(4)} (${signals.spreadPct.toFixed(1)}% relative)
- 24h Volume: ${volume24h} contracts
- Liquidity: $${liquidity.toFixed(2)}
- Time to Expiry: ${hoursToExpiry.toFixed(1)} hours (${signals.timeCategory})

## Derived Statistical Signals
- Price Region: ${signals.priceRegion} (${signals.impliedProb.toFixed(1)}% implied)
- Volume/Liquidity Ratio: ${signals.volumeToLiquidity.toFixed(2)} (${signals.volumeToLiquidity > 3 ? "heavy flow suggests informed trading" : "normal flow"})
- Market Efficiency: ${signals.marketEfficiency} (${signals.marketEfficiency === "high" ? "tight spread + high volume = hard to find edge" : signals.marketEfficiency === "low" ? "wide spread or low volume = possible mispricing" : "moderate efficiency"})

## Analysis Framework
Apply these lenses in your evaluation:
1. **Market Microstructure**: Is the implied probability well-calibrated given volume patterns? Heavy one-sided flow near expiry often signals informed money.
2. **Sports Fundamentals**: Based on the event description, what do known sports factors (home/away, matchup history, recent form, injuries, weather) suggest?
3. **Sentiment & Public Bias**: Public bettors tend to overvalue favorites and overs. Is there evidence of public bias in the pricing?
4. **Statistical Edge**: Markets with ${signals.marketEfficiency} efficiency in the ${signals.priceRegion} region have known calibration patterns. Consider whether the implied probability matches historical base rates for similar events.

## Instructions
Provide your true probability estimate, confidence level, and reasoning that explicitly references at least 2 of the analysis lenses above.

Respond in EXACTLY this JSON format:
{"probability": <number 0-100>, "confidence": <number 0-100>, "reasoning": "<string referencing specific signals>"}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const inputTokens = message.usage?.input_tokens || 0;
    const outputTokens = message.usage?.output_tokens || 0;
    await logApiCost("claude-haiku-4-5", inputTokens, outputTokens, "Analyst", market.ticker);

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createDefaultResult(candidate);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const modelProb = Math.max(1, Math.min(99, parsed.probability)) / 100;
    const confidence = Math.max(1, Math.min(100, parsed.confidence)) / 100;

    const yesSide = modelProb > yesPrice;
    const side: "yes" | "no" = yesSide ? "yes" : "no";
    const edge = yesSide
      ? (modelProb - yesPrice) / yesPrice * 100
      : ((1 - modelProb) - (1 - yesPrice)) / (1 - yesPrice) * 100;

    return {
      candidate,
      modelProbability: modelProb,
      edge: Math.max(0, edge),
      confidence,
      side,
      reasoning: parsed.reasoning || "No reasoning provided",
    };
  } catch (error) {
    console.error("Analyst error:", error);
    return createDefaultResult(candidate);
  }
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

export async function analyzeMarkets(candidates: ScanCandidate[]): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = [];
  const batchSize = 3;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(analyzeMarket));
    results.push(...batchResults);
  }

  return results;
}
