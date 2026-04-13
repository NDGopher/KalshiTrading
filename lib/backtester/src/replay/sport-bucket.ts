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
  if (s === "CRYPTO+OTHER" || s === "CRYPTO_OTHER" || s === "CRYPTOPLUSOTHER") {
    const b = kalshiSportBucket(ticker);
    return b === "Crypto" || b === "Other";
  }
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
  const up = raw.toUpperCase();
  if (up === "ALL" || raw === "*") return ticks;
  if (up === "CRYPTO+OTHER" || up === "CRYPTO_OTHER" || up === "CRYPTOPLUSOTHER") {
    return ticks.filter((x) => {
      const b = kalshiSportBucket(x.ticker);
      return b === "Crypto" || b === "Other";
    });
  }
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) {
    return ticks.filter((x) => tickerMatchesSportToken(x.ticker, raw));
  }
  return ticks.filter((x) => parts.some((p) => tickerMatchesSportToken(x.ticker, p)));
}

/**
 * Bucket using both event and market ticker — political/crypto events often use a clear
 * event_ticker (e.g. KXPRES-…) while the market ticker suffix is opaque.
 */
export function kalshiMarketBucket(market: {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
}): string {
  for (const raw of [market.series_ticker, market.event_ticker, market.ticker] as const) {
    const s = (raw || "").trim();
    if (!s) continue;
    const b = kalshiSportBucket(s);
    if (b !== "Other") return b;
  }
  return kalshiSportBucket(market.ticker);
}

/** Roll Kalshi buckets into Sports vs Politics/Crypto/Economics/Mention/Other for reporting. */
export type KalshiCoarseMacro = "Sports" | "Politics" | "Crypto" | "Economics" | "Mention" | "Other";

export function kalshiCoarseMacroGroup(market: {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
}): KalshiCoarseMacro {
  const m = kalshiMarketBucket(market);
  if (m === "Sports") return "Sports";
  if (m === "Politics") return "Politics";
  if (m === "Crypto") return "Crypto";
  if (m === "Economics") return "Economics";
  if (m === "Mention") return "Mention";
  return "Other";
}

/**
 * Earnings / pop-culture mention contracts (KXMENTION*, INMENTION-style series, corp mention).
 * Used by live scanner priority — keep patterns tight to avoid false positives.
 */
export function kalshiIsMentionTicker(ticker: string): boolean {
  const t = (ticker || "").toUpperCase();
  if (!t) return false;
  if (t.startsWith("KXTRUMPMENTION")) return true;
  if (t.startsWith("KXMENTION")) return true;
  if (t.startsWith("KXINMENTION")) return true;
  if (t.startsWith("KXCORPMENTION")) return true;
  if (t.startsWith("KXSTOCKMENTION")) return true;
  if (t.includes("EARNINGSMENT") || t.includes("EARNMENTION")) return true;
  if (t.includes("MENTION") && t.startsWith("KX") && !t.startsWith("KXGAME")) return true;
  return false;
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
  if (
    t.startsWith("KXBTC") ||
    t.startsWith("KXETH") ||
    t.startsWith("KXCRYPTO") ||
    t.startsWith("KXSOLANA") ||
    t.startsWith("KXDOGE") ||
    t.startsWith("KXXRP") ||
    t.startsWith("KXADA")
  ) {
    return "Crypto";
  }
  if (
    t.startsWith("KXPRES") ||
    t.startsWith("KXSEN") ||
    t.startsWith("KXGOV") ||
    t.startsWith("KXELECT") ||
    t.startsWith("KXHOUSE") ||
    t.startsWith("KXCONG") ||
    t.startsWith("KXCOURT") ||
    t.startsWith("KXVP") ||
    t.startsWith("KXVOTE") ||
    t.startsWith("KXPOLL")
  ) {
    return "Politics";
  }
  if (kalshiIsMentionTicker(t)) {
    return "Mention";
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

/** Daily high / temp-bin style weather contracts (KXHIGH*, HIGHCHI, …). */
export function kalshiIsWeatherTicker(ticker: string): boolean {
  const t = ticker.toUpperCase();
  if (t.startsWith("KXHIGH")) return true;
  if (t.startsWith("HIGH") && t.length >= 6) return true;
  if (t.includes("WEATHER") || t.includes("TMAX") || t.includes("TMIN")) return true;
  return false;
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
