import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketSnapshotsTable = pgTable("market_snapshots", {
  id: serial("id").primaryKey(),
  kalshiTicker: text("kalshi_ticker").notNull(),
  yesPrice: real("yes_price").notNull(),
  noPrice: real("no_price").notNull(),
  yesAsk: real("yes_ask"),
  yesBid: real("yes_bid"),
  volume: integer("volume"),
  openInterest: integer("open_interest"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull().defaultNow(),
  hoursToExpiry: real("hours_to_expiry"),
  isEventStart: integer("is_event_start").default(0),
});

export const insertMarketSnapshotSchema = createInsertSchema(marketSnapshotsTable).omit({ id: true });
export type InsertMarketSnapshot = z.infer<typeof insertMarketSnapshotSchema>;
export type MarketSnapshot = typeof marketSnapshotsTable.$inferSelect;
