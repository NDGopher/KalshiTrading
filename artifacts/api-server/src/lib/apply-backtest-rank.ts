import { defaultDataDir, tryApplyMultiBacktestRankPatch } from "@workspace/backtester";

/**
 * If `data/backtest-results/multi/last-ranked.json` exists and is fresh, merge
 * `suggestedSettingsPatch` into `trading_settings` (conservative clamps).
 */
export async function tryApplyMultiBacktestRankToSettings(): Promise<{
  applied: boolean;
  detail: string;
}> {
  return tryApplyMultiBacktestRankPatch(defaultDataDir());
}
