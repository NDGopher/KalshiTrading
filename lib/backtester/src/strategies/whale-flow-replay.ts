import type { ReplayAnalysis, Strategy } from "../types.js";

/** Large prints vs recent size distribution on the same ticker. */
export const whaleFlowReplayStrategy: Strategy = {
  name: "Whale Flow",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.replayWhalePrint === true && c.yesPrice > 0.1 && c.yesPrice < 0.9);
  },
  shouldTrade(analysis: ReplayAnalysis) {
    if (!analysis.candidate.replayWhalePrint) return { trade: false, reason: "No whale print" };
    if (analysis.edge >= 4.25 && analysis.confidence >= 0.34) {
      return {
        trade: true,
        reason: `Whale print mid=${(analysis.candidate.yesPrice * 100).toFixed(1)}¢`,
      };
    }
    return { trade: false, reason: "Whale print but weak edge/conf" };
  },
};
