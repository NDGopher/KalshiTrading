import type { ArchiveMarketTick } from "./normalize.js";

/** Minimal market shape for synthetic model + Pure Value (mirrors Kalshi fields used in live backtester). */
export interface ReplayMarket {
  ticker: string;
  close_time: string;
  result?: string;
  category?: string;
  expected_expiration_time?: string;
  expiration_time?: string;
  open_time?: string;
  _dbResult?: string;
}

/** Rolling-window stats for replay-only strategies (Dip Buy, etc.). */
export interface PriceHistoryLite {
  snapshots: number;
  recentMean: number;
  stdDev: number;
  currentVsMeanPct: number;
  isDip: boolean;
  isSurge: boolean;
  hoursSincePeak: number | null;
  volumeTrend: "flat" | "rising" | "falling";
  isLiquidityFlush: boolean;
  spreadWidening: number;
}

export interface ReplayCandidate {
  market: ReplayMarket;
  yesPrice: number;
  noPrice: number;
  yesAsk: number;
  noAsk: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
  hasLiveData: boolean;
  /** Populated during historical trade replay for mean-reversion strategies. */
  priceHistory?: PriceHistoryLite;
  /** Tape-derived context (strictly causal — known at tick time). */
  replayFlowImbalance?: number;
  replayWhalePrint?: boolean;
  replayFreshWallet?: boolean;
  replayWalletDiversity?: number;
  /** Wallet id on this tape print (for optional allowlists). */
  replayTapeWalletId?: string;
  /** Causal wallet tape stats (post-settlement trades only). */
  replayWalletWinRate?: number;
  replayWalletSharpe?: number;
  replayWalletSettledTrades?: number;
  replayWalletTopSport?: string;
  replayWalletTopSportWinRate?: number;
  replayWalletCurrentSportWinRate?: number;
}

export interface ReplayAnalysis {
  candidate: ReplayCandidate;
  modelProbability: number;
  edge: number;
  confidence: number;
  side: "yes" | "no";
  reasoning: string;
}

export interface Strategy {
  name: string;
  selectCandidates(candidates: ReplayCandidate[]): ReplayCandidate[];
  shouldTrade(analysis: ReplayAnalysis): { trade: boolean; reason: string };
}

export interface SimulatedTrade {
  ticker: string;
  side: "yes" | "no";
  entryPrice: number;
  stakeUsd: number;
  contracts: number;
  pnlUsd: number;
  won: boolean;
  usedSyntheticOutcome: boolean;
  reason: string;
  tsMs: number;
  /** Kalshi coarse sport bucket (e.g. NFL, NBA) when derivable from ticker. */
  sportLabel?: string;
  edgeAtEntry?: number;
  modelProbability?: number;
  strategyName?: string;
}

export interface EquityPoint {
  tsMs: number;
  equity: number;
}

export interface BacktestMetrics {
  strategyName: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;
  sharpeApprox: number;
  equityCurve: EquityPoint[];
  usedSyntheticOutcomes: number;
}

export type PositionSizing =
  | { mode: "fixed_fraction"; fraction: number }
  | { mode: "kelly"; kellyFraction: number; capFraction: number };

/** Applied uniformly to every strategy in parallel replay. */
export interface ReplayRiskLimits {
  maxTradesPerHour: number;
  minEdgePp: number;
  minConfidence: number;
  positionSizing: PositionSizing;
  cooldownSameTickerMs: number;
}

export interface SportBucketMetrics {
  sport: string;
  trades: number;
  wins: number;
  totalPnlUsd: number;
}

export interface RankedStrategyRow {
  rank: number;
  strategyName: string;
  totalPnlUsd: number;
  winRate: number;
  sharpeApprox: number;
  maxDrawdownPct: number;
  trades: number;
  tradesPerHour: number;
  usedSyntheticOutcomes: number;
  /** Mean PnL per trade (USD). */
  expectancyPerTradeUsd?: number;
}

export interface MultiStrategyEquitySample {
  tsMs: number;
  /** Per-strategy equity at this timestamp (piecewise-constant / last known). */
  equityByStrategy: Record<string, number>;
  meanEquity: number;
}

export interface MultiStrategyBacktestReport {
  generatedAt: string;
  source: Record<string, unknown>;
  risk: ReplayRiskLimits;
  rankings: RankedStrategyRow[];
  perStrategy: Record<
    string,
    {
      metrics: BacktestMetrics;
      bySport: SportBucketMetrics[];
      /** Rich export: top trades by |pnl| (default 50). */
      topTrades: SimulatedTrade[];
      tradesPreview: SimulatedTrade[];
    }
  >;
  /** Aligned equity snapshot for multi-line charts (dashboard). */
  combinedEquitySamples?: MultiStrategyEquitySample[];
  /** Relative paths under data root when CSVs were written. */
  outputFiles?: { rankedJson: string; summaryCsv?: string; tradesCsv?: string };
  /** Per-strategy per-sport rows (heatmap / pivot in Excel or dashboard). */
  sportTableByStrategy?: Record<string, SportBucketMetrics[]>;
  /** Conservative nudges for `trading_settings` (applied by API Learner). */
  suggestedSettingsPatch: {
    minEdge?: number;
    kellyFraction?: number;
    confidencePenaltyPct?: number;
    rationale: string;
  };
  /** Human-readable post-run notes (console + JSON for dashboards). */
  readability?: Record<
    string,
    {
      topWinReasons: { reason: string; count: number; pnlUsd: number }[];
      topLossReasons: { reason: string; count: number; pnlUsd: number }[];
      verdict: string;
      nextTestHint: string;
    }
  >;
}

export type { ArchiveMarketTick };
