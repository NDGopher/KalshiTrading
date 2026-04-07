import type { ArchiveMarketTick } from "./normalize.js";
import type { PmxtMarket, PmxtTicker } from "./pmxt-types.js";

/**
 * Build pmxt-shaped market/ticker views for interoperability with pmxt-style tooling.
 */
export function tickToPmxtMarket(tick: ArchiveMarketTick): PmxtMarket {
  return {
    id: tick.ticker,
    symbol: tick.ticker,
    base: "YES",
    quote: "USD",
    active: true,
    status: "open",
    question: tick.ticker,
    liquidity: tick.liquidity,
    volume24h: tick.volume24h,
    updatedAt: new Date(tick.tsMs),
    info: tick.raw,
  };
}

export function tickToPmxtTicker(tick: ArchiveMarketTick): PmxtTicker {
  return {
    symbol: tick.ticker,
    marketId: tick.ticker,
    last: tick.yesMid,
    bid: tick.yesBid,
    ask: tick.yesAsk,
    volume: tick.volume24h,
    timestamp: tick.tsMs,
    datetime: new Date(tick.tsMs),
    info: tick.raw,
  };
}
