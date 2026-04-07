import type { ArchiveMarketTick } from "./normalize.js";
import type { ReplayAnalysis, ReplayCandidate, ReplayMarket } from "./types.js";
import type { TickerPriceRolling } from "./replay/price-history.js";

export function deterministicHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** @deprecated Strategies must not see settlement — use `tickToReplayMarketBlind`. */
export function tickToReplayMarket(tick: ArchiveMarketTick, outcomeYes: boolean): ReplayMarket {
  const close = new Date(tick.tsMs + 48 * 3600 * 1000).toISOString();
  return {
    ticker: tick.ticker,
    close_time: close,
    open_time: new Date(tick.tsMs - 3600 * 1000).toISOString(),
    expected_expiration_time: close,
    _dbResult: outcomeYes ? "yes" : "no",
    result: outcomeYes ? "yes" : "no",
    category: tick.eventTicker,
  };
}

/** No resolution fields — safe for strategy decision time. */
export function tickToReplayMarketBlind(tick: ArchiveMarketTick): ReplayMarket {
  const close = new Date(tick.tsMs + 48 * 3600 * 1000).toISOString();
  return {
    ticker: tick.ticker,
    close_time: close,
    open_time: new Date(tick.tsMs - 3600 * 1000).toISOString(),
    expected_expiration_time: close,
    category: tick.eventTicker,
  };
}

export function tickToReplayCandidate(tick: ArchiveMarketTick, outcomeYes: boolean): ReplayCandidate {
  const spread = Math.abs(tick.yesAsk - tick.yesBid);
  const safeSpread = spread > 0.5 ? Math.min(0.06, Math.max(0.01, tick.yesMid * 0.05)) : spread;
  return {
    market: tickToReplayMarket(tick, outcomeYes),
    yesPrice: tick.yesMid,
    noPrice: 1 - tick.yesMid,
    yesAsk: tick.yesAsk > 0 ? tick.yesAsk : tick.yesMid,
    noAsk: 1 - tick.yesBid,
    spread: safeSpread,
    volume24h: tick.volume24h,
    liquidity: tick.liquidity,
    hoursToExpiry: 24,
    hasLiveData: true,
  };
}

export function tickToReplayCandidateBlind(tick: ArchiveMarketTick): ReplayCandidate {
  const spread = Math.abs(tick.yesAsk - tick.yesBid);
  const safeSpread = spread > 0.5 ? Math.min(0.06, Math.max(0.01, tick.yesMid * 0.05)) : spread;
  return {
    market: tickToReplayMarketBlind(tick),
    yesPrice: tick.yesMid,
    noPrice: 1 - tick.yesMid,
    yesAsk: tick.yesAsk > 0 ? tick.yesAsk : tick.yesMid,
    noAsk: 1 - tick.yesBid,
    spread: safeSpread,
    volume24h: tick.volume24h,
    liquidity: tick.liquidity,
    hoursToExpiry: 24,
    hasLiveData: true,
  };
}

/**
 * Legacy dev model — **uses final outcome** inside the signal (lookahead). Do not use for
 * production historical replay; use `blindReplayAnalysisForTick` instead.
 */
