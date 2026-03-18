import type { ScanCandidate } from "../agents/scanner.js";
import type { AnalysisResult } from "../agents/analyst.js";
import { getMarketYesAsk, getMarketYesBid } from "../kalshi-client.js";

export interface StrategyMetadata {
  dipCatch?: boolean;
  distanceFromPeak?: number;
  volumeSurge?: number;
  hoursRemaining?: number;
  publicBiasScore?: number;
  reversalMagnitude?: number;
  sharpScore?: number;
  priceDropPct?: number;
  sharpEdgePp?: number;
  bidAskSpread?: number;
}

export interface Strategy {
  name: string;
  description: string;
  selectCandidates(candidates: ScanCandidate[]): ScanCandidate[];
  shouldTrade(analysis: AnalysisResult): { trade: boolean; reason: string; metadata?: StrategyMetadata };
}

/**
 * Resolves the open price for a scan candidate, handling two formats:
 * - Kalshi API format: `open_price` in cents (0-100 integer)
 * - Backtester format: `_openPrice` as 0-1 float (injected from historical_markets DB)
 * Returns null if no open price is available.
 */
function resolveOpenPrice(candidate: ScanCandidate): number | null {
  const raw = candidate.market as unknown as Record<string, number | undefined>;

  // Backtester injects _openPrice as 0-1 float
  if (raw._openPrice != null && raw._openPrice > 0 && raw._openPrice < 1.5) {
    return raw._openPrice as number;
  }

  // Kalshi API provides open_price in cents (0-100)
  if (raw.open_price != null && raw.open_price > 0) {
    const asCents = raw.open_price as number;
    return asCents > 1 ? asCents / 100 : asCents;
  }

  return null;
}

