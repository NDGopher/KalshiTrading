import { db, backtestRunsTable, backtestTradesTable, historicalMarketsTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { getMarkets, type KalshiMarket } from "./kalshi-client.js";
import { analyzeMarket, type AnalysisResult } from "./agents/analyst.js";
import { auditTrade } from "./agents/auditor.js";
import { computeRisk, type RiskParams } from "./agents/risk-manager.js";
import { getStrategy, strategies, type Strategy, type StrategyMetadata } from "./strategies/index.js";
import type { ScanCandidate } from "./agents/scanner.js";

interface BacktestConfig {
  strategyName: string;
  startDate: string;
  endDate: string;
  initialBankroll: number;
  maxPositionPct: number;
  kellyFraction: number;
  minEdge: number;
  minLiquidity: number;
  useAiAnalysis: boolean;
}

function marketToCandidate(market: KalshiMarket, simulatedTimeBeforeClose?: number): ScanCandidate | null {
  const yesPrice = market.last_price / 100;
  if (yesPrice <= 0.01 || yesPrice >= 0.99) return null;

  const noPrice = 1 - yesPrice;
  const spread = Math.abs(market.yes_ask - market.yes_bid) / 100;
  const volume24h = market.volume_24h || 0;
  const liquidity = market.liquidity || 0;

  const hoursToExpiry = simulatedTimeBeforeClose ??
    Math.max(0.5, (new Date(market.expected_expiration_time || market.expiration_time || market.close_time).getTime() - Date.now()) / (1000 * 60 * 60));

  return { market, yesPrice, noPrice, spread, volume24h, liquidity, hoursToExpiry };
}

function simulateHoursBeforeClose(market: KalshiMarket): number {
  const openTime = new Date(market.open_time || market.close_time).getTime();
  const closeTime = new Date(market.close_time).getTime();
  const duration = closeTime - openTime;
  if (duration <= 0) return 4;
  const entryFraction = 0.3 + Math.random() * 0.5;
  return Math.max(0.5, (duration * (1 - entryFraction)) / (1000 * 60 * 60));
}

function deterministicHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function simulateAnalysis(candidate: ScanCandidate, market: KalshiMarket): AnalysisResult {
  const yesPrice = candidate.yesPrice;
  const settledYes = market.result === "yes";

  const hash = deterministicHash(market.ticker + market.close_time);
  const hashFrac = (hash % 1000) / 1000;

  const volumeSignal = Math.min(1, candidate.volume24h / 2000);
  const spreadSignal = Math.min(1, candidate.spread / 0.1);
  const shift = (hashFrac - 0.5) * 0.15 * (1 + volumeSignal - spreadSignal);
  const modelProb = Math.max(0.05, Math.min(0.95, yesPrice + shift));

  const yesSide = modelProb > yesPrice;
  const side: "yes" | "no" = yesSide ? "yes" : "no";
  const edge = yesSide
    ? (modelProb - yesPrice) / yesPrice * 100
    : ((1 - modelProb) - (1 - yesPrice)) / (1 - yesPrice) * 100;

  const confidenceBase = 0.4 + volumeSignal * 0.2 + (1 - spreadSignal) * 0.1;
  const confidence = Math.min(0.9, confidenceBase + (hashFrac * 0.15));

  return {
    candidate,
    modelProbability: modelProb,
    edge: Math.max(0, edge),
    confidence,
    side,
    reasoning: `Deterministic backtest analysis: vol=${candidate.volume24h}, spread=${candidate.spread.toFixed(3)}, model=${(modelProb * 100).toFixed(1)}%`,
  };
}

async function fetchFromHistoricalDb(startDate: string, endDate: string): Promise<KalshiMarket[]> {
  const rows = await db.select()
    .from(historicalMarketsTable)
    .where(
      and(
        eq(historicalMarketsTable.status, "settled"),
        gte(historicalMarketsTable.closeTime, new Date(startDate)),
        lte(historicalMarketsTable.closeTime, new Date(endDate))
      )
    );

  return rows
    .filter((r) => r.result && r.rawData)
    .map((r) => r.rawData as unknown as KalshiMarket);
}

async function fetchFromApi(startDate: string, endDate: string): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = 10;

  while (pages < maxPages) {
    try {
      const result = await getMarkets({
        limit: 100,
        cursor,
        status: "settled",
      });
      const filtered = result.markets.filter((m) => {
        const closeTime = new Date(m.close_time);
        return closeTime >= new Date(startDate) && closeTime <= new Date(endDate);
      });
      allMarkets.push(...filtered);
      cursor = result.cursor;
      pages++;
      if (!cursor || result.markets.length < 100) break;
    } catch (err) {
      console.error("Error fetching settled markets:", err);
      break;
    }
  }

  return allMarkets;
}

