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
    // 12–88¢: same uncertainty band as the scanner. Extreme prices are already
    // correctly priced by the market — we have no information advantage there.
    return candidates.filter((c) => c.yesPrice >= 0.12 && c.yesPrice <= 0.88);
  },
  shouldTrade(analysis) {
    // Edge sanity cap: anything > 50pp means the AI is hallucinating a fake edge
    // (e.g., claiming 200pp edge on a market priced at 8¢). Cap and reject.
    if (analysis.edge > 50) {
      return { trade: false, reason: `Edge claim ${analysis.edge.toFixed(0)}pp exceeds sanity cap — model hallucination, skip` };
    }
    if (analysis.edge >= 4 && analysis.confidence >= 0.35) {
      return { trade: true, reason: `Pure value: ${analysis.edge.toFixed(1)}pp edge, ${(analysis.confidence * 100).toFixed(0)}% confidence` };
    }
    return { trade: false, reason: `Insufficient value: edge=${analysis.edge.toFixed(1)}pp, conf=${(analysis.confidence * 100).toFixed(0)}%` };
  },
};

// ─── Strategy 2: Sharp Money ──────────────────────────────────────────────────
const sharpMoney: Strategy = {
  name: "Sharp Money",
  description: "Trades markets with elevated informed volume flow vs liquidity. Only fires on live Kalshi API data — DB-cache candidates have synthetic volume numbers that produce direction-blind noise.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      // Reject if volume/liquidity came from our synthetic estimates in the DB cache.
      // Sharp Money is meaningless without real order-book numbers — a fabricated
      // vol/liq ratio tells us nothing about actual informed activity.
      if (!c.hasLiveData) return false;
      const hasRealVolume = c.volume24h > 100;
      const hasRealLiquidity = c.liquidity > 5000;
      return (hasRealVolume || hasRealLiquidity) && c.yesPrice >= 0.12 && c.yesPrice <= 0.88;
    });
  },
  shouldTrade(analysis) {
    if (analysis.edge > 50) return { trade: false, reason: `Edge ${analysis.edge.toFixed(0)}pp exceeds sanity cap` };
    const volume = analysis.candidate.volume24h;
    const liquidity = Math.max(1, analysis.candidate.liquidity);
    const volumeToLiquidity = Math.min(volume / liquidity, 10);
    const sharpScore = volumeToLiquidity * analysis.edge;

    // Require a meaningful vol/liq ratio — 0.5x is trivially easy to hit.
    // At 1.5x, someone is actually trading hard relative to available liquidity.
    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && volumeToLiquidity >= 1.5) {
      return {
        trade: true,
        reason: `Sharp money: ${analysis.edge.toFixed(1)}pp edge, vol/liq=${volumeToLiquidity.toFixed(2)}x (live), sharp score=${sharpScore.toFixed(1)}`,
        metadata: { sharpScore, volumeSurge: volumeToLiquidity },
      };
    }
    return { trade: false, reason: `No sharp signal (edge=${analysis.edge.toFixed(1)}pp, vol/liq=${volumeToLiquidity.toFixed(2)}, liveData=${analysis.candidate.hasLiveData})` };
  },
};

// ─── Strategy 3: Contrarian Reversal ─────────────────────────────────────────
/**
 * Fades sudden price spikes (surges) in markets that were previously stable.
 *
 * The setup we're looking for:
 *   1. Market was STEADY — low stdDev relative to mean over the lookback window
 *   2. Price SPIKED recently — currently ≥10% above the recent mean (isSurge)
 *   3. The surge happened recently (within ~3 hours) but not too recently (<15 min)
 *      — too fresh might be real news, confirmed over a few cycles is safer
 *   4. Volume did NOT surge alongside the price — a low-volume spike is a liquidity
 *      buy that overshoots; a high-volume spike is informed buying (don't fade)
 *   5. Model probability < current price (model says the spike overshot fair value)
 *
 * This is the mirror of Dip Buy (which fades drops). Together they form a
 * mean-reversion pair: Dip Buy catches oversold, Contrarian catches overbought.
 *
 * We do NOT compare to open_price anymore — that field is often null in the DB
 * and says nothing about whether the CURRENT market is stable or volatile.
 */