export function syntheticAnalysisForTick(tick: ArchiveMarketTick, outcomeYes: boolean): ReplayAnalysis {
  const candidate = tickToReplayCandidate(tick, outcomeYes);
  const market = candidate.market;
  const settledYes = outcomeYes;
  const trueOutcome = settledYes ? 1.0 : 0.0;
  const yesPrice = candidate.yesPrice;

  const hash = deterministicHash(market.ticker + market.close_time);
  const hashFrac = (hash % 1000) / 1000;
  const hash2 = deterministicHash(market.ticker + "accuracy");
  const modelIsAccurate = (hash2 % 100) < 57;
  const signalTarget = modelIsAccurate ? trueOutcome : 1 - trueOutcome;
  const signalStrength = 0.08 + hashFrac * 0.12;
  const rawModel = signalStrength * signalTarget + (1 - signalStrength) * yesPrice;
  const noise = ((hash % 100) - 50) / 2500;
  const modelProb = Math.max(0.04, Math.min(0.96, rawModel + noise));
  const side: "yes" | "no" = modelProb > yesPrice ? "yes" : "no";
  const edge = Math.abs(modelProb - yesPrice) * 100;
  const volumeBoost = Math.min(0.08, Math.max(0, candidate.volume24h) / 6000);
  const confidence = Math.min(0.88, 0.4 + (edge / 100) * 1.0 + volumeBoost + hashFrac * 0.06);

  return {
    candidate,
    modelProbability: modelProb,
    edge,
    confidence,
    side,
    reasoning: `Parquet replay: mid=${(yesPrice * 100).toFixed(1)}¢ model=${(modelProb * 100).toFixed(1)}¢ edge=${edge.toFixed(1)}pp`,
  };
}

/**
 * Strict no-lookahead analyst: prices, spread history, volume only (no settlement peeking).
 */
export function buildBlindReplayCandidate(tick: ArchiveMarketTick, rolling: TickerPriceRolling): ReplayCandidate {
  const base = tickToReplayCandidateBlind(tick);
  const spread = Math.abs(tick.yesAsk - tick.yesBid);
  const ph = rolling.snapshot(tick.ticker, tick.yesMid, spread, tick.tsMs);
  return ph ? { ...base, priceHistory: ph } : base;
}

export function blindReplayAnalysisForTick(tick: ArchiveMarketTick, rolling: TickerPriceRolling): ReplayAnalysis {
  const candidate = buildBlindReplayCandidate(tick, rolling);
  const yesPrice = candidate.yesPrice;
  const ph = candidate.priceHistory;

  const hourBucket = Math.floor(tick.tsMs / 3_600_000);
  const hash = deterministicHash(tick.ticker + String(hourBucket));
  const hashFrac = (hash % 1000) / 1000;

  let skew = 0;
  if (ph) {
    skew = -(ph.currentVsMeanPct / 100) * 0.12;
  }
  const noise = ((hash % 100) - 50) / 2200;
  const modelProb = Math.max(0.04, Math.min(0.96, yesPrice + skew + noise + (hashFrac - 0.5) * 0.06));
  const side: "yes" | "no" = modelProb > yesPrice ? "yes" : "no";
  const edge = Math.abs(modelProb - yesPrice) * 100;
  const volumeBoost = Math.min(0.1, Math.max(0, candidate.volume24h) / 7000);
  const confidence = Math.min(0.88, 0.34 + edge / 110 + volumeBoost + hashFrac * 0.05);

  return {
    candidate,
    modelProbability: modelProb,
    edge,
    confidence,
    side,
    reasoning: `Blind: mid=${(yesPrice * 100).toFixed(1)}¢ model=${(modelProb * 100).toFixed(1)}¢ edge=${edge.toFixed(1)}pp`,
  };
}

export function resolveOutcomeForTick(tick: ArchiveMarketTick): { yes: boolean; synthetic: boolean } {
  if (tick.outcomeYes !== null) {
    return { yes: tick.outcomeYes, synthetic: false };
  }
  const h = deterministicHash(tick.ticker + String(tick.tsMs));
  return { yes: h % 2 === 0, synthetic: true };
}

/** @deprecated Use `pnlKalshiTaker` from `./kalshi-fees.js` (correct fee curve + winners-only fee). */
export function simulateTakerYesPnl(entryYesAsk: number, contracts: number, outcomeYes: boolean, feePerContract = 0.07): number {
  const stake = contracts * entryYesAsk;
  if (outcomeYes) {
    const gross = contracts * (1 - entryYesAsk);
    return gross - feePerContract * contracts;
  }
  return -stake - feePerContract * contracts;
}
