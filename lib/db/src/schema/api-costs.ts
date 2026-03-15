import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const apiCostsTable = pgTable("api_costs", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull().default("anthropic"),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  agentName: text("agent_name").notNull(),
  marketTicker: text("market_ticker"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertApiCostSchema = createInsertSchema(apiCostsTable).omit({ id: true, createdAt: true });
export type InsertApiCost = z.infer<typeof insertApiCostSchema>;
export type ApiCost = typeof apiCostsTable.$inferSelect;
