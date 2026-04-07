import type { ReplayCandidate } from "../types.js";

/** Kalshi multi-leg games: first two hyphen segments (see live Probability Arb). */
export function gameKeyFromKalshiTicker(ticker: string): string | null {
  const parts = ticker.split("-");
  if (parts.length < 3) return null;
  return parts.slice(0, 2).join("-");
}

/** Latest candidate snapshot per ticker, grouped by game key (for probability arb). */
export class GameLegBook {
  private readonly games = new Map<string, Map<string, ReplayCandidate>>();

  update(c: ReplayCandidate): void {
    const gk = gameKeyFromKalshiTicker(c.market.ticker);
    if (!gk) return;
    let m = this.games.get(gk);
    if (!m) {
      m = new Map();
      this.games.set(gk, m);
    }
    m.set(c.market.ticker, { ...c });
  }

  /** All legs we have seen for this ticker's game (including current). */
  legsForTicker(ticker: string): ReplayCandidate[] {
    const gk = gameKeyFromKalshiTicker(ticker);
    if (!gk) return [];
    const m = this.games.get(gk);
    if (!m) return [];
    return [...m.values()];
  }
}
