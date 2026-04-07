import type { ReplayAnalysis, Strategy } from "../types.js";

/** Mean-reversion dip buy aligned with live `Dip Buy` (see api-server strategies) — requires `priceHistory` on candidates. */
export const dipBuyReplayStrategy: Strategy = {
  name: "Dip Buy",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      if (!h?.isDip) return false;
      if (h.snapshots < 6) return false;
      return c.hoursToExpiry > 2 && c.yesPrice > 0.1 && c.yesPrice < 0.9;
    });
  },
  shouldTrade(analysis: ReplayAnalysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const hoursSinceDrop = h.hoursSincePeak;

    if (h.isLiquidityFlush && analysis.edge >= 3 && analysis.confidence >= 0.25 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Liquidity flush dip: ${priceDropPct.toFixed(1)}% vs mean`,
      };
    }

    if (hoursSinceDrop !== null && hoursSinceDrop < 0.08) {
      return { trade: false, reason: "Dip too fresh (<5m vs peak)" };
    }

    if (analysis.edge >= 4.5 && analysis.confidence >= 0.3 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Dip buy: ${priceDropPct.toFixed(1)}% below mean, edge=${analysis.edge.toFixed(1)}pp`,
      };
    }

    return { trade: false, reason: `Dip edge/conf insufficient (${analysis.edge.toFixed(1)}pp)` };
  },
};
