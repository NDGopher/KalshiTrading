import { pgTable, text, serial, timestamp, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketOpportunitiesTable = pgTable("market_opportunities", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  currentYesPrice: real("current_yes_price").notNull(),
  modelProbability: real("model_probability").notNull(),
  edge: real("edge").notNull(),
  confidence: real("confidence").notNull(),
  side: text("side").notNull(),
  volume24h: real("volume_24h").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMarketOpportunitySchema = createInsertSchema(marketOpportunitiesTable).omit({ id: true, createdAt: true });
export type InsertMarketOpportunity = z.infer<typeof insertMarketOpportunitySchema>;
export type MarketOpportunity = typeof marketOpportunitiesTable.$inferSelect;