export async function fetchSettledMarkets(startDate: string, endDate: string): Promise<KalshiMarket[]> {
  const dbMarkets = await fetchFromHistoricalDb(startDate, endDate);
  if (dbMarkets.length > 0) {
    console.log(`Loaded ${dbMarkets.length} settled markets from historical DB`);
    return dbMarkets;
  }

  console.log("No historical data in DB, fetching from Kalshi API...");
  return fetchFromApi(startDate, endDate);
}

export async function runBacktest(config: BacktestConfig): Promise<number> {
  const strategy = getStrategy(config.strategyName);
  if (!strategy) {
    throw new Error(`Unknown strategy: ${config.strategyName}`);
  }

  const [run] = await db.insert(backtestRunsTable).values({
    strategyName: config.strategyName,
    status: "running",
    startDate: config.startDate,
    endDate: config.endDate,
    config: config as unknown as Record<string, unknown>,
  }).returning();

  try {
    const settledMarkets = await fetchSettledMarkets(config.startDate, config.endDate);

    if (settledMarkets.length === 0) {
      await db.update(backtestRunsTable).set({
        status: "completed",
        marketsEvaluated: 0,
        completedAt: new Date(),
      }).where(eq(backtestRunsTable.id, run.id));
      return run.id;
    }

    let bankroll = config.initialBankroll;
    let peakBankroll = bankroll;
    let maxDrawdown = 0;
    const pnls: number[] = [];
    const outcomes: boolean[] = [];
    let wins = 0;
    let totalTrades = 0;
    let totalEdge = 0;
    let totalClv = 0;
    let dipCatchAttempts = 0;
    let dipCatchWins = 0;

    for (const market of settledMarkets) {
      if (!market.result) continue;

      const simHours = simulateHoursBeforeClose(market);
      const candidate = marketToCandidate(market, simHours);
      if (!candidate) continue;

      const stratCandidates = strategy.selectCandidates([candidate]);
      if (stratCandidates.length === 0) continue;

      let analysis: AnalysisResult;
      if (config.useAiAnalysis) {
        analysis = await analyzeMarket(candidate);
      } else {
        analysis = simulateAnalysis(candidate, market);
      }

      const stratResult = strategy.shouldTrade(analysis);
      if (!stratResult.trade) continue;
      const stratMeta = stratResult.metadata;
      const stratReason = stratResult.reason;

      const auditResult = auditTrade(analysis, {
        minLiquidity: config.minLiquidity,
        minTimeToExpiry: 0,
        confidencePenaltyPct: 8,
        minEdge: config.minEdge,
      });

      if (!auditResult.approved) continue;

      let consecutiveLosses = 0;
      for (let i = outcomes.length - 1; i >= 0; i--) {
        if (!outcomes[i]) consecutiveLosses++;
        else break;
      }
      const drawdownPct = peakBankroll > 0 ? ((peakBankroll - bankroll) / peakBankroll) * 100 : 0;

      const riskResult = computeRisk(
        analysis,
        {
          maxPositionPct: config.maxPositionPct,
          kellyFraction: config.kellyFraction,
          maxConsecutiveLosses: 3,
          maxDrawdownPct: 20,
          maxSimultaneousPositions: 8,
        },
        bankroll,
        {
          consecutiveLosses,
          drawdownPct,
          openPositions: 0,
          correlatedPositions: 0,
          adjustedConfidence: analysis.confidence,
          auditApproved: auditResult.approved,
        },
      );

      if (!riskResult.approved) continue;

      const marketPrice = analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice;
      const quantity = riskResult.positionSize;

      const won =
        (analysis.side === "yes" && market.result === "yes") ||
        (analysis.side === "no" && market.result === "no");

      const pnl = won
        ? quantity * (1 - marketPrice)
        : -quantity * marketPrice;

      const closingLinePrice = market.last_price / 100;
      const impliedEntry = analysis.side === "yes" ? marketPrice : 1 - marketPrice;
      const impliedClosing = analysis.side === "yes" ? closingLinePrice : 1 - closingLinePrice;
      const clv = impliedEntry - impliedClosing;

      bankroll += pnl;
      pnls.push(pnl);
      outcomes.push(won);
      totalEdge += analysis.edge;
      totalClv += clv;
      totalTrades++;
      if (won) wins++;
      if (stratMeta?.dipCatch) {
        dipCatchAttempts++;
        if (won) dipCatchWins++;
      }

      if (bankroll > peakBankroll) peakBankroll = bankroll;
      const currentDrawdown = peakBankroll > 0 ? ((peakBankroll - bankroll) / peakBankroll) * 100 : 0;
      if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

      await db.insert(backtestTradesTable).values({
        backtestRunId: run.id,
        kalshiTicker: market.ticker,
        title: market.title || market.ticker,
        strategyName: config.strategyName,
        side: analysis.side,
        entryPrice: marketPrice,
        exitPrice: closingLinePrice,
        quantity,
        pnl,
        outcome: won ? "won" : "lost",
        clv,
        modelProbability: analysis.modelProbability,
        edge: analysis.edge,
        confidence: analysis.confidence,
        reasoning: `[Strategy] ${stratReason}\n[Analysis] ${analysis.reasoning}`,
        marketResult: market.result,
        dipCatch: stratMeta?.dipCatch ?? null,
        distanceFromPeak: stratMeta?.distanceFromPeak ?? null,
      });
    }

    const totalPnl = pnls.reduce((s, p) => s + p, 0);
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const avgEdge = totalTrades > 0 ? totalEdge / totalTrades : 0;
    const avgClv = totalTrades > 0 ? totalClv / totalTrades : 0;
    const roi = config.initialBankroll > 0 ? (totalPnl / config.initialBankroll) * 100 : 0;

    let bestStreak = 0;
    let worstStreak = 0;
    let currentWin = 0;
    let currentLoss = 0;
    for (const w of outcomes) {
      if (w) { currentWin++; currentLoss = 0; bestStreak = Math.max(bestStreak, currentWin); }
      else { currentLoss++; currentWin = 0; worstStreak = Math.max(worstStreak, currentLoss); }
    }

    let sharpeRatio: number | null = null;
    if (pnls.length > 1) {
      const avgReturn = totalPnl / pnls.length;
      const variance = pnls.reduce((s, p) => s + (p - avgReturn) ** 2, 0) / (pnls.length - 1);
      const stdDev = Math.sqrt(variance);
      sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
    }

    const dipCatchSuccessRate = dipCatchAttempts > 0 ? dipCatchWins / dipCatchAttempts : null;

    await db.update(backtestRunsTable).set({
      status: "completed",
      marketsEvaluated: settledMarkets.length,
      tradesSimulated: totalTrades,
      totalPnl,
      winRate,
      roi,
      sharpeRatio,
      maxDrawdown,
      avgEdge,
      avgClv,
      bestStreak,
      worstStreak,
      dipCatchSuccessRate,
      completedAt: new Date(),
    }).where(eq(backtestRunsTable.id, run.id));

    return run.id;
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await db.update(backtestRunsTable).set({
      status: "error",
      errorMessage: errMsg,
      completedAt: new Date(),
    }).where(eq(backtestRunsTable.id, run.id));
    throw err;
  }
}
