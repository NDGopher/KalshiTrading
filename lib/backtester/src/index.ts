export { Backtester, type BacktesterOptions } from "./backtester.js";
export {
  ARCHIVE_HOST,
  ORDERBOOK_R2_HOST,
  ensureKalshiDayCached,
  ensureKalshiHourCached,
  kalshiOrderbookDumpUrl,
  polymarketOrderbookDumpUrl,
} from "./archive-client.js";
export { readParquetFile, readParquetBuffer, type ParquetRow } from "./parquet-load.js";
export { normalizeArchiveRow, type ArchiveMarketTick } from "./normalize.js";
export { tickToPmxtMarket, tickToPmxtTicker } from "./pmxt-bridge.js";
export { pureValueStrategy } from "./strategies/pure-value.js";
export {
  getRepoRoot,
  defaultDataDir,
  kalshiCacheDir,
  latestBacktestResultPath,
  backtestResultsDir,
  jbeckerKalshiRoot,
  multiBacktestRankPath,
} from "./paths.js";
export {
  buildPmxtBacktestRunFilename,
  pmxtBacktestRunsDir,
  writePmxtBacktestOutputs,
  type PmxtBacktestFilePayload,
} from "./pmxt-result-writer.js";
export {
  runParallelStrategies,
  defaultReplayRiskLimits,
  defaultHalfKellySizing,
} from "./replay/parallel-replay.js";
export { runStrategyReplayWithRisk, type RunReplayParams } from "./replay/replay-engine.js";
export { tryApplyMultiBacktestRankPatch } from "./apply-multi-rank-pg.js";
export {
  filterTicksBySport,
  kalshiSportLabel,
  kalshiSportBucket,
  kalshiMarketBucket,
  kalshiCoarseMacroGroup,
  kalshiIsWeatherTicker,
  kalshiIsMentionTicker,
  type KalshiCoarseMacro,
} from "./replay/sport-bucket.js";
export { kalshiTakerFeeUsd, pnlKalshiTaker, CONSERVATIVE_LIP_USD_PER_CONTRACT } from "./kalshi-fees.js";
export { DEFAULT_PARALLEL_REPLAY_STRATEGIES, replayStrategiesByNames } from "./strategies/replay-registry.js";
export {
  collectTradeTickersInDateRange,
  loadJbeckerResolvedMarkets,
  loadJbeckerResolvedMarketsForTickers,
  loadJbeckerTradeTicks,
  defaultJbeckerRoot,
  resolveJbeckerParquetDirs,
} from "./historical/jbecker-loader.js";
export {
  JBECKER_DATA_TAR_ZST_URL,
  JBECKER_ARCHIVE_BASENAME,
  jbeckerArchiveFilePath,
  jbeckerKalshiTargetPath,
  jbeckerDownloadInstructions,
  downloadJbeckerArchive,
  extractJbeckerArchiveToLayout,
  runJBeckerDownloadPipeline,
  verifySha256IfPublished,
} from "./jbecker-downloader.js";
export { writeMultiBacktestRankReport, writePartialMultiBacktestCheckpoint } from "./multi-report-writer.js";
export { sortStrategiesByRunOrder, REPLAY_STRATEGY_RUN_ORDER } from "./strategies/strategy-run-order.js";
export {
  parseLastPartialRankingsFromLog,
  stubPerStrategyBlockFromParsedLogRow,
  rankedRowFromParsedLogLine,
} from "./replay/parse-partial-run-log.js";
export type {
  BacktestMetrics,
  EquityPoint,
  MultiStrategyEquitySample,
  MultiStrategyBacktestReport,
  RankedStrategyRow,
  ReplayAnalysis,
  ReplayCandidate,
  ReplayRiskLimits,
  SimulatedTrade,
  SportBucketMetrics,
  Strategy,
} from "./types.js";
