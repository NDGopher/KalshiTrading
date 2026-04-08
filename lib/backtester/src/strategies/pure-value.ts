import type { ReplayAnalysis, ReplayCandidate, Strategy } from "../types.js";

/**
 * Same rules as `artifacts/api-server/src/lib/strategies/index.ts` — Pure Value.
 * Keep in sync when tuning production strategies.
 */
export const pureValueStrategy: Strategy = {
  name: "Pure Value",
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
