/**
 * Scan-to-scan proxy for replay tape microstructure (imbalance + whale prints).
 * State persists for the lifetime of the API process; resets naturally as tickers age out.
 */
type TapeState = {
  prevMid: number;
  prevVol: number;
  signedMoves: number[];
  counts: number[];
};

const states = new Map<string, TapeState>();

export function updateLiveTapeFlow(
  ticker: string,
  yesMid: number,
  volume24h: number,
): { imbalance: number; whalePrint: boolean } {
  let s = states.get(ticker);
  if (!s) {
    states.set(ticker, {
      prevMid: yesMid,
      prevVol: volume24h,
      signedMoves: [],
      counts: [],
    });
    return { imbalance: 0, whalePrint: false };
  }

  const dVol = Math.max(0, volume24h - s.prevVol);
  const cnt = Math.max(1, Math.round(dVol / 30 + 1));
  const delta = yesMid - s.prevMid;
  s.prevMid = yesMid;
  s.prevVol = volume24h;

  const signed = Math.sign(delta) * Math.log1p(cnt);
  s.signedMoves.push(signed);
  while (s.signedMoves.length > 24) s.signedMoves.shift();
  s.counts.push(cnt);
  while (s.counts.length > 64) s.counts.shift();

  const imbalance = s.signedMoves.reduce((a, b) => a + b, 0);
  const sorted = [...s.counts].sort((a, b) => a - b);
  const p90 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.9)]! : cnt;
  const whalePrint = cnt >= Math.max(p90, 6) && cnt >= 12;

  return { imbalance, whalePrint };
}
