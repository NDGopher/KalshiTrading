import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";
import { getMarketYesAsk, getMarketYesBid } from "../kalshi-client.js";

export interface StrategyMetadata {
  dipCatch?: boolean;
  distanceFromPeak?: number;
  volumeSurge?: number;
  hoursRemaining?: number;
  publicBiasScore?: number;
  reversalMagnitude?: number;
  sharpScore?: number;
}

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string; metadata?: StrategyMetadata };
}

/**
 * Resolves the open price for a scan candidate, handling two formats:
 * - Kalshi API format: `open_price` in cents (0-100 integer)
 * - Backtester format: `_openPrice` as 0-1 float (injected from historical_markets DB)
 * Returns null if no open price is available.
 */
function resolveOpenPrice(candidate: ScanCandidate): number | null {
  const raw = candidate.market as unknown as Record<string, number | undefined>;

  // Backtester injects _openPrice as 0-1 float
  if (raw._openPrice != null && raw._openPrice > 0 && raw._openPrice < 1.5) {
    return raw._openPrice as number;
  }

  // Kalshi API provides open_price in cents (0-100)
  if (raw.open_price != null && raw.open_price > 0) {
    const asCents = raw.open_price as number;
    return asCents > 1 ? asCents / 100 : asCents;
  }

  return null;
}

