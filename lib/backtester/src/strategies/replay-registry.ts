import type { Strategy } from "../types.js";
import { dipBuyReplayStrategy } from "./dip-buy-replay.js";
import { pureValueStrategy } from "./pure-value.js";
import { volumeImbalanceReplayStrategy } from "./volume-imbalance-replay.js";
import { whaleFlowReplayStrategy } from "./whale-flow-replay.js";

/** Same order as `strategy-run-order.ts` (best-first for checkpoints). Keeper stack only. */
export const DEFAULT_PARALLEL_REPLAY_STRATEGIES: Strategy[] = [
  whaleFlowReplayStrategy,
  volumeImbalanceReplayStrategy,
  dipBuyReplayStrategy,
  pureValueStrategy,
];

const ALIASES: Record<string, string> = {
  "dip buyer": "Dip Buy",
  "dip buy": "Dip Buy",
  "pure value": "Pure Value",
  "volume imbalance": "Volume Imbalance",
  "whale flow": "Whale Flow",
};

export function replayStrategiesByNames(names: string[]): Strategy[] {
  const all = DEFAULT_PARALLEL_REPLAY_STRATEGIES;
  if (names.length === 0 || names.includes("all")) return all;
  const normalized = names.map((n) => {
    const t = n.trim().toLowerCase();
    return ALIASES[t] ?? n.trim();
  });
  const set = new Set(normalized.map((n) => n.toLowerCase()));
  return all.filter((s) => set.has(s.name.toLowerCase()));
}
