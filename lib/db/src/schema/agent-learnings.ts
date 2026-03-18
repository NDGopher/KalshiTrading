import { pgTable, serial, text, real, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export interface LearningInsight {
  dimension: string;
  finding: string;
  action: string;
  signal: "favor" | "avoid" | "caution" | "neutral";
  trades: number;
  winRate: number;
  avgPnl: number;
}

export const agentLearningsTable = pgTable("agent_learnings", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  totalClosedTrades: integer("total_closed_trades").notNull(),
  winRate: real("win_rate").notNull(),
  totalPnl: real("total_pnl").notNull(),
  insights: jsonb("insights").$type<LearningInsight[]>().notNull().default([]),
  analystInjection: text("analyst_injection").notNull(),
  rawAnalysis: text("raw_analysis").notNull(),
});

export type AgentLearning = typeof agentLearningsTable.$inferSelect;
