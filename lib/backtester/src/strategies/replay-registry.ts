import type { Strategy } from "../types.js";
import { dipBuyReplayStrategy } from "./dip-buy-replay.js";
import { freshWalletReplayStrategy } from "./fresh-wallet-replay.js";
import { marketMakerReplayStrategy } from "./market-maker-replay.js";
import { probabilityArbReplayStrategy } from "./probability-arb-replay.js";
import { pureValueStrategy } from "./pure-value.js";
import { sharpWalletReplayStrategy } from "./sharp-wallet-replay.js";
import { volumeImbalanceReplayStrategy } from "./volume-imbalance-replay.js";
import { whaleFlowReplayStrategy } from "./whale-flow-replay.js";

export const DEFAULT_PARALLEL_REPLAY_STRATEGIES: Strategy[] = [
  pureValueStrategy,
  dipBuyReplayStrategy,
  volumeImbalanceReplayStrategy,
  whaleFlowReplayStrategy,
  freshWalletReplayStrategy,
  sharpWalletReplayStrategy,
  probabilityArbReplayStrategy,
  marketMakerReplayStrategy,
];

const ALIASES: Record<string, string> = {
  "dip buyer": "Dip Buy",
  "dip buy": "Dip Buy",
  "pure value": "Pure Value",
  "probability arb": "Probability Arb",
  "volume imbalance": "Volume Imbalance",
  "whale flow": "Whale Flow",
  "fresh wallet": "Fresh Wallet",
  "sharp wallet": "Sharp Wallet",
  "sharp money": "Sharp Wallet",
  "market maker": "Market Maker",
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
