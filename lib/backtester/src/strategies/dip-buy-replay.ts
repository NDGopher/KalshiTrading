import type { ReplayAnalysis, Strategy } from "../types.js";

/** Mean-reversion dip buy aligned with live `Dip Buy` (see api-server strategies) — requires `priceHistory` on candidates. */
export const dipBuyReplayStrategy: Strategy = {
  name: "Dip Buy",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      if (!h?.isDip) return false;
      if (h.snapshots < 9) return false;
      return c.hoursToExpiry > 4 && c.yesPrice > 0.1 && c.yesPrice < 0.9;
    });
  },
  shouldTrade(analysis: ReplayAnalysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const hoursSinceDrop = h.hoursSincePeak;

    if (h.isLiquidityFlush && analysis.edge >= 6 && analysis.confidence >= 0.34 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Liquidity flush dip: ${priceDropPct.toFixed(1)}% vs mean`,
      };
    }

    if (hoursSinceDrop !== null && hoursSinceDrop < 0.2) {
      return { trade: false, reason: "Dip too fresh (<12m vs peak)" };
    }

    if (analysis.edge >= 7 && analysis.confidence >= 0.4 && hoursLeft > 4) {
      return {
        trade: true,
        reason: `Dip buy: ${priceDropPct.toFixed(1)}% below mean, edge=${analysis.edge.toFixed(1)}pp`,
      };
    }

    return { trade: false, reason: `Dip edge/conf insufficient (${analysis.edge.toFixed(1)}pp)` };
  },
};
