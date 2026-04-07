import { db, agentRunsTable, marketOpportunitiesTable, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { scanMarkets } from "./scanner.js";
import { analyzeMarkets } from "./analyst.js";
import { auditTrades } from "./auditor.js";
import { assessRisk, type RiskDecision } from "./risk-manager.js";
import { executeTrade } from "./executor.js";
import { reconcileOpenTrades, reconcilePaperTrades } from "./reconciler.js";
import { checkBudget } from "./analyst.js";
import { getBalance } from "../kalshi-client.js";
import { evaluateStrategies } from "../strategies/index.js";
import { startNewsFetcher, getNewsFetcherStatus } from "./news-fetcher.js";
import { runLearner } from "./learner.js";

interface AgentRunLog {
  agentName: string;
  status: "success" | "error" | "skipped";
  duration: number;
  details: string | null;
}

export interface CycleResult {
  marketsScanned: number;
  opportunitiesFound: number;
  tradesExecuted: number;
  tradesSkipped: number;
  totalDuration: number;
  agentResults: AgentRunLog[];
  paperMode?: boolean;
}

export interface LastCycleMarket {
  ticker: string;
  title: string;
  sport: string;
  yesPrice: number;
  modelProbability: number;
  confidence: number;
  edge: number;
  kellyFraction: number | null;
  side: "yes" | "no";
  strategyName: string | null;
  reasoning: string | null;
  strategyReason: string | null;
  disposition: "executed" | "skipped_risk" | "skipped_audit" | "skipped_duplicate" | "skipped_confidence" | "skipped_no_price" | "skipped_game_cap" | "candidate";
  rejectionReason: string | null;
}

// Hard ceiling on AI confidence: empirical data shows win rate collapses above 75%.
// 40–50% confidence = 71% win rate; 80%+ = 30% win rate. Above this threshold
// Claude is almost always pricing "obvious" outcomes that the market has already
// absorbed efficiently.
const CONFIDENCE_CEILING = 0.75;

// Hard cap on NO-side entry price. Buying NO above 80¢ means the payout when
// correct is only 20¢ per dollar risked — you need a >83% win rate just to break
// even. Empirically, Sharp Money's NBA near-lock NO bets at 87–93¢ had 100% win
// rate but still produced nearly zero profit because the math never works out.
// This cap keeps us off the chalk and forces strategies to find meaningful edges.
const NO_MAX_ENTRY_PRICE = 0.80;

// Per-game position limit: max number of open bets on the SAME game (same game ID
// extracted from the ticker). Prevents correlated spread stacking — e.g., 7 bets on
// MIL/POR at different spread lines where ONE outcome resolves ALL of them the same way.
// March 2026: Late Efficiency stacked 7 POR bets in one night → -$208 from one game.
const MAX_POSITIONS_PER_GAME = 2;

/**
 * Extracts a stable game key from a Kalshi ticker.
 * Format: KXNBASPREAD-26MAR25DALDEN-DEN8 → "26MAR25DALDEN"
 *          KXNHLGAME-26MAR26PITOTT-OTT    → "26MAR26PITOTT"
 * Returns null for tickers that don't follow the series-game-leg pattern.
 */
function extractGameKey(ticker: string): string | null {
  const parts = ticker.split("-");
  return parts.length >= 2 ? parts[1] : null;
}

let lastCycleMarkets: LastCycleMarket[] = [];
let lastCycleAt: Date | null = null;
let lastSuccessfulCycleAt: Date | null = null;
let liveCycleId: string | null = null;
let liveCycleInProgress = false;
let liveCycleActiveAgent: string | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

export function getLastCycleSummary() {
  return {
    markets: lastCycleMarkets,
    cycleAt: lastCycleAt,
    cycleId: liveCycleId,
    inProgress: liveCycleInProgress,
    activeAgent: liveCycleActiveAgent,
    lastHeartbeatAt: lastSuccessfulCycleAt?.toISOString() || null,
  };
}

function setLiveAgent(agent: string | null) {
  liveCycleActiveAgent = agent;
}

let pipelineInterval: ReturnType<typeof setInterval> | null = null;
let pipelineRunning = false;

const agentStatuses: Record<string, {
  status: "idle" | "running" | "error" | "disabled";
  lastRunAt: Date | null;
  lastResult: string | null;
  errorMessage: string | null;
}> = {
  Scanner: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  Analyst: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  Auditor: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  "Risk Manager": { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  Executor: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  Reconciler: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
  Learner: { status: "idle", lastRunAt: null, lastResult: null, errorMessage: null },
};

// Learner runs every LEARNER_CYCLE_INTERVAL cycles (or when enough trades close)
const LEARNER_CYCLE_INTERVAL = 10;
let pipelineCycleCount = 0;

export function getAgentStatuses() {
  return Object.entries(agentStatuses).map(([name, s]) => ({
    name,
    status: s.status,
    lastRunAt: s.lastRunAt?.toISOString() || null,
    lastResult: s.lastResult,
    errorMessage: s.errorMessage,
  }));
}

async function logAgentRun(run: AgentRunLog): Promise<void> {
  await db.insert(agentRunsTable).values({
    agentName: run.agentName,
    status: run.status,
    duration: run.duration,
    details: run.details,
  });
}

function updateAgentStatus(name: string, status: "idle" | "running" | "error", result?: string, error?: string) {
  if (agentStatuses[name]) {
    agentStatuses[name].status = status;
    agentStatuses[name].lastRunAt = new Date();
    if (result) agentStatuses[name].lastResult = result;
    if (error) agentStatuses[name].errorMessage = error;
    else agentStatuses[name].errorMessage = null;
    if (status === "running") liveCycleActiveAgent = name;
    else if (liveCycleActiveAgent === name) liveCycleActiveAgent = null;
  }
}

function finishCycle() {
  pipelineRunning = false;
  liveCycleInProgress = false;
  liveCycleActiveAgent = null;
  // Update heartbeat on every completion (success OR error) so the watchdog
  // can tell the interval is still firing even when cycles fail.
  lastSuccessfulCycleAt = new Date();
}

export async function runTradingCycle(): Promise<CycleResult> {
  if (pipelineRunning) {
    return {
      marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
      tradesSkipped: 0, totalDuration: 0, agentResults: [{
        agentName: "Pipeline", status: "skipped", duration: 0,
        details: "Pipeline already running",
      }],
    };
  }

  pipelineRunning = true;
  liveCycleInProgress = true;
  liveCycleId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  liveCycleActiveAgent = null;
  const cycleStart = Date.now();
  const agentResults: AgentRunLog[] = [];

  try {
    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    if (!settings) {
      const noSettingsResult: AgentRunLog = {
        agentName: "Pipeline", status: "error", duration: 0,
        details: "No trading settings found. Please save settings first.",
      };
      await logAgentRun(noSettingsResult);
      finishCycle();
      return {
        marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
        tradesSkipped: 0, totalDuration: 0, agentResults: [noSettingsResult],
      };
    }

    const paperMode = settings.paperTradingMode;
    const enabledStrategies = (settings.enabledStrategies as string[] | null) ?? undefined;

    const budgetCheck = await checkBudget();
    if (!budgetCheck.allowed) {
      const budgetResult: AgentRunLog = {
        agentName: "Pipeline", status: "skipped", duration: 0,
        details: `Budget exceeded: ${budgetCheck.reason}. Pipeline paused.`,
      };
      await logAgentRun(budgetResult);
      finishCycle();
      return {
        marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
        tradesSkipped: 0, totalDuration: 0, agentResults: [budgetResult],
        paperMode,
      };
    }

    // Pre-scan reconcile: close any trades that already resolved so the
    // balance is accurate before we size new positions this cycle.
    if (paperMode) {
      try {
        await reconcilePaperTrades();
      } catch {
        // Non-fatal — log nothing; the main reconciler block will report errors
      }
    } else {
      try {
        await reconcileOpenTrades();
      } catch {
        // Non-fatal
      }
    }

    let scanStart = Date.now();
    updateAgentStatus("Scanner", "running");
    let scanResult;
    try {
      scanResult = await scanMarkets(settings.sportFilters as string[]);
      const scanDuration = (Date.now() - scanStart) / 1000;
      updateAgentStatus("Scanner", "idle", `Scanned ${scanResult.totalScanned} markets, found ${scanResult.candidates.length} candidates`);
      agentResults.push({ agentName: "Scanner", status: "success", duration: scanDuration, details: `Scanned ${scanResult.totalScanned} markets, ${scanResult.candidates.length} candidates` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const scanDuration = (Date.now() - scanStart) / 1000;
      updateAgentStatus("Scanner", "error", undefined, errMsg);
      agentResults.push({ agentName: "Scanner", status: "error", duration: scanDuration, details: errMsg });
      for (const run of agentResults) await logAgentRun(run);
      finishCycle();
      return { marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    if (scanResult.candidates.length === 0) {
      for (const run of agentResults) await logAgentRun(run);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    // Analyze top 35 candidates with real AI in both paper and live mode.
    // 35 gives enough room for diverse categories (sports + crypto + politics +
    // weather) after the scanner's diversity-reservation pass fills non-sports slots.
    const topCandidates = scanResult.candidates.slice(0, 35);

    let analysisStart = Date.now();
    updateAgentStatus("Analyst", "running");
    let analyses;
    try {
      analyses = await analyzeMarkets(topCandidates);
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      const withEdge = analyses.filter((a) => a.edge > 0);
      const modeLabel = paperMode ? " [paper]" : "";
      updateAgentStatus("Analyst", "idle", `Analyzed ${analyses.length} markets${modeLabel}, ${withEdge.length} with edge`);
      agentResults.push({ agentName: "Analyst", status: "success", duration: analysisDuration, details: `${withEdge.length}/${analyses.length} markets have edge${modeLabel}` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      updateAgentStatus("Analyst", "error", undefined, errMsg);
      agentResults.push({ agentName: "Analyst", status: "error", duration: analysisDuration, details: errMsg });
      for (const run of agentResults) await logAgentRun(run);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    let auditStart = Date.now();
    updateAgentStatus("Auditor", "running");
    const auditMinEdge = paperMode ? Math.max(3, settings.minEdge - 2) : settings.minEdge;
    const auditMinLiquidity = paperMode ? 0 : settings.minLiquidity;
    const auditResults = auditTrades(analyses, {
      minLiquidity: auditMinLiquidity,
      minTimeToExpiry: settings.minTimeToExpiry,
      confidencePenaltyPct: settings.confidencePenaltyPct,
      minEdge: auditMinEdge,
    });
    const approved = auditResults.filter((a) => a.approved);
    const auditDuration = (Date.now() - auditStart) / 1000;
    updateAgentStatus("Auditor", "idle", `${approved.length}/${auditResults.length} trades approved`);
    agentResults.push({ agentName: "Auditor", status: "success", duration: auditDuration, details: `${approved.length}/${auditResults.length} approved` });

    await db.delete(marketOpportunitiesTable);
    for (const audit of auditResults) {
      const { analysis } = audit;
      const strategyMatches = evaluateStrategies(analysis, enabledStrategies);
      await db.insert(marketOpportunitiesTable).values({
        kalshiTicker: analysis.candidate.market.ticker,
        title: analysis.candidate.market.title || analysis.candidate.market.ticker,
        category: analysis.candidate.market.category || "Sports",
        currentYesPrice: analysis.candidate.yesPrice,
        modelProbability: analysis.modelProbability,
        edge: analysis.edge,
        confidence: audit.adjustedConfidence,
        side: analysis.side,
        volume24h: analysis.candidate.volume24h,
        expiresAt: new Date(analysis.candidate.market.expected_expiration_time || analysis.candidate.market.expiration_time || analysis.candidate.market.close_time),
      });
    }

    if (approved.length === 0) {
      for (const run of agentResults) await logAgentRun(run);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: auditResults.length, tradesExecuted: 0, tradesSkipped: auditResults.length, totalDuration: (Date.now() - cycleStart) / 1000, agentResults, paperMode };
    }

    let riskStart = Date.now();
    updateAgentStatus("Risk Manager", "running");
    let bankroll: number;
    if (paperMode) {
      // Compute true paper bankroll from trade history rather than using the
      // stale DB paper_balance field (which drifts when executor deducts stakes
      // but reconciler only credits net profit rather than full stake recovery).
      // Formula: $5,000 starting capital + all settled net P&L.
      // Open positions don't reduce available cash in paper mode — they are
      // virtual, so we only anchor on realised results.
      try {
        const { paperTradesTable: ptbl } = await import("@workspace/db");
        const allSettled = await db.select({ pnl: ptbl.pnl }).from(ptbl);
        const settledPnl = allSettled.reduce((s, t) => s + (t.pnl || 0), 0);
        bankroll = 5000 + settledPnl;
      } catch {
        bankroll = settings.paperBalance || 5000;
      }
    } else {
      try {
        const balanceData = await getBalance();
        bankroll = balanceData.balance / 100;
      } catch {
        bankroll = 10000;
      }
    }

    const riskDecisions: RiskDecision[] = [];
    let effectiveBankroll = bankroll;
    let approvedThisCycle = 0;
    let strategySkipped = 0;
    let confidenceCapped = 0;
    let noPriceCapped = 0;
    let gameCapSkipped = 0;
    // Tracks trades approved THIS cycle so the reverse middle detector can see
    // intra-cycle positions before they are written to the DB.
    const confidenceCappedTickers = new Set<string>();
    const noPriceCappedTickers = new Set<string>();
    const gameCapTickers = new Set<string>();
    const intraCycleTrades: Array<{ kalshiTicker: string; side: string }> = [];

    // Build a game-key → count map from currently open DB positions.
    // This prevents adding a 3rd bet on a game where we already have 2 open.
    const openGameCounts = new Map<string, number>();
    try {
      const { paperTradesTable } = await import("@workspace/db");
      const openTrades = await db
        .select({ kalshiTicker: paperTradesTable.kalshiTicker })
        .from(paperTradesTable)
        .where(eq(paperTradesTable.status, "open"));
      for (const t of openTrades) {
        const gk = extractGameKey(t.kalshiTicker);
        if (gk) openGameCounts.set(gk, (openGameCounts.get(gk) ?? 0) + 1);
      }
    } catch {
      // Non-fatal — if we can't load open trades, skip the per-game check
    }

    for (const audit of approved) {
      const strategyMatches = evaluateStrategies(audit.analysis, enabledStrategies);
      if (strategyMatches.length === 0) {
        strategySkipped++;
        continue;
      }

      // Confidence ceiling: empirically, win rate collapses above 75% confidence.
      // Skip the trade but record the ticker so the dashboard can display why.
      if (audit.adjustedConfidence > CONFIDENCE_CEILING) {
        confidenceCapped++;
        confidenceCappedTickers.add(audit.analysis.candidate.market.ticker);
        console.log(`[Pipeline] Confidence ceiling hit: ${audit.analysis.candidate.market.ticker} conf=${(audit.adjustedConfidence * 100).toFixed(0)}% > ${(CONFIDENCE_CEILING * 100).toFixed(0)}% — skipped`);
        continue;
      }

      // NO-side entry price cap: buying NO above 80¢ requires >83% win rate to
      // break even. Empirically these bets had 100% wins but near-zero profit
      // because they collect only 4–13¢ on a $30 risk, with losses wiping
      // multiple wins. Math never works — skip regardless of strategy.
      if (audit.analysis.side === "no") {
        const candidate = audit.analysis.candidate;
        const noEntryPrice = candidate.noAsk ?? candidate.noPrice ?? (1 - (candidate.yesPrice ?? 0));
        if (noEntryPrice > NO_MAX_ENTRY_PRICE) {
          noPriceCapped++;
          noPriceCappedTickers.add(candidate.market.ticker);
          console.log(`[Pipeline] NO price cap: ${candidate.market.ticker} noAsk=${noEntryPrice.toFixed(2)} > ${NO_MAX_ENTRY_PRICE} — skipped`);
          continue;
        }
      }

      // Per-game position limit: prevent correlated spread stacking on the same game.
      // Count positions already open in DB + approved this cycle for this game key.
      const ticker = audit.analysis.candidate.market.ticker;
      const gameKey = extractGameKey(ticker);
      if (gameKey) {
        const dbCount = openGameCounts.get(gameKey) ?? 0;
        const cycleCount = intraCycleTrades.filter((t) => extractGameKey(t.kalshiTicker) === gameKey).length;
        const totalGamePositions = dbCount + cycleCount;
        if (totalGamePositions >= MAX_POSITIONS_PER_GAME) {
          gameCapSkipped++;
          gameCapTickers.add(ticker);
          console.log(`[Pipeline] Game cap: ${ticker} already has ${totalGamePositions} positions on game ${gameKey} (max ${MAX_POSITIONS_PER_GAME}) — skipped`);
          continue;
        }
      }

      const strategyName = strategyMatches[0].strategyName;
      const decision = await assessRisk(audit, {
        maxPositionPct: settings.maxPositionPct,
        kellyFraction: settings.kellyFraction,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        maxDrawdownPct: settings.maxDrawdownPct,
        maxSimultaneousPositions: settings.maxSimultaneousPositions,
      }, effectiveBankroll, { strategyName, paperMode, additionalOpenPositions: approvedThisCycle, intraCycleTrades });
      riskDecisions.push(decision);
      if (decision.approved) {
        const entryPrice = decision.audit.analysis.side === "yes"
          ? (decision.audit.analysis.candidate.yesAsk || decision.audit.analysis.candidate.yesPrice)
          : (decision.audit.analysis.candidate.noAsk || decision.audit.analysis.candidate.noPrice);
        effectiveBankroll -= decision.positionSize * entryPrice;
        approvedThisCycle++;
        intraCycleTrades.push({
          kalshiTicker: audit.analysis.candidate.market.ticker,
          side: audit.analysis.side,
        });
      }
    }
    const riskApproved = riskDecisions.filter((d) => d.approved);
    const riskDuration = (Date.now() - riskStart) / 1000;
    const riskExtras = [
      strategySkipped > 0 ? `${strategySkipped} no-strategy` : null,
      confidenceCapped > 0 ? `${confidenceCapped} conf>${(CONFIDENCE_CEILING * 100).toFixed(0)}% capped` : null,
      noPriceCapped > 0 ? `${noPriceCapped} NO>${(NO_MAX_ENTRY_PRICE * 100).toFixed(0)}¢ capped` : null,
      gameCapSkipped > 0 ? `${gameCapSkipped} game-cap (max ${MAX_POSITIONS_PER_GAME}/game)` : null,
    ].filter(Boolean).join(", ");
    const riskDetails = riskExtras
      ? `${riskApproved.length}/${riskDecisions.length} risk-approved, ${riskExtras}`
      : `${riskApproved.length}/${riskDecisions.length} risk-approved`;
    updateAgentStatus("Risk Manager", "idle", riskDetails);
    agentResults.push({ agentName: "Risk Manager", status: "success", duration: riskDuration, details: riskDetails });

    let execStart = Date.now();
    updateAgentStatus("Executor", "running");
    let executed = 0;
    for (const decision of riskApproved) {
      const result = await executeTrade(decision, paperMode);
      if (result.executed) executed++;
    }
    const execDuration = (Date.now() - execStart) / 1000;
    const modeLabel = paperMode ? " (paper)" : "";
    updateAgentStatus("Executor", "idle", `Executed ${executed}/${riskApproved.length} trades${modeLabel}`);
    agentResults.push({ agentName: "Executor", status: "success", duration: execDuration, details: `${executed}/${riskApproved.length} executed${modeLabel}` });

    // Build last cycle summary for Brain view
    const executedTickers = new Set(
      riskApproved
        .filter((d) => d.approved)
        .map((d) => d.audit.analysis.candidate.market.ticker)
    );
    const riskSkippedTickers = new Set(
      riskDecisions
        .filter((d) => !d.approved)
        .map((d) => d.audit.analysis.candidate.market.ticker)
    );
    const auditFailedTickers = new Set(
      auditResults
        .filter((a) => !a.approved)
        .map((a) => a.analysis.candidate.market.ticker)
    );
    lastCycleMarkets = topCandidates.map((c) => {
      const analysis = analyses.find((a) => a.candidate.market.ticker === c.market.ticker);
      const audit = auditResults.find((a) => a.analysis.candidate.market.ticker === c.market.ticker);
      const risk = riskDecisions.find((d) => d.audit.analysis.candidate.market.ticker === c.market.ticker);
      const strategyMatches = analysis ? evaluateStrategies(analysis, enabledStrategies) : [];
      let disposition: LastCycleMarket["disposition"] = "candidate";
      let rejectionReason: string | null = null;
      if (executedTickers.has(c.market.ticker)) {
        disposition = "executed";
      } else if (confidenceCappedTickers.has(c.market.ticker)) {
        disposition = "skipped_confidence";
        rejectionReason = `Confidence ${((analysis?.confidence ?? 0) * 100).toFixed(0)}% exceeds ${(CONFIDENCE_CEILING * 100).toFixed(0)}% ceiling — historically 30% win rate above this level`;
      } else if (noPriceCappedTickers.has(c.market.ticker)) {
        disposition = "skipped_no_price";
        const candidate = c;
        const noAsk = candidate.noAsk ?? candidate.noPrice ?? (1 - (candidate.yesPrice ?? 0));
        rejectionReason = `NO entry ${(noAsk * 100).toFixed(0)}¢ exceeds ${(NO_MAX_ENTRY_PRICE * 100).toFixed(0)}¢ cap — requires >83% win rate to break even at this price`;
      } else if (gameCapTickers.has(c.market.ticker)) {
        disposition = "skipped_game_cap";
        const gk = extractGameKey(c.market.ticker);
        rejectionReason = `Game position limit reached — already have ${MAX_POSITIONS_PER_GAME} bets on game ${gk ?? "this game"} (correlated spread stacking blocked)`;
      } else if (riskSkippedTickers.has(c.market.ticker)) {
        disposition = "skipped_risk";
        rejectionReason = risk?.rejectReason || "Risk limit exceeded";
      } else if (auditFailedTickers.has(c.market.ticker)) {
        disposition = "skipped_audit";
        rejectionReason = audit?.flags?.join(", ") || "Audit filters failed";
      } else if (strategyMatches.length === 0) {
        disposition = "skipped_audit";
        rejectionReason = "No strategy match";
      }
      return {
        ticker: c.market.ticker,
        title: c.market.title || c.market.ticker,
        sport: c.market.category || "Sports",
        yesPrice: c.yesPrice,
        modelProbability: analysis?.modelProbability ?? c.yesPrice,
        confidence: analysis?.confidence ?? 0,
        edge: analysis?.edge ?? 0,
        kellyFraction: risk?.kellyFraction ?? null,
        side: analysis?.side ?? "yes",
        strategyName: strategyMatches[0]?.strategyName ?? null,
        reasoning: analysis?.reasoning ?? null,
        strategyReason: strategyMatches[0]?.reason ?? null,
        disposition,
        rejectionReason,
      } as LastCycleMarket;
    });
    lastCycleAt = new Date();

    let reconStart = Date.now();
    updateAgentStatus("Reconciler", "running");
    if (paperMode) {
      try {
        const reconResult = await reconcilePaperTrades();
        const reconDuration = (Date.now() - reconStart) / 1000;
        updateAgentStatus("Reconciler", "idle", `${reconResult.settled} paper trades settled`);
        agentResults.push({ agentName: "Reconciler", status: "success", duration: reconDuration, details: `${reconResult.settled} paper trades settled` });
      } catch (reconErr: unknown) {
        const reconMsg = reconErr instanceof Error ? reconErr.message : "Unknown error";
        updateAgentStatus("Reconciler", "error", undefined, reconMsg);
        agentResults.push({ agentName: "Reconciler", status: "error", duration: (Date.now() - reconStart) / 1000, details: reconMsg });
      }
    } else {
      try {
        const reconResult = await reconcileOpenTrades();
        const reconDuration = (Date.now() - reconStart) / 1000;
        updateAgentStatus("Reconciler", "idle", `${reconResult.settled} settled, ${reconResult.errors} errors`);
        agentResults.push({ agentName: "Reconciler", status: "success", duration: reconDuration, details: `${reconResult.settled} settled, ${reconResult.errors} errors` });
      } catch (reconErr: unknown) {
        const reconMsg = reconErr instanceof Error ? reconErr.message : "Unknown error";
        updateAgentStatus("Reconciler", "error", undefined, reconMsg);
        agentResults.push({ agentName: "Reconciler", status: "error", duration: (Date.now() - reconStart) / 1000, details: reconMsg });
      }
    }

    // Learner: run every LEARNER_CYCLE_INTERVAL cycles to distill empirical insights
    pipelineCycleCount++;
    if (pipelineCycleCount % LEARNER_CYCLE_INTERVAL === 0) {
      updateAgentStatus("Learner", "running");
      try {
        const learnResult = await runLearner();
        if (learnResult.skipped) {
          updateAgentStatus("Learner", "idle", learnResult.reason ?? "Skipped");
          agentResults.push({ agentName: "Learner", status: "skipped", duration: 0, details: learnResult.reason ?? "Skipped" });
        } else {
          const summary = `${learnResult.insights?.length ?? 0} insights from ${learnResult.totalClosedTrades} closed trades`;
          updateAgentStatus("Learner", "idle", summary);
          agentResults.push({ agentName: "Learner", status: "success", duration: 0, details: summary });
        }
      } catch (learnErr: unknown) {
        const msg = learnErr instanceof Error ? learnErr.message : "Unknown error";
        updateAgentStatus("Learner", "error", undefined, msg);
        agentResults.push({ agentName: "Learner", status: "error", duration: 0, details: msg });
      }
    }

    for (const run of agentResults) {
      await logAgentRun(run);
    }

    finishCycle();
    return {
      marketsScanned: scanResult.totalScanned,
      opportunitiesFound: auditResults.length,
      tradesExecuted: executed,
      tradesSkipped: auditResults.length - executed,
      totalDuration: (Date.now() - cycleStart) / 1000,
      agentResults,
      paperMode,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    agentResults.push({ agentName: "Pipeline", status: "error", duration: (Date.now() - cycleStart) / 1000, details: errMsg });
    for (const run of agentResults) await logAgentRun(run);
    finishCycle();
    return {
      marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
      tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000,
      agentResults,
    };
  }
}

export function startPipeline(intervalMinutes: number) {
  if (pipelineInterval) {
    clearInterval(pipelineInterval);
  }

  // Seed heartbeat so the watchdog doesn't fire before the first cycle finishes.
  // The watchdog checks 15 min with no cycle — if we just started, that's fine.
  lastSuccessfulCycleAt = new Date();

  // Start the news fetcher so breaking news is available for analyst prompts
  startNewsFetcher();

  runTradingCycle().catch((err) => console.error("Pipeline initial cycle error:", err));

  pipelineInterval = setInterval(() => {
    runTradingCycle().catch((err) => console.error("Pipeline cycle error:", err));
  }, intervalMinutes * 60 * 1000);

  console.log(`[Pipeline] Started: runs every ${intervalMinutes} min (first cycle immediate)`);
}

/**
 * Force-clears all in-progress pipeline state.
 * Called by the watchdog when it detects a hung cycle — `pipelineRunning`
 * may be permanently `true` if a cycle threw outside its try/catch and never
 * reached `finishCycle()`. Without clearing this, every subsequent
 * `runTradingCycle()` returns "Pipeline already running" — making the
 * watchdog restart a no-op that never actually starts a new cycle.
 */
function forceResetPipelineRunningState() {
  pipelineRunning = false;
  liveCycleInProgress = false;
  liveCycleActiveAgent = null;
}

export function startWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
  }

  const WATCHDOG_CHECK_MS = 60 * 1000; // check every 1 minute
  const STALE_THRESHOLD_MS = 15 * 60 * 1000; // restart if no cycle in 15 min

  watchdogInterval = setInterval(async () => {
    // Watchdog only acts when the pipeline is supposed to be active
    if (!pipelineInterval) return;

    const now = Date.now();
    const lastCycleMs = lastSuccessfulCycleAt ? lastSuccessfulCycleAt.getTime() : 0;
    const msSinceLastCycle = now - lastCycleMs;

    if (msSinceLastCycle > STALE_THRESHOLD_MS) {
      const minutesSince = Math.round(msSinceLastCycle / 60000);
      console.warn(`[Watchdog] No pipeline cycle in ${minutesSince} min — force-resetting and restarting`);

      // CRITICAL: clear the pipelineRunning flag BEFORE restarting. If a cycle
      // hung and never reached finishCycle(), pipelineRunning is stuck as true
      // and every subsequent runTradingCycle() call immediately returns
      // "Pipeline already running" — making the restart a no-op. Force-clear it
      // so the new cycle can actually execute.
      forceResetPipelineRunningState();

      try {
        await db.insert(agentRunsTable).values({
          agentName: "Watchdog",
          status: "error",
          duration: 0,
          details: `Pipeline stall detected: no heartbeat for ${minutesSince} min. Force-reset pipelineRunning + restarted.`,
        });
      } catch {
        // Non-fatal — don't let the watchdog itself crash
      }

      try {
        const [settings] = await db.select().from(tradingSettingsTable).limit(1);
        const intervalMin = settings?.scanIntervalMinutes || 5;
        startPipeline(intervalMin);
        console.log(`[Watchdog] Pipeline restarted with ${intervalMin} min interval`);
      } catch (err) {
        console.error("[Watchdog] Failed to restart pipeline:", err instanceof Error ? err.message : err);
      }
    }
  }, WATCHDOG_CHECK_MS);

  console.log("[Watchdog] Dead-man's switch started (checks every 1 min, threshold 15 min)");
}

export function getNewsFetcherInfo() {
  return getNewsFetcherStatus();
}

export function stopPipeline() {
  if (pipelineInterval) {
    clearInterval(pipelineInterval);
    pipelineInterval = null;
  }
  console.log("Pipeline stopped");
}

export function isPipelineActive(): boolean {
  return pipelineInterval !== null;
}

export interface ScanDiscoverResult {
  marketsScanned: number;
  opportunitiesFound: number;
  scanDuration: number;
}

export async function scanAndDiscover(): Promise<ScanDiscoverResult> {
  const start = Date.now();

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (!settings) {
    throw new Error("No trading settings found. Please save settings first.");
  }

  updateAgentStatus("Scanner", "running");
  const scanResult = await scanMarkets(settings.sportFilters as string[]);
  updateAgentStatus("Scanner", "idle", `Scanned ${scanResult.totalScanned} markets, found ${scanResult.candidates.length} candidates`);

  if (scanResult.candidates.length === 0) {
    return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, scanDuration: (Date.now() - start) / 1000 };
  }

  const topCandidates = scanResult.candidates.slice(0, 20);

  updateAgentStatus("Analyst", "running");
  const analyses = await analyzeMarkets(topCandidates);
  updateAgentStatus("Analyst", "idle", `Analyzed ${analyses.length} markets`);

  updateAgentStatus("Auditor", "running");
  const auditResults = auditTrades(analyses, {
    minLiquidity: settings.minLiquidity,
    minTimeToExpiry: settings.minTimeToExpiry,
    confidencePenaltyPct: settings.confidencePenaltyPct,
    minEdge: settings.minEdge,
  });
  updateAgentStatus("Auditor", "idle", `${auditResults.filter(a => a.approved).length}/${auditResults.length} approved`);

  await db.delete(marketOpportunitiesTable);
  for (const audit of auditResults) {
    const { analysis } = audit;
    await db.insert(marketOpportunitiesTable).values({
      kalshiTicker: analysis.candidate.market.ticker,
      title: analysis.candidate.market.title || analysis.candidate.market.ticker,
      category: analysis.candidate.market.category || "Sports",
      currentYesPrice: analysis.candidate.yesPrice,
      modelProbability: analysis.modelProbability,
      edge: analysis.edge,
      confidence: audit.adjustedConfidence,
      side: analysis.side,
      volume24h: analysis.candidate.volume24h,
      expiresAt: new Date(analysis.candidate.market.expected_expiration_time || analysis.candidate.market.expiration_time || analysis.candidate.market.close_time),
    });
  }

  return {
    marketsScanned: scanResult.totalScanned,
    opportunitiesFound: auditResults.length,
    scanDuration: (Date.now() - start) / 1000,
  };
}

export async function bootstrapSettings(): Promise<void> {
  const [existing] = await db.select().from(tradingSettingsTable).limit(1);
  if (!existing) {
    await db.insert(tradingSettingsTable).values({});
    console.log("[Bootstrap] Created default trading settings row");
  }
}

export async function rehydratePipeline(): Promise<void> {
  await bootstrapSettings();

  // Always start the news fetcher on server boot so AI has news context
  startNewsFetcher();

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (settings?.pipelineActive) {
    const interval = settings.scanIntervalMinutes || 60;
    startPipeline(interval);
    console.log(`Pipeline rehydrated from DB: active with ${interval} minute interval`);
  } else {
    console.log("Pipeline rehydration: not active in DB settings");
  }
}
