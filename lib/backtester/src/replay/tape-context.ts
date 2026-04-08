import { deterministicHash } from "../synthetic-analysis.js";
import type { ArchiveMarketTick } from "../normalize.js";
import { kalshiSportLabel } from "./sport-bucket.js";

function sharpeTiny(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  const sd = Math.sqrt(v) || 1e-9;
  return (m / sd) * Math.sqrt(xs.length);
}

type WalletPending = { wallet?: string; tsMs: number; entryYes: number; sport: string };

/**
 * Causal wallet stats: attributes tape trades to a wallet only after `marketSettledMs` has passed
 * (no outcome used before settlement). Uses realized YES outcome for unit PnL of a hypothetical YES buy at tape mid.
 */
export class WalletSettlementProfiler {
  private readonly pending = new Map<string, WalletPending[]>();
  private readonly flushed = new Set<string>();
  private readonly settledMs = new Map<string, number | null>();
  private readonly outcomeYes = new Map<string, boolean>();
  private readonly lastTapeTs = new Map<string, number>();
  private readonly wins = new Map<string, number>();
  private readonly losses = new Map<string, number>();
  private readonly pnls = new Map<string, number[]>();
  private readonly sportStats = new Map<string, Map<string, { w: number; n: number }>>();

  onTime(tsMs: number): void {
    for (const ticker of [...this.pending.keys()]) {
      if (this.flushed.has(ticker)) continue;
      const s = this.settledMs.get(ticker);
      if (s == null || tsMs <= s) continue;
      this.flushTicker(ticker);
    }
  }

  private flushTicker(ticker: string): void {
    const s = this.settledMs.get(ticker);
    const oy = this.outcomeYes.get(ticker);
    if (s == null || oy === undefined) {
      this.flushed.add(ticker);
      this.pending.set(ticker, []);
      return;
    }
    const list = this.pending.get(ticker) ?? [];
    for (const p of list) {
      if (!p.wallet) continue;
      if (p.tsMs >= s) continue;
      const won = oy === true;
      const pnlUnit = won ? 1 - p.entryYes : -p.entryYes;
      const w = p.wallet;
      if (won) this.wins.set(w, (this.wins.get(w) ?? 0) + 1);
      else this.losses.set(w, (this.losses.get(w) ?? 0) + 1);
      const arr = this.pnls.get(w) ?? [];
      arr.push(pnlUnit);
      while (arr.length > 96) arr.shift();
      this.pnls.set(w, arr);
      let sm = this.sportStats.get(w);
      if (!sm) {
        sm = new Map();
        this.sportStats.set(w, sm);
      }
      const row = sm.get(p.sport) ?? { w: 0, n: 0 };
      row.n++;
      if (won) row.w++;
      sm.set(p.sport, row);
    }
    this.pending.set(ticker, []);
    this.flushed.add(ticker);
  }

  ensureTickerMeta(tick: ArchiveMarketTick): void {
    if (this.settledMs.has(tick.ticker)) return;
    this.settledMs.set(tick.ticker, tick.marketSettledMs ?? null);
    this.outcomeYes.set(tick.ticker, tick.outcomeYes === true);
  }

  /** Record a historical tape print (not our simulated trade). */
  recordTapeTrade(tick: ArchiveMarketTick): void {
    this.ensureTickerMeta(tick);
    this.lastTapeTs.set(tick.ticker, tick.tsMs);
    const sport = kalshiSportLabel(tick.ticker);
    const list = this.pending.get(tick.ticker) ?? [];
    list.push({ wallet: tick.walletId, tsMs: tick.tsMs, entryYes: tick.yesMid, sport });
    this.pending.set(tick.ticker, list);
  }

  /**
   * When market parquet had no settlement timestamp, flush after last tape print in this run
   * (no information beyond the loaded window).
   */
  finalizeUnsettledFromTapeEnd(fallbackEndTs: number): void {
    for (const ticker of [...this.pending.keys()]) {
      if (this.flushed.has(ticker)) continue;
      if (this.settledMs.get(ticker) != null) continue;
      const last = this.lastTapeTs.get(ticker) ?? fallbackEndTs;
      this.settledMs.set(ticker, last + 1);
      this.flushTicker(ticker);
    }
  }

