import { pgTable, serial, text, real, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Daily rolling aggregates per keeper strategy (7d / 30d windows). Statistical only — no LLM, tiny rows.
 */
export const strategyPerformanceSnapshotsTable = pgTable(
  "strategy_performance_snapshots",
  {
    id: serial("id").primaryKey(),
    /** UTC calendar date when the snapshot was computed (YYYY-MM-DD). */
    computedForDate: text("computed_for_date").notNull(),
    periodDays: integer("period_days").notNull(),
    strategyName: text("strategy_name").notNull(),
    trades: integer("trades").notNull(),
    wins: integer("wins").notNull(),
    pnlUsd: real("pnl_usd").notNull(),
    sharpeApprox: real("sharpe_approx"),
    expectancy: real("expectancy"),
    avgEdge: real("avg_edge"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    unq: uniqueIndex("strategy_perf_snap_unq").on(t.computedForDate, t.periodDays, t.strategyName),
  }),
);

export type StrategyPerformanceSnapshot = typeof strategyPerformanceSnapshotsTable.$inferSelect;
