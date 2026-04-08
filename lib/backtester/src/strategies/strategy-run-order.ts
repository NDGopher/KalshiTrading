import type { Strategy } from "../types.js";

/** Replay order: tape → dip → value (matches live `strategies` ordering). */
export const REPLAY_STRATEGY_RUN_ORDER: string[] = [
  "Whale Flow",
  "Volume Imbalance",
  "Dip Buy",
  "Pure Value",
];

const ORDER_INDEX = new Map(REPLAY_STRATEGY_RUN_ORDER.map((n, i) => [n.toLowerCase(), i]));

/** Stable ordering for any subset of replay strategies. */
export function sortStrategiesByRunOrder(strategies: Strategy[]): Strategy[] {
  return [...strategies].sort((a, b) => {
    const ia = ORDER_INDEX.get(a.name.toLowerCase()) ?? 999;
    const ib = ORDER_INDEX.get(b.name.toLowerCase()) ?? 999;
    if (ia !== ib) return ia - ib;
    return a.name.localeCompare(b.name);
  });
}
