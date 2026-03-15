import { pgTable, serial, text, real, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const backtestRunsTable = pgTable("backtest_runs", {
  id: serial("id").primaryKey(),
  strategyName: text("strategy_name").notNull(),
  status: text("status").notNull().default("running"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  marketsEvaluated: integer("markets_evaluated").notNull().default(0),
  tradesSimulated: integer("trades_simulated").notNull().default(0),
  totalPnl: real("total_pnl").notNull().default(0),
  winRate: real("win_rate").notNull().default(0),
  sharpeRatio: real("sharpe_ratio"),
  maxDrawdown: real("max_drawdown"),
  avgEdge: real("avg_edge"),
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertBacktestRunSchema = createInsertSchema(backtestRunsTable).omit({ id: true, createdAt: true });
export type InsertBacktestRun = z.infer<typeof insertBacktestRunSchema>;
export type BacktestRun = typeof backtestRunsTable.$inferSelect;
