import { db, backtestRunsTable, backtestTradesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getMarkets, type KalshiMarket } from "./kalshi-client.js";
import { analyzeMarket, type AnalysisResult } from "./agents/analyst.js";
import { auditTrade } from "./agents/auditor.js";
import { getStrategy, strategies, type Strategy } from "./strategies/index.js";
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

function marketToCandidate(market: KalshiMarket): ScanCandidate | null {
  const yesPrice = market.last_price / 100;
  if (yesPrice <= 0.01 || yesPrice >= 0.99) return null;

  const noPrice = 1 - yesPrice;
  const spread = Math.abs(market.yes_ask - market.yes_bid) / 100;
  const volume24h = market.volume_24h || 0;
  const liquidity = market.liquidity || 0;
  const expiresAt = new Date(market.expected_expiration_time || market.expiration_time || market.close_time);
  const hoursToExpiry = Math.max(0, (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60));

  return { market, yesPrice, noPrice, spread, volume24h, liquidity, hoursToExpiry };
}

function simulateAnalysis(candidate: ScanCandidate, market: KalshiMarket): AnalysisResult {
  const yesPrice = candidate.yesPrice;
  const settledYes = market.result === "yes";
  const actualProb = settledYes ? 1.0 : 0.0;

  const noise = (Math.random() - 0.5) * 0.2;
  const modelProb = Math.max(0.05, Math.min(0.95, yesPrice + noise));

  const yesSide = modelProb > yesPrice;
  const side: "yes" | "no" = yesSide ? "yes" : "no";
  const edge = yesSide
    ? (modelProb - yesPrice) / yesPrice * 100
    : ((1 - modelProb) - (1 - yesPrice)) / (1 - yesPrice) * 100;

  return {
    candidate,
    modelProbability: modelProb,
    edge: Math.max(0, edge),
    confidence: 0.5 + Math.random() * 0.3,
    side,
    reasoning: "Backtest simulation analysis",
  };
}

export async function fetchSettledMarkets(startDate: string, endDate: string): Promise<KalshiMarket[]> {
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

    for (const market of settledMarkets) {
      if (!market.result) continue;

      const candidate = marketToCandidate(market);
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

      const auditResult = auditTrade(analysis, {
        minLiquidity: config.minLiquidity,
        minTimeToExpiry: 0,
        confidencePenaltyPct: 8,
        minEdge: config.minEdge,
      });

      if (!auditResult.approved) continue;

      const maxPosDollars = bankroll * (config.maxPositionPct / 100);
      const marketPrice = analysis.side === "yes" ? candidate.yesPrice : candidate.noPrice;
      const b = (1 / marketPrice) - 1;
      const p = analysis.side === "yes" ? analysis.modelProbability : 1 - analysis.modelProbability;
      const q = 1 - p;
      const fullKelly = b > 0 ? (b * p - q) / b : 0;
      const kellyPos = Math.max(0, fullKelly * config.kellyFraction) * bankroll;
      const posDollars = Math.min(kellyPos, maxPosDollars);
      const quantity = Math.max(1, Math.floor(posDollars / Math.max(0.01, marketPrice)));

      const won =
        (analysis.side === "yes" && market.result === "yes") ||
        (analysis.side === "no" && market.result === "no");

      const pnl = won
        ? quantity * (1 - marketPrice)
        : -quantity * marketPrice;

      const closingPrice = won ? 1.0 : 0.0;
      const impliedEntry = analysis.side === "yes" ? marketPrice : 1 - marketPrice;
      const impliedClosing = analysis.side === "yes" ? closingPrice : 1 - closingPrice;
      const clv = impliedClosing - impliedEntry;

      bankroll += pnl;
      pnls.push(pnl);
      outcomes.push(won);
      totalEdge += analysis.edge;
      totalClv += clv;
      totalTrades++;
      if (won) wins++;

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
        exitPrice: closingPrice,
        quantity,
        pnl,
        outcome: won ? "won" : "lost",
        clv,
        modelProbability: analysis.modelProbability,
        edge: analysis.edge,
        confidence: analysis.confidence,
        reasoning: analysis.reasoning,
        marketResult: market.result,
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