  snapshot(
    walletId: string | undefined,
    currentSport: string,
  ): {
    winRate: number | null;
    sharpe: number | null;
    settledTrades: number;
    topSport: string | null;
    topSportWinRate: number | null;
    currentSportWinRate: number | null;
  } {
    if (!walletId) {
      return {
        winRate: null,
        sharpe: null,
        settledTrades: 0,
        topSport: null,
        topSportWinRate: null,
        currentSportWinRate: null,
      };
    }
    const w = this.wins.get(walletId) ?? 0;
    const l = this.losses.get(walletId) ?? 0;
    const n = w + l;
    const pnls = this.pnls.get(walletId) ?? [];
    const sm = this.sportStats.get(walletId);
    let topSport: string | null = null;
    let best = -1;
    let topSportWinRate: number | null = null;
    if (sm) {
      for (const [sp, { w: ww, n: nn }] of sm) {
        if (nn < 3) continue;
        const wr = ww / nn;
        if (wr > best) {
          best = wr;
          topSport = sp;
          topSportWinRate = wr;
        }
      }
    }
    let currentSportWinRate: number | null = null;
    if (sm && currentSport) {
      const row = sm.get(currentSport);
      if (row && row.n >= 2) currentSportWinRate = row.w / row.n;
    }
    return {
      winRate: n === 0 ? null : w / n,
      sharpe: pnls.length >= 2 ? sharpeTiny(pnls) : null,
      settledTrades: n,
      topSport,
      topSportWinRate,
      currentSportWinRate,
    };
  }
}

/** Signed microstructure pressure from tape (no outcomes). */
export class TapeFlowTracker {
  private readonly prevMid = new Map<string, number>();
  private readonly signedMoves = new Map<string, number[]>();
  private readonly counts = new Map<string, number[]>();

  update(tick: ArchiveMarketTick): { imbalance: number; whalePrint: boolean } {
    const { ticker } = tick;
    const prev = this.prevMid.get(ticker) ?? tick.yesMid;
    const delta = tick.yesMid - prev;
    this.prevMid.set(ticker, tick.yesMid);

    const cnt = Math.max(1, tick.tradeCount ?? 1);
    const signed = Math.sign(delta) * Math.log1p(cnt);
    const arr = this.signedMoves.get(ticker) ?? [];
    arr.push(signed);
    while (arr.length > 24) arr.shift();
    this.signedMoves.set(ticker, arr);

    const cArr = this.counts.get(ticker) ?? [];
    cArr.push(cnt);
    while (cArr.length > 64) cArr.shift();
    this.counts.set(ticker, cArr);

    const imbalance = arr.reduce((a, b) => a + b, 0);
    const sorted = [...cArr].sort((a, b) => a - b);
    const p90 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.9)]! : cnt;
    const whalePrint = cnt >= Math.max(p90, 6) && cnt >= 12;

    return { imbalance, whalePrint };
  }
}

const FRESH_WALLET_WINDOW_MS = 48 * 3600_000;

export class FreshWalletTracker {
  private readonly firstSeenMs = new Map<string, number>();

  /**
   * "Fresh" = first tape print for this wallet, or any print within 48h of first sight
   * (month-long replays were starving the old single-tick definition).
   */
  isFresh(id: string | undefined, tsMs: number): boolean {
    if (!id) return false;
    const t0 = this.firstSeenMs.get(id);
    if (t0 === undefined) {
      this.firstSeenMs.set(id, tsMs);
      return true;
    }
    return tsMs - t0 <= FRESH_WALLET_WINDOW_MS;
  }
}

export class WalletActivityTracker {
  private readonly tickersByWallet = new Map<string, Set<string>>();

  noteTrade(walletId: string | undefined, ticker: string): void {
    if (!walletId) return;
    let s = this.tickersByWallet.get(walletId);
    if (!s) {
      s = new Set();
      this.tickersByWallet.set(walletId, s);
    }
    s.add(ticker);
  }

  diversity(walletId: string | undefined): number {
    if (!walletId) return 0;
    return this.tickersByWallet.get(walletId)?.size ?? 0;
  }
}

export class MarketMakerSim {
  deterministicFill(ticker: string, tsMs: number): boolean {
    const h = deterministicHash(`${ticker}|${tsMs}`);
    return h % 100 < 9;
  }
}
