import { pgTable, text, serial, real, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradingSettingsTable = pgTable("trading_settings", {
  id: serial("id").primaryKey(),
  maxPositionPct: real("max_position_pct").notNull().default(5),
  /** Half-Kelly-style multiplier on full Kelly in risk-manager (0.5 = half-Kelly). */
  kellyFraction: real("kelly_fraction").notNull().default(0.5),
  maxConsecutiveLosses: integer("max_consecutive_losses").notNull().default(3),
  maxDrawdownPct: real("max_drawdown_pct").notNull().default(20),
  /** 0 = no cap (Kelly + maxPositionPct still bound size). >0 = max concurrent open positions. */
  maxSimultaneousPositions: integer("max_simultaneous_positions").notNull().default(0),
  minEdge: real("min_edge").notNull().default(6),
  minLiquidity: real("min_liquidity").notNull().default(100),
  minTimeToExpiry: integer("min_time_to_expiry").notNull().default(10),
  confidencePenaltyPct: real("confidence_penalty_pct").notNull().default(8),
  sportFilters: jsonb("sport_filters").$type<string[]>().default(["NFL", "NBA", "MLB", "Soccer"]),
  scanIntervalMinutes: integer("scan_interval_minutes").notNull().default(3),
  pipelineActive: boolean("pipeline_active").notNull().default(true),
  paperTradingMode: boolean("paper_trading_mode").notNull().default(false),
  paperBalance: real("paper_balance").notNull().default(5000),
  /** Target average notional per trade (USD); risk-manager clamps toward ~$10–$22 around this. */
  targetBetUsd: real("target_bet_usd").notNull().default(15),
  enabledStrategies: jsonb("enabled_strategies").$type<string[]>().default([
    "Whale Flow",
    "Volume Imbalance",
    "Dip Buy",
    "Pure Value",
  ]),
  kalshiApiKey: text("kalshi_api_key"),
  kalshiBaseUrl: text("kalshi_base_url"),
});

export const insertTradingSettingsSchema = createInsertSchema(tradingSettingsTable).omit({ id: true });
export type InsertTradingSettings = z.infer<typeof insertTradingSettingsSchema>;
export type TradingSettings = typeof tradingSettingsTable.$inferSelect;
