import type { ReplayAnalysis, Strategy } from "../types.js";
import { isKnownSharpWallet } from "./sharp-wallet-ids.js";

/**
 * Follow wallets with strong **causal** tape history: stats update only after each market's
 * `marketSettledMs` (from JBecker market parquet). Uses hypothetical YES-at-mid unit outcomes.
 */
export const sharpWalletReplayStrategy: Strategy = {
  name: "Sharp Wallet",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const known = isKnownSharpWallet(c.replayTapeWalletId);
      const n = c.replayWalletSettledTrades ?? 0;
      const wr = c.replayWalletWinRate;
      if (c.yesPrice <= 0.1 || c.yesPrice >= 0.9) return false;

      if (known) {
        return n >= 3 && wr != null && wr >= 0.52;
      }

      if (n < 6 || wr == null) return false;
      if (wr < 0.54) return false;
      const sh = c.replayWalletSharpe ?? 0;
      if (sh < 0.08) return false;
      const cur = c.replayWalletCurrentSportWinRate;
      if (cur != null && cur >= 0.55) return true;
      const top = c.replayWalletTopSportWinRate;
      return top != null && top >= 0.57;
    });
  },
  shouldTrade(analysis: ReplayAnalysis) {
    const c = analysis.candidate;
    const known = isKnownSharpWallet(c.replayTapeWalletId);
    const n = c.replayWalletSettledTrades ?? 0;
    if (!known && n < 6) return { trade: false, reason: "Insufficient settled wallet history" };
    if (known && n < 3) return { trade: false, reason: "Known sharp wallet: need minimal settled sample" };

    const wr = c.replayWalletWinRate ?? 0;
    const minWr = known ? 0.52 : 0.54;
    if (wr < minWr) return { trade: false, reason: `Wallet WR ${(wr * 100).toFixed(1)}% below threshold` };

    const minSh = known ? 0 : 0.08;
    if ((c.replayWalletSharpe ?? 0) < minSh && !known) {
      return { trade: false, reason: "Wallet Sharpe too low" };
    }

    const cur = c.replayWalletCurrentSportWinRate;
    const sportEdge =
      cur != null && cur >= (known ? 0.54 : 0.55)
        ? `this sport WR ${(cur * 100).toFixed(0)}%`
        : `top sport ${c.replayWalletTopSport ?? "?"} WR ${((c.replayWalletTopSportWinRate ?? 0) * 100).toFixed(0)}%`;

    const minEdge = 6;
    const minConf = known ? 0.32 : 0.34;
    if (analysis.edge >= minEdge && analysis.confidence >= minConf) {
      return {
        trade: true,
        reason: `Sharp wallet${known ? " (allowlist)" : ""}: WR ${(wr * 100).toFixed(0)}% n=${n} Sharpe~${(c.replayWalletSharpe ?? 0).toFixed(2)} ${sportEdge}`,
      };
    }
    return { trade: false, reason: "Edge/conf below sharp-wallet gate" };
  },
};
