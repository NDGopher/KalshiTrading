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
  disposition: "executed" | "skipped_risk" | "skipped_audit" | "skipped_duplicate" | "candidate";
  rejectionReason: string | null;
}

let lastCycleMarkets: LastCycleMarket[] = [];
let lastCycleAt: Date | null = null;
let liveCycleId: string | null = null;
let liveCycleInProgress = false;
let liveCycleActiveAgent: string | null = null;

export function getLastCycleSummary() {
  return {
    markets: lastCycleMarkets,
    cycleAt: lastCycleAt,
    cycleId: liveCycleId,
    inProgress: liveCycleInProgress,
    activeAgent: liveCycleActiveAgent,
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
};

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

    // Analyze top 20 candidates with real AI in both paper and live mode.
    // Paper mode previously used simulated analysis, but real AI is used now
    // so we accurately measure model performance before risking real capital.
    const topCandidates = scanResult.candidates.slice(0, 20);

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
      bankroll = settings.paperBalance;
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
    // Track game-keys approved THIS cycle (DB not yet written, so correlation check
    // won't catch intra-cycle same-game duplicates without this set).
    const approvedGameKeysThisCycle = new Set<string>();
    for (const audit of approved) {
      const ticker = audit.analysis.candidate.market.ticker;
      const gameKey = ticker.split("-").slice(0, 2).join("-");

      // Skip immediately if we already approved a trade in this same game this cycle
      if (approvedGameKeysThisCycle.has(gameKey)) {
        continue;
      }

      const strategyMatches = evaluateStrategies(audit.analysis, enabledStrategies);
      if (strategyMatches.length === 0) {
        strategySkipped++;
        continue;
      }
      const strategyName = strategyMatches[0].strategyName;
      const decision = await assessRisk(audit, {
        maxPositionPct: settings.maxPositionPct,
        kellyFraction: settings.kellyFraction,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        maxDrawdownPct: settings.maxDrawdownPct,
        maxSimultaneousPositions: settings.maxSimultaneousPositions,
      }, effectiveBankroll, { strategyName, paperMode, additionalOpenPositions: approvedThisCycle });
      riskDecisions.push(decision);
      if (decision.approved) {
        const entryPrice = decision.audit.analysis.side === "yes"
          ? decision.audit.analysis.candidate.yesPrice
          : decision.audit.analysis.candidate.noPrice;
        effectiveBankroll -= decision.positionSize * entryPrice;
        approvedThisCycle++;
        approvedGameKeysThisCycle.add(gameKey);
      }
    }
    const riskApproved = riskDecisions.filter((d) => d.approved);
    const riskDuration = (Date.now() - riskStart) / 1000;
    const riskDetails = strategySkipped > 0
      ? `${riskApproved.length}/${riskDecisions.length} risk-approved, ${strategySkipped} no strategy match`
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

  // Start the news fetcher so breaking news is available for analyst prompts
  startNewsFetcher();

  runTradingCycle().catch((err) => console.error("Pipeline initial cycle error:", err));

  pipelineInterval = setInterval(() => {
    runTradingCycle().catch((err) => console.error("Pipeline cycle error:", err));
  }, intervalMinutes * 60 * 1000);

  console.log(`[Pipeline] Started: runs every ${intervalMinutes} min (first cycle immediate)`);
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
