import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string };
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
  description: "Buys when market prices drop sharply relative to volume, suggesting overreaction.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const impliedProb = c.yesPrice * 100;
      return impliedProb >= 15 && impliedProb <= 45 && c.volume24h > 200;
    });
  },
  shouldTrade(analysis) {
    const impliedProb = analysis.candidate.yesPrice * 100;
    const modelProb = analysis.modelProbability * 100;
    if (modelProb > impliedProb + 10 && analysis.confidence >= 0.35) {
      return { trade: true, reason: `Dip buyer: model ${modelProb.toFixed(0)}% vs market ${impliedProb.toFixed(0)}%, underpriced by ${(modelProb - impliedProb).toFixed(0)}pp` };
    }
    return { trade: false, reason: `No significant dip detected` };
  },
};

const fadeThePublic: Strategy = {
  name: "Fade the Public",
  description: "Bets against heavily favored outcomes when public sentiment inflates prices beyond fair value.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const impliedProb = c.yesPrice * 100;
      return (impliedProb >= 70 || impliedProb <= 30) && c.volume24h > 300;
    });
  },
  shouldTrade(analysis) {
    const impliedProb = analysis.candidate.yesPrice * 100;
    const modelProb = analysis.modelProbability * 100;
    const isFavoriteOverpriced = impliedProb > 70 && modelProb < impliedProb - 8;
    const isUnderdogUnderpriced = impliedProb < 30 && modelProb > impliedProb + 8;
    if ((isFavoriteOverpriced || isUnderdogUnderpriced) && analysis.confidence >= 0.35) {
      return { trade: true, reason: `Fade public: market=${impliedProb.toFixed(0)}%, model=${modelProb.toFixed(0)}% — public bias detected` };
    }
    return { trade: false, reason: `No clear public bias` };
  },
};

const momentum: Strategy = {
  name: "Momentum",
  description: "Follows strong volume-backed price movements, riding trends in high-activity markets.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.volume24h > 500 && c.liquidity > 200);
  },
  shouldTrade(analysis) {
    const volLiq = analysis.candidate.volume24h / Math.max(1, analysis.candidate.liquidity);
    if (volLiq > 3 && analysis.edge >= 5 && analysis.confidence >= 0.45) {
      return { trade: true, reason: `Momentum: vol/liq ratio ${volLiq.toFixed(1)} with ${analysis.edge.toFixed(1)}% edge — strong flow` };
    }
    return { trade: false, reason: `Insufficient momentum signal` };
  },
};

const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits pricing inefficiencies in markets approaching expiry where prices haven't converged.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.hoursToExpiry < 6 && c.hoursToExpiry > 0.5 && c.spread > 0.02);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spreadPct = analysis.candidate.spread / Math.max(0.01, analysis.candidate.yesPrice) * 100;
    if (hoursLeft < 6 && spreadPct > 3 && analysis.edge >= 10 && analysis.confidence >= 0.5) {
      return { trade: true, reason: `Late efficiency: ${hoursLeft.toFixed(1)}h to expiry, ${spreadPct.toFixed(1)}% spread — mispricing likely` };
    }
    return { trade: false, reason: `No late-stage inefficiency` };
  },
};

export const strategies: Strategy[] = [pureValue, dipBuyer, fadeThePublic, momentum, lateEfficiency];

export function getStrategy(name: string): Strategy | undefined {
  return strategies.find((s) => s.name === name);
}

export function getStrategyNames(): string[] {
  return strategies.map((s) => s.name);
}

export function evaluateStrategies(analysis: AnalysisResult): { strategyName: string; reason: string }[] {
  const matches: { strategyName: string; reason: string }[] = [];
  for (const strategy of strategies) {
    const candidateMatch = strategy.selectCandidates([analysis.candidate]);
    if (candidateMatch.length > 0) {
      const result = strategy.shouldTrade(analysis);
      if (result.trade) {
        matches.push({ strategyName: strategy.name, reason: result.reason });
      }
    }
  }
  return matches;
}
