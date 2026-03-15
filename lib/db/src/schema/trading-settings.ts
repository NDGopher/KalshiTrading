import { pgTable, text, serial, real, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradingSettingsTable = pgTable("trading_settings", {
  id: serial("id").primaryKey(),
  maxPositionPct: real("max_position_pct").notNull().default(5),
  kellyFraction: real("kelly_fraction").notNull().default(0.25),
  maxConsecutiveLosses: integer("max_consecutive_losses").notNull().default(3),
  maxDrawdownPct: real("max_drawdown_pct").notNull().default(20),
  maxSimultaneousPositions: integer("max_simultaneous_positions").notNull().default(8),
  minEdge: real("min_edge").notNull().default(5),
  minLiquidity: real("min_liquidity").notNull().default(100),
  minTimeToExpiry: integer("min_time_to_expiry").notNull().default(10),
  confidencePenaltyPct: real("confidence_penalty_pct").notNull().default(8),
  sportFilters: jsonb("sport_filters").$type<string[]>().default(["NFL", "NBA", "MLB", "Soccer"]),
  scanIntervalMinutes: integer("scan_interval_minutes").notNull().default(60),
  pipelineActive: boolean("pipeline_active").notNull().default(true),
  paperTradingMode: boolean("paper_trading_mode").notNull().default(false),
  paperBalance: real("paper_balance").notNull().default(5000),
  dailyBudgetUsd: real("daily_budget_usd").notNull().default(5),
  monthlyBudgetUsd: real("monthly_budget_usd").notNull().default(50),
  kalshiApiKey: text("kalshi_api_key"),
  kalshiBaseUrl: text("kalshi_base_url"),
});

export const insertTradingSettingsSchema = createInsertSchema(tradingSettingsTable).omit({ id: true });
export type InsertTradingSettings = z.infer<typeof insertTradingSettingsSchema>;
export type TradingSettings = typeof tradingSettingsTable.$inferSelect;
