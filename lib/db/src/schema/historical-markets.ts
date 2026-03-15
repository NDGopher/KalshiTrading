import { pgTable, serial, text, real, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const historicalMarketsTable = pgTable("historical_markets", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  title: text("title").notNull(),
  category: text("category"),
  openPrice: real("open_price"),
  lastPrice: real("last_price").notNull(),
  yesAsk: real("yes_ask"),
  yesBid: real("yes_bid"),
  volume24h: integer("volume_24h"),
  liquidity: real("liquidity"),
  status: text("status").notNull(),
  result: text("result"),
  closeTime: timestamp("close_time", { withTimezone: true }),
  expirationTime: timestamp("expiration_time", { withTimezone: true }),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  rawData: jsonb("raw_data").$type<Record<string, unknown>>(),
});

export const insertHistoricalMarketSchema = createInsertSchema(historicalMarketsTable).omit({ id: true });
export type InsertHistoricalMarket = z.infer<typeof insertHistoricalMarketSchema>;
export type HistoricalMarket = typeof historicalMarketsTable.$inferSelect;