// ─── Strategy 1: Pure Value ───────────────────────────────────────────────────
const pureValue: Strategy = {
  name: "Pure Value",
  description: "Trades when model probability diverges significantly from market price, regardless of direction.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice > 0.05 && c.yesPrice < 0.95);
  },
  shouldTrade(analysis) {
    if (analysis.edge >= 4 && analysis.confidence >= 0.25) {
      return { trade: true, reason: `Pure value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence` };
    }
    return { trade: false, reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}pp, conf=${(analysis.confidence * 100).toFixed(0)}%` };
  },
};

// ─── Strategy 2: Sharp Money ──────────────────────────────────────────────────
const sharpMoney: Strategy = {
  name: "Sharp Money",
  description: "Trades markets with elevated informed volume flow (high volume/liquidity ratio). Sharps are active — follow the AI's probability edge.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const hasVolume = c.volume24h > 100 || c.liquidity > 5000;
      return hasVolume && c.yesPrice > 0.05 && c.yesPrice < 0.95;
    });
  },
  shouldTrade(analysis) {
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeToLiquidity = Math.min(volume / liquidity, 10);
    const sharpScore = volumeToLiquidity * analysis.edge;

    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && volumeToLiquidity >= 0.5) {
      return {
        trade: true,
        reason: `Sharp money: ${analysis.edge.toFixed(1)}pp edge, vol/liq=${volumeToLiquidity.toFixed(2)}, sharp score=${sharpScore.toFixed(1)}`,
        metadata: { sharpScore, volumeSurge: volumeToLiquidity },
      };
    }
    return { trade: false, reason: `No sharp signal (edge=${analysis.edge.toFixed(1)}pp, vol/liq=${volumeToLiquidity.toFixed(2)})` };
  },
};

// ─── Strategy 3: Contrarian Reversal ─────────────────────────────────────────
const contrarianReversal: Strategy = {
  name: "Contrarian Reversal",
  description: "Bets against sharp price overreactions when the AI model identifies the market has overshot fair value.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const openPrice = resolveOpenPrice(c);
      if (!openPrice) return false;
      const priceMoveAbsolute = Math.abs(c.yesPrice - openPrice);
      const priceMoveRelative = openPrice > 0 ? priceMoveAbsolute / openPrice : 0;
      return priceMoveRelative > 0.08 && c.yesPrice > 0.05 && c.yesPrice < 0.95;
    });
  },
  shouldTrade(analysis) {
    const currentPrice = analysis.candidate.yesPrice;
    const openPrice = resolveOpenPrice(analysis.candidate) ?? currentPrice;
    const priceMove = currentPrice - openPrice;
    const modelMove = analysis.modelProbability - openPrice;
    const isContrarian = (priceMove > 0 && modelMove < 0) || (priceMove < 0 && modelMove > 0);
    const reversalMagnitude = Math.abs(priceMove / Math.max(0.01, openPrice)) * 100;

    if (isContrarian && analysis.edge >= 5 && analysis.confidence >= 0.38 && reversalMagnitude > 8) {
      return {
        trade: true,
        reason: `Contrarian reversal: ${reversalMagnitude.toFixed(1)}% move from open, model disagrees by ${analysis.edge.toFixed(1)}pp`,
        metadata: { reversalMagnitude },
      };
    }
    return { trade: false, reason: `No reversal signal (move=${reversalMagnitude.toFixed(1)}%, contrarian=${isContrarian}, edge=${analysis.edge.toFixed(1)}pp)` };
  },
};

// ─── Strategy 4: Momentum ─────────────────────────────────────────────────────
const momentum: Strategy = {
  name: "Momentum",
  description: "Follows strong price movements backed by model confidence in high-activity periods.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.yesPrice > 0.08 && c.yesPrice < 0.92);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const currentPrice = analysis.candidate.yesPrice;
    const market = analysis.candidate.market;
    const mktAsk = getMarketYesAsk(market);
    const mktBid = getMarketYesBid(market);
    const resolvedOpen = resolveOpenPrice(analysis.candidate);
    const referencePrice = resolvedOpen != null && resolvedOpen > 0
      ? resolvedOpen
      : (mktBid > 0.01 && mktAsk < 0.99 ? (mktAsk + mktBid) / 2 : currentPrice * 0.88);

    const priceMovement = referencePrice > 0
      ? Math.abs(currentPrice - referencePrice) / referencePrice * 100
      : 0;
    const trendDirection = currentPrice > referencePrice ? "up" : "down";
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeSurge = volume > 0 ? Math.min(volume / liquidity, 10) : 1.0;

    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && hoursLeft > 0.25) {
      return {
        trade: true,
        reason: `Momentum (${trendDirection}): ${analysis.edge.toFixed(1)}pp edge, ${priceMovement.toFixed(1)}% from ref, surge ${volumeSurge.toFixed(1)}x`,
        metadata: { volumeSurge, hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `Insufficient momentum (edge=${analysis.edge.toFixed(1)}pp, surge=${volumeSurge.toFixed(1)}x)` };
  },
};

// ─── Strategy 5: Late Efficiency ──────────────────────────────────────────────
const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits spread inefficiencies across all pre-game and near-expiry windows where pricing hasn't converged.",
  selectCandidates(candidates) {
    return candidates.filter((c) => c.hoursToExpiry > 0.25 && c.hoursToExpiry <= 36 && c.spread > 0.01);
  },
  shouldTrade(analysis) {
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spread = analysis.candidate.spread;
    const yesPrice = Math.max(0.01, analysis.candidate.yesPrice);
    const spreadPct = (spread / yesPrice) * 100;

    if (analysis.edge >= 8 && analysis.confidence >= 0.25 && spreadPct > 2) {
      return {
        trade: true,
        reason: `Late efficiency: ${hoursLeft.toFixed(1)}h to expiry, ${spreadPct.toFixed(1)}% spread, ${analysis.edge.toFixed(1)}pp edge`,
        metadata: { hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `No inefficiency (${hoursLeft.toFixed(1)}h, ${spreadPct.toFixed(1)}% spread, ${analysis.edge.toFixed(1)}pp edge)` };
  },
};

// ─── Strategy 6: Dip Buy (Mean Reversion) ────────────────────────────────────
/**
 * Mean reversion with two tiers:
 *
 * TIER 1 — Liquidity Flush (high confidence)
 *   Spread widened during the drop (the bid retreated, not a wave of real sellers)
 *   AND volume did not surge. This is a single large seller dumping contracts with
 *   no fundamental reason. Price recovers once their order is absorbed.
 *   Conditions: isDip + isLiquidityFlush + edge ≥ 3 + confidence ≥ 0.25
 *
 * TIER 2 — Generic Dip (standard confidence)
 *   Price dropped ≥8% from mean but without the clear liquidity signature.
 *   Still tradeable if the model has strong conviction.
 *   Conditions: isDip + edge ≥ 6 + confidence ≥ 0.35
 *
 * Never fires on in-play markets (< 2h to expiry) where price drops ARE information.
 */
const dipBuy: Strategy = {
  name: "Dip Buy",
  description: "Buys into pregame price drops. Tier 1: liquidity flush (spread widens, low volume) — highest confidence. Tier 2: generic dip with model edge.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      return (
        h?.isDip === true &&
        c.hoursToExpiry > 2 &&
        c.yesPrice > 0.08 &&
        c.yesPrice < 0.92
      );
    });
  },
  shouldTrade(analysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const flushStr = h.isLiquidityFlush
      ? `, liquidity flush (spread widened ${(h.spreadWidening * 100).toFixed(0)}%, volume ${h.volumeTrend})`
      : "";

    // Tier 1: liquidity flush — lower edge/confidence required
    if (h.isLiquidityFlush && analysis.edge >= 3 && analysis.confidence >= 0.25 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Liquidity flush dip: ${priceDropPct.toFixed(1)}% below mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)})${flushStr}, ${hoursLeft.toFixed(1)}h left`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    // Tier 2: generic dip — higher edge required since we lack the flush signature
    if (analysis.edge >= 6 && analysis.confidence >= 0.35 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Dip buy: ${priceDropPct.toFixed(1)}% below mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)}), volume=${h.volumeTrend}, model edge=${analysis.edge.toFixed(1)}pp`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    return {
      trade: false,
      reason: `Dip (${priceDropPct.toFixed(1)}%) — ${h.isLiquidityFlush ? "flush but" : "not flush,"} edge=${analysis.edge.toFixed(1)}pp conf=${(analysis.confidence * 100).toFixed(0)}% insufficient`,
    };
  },
};

// ─── Strategy 9: Probability Consistency Arb ─────────────────────────────────
/**
 * On Kalshi, soccer matches have 3 markets for the same game:
 *   KXLALIGAGAME-26MAR20RVCLEV-RVC  (Real Valladolid wins)
 *   KXLALIGAGAME-26MAR20RVCLEV-LEV  (Levante wins)
 *   KXLALIGAGAME-26MAR20RVCLEV-TIE  (Draw)
 *
 * These three YES prices should sum to ≈1.0 minus vig. When they don't,
 * the most expensive one is overpriced — fade it with NO.
 *
 * This is pure math: no AI edge, no news, no model needed. If the sum
 * is 1.15 (15% over 100%), one of the three is 15% too expensive to buy.
 * We sell (buy NO on) the most overpriced leg.
 *
 * Also works for any binary markets on the same underlying event that
 * have inconsistent implied probabilities (e.g., same BTC close price
 * market traded at different times with a large stale spread).
 */
const probabilityArb: Strategy = {
  name: "Probability Arb",
  description: "Fades the overpriced leg when a multi-outcome market's YES prices sum > 100%. Pure math — no AI needed. Applies to soccer 3-ways and other multi-outcome Kalshi markets.",
  selectCandidates(candidates) {
    // Group by game key (first two ticker segments): KXLALIGAGAME-26MAR20RVCLEV
    const byGame = new Map<string, typeof candidates>();
    for (const c of candidates) {
      const parts = c.market.ticker.split("-");
      if (parts.length < 3) continue;
      const gameKey = parts.slice(0, 2).join("-");
      if (!byGame.has(gameKey)) byGame.set(gameKey, []);
      byGame.get(gameKey)!.push(c);
    }
    // Return candidates that belong to a game where sum of YES prices > 1.0
    const arbitrageable: typeof candidates = [];
    for (const [, legs] of byGame) {
      if (legs.length < 2) continue;
      const sumYes = legs.reduce((s, l) => s + l.yesAsk, 0);
      if (sumYes > 1.02) {
        // Mark the most expensive leg as the arb target
        const sorted = [...legs].sort((a, b) => b.yesAsk - a.yesAsk);
        arbitrageable.push(sorted[0]);
      }
    }
    return arbitrageable;
  },
  shouldTrade(analysis) {
    // Recompute the game sum from currently live candidates
    // (we can't easily access all legs here, so we rely on the edge signal)
    // The analyst will have been told about overpricing — require it to flag NO
    if (analysis.side === "no" && analysis.edge >= 5) {
      return {
        trade: true,
        reason: `Probability arb: YES prices sum > 100% in this game — overpriced leg, buying NO (edge=${analysis.edge.toFixed(1)}pp)`,
        metadata: {},
      };
    }
    return { trade: false, reason: "Probability arb: no overpricing detected or model edge insufficient" };
  },
};

// ─── Strategy 7: Sharp Arb ────────────────────────────────────────────────────
/**
 * Fires when Kalshi's implied probability deviates materially from Pinnacle's
 * no-vig fair line. Pinnacle is the sharpest book in the world — when Kalshi
 * is cheaper than Pinnacle's fair probability, it's near-certain positive EV.
 *
 * Requires: ODDS_API_KEY environment variable pointing to the-odds-api.com.
 * Without the key, this strategy never fires (gracefully skipped).
 *
 * Edge direction:
 *   kalshiEdgeVsSharp < 0 → Kalshi YES is underpriced → BUY YES
 *   kalshiEdgeVsSharp > 0 → Kalshi YES is overpriced  → BUY NO
 */
const sharpArb: Strategy = {
  name: "Sharp Arb",
  description: "Trades when Kalshi's price deviates from Pinnacle's no-vig fair line by ≥3pp. Requires ODDS_API_KEY.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const sl = c.sharpLine;
      return sl !== null && sl !== undefined && sl.edgeSide !== "NONE";
    });
  },
  shouldTrade(analysis) {
    const sl = analysis.candidate.sharpLine;
    if (!sl || sl.edgeSide === "NONE") {
      return { trade: false, reason: "No sharp book line available or no material edge" };
    }

    const edgePp = Math.abs(sl.kalshiEdgeVsSharp);
    const MIN_EDGE_PP = 3;

    if (edgePp >= MIN_EDGE_PP) {
      const side = sl.edgeSide;
      const pinnacleStr = (sl.noVigYesProb * 100).toFixed(1);
      const kalshiStr = (analysis.candidate.yesPrice * 100).toFixed(1);
      return {
        trade: true,
        reason: `Sharp arb: buy ${side} — Pinnacle fair=${pinnacleStr}¢, Kalshi=${kalshiStr}¢, edge=${edgePp.toFixed(1)}pp vs ${sl.bookmaker}`,
        metadata: { sharpEdgePp: edgePp },
      };
    }

    return { trade: false, reason: `Sharp edge too small: ${edgePp.toFixed(1)}pp (need ≥${MIN_EDGE_PP}pp)` };
  },
};

// ─── Strategy 8: Market Making ────────────────────────────────────────────────
/**
 * Identifies markets where the bid-ask spread is wide enough to profitably
 * post limit orders on both sides and earn the spread as a liquidity provider.
 *
 * In paper mode: flags markets as MM candidates and simulates quoting both sides.
 * To collect the spread you need both sides to fill — adverse selection is the risk.
 *
 * Only fires on markets with:
 *   - Spread ≥ 5¢ (enough margin after Kalshi's 7¢/contract fee on the winning side)
 *   - Sufficient liquidity to suggest regular order flow
 *   - Not near expiry (live game price movement destroys MM positions)
 */
const marketMaking: Strategy = {
  name: "Market Making",
  description: "Posts limit orders on both sides of wide-spread markets to earn the bid-ask as a liquidity provider. Requires flat markets with no directional signal.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      return (
        c.spread >= 0.05 &&
        c.liquidity > 1000 &&
        c.hoursToExpiry > 4 &&
        c.yesPrice > 0.15 &&
        c.yesPrice < 0.85
      );
    });
  },
  shouldTrade(analysis) {
    const spread = analysis.candidate.spread;
    const liquidity = analysis.candidate.liquidity;
    const hoursLeft = analysis.candidate.hoursToExpiry;

    // Only make markets when the AI does NOT have a strong directional view
    // (a directional conviction is better served by the other strategies)
    if (Math.abs(analysis.edge) > 8) {
      return { trade: false, reason: `Strong directional signal (edge=${analysis.edge.toFixed(1)}pp) — use directional strategy instead` };
    }

    if (spread >= 0.05 && liquidity > 1000 && hoursLeft > 4) {
      const spreadPct = (spread * 100).toFixed(1);
      return {
        trade: true,
        reason: `Market making: ${spreadPct}¢ spread, $${liquidity.toFixed(0)} liquidity, ${hoursLeft.toFixed(1)}h to expiry — post both sides to earn spread`,
        metadata: { bidAskSpread: spread, hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `Spread too tight or market too illiquid (spread=${(spread * 100).toFixed(1)}¢, liq=$${liquidity.toFixed(0)})` };
  },
};

export const strategies: Strategy[] = [
  pureValue,
  sharpMoney,
  contrarianReversal,
  momentum,
  lateEfficiency,
  dipBuy,
  sharpArb,
  marketMaking,
  probabilityArb,
];

export function getStrategy(name: string): Strategy | undefined {
  return strategies.find((s) => s.name === name);
}

export function getStrategyNames(): string[] {
  return strategies.map((s) => s.name);
}

export function evaluateStrategies(analysis: AnalysisResult, enabledStrategyNames?: string[]): { strategyName: string; reason: string; metadata?: StrategyMetadata }[] {
  const matches: { strategyName: string; reason: string; metadata?: StrategyMetadata }[] = [];
  const activeStrategies = enabledStrategyNames
    ? strategies.filter((s) => enabledStrategyNames.includes(s.name))
    : strategies;
  for (const strategy of activeStrategies) {
    const candidateMatch = strategy.selectCandidates([analysis.candidate]);
    if (candidateMatch.length > 0) {
      const result = strategy.shouldTrade(analysis);
      if (result.trade) {
        matches.push({ strategyName: strategy.name, reason: result.reason, metadata: result.metadata });
      }
    }
  }
  return matches;
}
