/**
 * Structural copies of pmxt's unified types (see pmxt `src/types/index.ts`).
 * The published `pmxt@0.1.0` npm package does not ship `dist/`, so we mirror types here
 * and still depend on `pmxt` in package.json for version tracking / future builds.
 */
export type MarketStatus = "open" | "closed" | "resolved" | "paused";

export interface PmxtMarket {
  id: string;
  symbol: string;
  base: string;
  quote: string;
  active: boolean;
  status: MarketStatus;
  question: string;
  description?: string;
  endDate?: Date;
  resolutionDate?: Date;
  category?: string;
  tags?: string[];
  liquidity?: number;
  volume24h?: number;
  createdAt?: Date;
  updatedAt?: Date;
  info: unknown;
}

export interface PmxtTicker {
  symbol: string;
  marketId: string;
  last: number;
  bid?: number;
  ask?: number;
  volume?: number;
  high?: number;
  low?: number;
  change?: number;
  changePercent?: number;
  timestamp: number;
  datetime: Date;
  info: unknown;
}
