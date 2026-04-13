/**
 * Persists one JSON artifact per pipeline cycle after scanner enrichment and rule-based
 * analysis (edge/confidence), before the auditor — so each row includes snapshots + keeper gates.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir } from "@workspace/backtester";
import { kalshiMarketBucket, kalshiSportLabel } from "@workspace/backtester";
import type { AnalysisResult } from "./analyst.js";
import {
  classifyHpMarket,
  isCryptoPriorityCandidate,
  isMentionPriorityCandidate,
  isPoliticsPriorityCandidate,
  isSportsCandidate,
  isWeatherPriorityCandidate,
  type ScanCandidate,
  type ScannerCycleDebugSnapshot,
} from "./scanner.js";
import { keeperDebugStatuses } from "../strategies/index.js";

export async function writeCycleDebugJson(params: {
  cycleId: string;
  scanResult: {
    candidates: ScanCandidate[];
    totalScanned: number;
    source: string;
    scannerCycleDebug?: ScannerCycleDebugSnapshot;
  };
  analyses: AnalysisResult[];
  enabledStrategies?: string[];
}): Promise<string | null> {
  const { cycleId, scanResult, analyses, enabledStrategies } = params;
  const dir = path.join(defaultDataDir(), "debug");
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `cycle-${ts}.json`;
  const absPath = path.join(dir, fileName);
  const relPath = path.join("data", "debug", fileName);

  const byTicker = new Map<string, AnalysisResult>();
  for (const a of analyses) {
    byTicker.set(a.candidate.market.ticker, a);
  }

  const candidatesJson = scanResult.candidates.map((c) => {
    const m = c.market;
    const hp = classifyHpMarket(m);
    const ph = c.priceHistory;
    const analysis = byTicker.get(m.ticker);
    return {
      ticker: m.ticker,
      event_ticker: m.event_ticker ?? "",
      series_ticker: m.series_ticker ?? "",
      category: m.category ?? "",
      bucket: kalshiMarketBucket(m),
      sportLabel: kalshiSportLabel(m.ticker),
      liquidity: c.liquidity,
      volume24h: c.volume24h,
      timeToExpiryHours: c.hoursToExpiry,
      yesAsk: c.yesAsk,
      noAsk: c.noAsk,
      yesMid: c.yesPrice,
      spread: c.spread,
      edgePp: analysis?.edge ?? null,
      confidence: analysis?.confidence ?? null,
      snapshotsAvailable: ph?.snapshots ?? 0,
      isHighPriorityCategory: hp.hp,
      reasonForHP: hp.reason,
      reasonForDrop: null as string | null,
      rawTiers: {
        weatherPriority: isWeatherPriorityCandidate(c),
        politicsPriority: isPoliticsPriorityCandidate(c),
        mentionPriority: isMentionPriorityCandidate(c),
        cryptoPriority: isCryptoPriorityCandidate(c),
        sports: isSportsCandidate(c),
      },
      keeperStatuses: analysis ? keeperDebugStatuses(analysis, enabledStrategies) : [],
    };
  });

  const payload = {
    cycleId,
    savedAt: new Date().toISOString(),
    scanSource: scanResult.source,
    marketsScanned: scanResult.totalScanned,
    poolCandidates: scanResult.candidates.length,
    analysisSliceSize: analyses.length,
    scanner: scanResult.scannerCycleDebug ?? null,
    droppedHpEarly: scanResult.scannerCycleDebug?.hpEarlyDrops ?? [],
    candidates: candidatesJson,
  };

  await writeFile(absPath, JSON.stringify(payload, null, 2), "utf8");
  console.info(`[Scanner] Debug JSON saved: ${relPath}`);
  return relPath;
}
