import type { SimulatedTrade, SportBucketMetrics } from "../types.js";
import type { ArchiveMarketTick } from "../normalize.js";

/** Fine label for filters + heatmaps (NFL, NBA, …). */
export function kalshiSportLabel(ticker: string): string {
  const t = ticker.toUpperCase();
  const pairs: [string, string][] = [
    ["KXNFL", "NFL"],
    ["KXNBA", "NBA"],
    ["KXNHL", "NHL"],
    ["KXMLB", "MLB"],
    ["KXNCAAF", "NCAAF"],
    ["KXNCAAB", "NCAAB"],
    ["KXSOCCER", "Soccer"],
    ["KXEPL", "EPL"],
    ["KXUCL", "UCL"],
    ["KXMLS", "MLS"],
    ["KXNWSL", "NWSL"],
    ["KXUFC", "UFC"],
    ["KXGAME", "Game"],
  ];
  for (const [prefix, label] of pairs) {
    if (t.startsWith(prefix)) return label;
  }
  return kalshiSportBucket(ticker);
}

export function tickerMatchesSportToken(ticker: string, sportToken: string): boolean {
  const s = sportToken.trim().toUpperCase();
  if (s === "" || s === "ALL" || s === "*") return true;
  const label = kalshiSportLabel(ticker).toUpperCase();
  if (label === s) return true;
  const t = ticker.toUpperCase();
  if (s === "NFL") return t.startsWith("KXNFL");
  if (s === "NBA") return t.startsWith("KXNBA");
  if (s === "NHL") return t.startsWith("KXNHL");
  if (s === "MLB") return t.startsWith("KXMLB");
  if (s === "SOCCER") return /KX(EPL|UCL|MLS|SOCCER|CHAMPIONS|SERIEA|LALIGA)/.test(t);
  if (s === "SPORTS") return kalshiSportBucket(ticker) === "Sports";
  return t.startsWith(`KX${s}`) || label === s;
}

export function filterTicksBySport(ticks: ArchiveMarketTick[], sportToken: string): ArchiveMarketTick[] {
  const raw = sportToken.trim();
  if (raw.toUpperCase() === "ALL" || raw === "*") return ticks;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return ticks.filter((x) => tickerMatchesSportToken(x.ticker, raw));
  }
  return ticks.filter((x) => parts.some((p) => tickerMatchesSportToken(x.ticker, p)));
}

/** Coarse bucket aligned with Learner's category heuristics. */
export function kalshiSportBucket(ticker: string): string {
  const t = ticker.toUpperCase();
  if (
    t.startsWith("KXNBA") ||
    t.startsWith("KXNFL") ||
    t.startsWith("KXNHL") ||
    t.startsWith("KXMLB") ||
    t.startsWith("KXNWSL") ||
    t.startsWith("KXUFC") ||
    t.startsWith("KXLALIGA") ||
    t.startsWith("KXSERIEA") ||
    t.startsWith("KXEPL") ||
    t.startsWith("KXCHAMPIONS") ||
    t.startsWith("KXMLS") ||
    t.startsWith("KXUCL") ||
    t.startsWith("KXNCAAB") ||
    t.startsWith("KXNCAAF") ||
    t.startsWith("KXNCAAM") ||
    t.startsWith("KXSOCCER") ||
    t.startsWith("KXGAME")
  ) {
    return "Sports";
  }
  if (t.startsWith("KXBTC") || t.startsWith("KXETH") || t.startsWith("KXCRYPTO") || t.startsWith("KXSOLANA")) {
    return "Crypto";
  }
  if (
    t.startsWith("KXPRES") ||
    t.startsWith("KXSEN") ||
    t.startsWith("KXGOV") ||
    t.startsWith("KXELECT")
  ) {
    return "Politics";
  }
  if (
    t.startsWith("KXCPI") ||
    t.startsWith("KXGDP") ||
    t.startsWith("KXFED") ||
    t.startsWith("KXUNEMPLOYMENT") ||
    t.startsWith("KXINF")
  ) {
    return "Economics";
  }
  return "Other";
}

export function aggregateSportBuckets(trades: SimulatedTrade[]): SportBucketMetrics[] {
  const m = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const tr of trades) {
    const sport = tr.sportLabel ?? kalshiSportLabel(tr.ticker);
    const row = m.get(sport) ?? { trades: 0, wins: 0, pnl: 0 };
    row.trades++;
    if (tr.won) row.wins++;
    row.pnl += tr.pnlUsd;
    m.set(sport, row);
  }
  return [...m.entries()].map(([sport, v]) => ({
    sport,
    trades: v.trades,
    wins: v.wins,
    totalPnlUsd: v.pnl,
  }));
}
