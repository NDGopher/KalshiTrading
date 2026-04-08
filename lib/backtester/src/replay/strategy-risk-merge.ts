import type { ReplayRiskLimits } from "../types.js";

export function mergeReplayRiskLimits(base: ReplayRiskLimits, patch?: Partial<ReplayRiskLimits>): ReplayRiskLimits {
  if (!patch) return base;
  return {
    ...base,
    ...patch,
    positionSizing: patch.positionSizing ?? base.positionSizing,
    targetBetUsd: patch.targetBetUsd ?? base.targetBetUsd,
  };
}

/**
 * Per-strategy risk patches applied after CLI/global limits so tuned strategies
 * can safely go below global minEdge (e.g. Dip Buy liquidity-flush path at ~3pp).
 */
export const BUILTIN_STRATEGY_RISK_PATCHES: Record<string, Partial<ReplayRiskLimits>> = {
  "Pure Value": { minEdgePp: 6, minConfidence: 0.4 },
  "Dip Buy": { minEdgePp: 6, minConfidence: 0.34 },
  "Whale Flow": { minEdgePp: 6, minConfidence: 0.38 },
  "Volume Imbalance": { minEdgePp: 6, minConfidence: 0.36 },
};

export function effectiveRiskForStrategy(globalRisk: ReplayRiskLimits, strategyName: string): ReplayRiskLimits {
  const patch = BUILTIN_STRATEGY_RISK_PATCHES[strategyName];
  return mergeReplayRiskLimits(globalRisk, patch);
}
