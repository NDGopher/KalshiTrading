import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";

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
      return midPrice > 0.1 && midPrice < 0.9 && c.liquidity > 50;
    });
  },
  shouldTrade(analysis) {
    if (analysis.edge >= 8 && analysis.confidence >= 0.4) {
      return { trade: true, reason: `Pure value: ${analysis.edge.toFixed(1)}% edge with ${(analysis.confidence * 100).toFixed(0)}% confidence` };
    }
    return { trade: false, reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}%, confidence=${(analysis.confidence * 100).toFixed(0)}%` };
  },
};

const dipBuyer: Strategy = {
  name: "Dip Buyer",
  description: "Buys underdogs whose price has dropped below model estimate, capturing overreaction dips.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const impliedProb = c.yesPrice * 100;
      return impliedProb >= 10 && impliedProb <= 45 && c.volume24h > 200;
    });
  },
  shouldTrade(analysis) {
    const impliedProb = analysis.candidate.yesPrice * 100;
    const modelProb = analysis.modelProbability * 100;
    const dipSize = modelProb - impliedProb;

    const yesBid = analysis.candidate.market.yes_bid / 100;
    const yesAsk = analysis.candidate.market.yes_ask / 100;
    const midPrice = (yesBid + yesAsk) / 2;
    const distanceFromPeak = midPrice > 0 ? ((midPrice - analysis.candidate.yesPrice) / midPrice) * 100 : 0;

    const isDipCatch = dipSize > 10 && distanceFromPeak > 5;

    if (dipSize > 10 && analysis.confidence >= 0.35) {
      return {
        trade: true,
        reason: `Dip buyer: model ${modelProb.toFixed(0)}% vs market ${impliedProb.toFixed(0)}%, underpriced by ${dipSize.toFixed(0)}pp, dist-from-peak ${distanceFromPeak.toFixed(1)}%`,
        metadata: { dipCatch: isDipCatch, distanceFromPeak },
      };
    }
    return { trade: false, reason: `No significant dip detected` };
  },
};

const fadeThePublic: Strategy = {
  name: "Fade the Public",
  description: "Bets against heavily favored outcomes when high volume inflates prices beyond fair value.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const impliedProb = c.yesPrice * 100;
      return (impliedProb >= 70 || impliedProb <= 30) && c.volume24h > 300;
    });
  },
  shouldTrade(analysis) {
    const impliedProb = analysis.candidate.yesPrice * 100;
    const modelProb = analysis.modelProbability * 100;
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeRatio = volume / liquidity;
    const publicBiasScore = Math.abs(impliedProb - modelProb) * Math.min(volumeRatio, 5);

    const isFavoriteOverpriced = impliedProb > 70 && modelProb < impliedProb - 8;
    const isUnderdogUnderpriced = impliedProb < 30 && modelProb > impliedProb + 8;

    if ((isFavoriteOverpriced || isUnderdogUnderpriced) && analysis.confidence >= 0.35 && publicBiasScore > 20) {
      return {
        trade: true,
        reason: `Fade public: market=${impliedProb.toFixed(0)}%, model=${modelProb.toFixed(0)}%, bias score=${publicBiasScore.toFixed(1)}, vol/liq=${volumeRatio.toFixed(1)}`,
        metadata: { publicBiasScore },
      };
    }
    return { trade: false, reason: `No clear public bias (score=${publicBiasScore.toFixed(1)})` };
  },
};

const momentum: Strategy = {
  name: "Momentum",
  description: "Follows strong volume-backed price movements in high-activity markets with volume surge.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.volume24h > 500 && c.liquidity > 100);
  },
  shouldTrade(analysis) {
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeSurge = volume / liquidity;
    const hoursLeft = analysis.candidate.hoursToExpiry;

    if (volumeSurge > 3 && analysis.edge >= 5 && analysis.confidence >= 0.45 && hoursLeft > 1) {
      return {
        trade: true,
        reason: `Momentum: vol surge ${volumeSurge.toFixed(1)}x, ${analysis.edge.toFixed(1)}% edge, ${hoursLeft.toFixed(1)}h left`,
        metadata: { volumeSurge, hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `Insufficient momentum (surge=${volumeSurge.toFixed(1)}x)` };
  },
};

const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits pricing inefficiencies in markets within 2 hours of expiry where spreads haven't converged.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.hoursToExpiry <= 2 && c.hoursToExpiry > 0.25 && c.spread > 0.02);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spreadPct = analysis.candidate.spread / Math.max(0.01, analysis.candidate.yesPrice) * 100;

    if (hoursLeft <= 2 && spreadPct > 3 && analysis.edge >= 10 && analysis.confidence >= 0.5) {
      return {
        trade: true,
        reason: `Late efficiency: ${hoursLeft.toFixed(1)}h to expiry, ${spreadPct.toFixed(1)}% spread, ${analysis.edge.toFixed(1)}% edge`,
        metadata: { hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `No late-stage inefficiency (${hoursLeft.toFixed(1)}h, ${spreadPct.toFixed(1)}% spread)` };
  },
};

export const strategies: Strategy[] = [pureValue, dipBuyer, fadeThePublic, momentum, lateEfficiency];

export function getStrategy(name: string): Strategy | undefined {
  return strategies.find((s) => s.name === name);
}

export function getStrategyNames(): string[] {
  return strategies.map((s) => s.name);
}

export function evaluateStrategies(analysis: AnalysisResult): { strategyName: string; reason: string; metadata?: StrategyMetadata }[] {
  const matches: { strategyName: string; reason: string; metadata?: StrategyMetadata }[] = [];
  for (const strategy of strategies) {
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
