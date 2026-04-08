import type { ReplayAnalysis, ReplayCandidate, Strategy } from "../types.js";

/**
 * Same rules as `artifacts/api-server/src/lib/strategies/index.ts` — Pure Value.
 * Keep in sync when tuning production strategies (paper auditor floor + keeper edge).
 */
const KEEPER_EDGE_PP = 4;
const PURE_VALUE_MIN_CONFIDENCE = 0.35;

export const pureValueStrategy: Strategy = {
  name: "Pure Value",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice >= 0.1 && c.yesPrice <= 0.9);
  },
  shouldTrade(analysis) {
    if (analysis.edge > 20) {
      return {
        trade: false,
        reason: `Edge claim ${analysis.edge.toFixed(0)}pp exceeds 20pp sanity cap`,
      };
    }
    if (analysis.edge >= KEEPER_EDGE_PP && analysis.confidence >= PURE_VALUE_MIN_CONFIDENCE) {
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