const contrarianReversal: Strategy = {
  name: "Contrarian Reversal",
  description: "Fades sudden price surges in stable markets. Requires price history showing a spike above the recent mean with low volume — classic liquidity overshoot that reverts.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      if (!h?.isSurge) return false;
      // Need enough history to confirm the market was stable before the spike
      if (h.snapshots < 10) return false;
      // Low volatility pre-surge = the market was in equilibrium, not already chaotic
      const coefficientOfVariation = h.recentMean > 0 ? h.stdDev / h.recentMean : 1;
      if (coefficientOfVariation > 0.15) return false; // >15% CV = market was already volatile, not a clean spike
      // Must be in the uncertainty zone — no bets on extreme prices
      return c.yesPrice >= 0.12 && c.yesPrice <= 0.88 && c.hoursToExpiry > 2;
    });
  },
  shouldTrade(analysis) {
    if (analysis.edge > 50) return { trade: false, reason: `Edge ${analysis.edge.toFixed(0)}pp exceeds sanity cap` };

    const h = analysis.candidate.priceHistory;
    if (!h?.isSurge) return { trade: false, reason: "No surge detected in price history" };

    // Find how long ago the surge started by scanning the series for when price
    // crossed above the mean — oldest snapshot still above mean = surge start
    const series = h.series;
    const mean = h.recentMean;
    const surgeStartIdx = series.findIndex((s) => s.price <= mean * 1.03);
    const hoursSinceSurge = surgeStartIdx >= 0
      ? (Date.now() - series[surgeStartIdx].snapshotAt.getTime()) / (1000 * 60 * 60)
      : null;

    // Too fresh (< 15 min = 3 scan cycles): could be real breaking news — wait for confirmation
    if (hoursSinceSurge !== null && hoursSinceSurge < 0.25) {
      return { trade: false, reason: `Surge too fresh (${(hoursSinceSurge * 60).toFixed(0)} min) — waiting for confirmation cycle` };
    }
    // Too old (> 4 hours): the market had time to absorb real information — don't fade
    if (hoursSinceSurge !== null && hoursSinceSurge > 4) {
      return { trade: false, reason: `Surge is ${hoursSinceSurge.toFixed(1)}h old — too stale to fade, market likely absorbed real info` };
    }

    // Volume must NOT have surged with price — if volume is rising, it's informed buying
    if (h.volumeTrend === "rising") {
      return { trade: false, reason: `Surge has rising volume — likely informed buying, not a liquidity overshoot. Do not fade.` };
    }

    // Model must disagree with the spike — we want model probability < current price (buy NO)
    const modelDisagreesWithSurge = analysis.side === "no";
    if (!modelDisagreesWithSurge) {
      return { trade: false, reason: `Model agrees with surge direction (side=${analysis.side}) — not a fade setup` };
    }

    const surgePct = h.currentVsMeanPct.toFixed(1);
    if (analysis.edge >= 5 && analysis.confidence >= 0.40) {
      return {
        trade: true,
        reason: `Contrarian fade: price is ${surgePct}% above ${h.snapshots}-snapshot mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)}), surge is ${hoursSinceSurge?.toFixed(1) ?? "?"}h old, volume=${h.volumeTrend}, model edge=${analysis.edge.toFixed(1)}pp`,
        metadata: { reversalMagnitude: Math.abs(h.currentVsMeanPct) },
      };
    }
    return { trade: false, reason: `Surge present but edge=${analysis.edge.toFixed(1)}pp or conf=${(analysis.confidence * 100).toFixed(0)}% insufficient` };
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
    if (analysis.edge > 50) return { trade: false, reason: `Edge ${analysis.edge.toFixed(0)}pp exceeds sanity cap` };
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

    // Volume surge ≥ 2× is the actual momentum confirmation signal.
    // Defaulting to 1.0 when there's no volume data means Momentum was firing
    // on flat markets with zero real activity — pure luck, not momentum.
    if (analysis.edge >= 5 && analysis.confidence >= 0.40 && hoursLeft > 0.25 && volumeSurge >= 2.0) {
      return {
        trade: true,
        reason: `Momentum (${trendDirection}): ${analysis.edge.toFixed(1)}pp edge, ${priceMovement.toFixed(1)}% from ref, surge ${volumeSurge.toFixed(1)}x`,
        metadata: { volumeSurge, hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `Insufficient momentum (edge=${analysis.edge.toFixed(1)}pp, surge=${volumeSurge.toFixed(1)}x — need ≥2.0x)` };
  },
};

// ─── Strategy 5: Late Efficiency ──────────────────────────────────────────────
const lateEfficiency: Strategy = {
  name: "Late Efficiency",
  description: "Exploits spread inefficiencies in the pre-game window (≤36h). Requires live spread data (not DB estimates) and a strong AI edge — wide spreads on synthetic data are meaningless.",
  selectCandidates(candidates) {
    return candidates.filter((c) =>
      c.hoursToExpiry > 0.25 &&
      c.hoursToExpiry <= 36 &&
      c.spread > 0.01 &&
      // Live spread data only — the DB cache synthesizes spread from estimated ask/bid,
      // which tells us nothing about real market inefficiency.
      c.hasLiveData &&
      // Must be in genuine uncertainty zone
      c.yesPrice >= 0.12 &&
      c.yesPrice <= 0.88
    );
  },
  shouldTrade(analysis) {
    if (analysis.edge > 50) {
      return { trade: false, reason: `Edge ${analysis.edge.toFixed(0)}pp exceeds sanity cap` };
    }
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const spread = analysis.candidate.spread;
    const yesPrice = Math.max(0.01, analysis.candidate.yesPrice);
    const spreadPct = (spread / yesPrice) * 100;

    // Raised from 8pp to 12pp: Late Efficiency was over-firing on NBA spreads at 8pp.
    // A real spread inefficiency needs strong model conviction on top of the spread signal.
    // Confidence raised from 0.25 to 0.35 for the same reason.
    if (analysis.edge >= 12 && analysis.confidence >= 0.35 && spreadPct > 2) {
      return {
        trade: true,
        reason: `Late efficiency: ${hoursLeft.toFixed(1)}h to expiry, ${spreadPct.toFixed(1)}% spread (live), ${analysis.edge.toFixed(1)}pp edge`,
        metadata: { hoursRemaining: hoursLeft },
      };
    }
    return { trade: false, reason: `No inefficiency (${hoursLeft.toFixed(1)}h, ${spreadPct.toFixed(1)}% spread, edge=${analysis.edge.toFixed(1)}pp — need ≥12pp)` };
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
  description: "Buys into pregame price drops. Tier 1: liquidity flush (spread widens, low volume) — highest confidence. Tier 2: generic dip confirmed over ≥2 scan cycles.",
  selectCandidates(candidates) {
    return candidates.filter((c) => {
      const h = c.priceHistory;
      if (!h?.isDip) return false;
      // Require ≥10 snapshots (50 min at 5-min cadence) to trust the mean.
      // With fewer snapshots the "mean" is just the last few prices — not a real baseline.
      if (h.snapshots < 10) return false;
      return c.hoursToExpiry > 2 && c.yesPrice > 0.10 && c.yesPrice < 0.90;
    });
  },
  shouldTrade(analysis) {
    const h = analysis.candidate.priceHistory;
    if (!h?.isDip) return { trade: false, reason: "No price dip detected" };

    const priceDropPct = Math.abs(h.currentVsMeanPct);
    const hoursLeft = analysis.candidate.hoursToExpiry;
    const hoursSinceDrop = h.hoursSincePeak;
    const flushStr = h.isLiquidityFlush
      ? `, liquidity flush (spread widened ${(h.spreadWidening * 100).toFixed(0)}%, volume ${h.volumeTrend})`
      : "";

    // Tier 1: liquidity flush — spread widening is the confirmation signal.
    // Can fire on fresh dips because the spread-widening IS the confirmation.
    if (h.isLiquidityFlush && analysis.edge >= 3 && analysis.confidence >= 0.25 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Liquidity flush dip: ${priceDropPct.toFixed(1)}% below mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)})${flushStr}, ${hoursLeft.toFixed(1)}h left`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    // Tier 2: generic dip — require the drop to be at least 15 minutes old.
    // A dip that just happened (< 15 min = 3 cycles) could be breaking news.
    // We wait to see if it stays depressed — if it does, it's likely noise not info.
    if (hoursSinceDrop !== null && hoursSinceDrop < 0.25) {
      return {
        trade: false,
        reason: `Dip is only ${(hoursSinceDrop * 60).toFixed(0)} min old — waiting for confirmation (need ≥15 min). Will re-evaluate next cycle.`,
      };
    }

    if (analysis.edge >= 6 && analysis.confidence >= 0.35 && hoursLeft > 2) {
      return {
        trade: true,
        reason: `Dip buy: ${priceDropPct.toFixed(1)}% below ${h.snapshots}-snapshot mean (${h.recentMean.toFixed(2)}→${analysis.candidate.yesPrice.toFixed(2)}), dip age=${hoursSinceDrop?.toFixed(1) ?? "?"}h, volume=${h.volumeTrend}, edge=${analysis.edge.toFixed(1)}pp`,
        metadata: { dipCatch: true, priceDropPct, hoursRemaining: hoursLeft },
      };
    }

    return {
      trade: false,
      reason: `Dip (${priceDropPct.toFixed(1)}%, ${hoursSinceDrop?.toFixed(1) ?? "?"}h old) — ${h.isLiquidityFlush ? "flush but" : "not flush,"} edge=${analysis.edge.toFixed(1)}pp conf=${(analysis.confidence * 100).toFixed(0)}% insufficient`,
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

/**
 * Strategy priority order matters: the pipeline tags each trade with the FIRST
 * matching strategy. Specialized strategies must come before broad catch-alls so
 * a Dip Buy trade is tagged "Dip Buy" (not "Pure Value").
 *
 * Order: most selective (requires specific market conditions) → least selective (catch-all)
 */
export const strategies: Strategy[] = [
  sharpArb,           // Requires ODDS_API_KEY + Pinnacle line — most specific
  probabilityArb,     // Requires multi-leg YES sum > 100% — pure math
  dipBuy,             // Requires isDip + ≥10 snapshots + dip-age confirmation
  contrarianReversal, // Requires isSurge + stable market + low volume — specific
  lateEfficiency,     // Requires live spread + hoursToExpiry ≤ 36 + 12pp edge
  sharpMoney,         // Requires live vol/liq data + vol/liq ≥ 1.5×
  momentum,           // Requires volume surge ≥ 2× confirmation
  pureValue,          // Catch-all: any market with edge ≥ 4pp, conf ≥ 35% — always last
  // marketMaking removed: paper trade simulation only executes taker trades (market
  // orders), so Market Making was silently mislabeling directional bets as spread-
  // capture trades. P&L numbers were meaningless. Re-add when live limit-order
  // execution and fill simulation are implemented.
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
