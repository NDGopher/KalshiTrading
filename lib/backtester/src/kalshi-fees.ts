/**
 * Kalshi taker fee (matches `artifacts/api-server/src/lib/agents/reconciler.ts`).
 * fee = ceil(0.07 × C × P × (1 − P)) in dollars; only charged on winning trades.
 */
export function kalshiTakerFeeUsd(contracts: number, entryPrice01: number): number {
  if (contracts <= 0 || entryPrice01 <= 0 || entryPrice01 >= 1) return 0;
  return Math.ceil(0.07 * contracts * entryPrice01 * (1 - entryPrice01) * 100) / 100;
}

/** Buy YES at `entryYes` (0–1). Loss: stake only (no fee). Win: gross − taker fee. */
export function pnlKalshiTakerYes(entryYes: number, contracts: number, outcomeYes: boolean): number {
  const stake = contracts * entryYes;
  if (outcomeYes) {
    const gross = contracts * (1 - entryYes);
    return gross - kalshiTakerFeeUsd(contracts, entryYes);
  }
  return -stake;
}

/** Buy NO at `entryNo` (0–1). Win when outcome is NO. */
export function pnlKalshiTakerNo(entryNo: number, contracts: number, outcomeYes: boolean): number {
  const stake = contracts * entryNo;
  if (!outcomeYes) {
    const gross = contracts * (1 - entryNo);
    return gross - kalshiTakerFeeUsd(contracts, entryNo);
  }
  return -stake;
}

export function pnlKalshiTaker(
  side: "yes" | "no",
  entry: number,
  contracts: number,
  outcomeYes: boolean,
): number {
  return side === "yes"
    ? pnlKalshiTakerYes(entry, contracts, outcomeYes)
    : pnlKalshiTakerNo(entry, contracts, outcomeYes);
}

/** Maker fee: often $0 on Kalshi for resting liquidity; keep explicit for audits. */
export function kalshiMakerFeeUsd(_contracts: number, _price01: number): number {
  return 0;
}

/**
 * Conservative Liquidity Incentive Program credit (per filled maker contract-round).
 * Real LIP varies by market; cap low to avoid overstating.
 */
export const CONSERVATIVE_LIP_USD_PER_CONTRACT = 0.00025;