// Strategy 1: Pure Value
// Trades when the model finds a meaningful probability divergence from market price.
// No directional bias — model decides YES or NO based on true probability estimate.
const pureValue: Strategy = {
  name: "Pure Value",
  description: "Trades when model probability diverges significantly from market price, regardless of direction.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice > 0.05 && c.yesPrice < 0.95);
  },
  shouldTrade(analysis) {
    if (analysis.edge >= 4 && analysis.confidence >= 0.38) {
      return { trade: true, reason: `Pure value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence` };
    }
    return { trade: false, reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}pp, conf=${(analysis.confidence * 100).toFixed(0)}%` };
  },
};

// Strategy 2: Sharp Money
// Follows volume surges on liquid markets — elevated volume/liquidity ratio indicates informed
// traders ("sharps") are moving the market. Model still decides bet direction.
const sharpMoney: Strategy = {
  name: "Sharp Money",
  description: "Trades markets with elevated informed volume flow (high volume/liquidity ratio). Sharps are active — follow the AI's probability edge.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const hasVolume = c.volume24h > 100 || c.liquidity > 5000;
      return hasVolume && c.yesPrice > 0.05 && c.yesPrice < 0.95;
    });
  },
  shouldTrade(analysis) {
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeToLiquidity = Math.min(volume / liquidity, 10);

    const sharpScore = volumeToLiquidity * analysis.edge;

    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && volumeToLiquidity >= 0.5) {
      return {
        trade: true,
        reason: `Sharp money: ${analysis.edge.toFixed(1)}pp edge, vol/liq=${volumeToLiquidity.toFixed(2)}, sharp score=${sharpScore.toFixed(1)}`,
        metadata: { sharpScore, volumeSurge: volumeToLiquidity },
      };
    }
    return { trade: false, reason: `No sharp signal (edge=${analysis.edge.toFixed(1)}pp, vol/liq=${volumeToLiquidity.toFixed(2)})` };
  },
};

// Strategy 3: Contrarian Reversal
// When a market has moved sharply away from its opening price AND the model thinks it has
// overshot, bet the reversal. Works for all market types (elections, sports, etc.).
const contrarianReversal: Strategy = {
  name: "Contrarian Reversal",
  description: "Bets against sharp price overreactions when the AI model identifies the market has overshot fair value.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const openPrice = resolveOpenPrice(c);
      if (!openPrice) return false;

      const priceMoveAbsolute = Math.abs(c.yesPrice - openPrice);
      const priceMoveRelative = openPrice > 0 ? priceMoveAbsolute / openPrice : 0;
      return priceMoveRelative > 0.08 && c.yesPrice > 0.05 && c.yesPrice < 0.95;
    });
  },
  shouldTrade(analysis) {
    const currentPrice = analysis.candidate.yesPrice;
    const openPrice = resolveOpenPrice(analysis.candidate) ?? currentPrice;

    const priceMove = currentPrice - openPrice;
    const modelMove = analysis.modelProbability - openPrice;

    // Reversal signal: price moved one direction, model points the other way
    const isContrarian = (priceMove > 0 && modelMove < 0) || (priceMove < 0 && modelMove > 0);
    const reversalMagnitude = Math.abs(priceMove / Math.max(0.01, openPrice)) * 100;

    if (isContrarian && analysis.edge >= 5 && analysis.confidence >= 0.38 && reversalMagnitude > 8) {
      return {
        trade: true,
        reason: `Contrarian reversal: ${reversalMagnitude.toFixed(1)}% move from open, model disagrees by ${analysis.edge.toFixed(1)}pp`,
        metadata: { reversalMagnitude },
      };
    }
    return { trade: false, reason: `No reversal signal (move=${reversalMagnitude.toFixed(1)}%, contrarian=${isContrarian}, edge=${analysis.edge.toFixed(1)}pp)` };
  },
};

// Strategy 4: Momentum
// Follows strong directional price moves backed by model confidence.
const momentum: Strategy = {
  name: "Momentum",
  description: "Follows strong price movements backed by model confidence in high-activity periods.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice > 0.08 && c.yesPrice < 0.92);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const currentPrice = analysis.candidate.yesPrice;
    const market = analysis.candidate.market;
    const mktAsk = getMarketYesAsk(market);
    const mktBid = getMarketYesBid(market);
    const resolvedOpen = resolveOpenPrice(analysis.candidate);
    const referencePrice = resolvedOpen != null && resolvedOpen > 0
      ? resolvedOpen
      : (mktBid > 0.01 && mktAsk < 0.99 ? (mktAsk + mktBid) / 2 : currentPrice * 0.88);

    const priceMovement = referencePrice > 0
      ? Math.abs(currentPrice - referencePrice) / referencePrice * 100
      : 0;
    const trendDirection = currentPrice > referencePrice ? "up" : "down";

    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeSurge = volume > 0 ? Math.min(volume / liquidity, 10) : 1.0;

    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && hoursLeft > 0.25) {
      return {
        trade: true,
        reason: `Momentum (${trendDirection}): ${analysis.edge.toFixed(1)}pp edge, ${priceMovement.toFixed(1)}% from ref, surge ${volumeSurge.toFixed(1)}x`,
        metadata: { volumeSurge, hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `Insufficient momentum (edge=${analysis.edge.toFixed(1)}pp, surge=${volumeSurge.toFixed(1)}x)` };
  },
};

// Strategy 5: Late Efficiency
// Exploits spread inefficiencies in markets approaching expiry.
const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits spread inefficiencies across all pre-game and near-expiry windows where pricing hasn't converged.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.hoursToExpiry > 0.25 && c.hoursToExpiry <= 36 && c.spread > 0.01);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spread = analysis.candidate.spread;
    const yesPrice = Math.max(0.01, analysis.candidate.yesPrice);
    const spreadPct = (spread / yesPrice) * 100;

    if (analysis.edge >= 8 && analysis.confidence >= 0.35 && spreadPct > 2) {
      return {
        trade: true,
        reason: `Late efficiency: ${hoursLeft.toFixed(1)}h to expiry, ${spreadPct.toFixed(1)}% spread, ${analysis.edge.toFixed(1)}pp edge`,
        metadata: { hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `No inefficiency (${hoursLeft.toFixed(1)}h, ${spreadPct.toFixed(1)}% spread, ${analysis.edge.toFixed(1)}pp edge)` };
  },
};

export const strategies: Strategy[] = [pureValue, sharpMoney, contrarianReversal, momentum, lateEfficiency];

export function getStrategy(name: string): Strategy | undefined {
  return strategies.find((s) => s.name === name);
}

export function getStrategyNames(): string[] {
  return strategies.map((s) => s.name);
}

export function evaluateStrategies(analysis: AnalysisResult, enabledStrategyNames?: string[]): { strategyName: string; reason: string; metadata?: StrategyMetadata }[] {
  const matches: { strategyName: string; reason: string; metadata?: StrategyMetadata }[] = [];
  const activeStrategies = enabledStrategyNames
    ? strategies.filter((s) => enabledStrategyNames.includes(s.name))
    : strategies;
  for (const strategy of activeStrategies) {
    const candidateMatch = strategy.selectCandidates([analysis.candidate]);
    if (candidateMatch.length > 0) {
      const result = strategy.shouldTrade(analysis);
      if (result.trade) {
        matches.push({ strategyName: strategy.name, reason: result.reason, metadata: result.metadata });
      }
    }
  }
  return matches;
}
