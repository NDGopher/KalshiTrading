import { getSportsMarkets, type KalshiMarket } from "../kalshi-client.js";
import { db, marketOpportunitiesTable } from "@workspace/db";

export interface ScanCandidate {
  market: KalshiMarket;
  yesPrice: number;
  noPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  hoursToExpiry: number;
}

const SPORT_KEYWORDS = [
  "nfl", "nba", "mlb", "soccer", "mls", "premier league",
  "ncaa", "college", "football", "basketball", "baseball",
  "nhl", "hockey", "ufc", "mma", "tennis", "golf",
  "sports", "game", "match", "win", "points", "score",
  "player", "team",
  "KXNFL", "KXNBA", "KXMLB", "KXNHL", "KXSOC", "KXNCAA",
  "KXSPORT", "KXMVE"
];

export async function scanMarkets(customKeywords?: string[]): Promise<{
  candidates: ScanCandidate[];
  totalScanned: number;
}> {
  const keywords = customKeywords || SPORT_KEYWORDS;
  const markets = await getSportsMarkets(keywords);

  const now = new Date();
  const candidates: ScanCandidate[] = [];

  for (const market of markets) {
    const yesPrice = parseFloat(market.last_price_dollars || "0") || (market.yes_bid + market.yes_ask) / 2 / 100;
    const noPrice = 1 - yesPrice;
    const spread = Math.abs((market.yes_ask - market.yes_bid)) / 100;
    const volume24h = market.volume_24h || 0;
    const liquidity = parseFloat(market.liquidity_dollars || "0") || market.liquidity || 0;
    const expiresAt = new Date(market.expected_expiration_time || market.expiration_time || market.close_time);
    const hoursToExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursToExpiry < 0.5) continue;
    if (yesPrice <= 0.01 || yesPrice >= 0.99) continue;

    candidates.push({
      market,
      yesPrice,
      noPrice,
      spread,
      volume24h,
      liquidity,
      hoursToExpiry,
    });
  }

  candidates.sort((a, b) => b.volume24h - a.volume24h);

  return {
    candidates: candidates.slice(0, 50),
    totalScanned: markets.length,
  };
}
