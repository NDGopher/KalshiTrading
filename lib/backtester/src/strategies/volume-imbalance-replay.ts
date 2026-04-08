import type { ReplayAnalysis, Strategy } from "../types.js";

/** Bet side implied by persistent signed tape flow (depth proxy). */
export const volumeImbalanceReplayStrategy: Strategy = {
  name: "Volume Imbalance",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const im = c.replayFlowImbalance;
      if (im == null) return false;
      return Math.abs(im) > 0.45 && c.yesPrice > 0.08 && c.yesPrice < 0.92;
    });
  },
  shouldTrade(analysis: ReplayAnalysis) {
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
