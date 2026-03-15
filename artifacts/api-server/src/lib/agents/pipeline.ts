import { db, agentRunsTable, marketOpportunitiesTable, tradingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { scanMarkets } from "./scanner.js";
import { analyzeMarkets } from "./analyst.js";
import { auditTrades } from "./auditor.js";
import { assessRisk } from "./risk-manager.js";
import { executeTrade, type ExecutionResult } from "./executor.js";
import { reconcileOpenTrades } from "./reconciler.js";
import { getBalance } from "../kalshi-client.js";

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
  }
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
  const cycleStart = Date.now();
  const agentResults: AgentRunLog[] = [];

  try {
    const [settings] = await db.select().from(tradingSettingsTable).limit(1);
    if (!settings) {
      pipelineRunning = false;
      return {
        marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
        tradesSkipped: 0, totalDuration: 0, agentResults: [{
          agentName: "Pipeline", status: "error", duration: 0,
          details: "No trading settings found. Please save settings first.",
        }],
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
      pipelineRunning = false;
      return { marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    if (scanResult.candidates.length === 0) {
      pipelineRunning = false;
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    const topCandidates = scanResult.candidates.slice(0, 10);

    let analysisStart = Date.now();
    updateAgentStatus("Analyst", "running");
    let analyses;
    try {
      analyses = await analyzeMarkets(topCandidates);
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      const withEdge = analyses.filter((a) => a.edge > 0);
      updateAgentStatus("Analyst", "idle", `Analyzed ${analyses.length} markets, ${withEdge.length} with edge`);
      agentResults.push({ agentName: "Analyst", status: "success", duration: analysisDuration, details: `${withEdge.length}/${analyses.length} markets have edge` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      updateAgentStatus("Analyst", "error", undefined, errMsg);
      agentResults.push({ agentName: "Analyst", status: "error", duration: analysisDuration, details: errMsg });
      pipelineRunning = false;
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    let auditStart = Date.now();
    updateAgentStatus("Auditor", "running");
    const auditResults = auditTrades(analyses, {
      minLiquidity: settings.minLiquidity,
      minTimeToExpiry: settings.minTimeToExpiry,
      confidencePenaltyPct: settings.confidencePenaltyPct,
      minEdge: settings.minEdge,
    });
    const approved = auditResults.filter((a) => a.approved);
    const auditDuration = (Date.now() - auditStart) / 1000;
    updateAgentStatus("Auditor", "idle", `${approved.length}/${auditResults.length} trades approved`);
    agentResults.push({ agentName: "Auditor", status: "success", duration: auditDuration, details: `${approved.length}/${auditResults.length} approved` });

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

    if (approved.length === 0) {
      pipelineRunning = false;
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: auditResults.length, tradesExecuted: 0, tradesSkipped: auditResults.length, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    let riskStart = Date.now();
    updateAgentStatus("Risk Manager", "running");
    let balanceData;
    try {
      balanceData = await getBalance();
    } catch {
      balanceData = { balance: 10000 };
    }
    const bankroll = balanceData.balance / 100;

    const riskDecisions = [];
    for (const audit of approved) {
      const decision = await assessRisk(audit, {
        maxPositionPct: settings.maxPositionPct,
        kellyFraction: settings.kellyFraction,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        maxDrawdownPct: settings.maxDrawdownPct,
      }, bankroll);
      riskDecisions.push(decision);
    }
    const riskApproved = riskDecisions.filter((d) => d.approved);
    const riskDuration = (Date.now() - riskStart) / 1000;
    updateAgentStatus("Risk Manager", "idle", `${riskApproved.length}/${riskDecisions.length} risk-approved`);
    agentResults.push({ agentName: "Risk Manager", status: "success", duration: riskDuration, details: `${riskApproved.length}/${riskDecisions.length} risk-approved` });

    let execStart = Date.now();
    updateAgentStatus("Executor", "running");
    let executed = 0;
    for (const decision of riskApproved) {
      const result = await executeTrade(decision);
      if (result.executed) executed++;
    }
    const execDuration = (Date.now() - execStart) / 1000;
    updateAgentStatus("Executor", "idle", `Executed ${executed}/${riskApproved.length} trades`);
    agentResults.push({ agentName: "Executor", status: "success", duration: execDuration, details: `${executed}/${riskApproved.length} executed` });

    let reconStart = Date.now();
    updateAgentStatus("Reconciler", "running");
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

    for (const run of agentResults) {
      await logAgentRun(run);
    }

    pipelineRunning = false;
    return {
      marketsScanned: scanResult.totalScanned,
      opportunitiesFound: auditResults.length,
      tradesExecuted: executed,
      tradesSkipped: auditResults.length - executed,
      totalDuration: (Date.now() - cycleStart) / 1000,
      agentResults,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    pipelineRunning = false;
    return {
      marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
      tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000,
      agentResults: [{ agentName: "Pipeline", status: "error", duration: (Date.now() - cycleStart) / 1000, details: errMsg }],
    };
  }
}

export function startPipeline(intervalMinutes: number) {
  if (pipelineInterval) {
    clearInterval(pipelineInterval);
  }
  pipelineInterval = setInterval(() => {
    runTradingCycle().catch((err) => console.error("Pipeline cycle error:", err));
  }, intervalMinutes * 60 * 1000);

  console.log(`Pipeline started with ${intervalMinutes} minute interval`);
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

  const topCandidates = scanResult.candidates.slice(0, 10);

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
  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (settings?.pipelineActive) {
    const interval = settings.scanIntervalMinutes || 60;
    startPipeline(interval);
    console.log(`Pipeline rehydrated from DB: active with ${interval} minute interval`);
  } else {
    console.log("Pipeline rehydration: not active in DB settings");
  }
}
