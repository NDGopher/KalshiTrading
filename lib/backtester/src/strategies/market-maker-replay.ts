import type { ReplayAnalysis, Strategy } from "../types.js";

/**
 * Resting liquidity simulation: only fires on tight-spread liquid names.
 * PnL uses spread capture + conservative LIP in the replay engine (not taker fee curve).
 */
export const marketMakerReplayStrategy: Strategy = {
  name: "Market Maker",
  selectCandidates(candidates) {
    return candidates.filter(
      (c) => c.spread <= 0.045 && c.liquidity >= 1200 && c.volume24h >= 2500 && c.yesPrice > 0.12 && c.yesPrice < 0.88,
    );
  },
  shouldTrade(analysis: ReplayAnalysis) {
    if (analysis.candidate.spread > 0.045) return { trade: false, reason: "Spread too wide to quote" };
    if (analysis.confidence >= 0.3 && analysis.edge >= 2.5) {
      return {
        trade: true,
        reason: `MM quote zone spread=${(analysis.candidate.spread * 100).toFixed(1)}¢`,
      };
    }
    return { trade: false, reason: "MM confidence/edge below threshold" };
  },
};
