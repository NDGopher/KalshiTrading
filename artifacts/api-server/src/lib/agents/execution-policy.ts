import type { ScanCandidate } from "./scanner.js";
import { getMarketNoBid, getMarketYesAsk, getMarketYesBid } from "../kalshi-client.js";

/** Default wide-spread cap (5¢). DB `max_spread_cents` overrides in pipeline. */
export const MAX_SPREAD_CENTS_DEFAULT = 5;

/**
 * YES-leg bid–ask width in dollars (same as NO-leg width on complementary Kalshi books when both sides quote).
 */
export function yesBookSpreadDollars(candidate: ScanCandidate): number {
  const ya = getMarketYesAsk(candidate.market);
  const yb = getMarketYesBid(candidate.market);
  if (ya > 0 && yb > 0) return Math.max(0, Math.min(0.99, ya - yb));
  return candidate.spread;
}

/** Drop scanner candidates before analyst when the YES book is wider than `maxSpreadDollars`. */
export function rejectsWideBookForTrading(candidate: ScanCandidate, maxSpreadDollars: number): boolean {
  const ya = getMarketYesAsk(candidate.market);
  const yb = getMarketYesBid(candidate.market);
  if (ya <= 0 || yb <= 0) return false;
  return ya - yb > maxSpreadDollars + 1e-9;
}

/** Taker spread on the chosen side (for pipeline gate + paper trade logging). */
export function takerSpreadDollars(candidate: ScanCandidate, side: "yes" | "no"): number {
  if (side === "yes") {
    const ya = candidate.yesAsk;
    const yb = getMarketYesBid(candidate.market);
    if (ya > 0 && yb > 0) return Math.max(0, Math.min(0.99, ya - yb));
  } else {
    const na = candidate.noAsk;
    const nb = getMarketNoBid(candidate.market);
    if (na > 0 && nb > 0) return Math.max(0, Math.min(0.99, na - nb));
  }
  return yesBookSpreadDollars(candidate);
}

export function spreadCentsFromDollars(spreadDollars: number): number {
  return Math.round(Math.max(0, spreadDollars) * 100);
}
