import type { Strategy } from "../types.js";

/** Multi-leg YES sum arb — same grouping rule as live Probability Arb (stricter sum threshold). */
export const probabilityArbReplayStrategy: Strategy = {
  name: "Probability Arb",
  selectCandidates(candidates) {
    const byGame = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const parts = c.market.ticker.split("-");
      if (parts.length < 3) continue;
      const gameKey = parts.slice(0, 2).join("-");
      if (!byGame.has(gameKey)) byGame.set(gameKey, []);
      byGame.get(gameKey)!.push(c);
    }
    const out: typeof candidates = [];
    for (const [, legs] of byGame) {
      if (legs.length < 2) continue;
      const sumYes = legs.reduce((s, l) => s + l.yesAsk, 0);
      if (sumYes > 1.04) {
        const sorted = [...legs].sort((a, b) => b.yesAsk - a.yesAsk);
        out.push(sorted[0]!);
      }
    }
    return out;
  },
  shouldTrade(analysis) {
    if (analysis.side === "no" && analysis.edge >= 8 && analysis.confidence >= 0.45) {
      return {
        trade: true,
        reason: `Probability arb: YES legs sum > 104%, fade rich leg (${analysis.edge.toFixed(1)}pp)`,
      };
    }
    return { trade: false, reason: "Probability arb: no strong arb setup" };
  },
};
