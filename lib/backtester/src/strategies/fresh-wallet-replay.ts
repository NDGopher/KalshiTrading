import type { ReplayAnalysis, Strategy } from "../types.js";

/** Wallet in its first ~48h of tape activity (see FreshWalletTracker) with meaningful size. */
export const freshWalletReplayStrategy: Strategy = {
  name: "Fresh Wallet",
  selectCandidates(candidates) {
    return candidates.filter(
      (c) => c.replayFreshWallet === true && (c.liquidity > 320 || (c.volume24h ?? 0) > 650),
    );
  },
  shouldTrade(analysis: ReplayAnalysis) {
    if (!analysis.candidate.replayFreshWallet) return { trade: false, reason: "Not a fresh wallet window" };
    if (analysis.edge >= 4 && analysis.confidence >= 0.28) {
      return { trade: true, reason: "Fresh wallet + conviction tape" };
    }
    return { trade: false, reason: "Fresh wallet but filters not met" };
  },
};
