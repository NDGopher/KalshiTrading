import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const backtestTradesTable = pgTable("backtest_trades", {
  id: serial("id").primaryKey(),
  backtestRunId: integer("backtest_run_id").notNull(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  title: text("title").notNull(),
  strategyName: text("strategy_name").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price").notNull(),
  quantity: integer("quantity").notNull(),
  pnl: real("pnl").notNull(),
  outcome: text("outcome").notNull(),
  clv: real("clv"),
  modelProbability: real("model_probability").notNull(),
  edge: real("edge").notNull(),
  confidence: real("confidence").notNull(),
  reasoning: text("reasoning"),
  marketResult: text("market_result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBacktestTradeSchema = createInsertSchema(backtestTradesTable).omit({ id: true, createdAt: true });
export type InsertBacktestTrade = z.infer<typeof insertBacktestTradeSchema>;
export type BacktestTrade = typeof backtestTradesTable.$inferSelect;
