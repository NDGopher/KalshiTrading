import type { ReplayAnalysis, ReplayRiskLimits } from "../types.js";

export class ReplayRiskState {
  private tradesInHour: { tsMs: number }[] = [];
  private lastTradeByTicker = new Map<string, number>();

  constructor(private readonly limits: ReplayRiskLimits) {}

  resetHourWindow(nowMs: number): void {
    const h = 3600_000;
    this.tradesInHour = this.tradesInHour.filter((t) => nowMs - t.tsMs < h);
  }

  allowsTrade(tsMs: number, ticker: string, analysis: ReplayAnalysis): boolean {
    this.resetHourWindow(tsMs);
    if (this.tradesInHour.length >= this.limits.maxTradesPerHour) return false;
    if (analysis.edge < this.limits.minEdgePp) return false;
    if (analysis.confidence < this.limits.minConfidence) return false;
    const last = this.lastTradeByTicker.get(ticker);
    if (last != null && tsMs - last < this.limits.cooldownSameTickerMs) return false;
    return true;
  }

  recordTrade(tsMs: number, ticker: string): void {
    this.tradesInHour.push({ tsMs });
    this.lastTradeByTicker.set(ticker, tsMs);
  }
}

/** Clamp stake toward [~10, ~20] USD around targetBetUsd while respecting caps. */
function anchorStakeToTargetBand(
  stakeUsd: number,
  equity: number,
  targetBetUsd: number,
  capFraction: number,
): number {
  const t = Math.max(5, targetBetUsd);
  const lo = Math.max(8, t * (10 / 15));
  const hi = Math.min(22, t * (20 / 15));
  const cap = Math.min(equity * capFraction, equity * 0.25);
  const pulled = Math.min(Math.max(stakeUsd, lo), hi);
  return Math.min(pulled, cap);
}

export function computeStakeUsd(
  equity: number,
  analysis: ReplayAnalysis,
  limits: ReplayRiskLimits,
): number {
  const { positionSizing } = limits;
  const target = limits.targetBetUsd ?? 15;
  const capF = positionSizing.mode === "kelly" ? positionSizing.capFraction : 0.06;

  if (positionSizing.mode === "fixed_fraction") {
    const raw = Math.min(equity * positionSizing.fraction, equity * 0.25);
    return anchorStakeToTargetBand(raw, equity, target, capF);
  }
  const edge = Math.min(0.25, Math.max(0, analysis.edge / 100));
  const p = Math.max(0.05, Math.min(0.95, analysis.modelProbability));
  const b = p > 0.01 ? (1 - p) / p : 1;
  const kellyFull = (b * p - (1 - p)) / b;
  const k = Math.max(0, kellyFull) * positionSizing.kellyFraction;
  const raw = equity * k;
  const capped = Math.min(raw, equity * positionSizing.capFraction, equity * 0.25);
  return anchorStakeToTargetBand(capped, equity, target, positionSizing.capFraction);
}
