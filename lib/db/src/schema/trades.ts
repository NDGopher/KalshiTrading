import { pgTable, text, serial, timestamp, integer, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tradesTable = pgTable("trades", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  title: text("title").notNull(),
  side: text("side").notNull(),
  entryPrice: real("entry_price").notNull(),
  exitPrice: real("exit_price"),
  quantity: integer("quantity").notNull(),
  pnl: real("pnl"),
  status: text("status").notNull().default("pending"),
  modelProbability: real("model_probability").notNull(),
  edge: real("edge").notNull(),
  confidence: real("confidence").notNull(),
  analystReasoning: text("analyst_reasoning"),
  auditorFlags: jsonb("auditor_flags").$type<string[]>().default([]),
  riskScore: real("risk_score").notNull(),
  kellyFraction: real("kelly_fraction").notNull(),
  kalshiOrderId: text("kalshi_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});

export const insertTradeSchema = createInsertSchema(tradesTable).omit({ id: true, createdAt: true });
export type InsertTrade = z.infer<typeof insertTradeSchema>;
export type Trade = typeof tradesTable.$inferSelect;
