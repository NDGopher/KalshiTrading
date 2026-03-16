import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";
import { getMarketYesAsk, getMarketYesBid } from "../kalshi-client.js";

export interface StrategyMetadata {
  dipCatch?: boolean;
  distanceFromPeak?: number;
  volumeSurge?: number;
  hoursRemaining?: number;
  publicBiasScore?: number;
}

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string; metadata?: StrategyMetadata };
}

const pureValue: Strategy = {
  name: "Pure Value",
  description: "Trades when model probability diverges significantly from market price, regardless of direction.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const midPrice = c.yesPrice;
      // Accept markets in the 5-95¢ range — wide enough to include all game markets
      return midPrice > 0.05 && midPrice < 0.95;
    });
  },
  shouldTrade(analysis) {
    // 4pp minimum edge (absolute percentage points, not %)
    if (analysis.edge >= 4 && analysis.confidence >= 0.38) {
      return { trade: true, reason: `Pure value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence` };
    }
    return { trade: false, reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}pp, conf=${(analysis.confidence * 100).toFixed(0)}%` };
  },
};

const dipBuyer: Strategy = {
  name: "Dip Buyer",
  description: "Buys underdogs whose price has dropped below fair value, capturing overreaction dips.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const impliedProb = c.yesPrice;
      // Underdog range: 5¢-48¢ (probabilities where an overreaction is meaningful)
      return impliedProb >= 0.05 && impliedProb <= 0.48;
    });
  },
  shouldTrade(analysis) {
    const currentYesPrice = analysis.candidate.yesPrice;
    const modelProb = analysis.modelProbability;
    const dipSize = (modelProb - currentYesPrice) * 100; // pp above market

    const market = analysis.candidate.market;
    const rawOpenPrice = (market as unknown as Record<string, number>).open_price;
    const yesAsk = getMarketYesAsk(market);
    const openPrice = rawOpenPrice != null && rawOpenPrice > 0
      ? rawOpenPrice / 100
      : (yesAsk > 0.01 && yesAsk < 0.99 ? yesAsk : currentYesPrice * 1.15);
    const peakEstimate = Math.max(openPrice, yesAsk > 0.01 && yesAsk < 0.99 ? yesAsk : 0, currentYesPrice);
    const distanceFromPeak = peakEstimate > 0
      ? ((peakEstimate - currentYesPrice) / peakEstimate) * 100
      : 0;

    const isDipCatch = distanceFromPeak > 5 && dipSize > 5;

    if (dipSize > 5 && analysis.confidence >= 0.32) {
      return {
        trade: true,
        reason: `Dip buyer: model ${(modelProb * 100).toFixed(0)}% vs market ${(currentYesPrice * 100).toFixed(0)}%, ${dipSize.toFixed(0)}pp above market (${distanceFromPeak.toFixed(1)}% off peak)`,
        metadata: { dipCatch: isDipCatch, distanceFromPeak },
      };
    }
    return { trade: false, reason: `No significant dip (dip=${dipSize.toFixed(1)}pp)` };
  },
};

const fadeThePublic: Strategy = {
  name: "Fade the Public",
  description: "Bets against heavily favored outcomes when prices are inflated beyond fair value.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const p = c.yesPrice;
      // Heavy favorites (65%+) or strong underdogs (35%-) are candidates for public bias
      return p >= 0.62 || p <= 0.38;
    });
  },
  shouldTrade(analysis) {
    const impliedProb = analysis.candidate.yesPrice * 100;
    const modelProb = analysis.modelProbability * 100;
    const volume = Math.max(1, analysis.candidate.volume24h);
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeRatio = Math.min(volume / liquidity, 5);
    // When volume/liquidity data is unavailable, use a neutral ratio
    const effectiveRatio = analysis.candidate.liquidity === 0 ? 1.5 : volumeRatio;
    const publicBiasScore = Math.abs(impliedProb - modelProb) * effectiveRatio;

    const isFavoriteOverpriced = impliedProb > 62 && modelProb < impliedProb - 5;
    const isUnderdogUnderpriced = impliedProb < 38 && modelProb > impliedProb + 5;

    if ((isFavoriteOverpriced || isUnderdogUnderpriced) && analysis.confidence >= 0.32 && publicBiasScore > 6) {
      return {
        trade: true,
        reason: `Fade public: market=${impliedProb.toFixed(0)}%, model=${modelProb.toFixed(0)}%, bias=${publicBiasScore.toFixed(1)}`,
        metadata: { publicBiasScore },
      };
    }
    return { trade: false, reason: `No public bias (score=${publicBiasScore.toFixed(1)})` };
  },
};

const momentum: Strategy = {
  name: "Momentum",
  description: "Follows strong price movements backed by model confidence in high-activity periods.",
  selectCandidates(candidates) {
    // Accept all candidates with meaningful prices — volume boost is preferred but not required
    return candidates.filter((c) => c.yesPrice > 0.08 && c.yesPrice < 0.92);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const currentPrice = analysis.candidate.yesPrice;
    const market = analysis.candidate.market;
    const rawOpenPrice = (market as unknown as Record<string, number>).open_price;
    const mktAsk = getMarketYesAsk(market);
    const mktBid = getMarketYesBid(market);
    const referencePrice = rawOpenPrice != null && rawOpenPrice > 0
      ? rawOpenPrice / 100
      : (mktBid > 0.01 && mktAsk < 0.99 ? (mktAsk + mktBid) / 2 : currentPrice * 0.88);

    const priceMovement = referencePrice > 0
      ? Math.abs(currentPrice - referencePrice) / referencePrice * 100
      : 0;
    const trendDirection = currentPrice > referencePrice ? "up" : "down";

    // Volume surge if data available, else use edge strength as proxy
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeSurge = volume > 0 ? Math.min(volume / liquidity, 10) : 1.0;

    // Trade if: significant price movement OR strong model edge, with reasonable confidence
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

const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits spread inefficiencies across all pre-game and near-expiry windows where pricing hasn't converged.",
  selectCandidates(candidates) {
    // Broad window: from 15 min to 36 hours before expiry, any meaningful spread
    return candidates.filter((c) => c.hoursToExpiry > 0.25 && c.hoursToExpiry <= 36 && c.spread > 0.01);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spread = analysis.candidate.spread;
    const yesPrice = Math.max(0.01, analysis.candidate.yesPrice);
    const spreadPct = (spread / yesPrice) * 100;

    // More lenient thresholds: 8pp edge and 35% confidence
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

export const strategies: Strategy[] = [pureValue, dipBuyer, fadeThePublic, momentum, lateEfficiency];

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
