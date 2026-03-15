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
