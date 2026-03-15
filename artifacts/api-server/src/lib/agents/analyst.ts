import { anthropic } from "@workspace/integrations-anthropic-ai";
import type { ScanCandidate } from "./scanner.js";

export interface AnalysisResult {
  candidate: ScanCandidate;
  modelProbability: number;
  edge: number;
  confidence: number;
  side: "yes" | "no";
  reasoning: string;
}

export async function analyzeMarket(candidate: ScanCandidate): Promise<AnalysisResult> {
  const { market, yesPrice, volume24h, liquidity, hoursToExpiry, spread } = candidate;

  const prompt = `You are a quantitative sports prediction market analyst. Analyze this Kalshi prediction market and provide your probability estimate.

Market: ${market.title || market.ticker}
Ticker: ${market.ticker}
Current Yes Price: $${yesPrice.toFixed(4)} (implies ${(yesPrice * 100).toFixed(1)}% probability)
Current Spread: $${spread.toFixed(4)}
24h Volume: ${volume24h}
Liquidity: $${liquidity.toFixed(2)}
Hours to Expiry: ${hoursToExpiry.toFixed(1)}

Based on your analysis:
1. What is your estimated true probability that "Yes" resolves? (0-100)
2. How confident are you in this estimate? (0-100)
3. Brief reasoning (2-3 sentences max)

Respond in EXACTLY this JSON format:
{"probability": <number 0-100>, "confidence": <number 0-100>, "reasoning": "<string>"}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

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
