import type { ReplayRiskLimits } from "../types.js";

export function mergeReplayRiskLimits(base: ReplayRiskLimits, patch?: Partial<ReplayRiskLimits>): ReplayRiskLimits {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    positionSizing: patch.positionSizing ?? base.positionSizing,
  };
}

/**
 * Per-strategy risk patches applied after CLI/global limits so tuned strategies
 * can safely go below global minEdge (e.g. Dip Buy liquidity-flush path at ~3pp).
 */
export const BUILTIN_STRATEGY_RISK_PATCHES: Record<string, Partial<ReplayRiskLimits>> = {
  "Dip Buy": { minEdgePp: 2.75, minConfidence: 0.22 },
  "Probability Arb": {
    maxTradesPerHour: 10,
    minEdgePp: 7.5,
    minConfidence: 0.42,
    cooldownSameTickerMs: 600_000,
  },
  "Fresh Wallet": { minEdgePp: 3.75, minConfidence: 0.26 },
  "Sharp Wallet": { minEdgePp: 3.75, minConfidence: 0.28 },
};

export function effectiveRiskForStrategy(globalRisk: ReplayRiskLimits, strategyName: string): ReplayRiskLimits {
  const patch = BUILTIN_STRATEGY_RISK_PATCHES[strategyName];
  return mergeReplayRiskLimits(globalRisk, patch);
}
