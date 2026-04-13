import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";

export interface StrategyMetadata {
  dipCatch?: boolean;
  priceDropPct?: number;
  hoursRemaining?: number;
  bidAskSpread?: number;
  distanceFromPeak?: number | null;
}

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string; metadata?: StrategyMetadata };
}

/** Min edge (pp) for keeper gates — pipeline sets `strategyMinEdgePp` (4.5 macro vs DB minEdge for sports/other). */
function keeperMinEdgePp(analysis: AnalysisResult): number {
  return analysis.strategyMinEdgePp ?? 6;
}

/** Rule-based floor aligned with paper tuning / backtests. */
const PURE_VALUE_MIN_CONFIDENCE = 0.35;

// ─── Pure Value ─────────────────────────────────────────────────────────────
const pureValue: Strategy = {
  name: "Pure Value",
  description: "Trades when rule-based model probability diverges from mid with sufficient edge (paper: no Claude).",
  selectCandidates(candidates) {
    // Slightly wider than 0.12–0.88 so live paper volume tracks backtests on mid-tail prices.
    return candidates.filter((c) => c.yesPrice >= 0.1 && c.yesPrice <= 0.9);
  },
  shouldTrade(analysis) {
    if (analysis.edge > 20) {
      return {
        trade: false,
        reason: `Edge claim ${analysis.edge.toFixed(0)}pp exceeds 20pp sanity cap`,
      };
    }
    if (analysis.edge >= keeperMinEdgePp(analysis) && analysis.confidence >= PURE_VALUE_MIN_CONFIDENCE) {
      return {
        trade: true,
        reason: `Pure Value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence`,
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
    if (analysis.edge >= keeperMinEdgePp(analysis) && analysis.confidence >= 0.38) {
      return {
        trade: true,
        reason: `Whale Flow: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% conf, whale print`,
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
    if (analysis.edge >= keeperMinEdgePp(analysis) && analysis.confidence >= 0.36) {
      return {
        trade: true,
        reason: `Volume Imbalance: ${analysis.edge.toFixed(1)}pp flow edge, imb=${im.toFixed(2)}`,
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
      if (h.snapshots < 8) return false;
      return c.hoursToExpiry > 4 && c.yesPrice > 0.1 && c.yesPrice < 0.9;
    });
  },
  shouldTrade(analysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const hoursSinceDrop = h.hoursSincePeak;

    if (h.isLiquidityFlush && analysis.edge >= keeperMinEdgePp(analysis) && analysis.confidence >= 0.34 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Dip Buy: ${analysis.edge.toFixed(1)}pp edge, flush −${priceDropPct.toFixed(0)}% vs mean`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    if (hoursSinceDrop !== null && hoursSinceDrop < 0.12) {
      return {
        trade: false,
        reason: `Dip Buy: wait — dip only ${(hoursSinceDrop * 60).toFixed(0)}m old`,
      };
    }

    if (analysis.edge >= keeperMinEdgePp(analysis) && analysis.confidence >= 0.35 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Dip Buy: ${analysis.edge.toFixed(1)}pp edge, −${priceDropPct.toFixed(0)}% vs ${h.snapshots}pt mean`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    return {
      trade: false,
      reason: `Dip Buy: skip — ${priceDropPct.toFixed(0)}% dip, edge=${analysis.edge.toFixed(1)}pp`,
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

/** Snapshot of candidate gates for skip logs (tape / dip / price band). */
export function selectGateSummary(c: ScanCandidate): string {
  const h = c.priceHistory;
  return [
    `yesMid=${c.yesPrice.toFixed(3)}`,
    `yesAsk=${c.yesAsk != null ? c.yesAsk.toFixed(3) : "?"}`,
    `noAsk=${c.noAsk != null ? c.noAsk.toFixed(3) : "?"}`,
    `live=${c.hasLiveData}`,
    `dip=${h?.isDip ?? false}`,
    `snapshots=${h?.snapshots ?? "—"}`,
    `whale=${c.replayWhalePrint === true}`,
    `imb=${c.replayFlowImbalance != null ? c.replayFlowImbalance.toFixed(2) : "—"}`,
    `hrs=${c.hoursToExpiry.toFixed(1)}`,
  ].join(" ");
}

/** Per-enabled-strategy explanation when no keeper fires (for pipeline logging). */
export function diagnoseStrategyMiss(analysis: AnalysisResult, enabledStrategyNames?: string[]): string {
  const activeStrategies = enabledStrategyNames
    ? strategies.filter((s) => enabledStrategyNames.includes(s.name))
    : strategies;
  const parts: string[] = [];
  for (const strategy of activeStrategies) {
    const candidateMatch = strategy.selectCandidates([analysis.candidate]);
    if (candidateMatch.length === 0) {
      parts.push(`${strategy.name}: failed selectCandidates (${selectGateSummary(analysis.candidate)})`);
      continue;
    }
    const result = strategy.shouldTrade(analysis);
    if (!result.trade) {
      parts.push(`${strategy.name}: ${result.reason}`);
    }
  }
  return parts.join(" || ");
}
