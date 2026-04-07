import type { PriceHistoryLite } from "../types.js";

const MAX_SNAPS = 16;

export class TickerPriceRolling {
  private readonly byTicker = new Map<string, { mids: number[]; spreads: number[]; ts: number[] }>();

  push(ticker: string, tsMs: number, mid: number, spread: number): void {
    const row = this.byTicker.get(ticker) ?? { mids: [], spreads: [], ts: [] };
    row.mids.push(mid);
    row.spreads.push(spread);
    row.ts.push(tsMs);
    while (row.mids.length > MAX_SNAPS) {
      row.mids.shift();
      row.spreads.shift();
      row.ts.shift();
    }
    this.byTicker.set(ticker, row);
  }

  snapshot(ticker: string, currentMid: number, currentSpread: number, tsMs: number): PriceHistoryLite | undefined {
    const row = this.byTicker.get(ticker);
    if (!row || row.mids.length < 3) return undefined;

    const mids = row.mids;
    const n = mids.length;
    const mean = mids.reduce((a, b) => a + b, 0) / n;
    const varv = mids.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, n - 1);
    const stdDev = Math.sqrt(varv) || 1e-6;
    const currentVsMeanPct = mean > 0 ? ((currentMid - mean) / mean) * 100 : 0;
    const isDip = currentVsMeanPct <= -5.5;
    const isSurge = currentVsMeanPct >= 8;

    let peakIdx = 0;
    for (let i = 1; i < mids.length; i++) {
      if (mids[i]! > mids[peakIdx]!) peakIdx = i;
    }
    const hoursSincePeak =
      peakIdx < mids.length ? (tsMs - row.ts[peakIdx]!) / (3600 * 1000) : null;

    const olderSpread = row.spreads[0] ?? currentSpread;
    const spreadWidening = olderSpread > 0 ? (currentSpread - olderSpread) / olderSpread : 0;
    const isLiquidityFlush = isDip && spreadWidening > 0.15;

    const first = mids[0]!;
    const last = mids[mids.length - 1]!;
    let volumeTrend: "flat" | "rising" | "falling" = "flat";
    if (last > first * 1.02) volumeTrend = "rising";
    else if (last < first * 0.98) volumeTrend = "falling";

    return {
      snapshots: n,
      recentMean: mean,
      stdDev,
      currentVsMeanPct,
      isDip,
      isSurge,
      hoursSincePeak,
      volumeTrend,
      isLiquidityFlush,
      spreadWidening,
    };
  }
}
