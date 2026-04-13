/**
 * Shared macro / high-priority heuristics for Kalshi live fetch + scanner.
 * Keeps structural-junk bypass aligned with HP classification (ticker / event / series / category).
 */
import type { KalshiMarket } from "./kalshi-client.js";
import {
  kalshiIsMentionTicker,
  kalshiIsWeatherTicker,
  kalshiMarketBucket,
} from "@workspace/backtester";

export const MACRO_HP_SUBSTRING_KEYWORDS = [
  "election",
  "president",
  "climate",
  "temperature",
  "forecast",
  "mention",
  "earnings",
  "gas price",
  "gasprice",
] as const;

export function marketTickerTripleUpper(m: KalshiMarket): [string, string, string] {
  return [(m.ticker || "").toUpperCase(), (m.event_ticker || "").toUpperCase(), (m.series_ticker || "").toUpperCase()];
}

/** Backtest-style macro tickers: KXHIGH*, mentions, WTI, AAA gas. */
export function explicitHighVolumeMacroHp(m: KalshiMarket): { hp: true; reason: string } | null {
  const parts = marketTickerTripleUpper(m);
  if (parts.some((s) => s.startsWith("KXHIGH"))) return { hp: true, reason: "explicit_KXHIGH" };
  const mentionRoots = [
    "KXTRUMPMENTION",
    "KXMENTION",
    "KXINMENTION",
    "KXCORPMENTION",
    "KXSTOCKMENTION",
  ];
  for (const root of mentionRoots) {
    if (parts.some((s) => s.startsWith(root) || s.includes(root)))
      return { hp: true, reason: `explicit_${root}` };
  }
  if (parts.some((s) => s.startsWith("KXWTIW") || s.startsWith("KXWTI")))
    return { hp: true, reason: "explicit_KXWTI" };
  if (parts.some((s) => s.startsWith("KXAAAGASD"))) return { hp: true, reason: "explicit_KXAAAGASD" };
  return null;
}

/** Ticker + event + series + category (lowercase) — HP keywords + junk bypass + politics Raw tier. */
export function macroTickerEventSeriesCategoryBlobLower(m: KalshiMarket): string {
  return `${m.ticker || ""} ${m.event_ticker || ""} ${m.series_ticker || ""} ${m.category || ""}`.toLowerCase();
}

function mentionFromMarket(m: KalshiMarket): boolean {
  if (kalshiIsMentionTicker(m.ticker)) return true;
  const et = m.event_ticker;
  const st = m.series_ticker;
  if (et && kalshiIsMentionTicker(et)) return true;
  if (st && kalshiIsMentionTicker(st)) return true;
  const cat = (m.category || "").toLowerCase();
  if (cat.includes("mention")) return true;
  return false;
}

/** True when we should keep tight liquidity/price floors (game markets only). */
export function isStrictSportsLikeMarket(m: KalshiMarket): boolean {
  const cat = (m.category || "").toLowerCase();
  if (kalshiIsWeatherTicker(m.ticker)) return false;
  if (mentionFromMarket(m)) return false;
  if (cat.includes("politic") || cat.includes("crypto") || cat.includes("economic")) return false;
  if (cat.includes("financial") && !cat.includes("sport")) return false;
  if (cat.includes("entertainment") || cat.includes("weather") || cat.includes("science")) return false;
  if (cat.includes("sport")) return true;
  return kalshiMarketBucket(m) === "Sports";
}

/** Keyword macro HP — skipped for strict sports so NFL/NBA volume is unchanged. */
export function keywordSubstringMacroHp(m: KalshiMarket): { hp: true; reason: string } | null {
  if (isStrictSportsLikeMarket(m)) return null;
  const blob = macroTickerEventSeriesCategoryBlobLower(m);
  for (const k of MACRO_HP_SUBSTRING_KEYWORDS) {
    if (blob.includes(k)) return { hp: true, reason: `keyword_${k.replace(/\s+/g, "_")}` };
  }
  return null;
}

/**
 * Structural junk bypass: explicit macro families **or** macro substring keywords on
 * ticker/event/series/category. Strict sports unchanged — no keyword bypass.
 */
export function knownGoodMacroStructuralJunkBypass(m: KalshiMarket): boolean {
  if (explicitHighVolumeMacroHp(m) != null) return true;
  if (isStrictSportsLikeMarket(m)) return false;
  const blob = macroTickerEventSeriesCategoryBlobLower(m);
  return MACRO_HP_SUBSTRING_KEYWORDS.some((k) => blob.includes(k));
}

export function politicsKeywordMacroBlob(m: KalshiMarket): boolean {
  if (isStrictSportsLikeMarket(m)) return false;
  const blob = macroTickerEventSeriesCategoryBlobLower(m);
  return blob.includes("election") || blob.includes("president");
}

/** TRUMPMENTION / corp mention series on opaque child tickers — Raw pass Mention tier. */
export function explicitMentionTierBlob(m: KalshiMarket): boolean {
  const u = `${m.ticker || ""}${m.event_ticker || ""}${m.series_ticker || ""}`.toUpperCase();
  return (
    u.includes("TRUMPMENTION") ||
    u.includes("KXMENTION") ||
    u.includes("KXINMENTION") ||
    u.includes("KXCORPMENTION") ||
    u.includes("KXSTOCKMENTION")
  );
}
