import { pgTable, text, serial, real, integer, timestamp } from "drizzle-orm/pg-core";

export const positionsTable = pgTable("positions", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  title: text("title").notNull(),
  side: text("side").notNull().$type<"yes" | "no">(),
  quantity: integer("quantity").notNull(),
  avgPrice: real("avg_price").notNull(),
  currentPrice: real("current_price").notNull().default(0),
  unrealizedPnl: real("unrealized_pnl").notNull().default(0),
  marketStatus: text("market_status").notNull().default("open"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
