import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";

export interface StrategyMetadata {
  dipCatch?: boolean;
  priceDropPct?: number;
  hoursRemaining?: number;
  bidAskSpread?: number;
}

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string; metadata?: StrategyMetadata };
}

// ─── Pure Value ─────────────────────────────────────────────────────────────
const pureValue: Strategy = {
  name: "Pure Value",
  description: "Trades when rule-based model probability diverges from mid with sufficient edge (paper: no Claude).",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice >= 0.12 && c.yesPrice <= 0.88);
  },
  shouldTrade(analysis) {
    if (analysis.edge > 20) {
      return {
        trade: false,
        reason: `Edge claim ${analysis.edge.toFixed(0)}pp exceeds 20pp sanity cap`,
      };
    }
    if (analysis.edge >= 6 && analysis.confidence >= 0.4) {
      return {
        trade: true,
        reason: `Pure value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence`,
      };
    }
    return {
      trade: false,
      reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}pp, conf=${(analysis.confidence * 100).toFixed(0)}%`,
    };
  },
};

// ─── Whale Flow (live tape proxy) ───────────────────────────────────────────
const whaleFlow: Strategy = {
  name: "Whale Flow",
  description: "Large flow prints vs recent scan-to-scan distribution (Kalshi replay analogue).",
  selectCandidates(candidates) {
    return candidates.filter(
      (c) => c.hasLiveData && c.replayWhalePrint === true && c.yesPrice > 0.1 && c.yesPrice < 0.9,
    );
  },
  shouldTrade(analysis) {
    if (!analysis.candidate.replayWhalePrint) return { trade: false, reason: "No whale print" };
    if (analysis.edge >= 6 && analysis.confidence >= 0.38) {
      return {
        trade: true,
        reason: `Whale print mid=${(analysis.candidate.yesPrice * 100).toFixed(1)}¢`,
      };
    }
    return { trade: false, reason: "Whale print but weak edge/conf" };
  },
};

// ─── Volume Imbalance ───────────────────────────────────────────────────────
const volumeImbalance: Strategy = {
  name: "Volume Imbalance",
  description: "Signed tape pressure from scan-to-scan flow vs mid moves.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const im = c.replayFlowImbalance;
      if (im == null) return false;
      return c.hasLiveData && Math.abs(im) > 0.45 && c.yesPrice > 0.08 && c.yesPrice < 0.92;
    });
  },
  shouldTrade(analysis) {
    const im = analysis.candidate.replayFlowImbalance ?? 0;
    const side = im > 0 ? "yes" : "no";
    if (analysis.side !== side) {
      return { trade: false, reason: "Flow not aligned with price signal" };
    }
    if (analysis.edge >= 6 && analysis.confidence >= 0.36) {
      return {
        trade: true,
        reason: `Flow imbalance=${im.toFixed(2)} edge=${analysis.edge.toFixed(1)}pp`,
      };
    }
    return { trade: false, reason: "Flow edge/conf below threshold" };
  },
};

// ─── Dip Buy ────────────────────────────────────────────────────────────────
const dipBuy: Strategy = {
  name: "Dip Buy",
  description: "Mean reversion on liquidity-flush or confirmed dips (pregame).",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      if (!h?.isDip) return false;
      if (h.snapshots < 9) return false;
      return c.hoursToExpiry > 4 && c.yesPrice > 0.1 && c.yesPrice < 0.9;
    });
  },
  shouldTrade(analysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const hoursSinceDrop = h.hoursSincePeak;

    if (h.isLiquidityFlush && analysis.edge >= 6 && analysis.confidence >= 0.34 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Liquidity flush dip: ${priceDropPct.toFixed(1)}% below mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)}), ${hoursLeft.toFixed(1)}h left`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    if (hoursSinceDrop !== null && hoursSinceDrop < 0.2) {
      return {
        trade: false,
        reason: `Dip is only ${(hoursSinceDrop * 60).toFixed(0)} min old — waiting for confirmation (need ≥12 min).`,
      };
    }

    if (analysis.edge >= 7 && analysis.confidence >= 0.4 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Dip buy: ${priceDropPct.toFixed(1)}% below ${h.snapshots}-snapshot mean, edge=${analysis.edge.toFixed(1)}pp`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    return {
      trade: false,
      reason: `Dip (${priceDropPct.toFixed(1)}%) — edge=${analysis.edge.toFixed(1)}pp conf=${(analysis.confidence * 100).toFixed(0)}% insufficient`,
    };
  },
};

/**
 * Priority: tape-specific → dip → catch-all value.
 */
export const strategies: Strategy[] = [whaleFlow, volumeImbalance, dipBuy, pureValue];

export function getStrategy(name: string): Strategy | undefined {
  return strategies.find((s) => s.name === name);
}

export function getStrategyNames(): string[] {
  return strategies.map((s) => s.name);
}

export function evaluateStrategies(
  analysis: AnalysisResult,
  enabledStrategyNames?: string[],
): { strategyName: string; reason: string; metadata?: StrategyMetadata }[] {
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
