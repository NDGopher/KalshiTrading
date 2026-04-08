import type { MultiStrategyBacktestReport, RankedStrategyRow } from "../types.js";

/**
 * Extract the last "Partial rankings" table from a historical-multi tee log (e.g. after Ctrl+C).
 * Used to warm-start checkpoints without re-running completed strategies.
 */
export interface ParsedPartialRankingLine {
  strategyName: string;
  totalPnlUsd: number;
  winRate: number;
  sharpeApprox: number;
  trades: number;
  tradesPerHour: number;
}

const LINE_RE =
  /^\s*\d+\.\s+(.+?)\s+PnL\s+\$([-\d.]+)\s+WR\s+([\d.]+)%\s+Sharpe\s+([\d.]+)\s+trades\s+(\d+)\s+\(([\d.]+)\/h\)\s*\r?$/m;

/** Finds the last rankings block in the file text (ASCII or mojibake tee logs). */
export function parseLastPartialRankingsFromLog(text: string): ParsedPartialRankingLine[] {
  const key = "Partial rankings";
  const idx = text.lastIndexOf(key);
  if (idx < 0) return [];

  const tail = text.slice(idx);
  const lines = tail.split(/\r?\n/);
  const out: ParsedPartialRankingLine[] = [];
  for (const line of lines.slice(0, 48)) {
    if (/\[[^\]]+\]\s*starting replay/i.test(line)) break;
    const m = line.match(LINE_RE);
    if (m) {
      out.push({
        strategyName: m[1]!.trim(),
        totalPnlUsd: Number(m[2]),
        winRate: Number(m[3]) / 100,
        sharpeApprox: Number(m[4]),
        trades: Number(m[5]),
        tradesPerHour: Number(m[6]),
      });
    }
  }
  return out;
}

/** Metrics-only stub (no trade rows) for warm-start from a tee log. */
export function stubPerStrategyBlockFromParsedLogRow(
  p: ParsedPartialRankingLine,
): MultiStrategyBacktestReport["perStrategy"][string] {
  const wins = Math.round(p.winRate * p.trades);
  return {
    metrics: {
      strategyName: p.strategyName,
      trades: p.trades,
      wins,
      winRate: p.winRate,
      totalPnlUsd: p.totalPnlUsd,
      maxDrawdownPct: 0,
      sharpeApprox: p.sharpeApprox,
      equityCurve: [],
      usedSyntheticOutcomes: 0,
    },
    bySport: [],
    topTrades: [],
    tradesPreview: [],
  };
}

export function rankedRowFromParsedLogLine(p: ParsedPartialRankingLine): RankedStrategyRow {
  return {
    rank: 0,
    strategyName: p.strategyName,
    totalPnlUsd: p.totalPnlUsd,
    winRate: p.winRate,
    sharpeApprox: p.sharpeApprox,
    maxDrawdownPct: 0,
    trades: p.trades,
    tradesPerHour: p.tradesPerHour,
    usedSyntheticOutcomes: 0,
    expectancyPerTradeUsd: p.trades ? p.totalPnlUsd / p.trades : 0,
  };
}
