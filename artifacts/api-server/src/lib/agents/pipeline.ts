import {
  db,
  marketOpportunitiesTable,
  paperTradesTable,
  tradesTable,
  tradingSettingsTable,
  withTransactionStatementTimeout,
  type DbClient,
} from "@workspace/db";
import { eq, gte, sql, inArray } from "drizzle-orm";
import {
  isPriorityMacroAuditEdgeCandidate,
  PRIORITY_MACRO_AUDIT_MIN_EDGE_PP,
  scanMarkets,
  SCANNER_ANALYSIS_SLICE,
} from "./scanner.js";
import { analyzeMarketsRuleBased } from "./analyst.js";
import { auditTrades, type AuditResult } from "./auditor.js";
import { assessRisk, type RiskDecision } from "./risk-manager.js";
import { executeTrade } from "./executor.js";
import { reconcileOpenTrades, reconcilePaperTrades } from "./reconciler.js";
import { checkBudget } from "./analyst.js";
import { getBalance } from "../kalshi-client.js";
import { kalshiMarketBucket, kalshiSportBucket, kalshiSportLabel } from "@workspace/backtester";

function opportunityCategoryLabel(
  ticker: string,
  category: string | null | undefined,
  eventTicker?: string | null,
  seriesTicker?: string | null,
): string {
  const c = typeof category === "string" ? category.trim() : "";
  if (c.length > 0) return c;
  return kalshiMarketBucket({
    ticker,
    event_ticker: eventTicker || undefined,
    series_ticker: seriesTicker || undefined,
  });
}
import { diagnoseStrategyMiss, evaluateStrategies } from "../strategies/index.js";
import { takerSpreadDollars } from "./execution-policy.js";
import { startNewsFetcher } from "./news-fetcher.js";
import { startStrategyLearnerSchedule } from "./strategy-learner.js";

/** DB/API fallback when `scan_interval_minutes` is null (must match schema default). */
const DEFAULT_SCAN_INTERVAL_MINUTES = 2;
import { getLiveTapeSnapshot } from "../live-tape-flow.js";
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

// Per-game: at most **one** open paper/live position per gameKey (same event), so we never
// stack MIL YES + BOS NO + spreads on the same game. Auditor may approve many legs; we
// also pre-filter to the single highest-edge approval per gameKey before execution.
const MAX_POSITIONS_PER_GAME = 1;

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

/** One execution candidate per gameKey: highest edge (tie → higher adjusted confidence). */
function dedupeApprovedOnePerGame(approved: AuditResult[]): AuditResult[] {
  const bestByGame = new Map<string, AuditResult>();
  const noGameKey: AuditResult[] = [];
  for (const a of approved) {
    const ticker = a.analysis.candidate.market.ticker;
    const gk = extractGameKey(ticker);
    if (!gk) {
      noGameKey.push(a);
      continue;
    }
    const prev = bestByGame.get(gk);
    if (
      !prev ||
      a.analysis.edge > prev.analysis.edge ||
      (a.analysis.edge === prev.analysis.edge && a.adjustedConfidence > prev.adjustedConfidence)
    ) {
      bestByGame.set(gk, a);
    }
  }
  return [...noGameKey, ...bestByGame.values()];
}

let lastSuccessfulCycleAt: Date | null = null;
let liveCycleId: string | null = null;
let liveCycleInProgress = false;
let liveCycleActiveAgent: string | null = null;
let watchdogInterval: ReturnType<typeof setInterval> | null = null;

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

/** Bound Neon latency so one slow statement cannot wedge the pool for minutes. */
const PIPELINE_DB_MS = Math.min(120_000, Number(process.env.PIPELINE_STATEMENT_TIMEOUT_MS) || 90_000);

export function getAgentStatuses() {
  return Object.entries(agentStatuses).map(([name, s]) => ({
    name,
    status: s.status,
    lastRunAt: s.lastRunAt?.toISOString() || null,
    lastResult: s.lastResult,
    errorMessage: s.errorMessage,
  }));
}

/** Agent run rows are no longer persisted (Neon size / no agent UI). */
async function flushAgentRuns(_runs: AgentRunLog[]): Promise<void> {}

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
    let settings: typeof tradingSettingsTable.$inferSelect | undefined;
    try {
      const rows = await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) =>
        tx.select().from(tradingSettingsTable).limit(1),
      );
      settings = rows[0];
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Pipeline] Failed to load trading_settings:", msg);
      finishCycle();
      return {
        marketsScanned: 0,
        opportunitiesFound: 0,
        tradesExecuted: 0,
        tradesSkipped: 0,
        totalDuration: (Date.now() - cycleStart) / 1000,
        agentResults: [
          {
            agentName: "Pipeline",
            status: "error",
            duration: 0,
            details: `DB timeout loading settings: ${msg}`,
          },
        ],
      };
    }
    if (!settings) {
      const noSettingsResult: AgentRunLog = {
        agentName: "Pipeline", status: "error", duration: 0,
        details: "No trading settings found. Please save settings first.",
      };
      await flushAgentRuns([noSettingsResult]);
      finishCycle();
      return {
        marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0,
        tradesSkipped: 0, totalDuration: 0, agentResults: [noSettingsResult],
      };
    }

    const paperMode = settings.paperTradingMode;
    const enabledStrategies = (settings.enabledStrategies as string[] | null) ?? undefined;
    const intervalMin = settings.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES;

    console.log(
      `[Pipeline] Cycle ${liveCycleId} started | paperMode=${paperMode} | scanIntervalMin=${intervalMin} | keepers=${JSON.stringify(enabledStrategies ?? ["default"])}`,
    );

    const budgetCheck = await checkBudget();
    if (!budgetCheck.allowed) {
      const budgetResult: AgentRunLog = {
        agentName: "Pipeline", status: "skipped", duration: 0,
        details: `Budget exceeded: ${budgetCheck.reason}. Pipeline paused.`,
      };
      await flushAgentRuns([budgetResult]);
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
      scanResult = await scanMarkets(settings.sportFilters as string[], {
        crypto: settings.cryptoPriorityWeight ?? 3.2,
        weather: settings.weatherPriorityWeight ?? 3.2,
        politics: settings.politicsPriorityWeight ?? 3.2,
        mention: settings.mentionPriorityWeight ?? 3.2,
        maxSpreadCents: settings.maxSpreadCents ?? 5,
      });
      const scanDuration = (Date.now() - scanStart) / 1000;
      const sample = scanResult.candidates.slice(0, 12).map((c) => c.market.ticker);
      console.log(
        `[Scanner] ${scanResult.totalScanned} markets → ${scanResult.candidates.length} candidates (pool) | sample: ${sample.join(", ")}`,
      );
      const tapeSnap = getLiveTapeSnapshot(12);
      console.log(
        `[Tape] tracked=${tapeSnap.trackedTickers} tickers with flow state | recent: ${tapeSnap.sampleTickers.slice(-8).join(", ") || "(none yet)"}`,
      );
      updateAgentStatus("Scanner", "idle", `Scanned ${scanResult.totalScanned} markets, found ${scanResult.candidates.length} candidates`);
      agentResults.push({ agentName: "Scanner", status: "success", duration: scanDuration, details: `Scanned ${scanResult.totalScanned} markets, ${scanResult.candidates.length} candidates` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const scanDuration = (Date.now() - scanStart) / 1000;
      updateAgentStatus("Scanner", "error", undefined, errMsg);
      agentResults.push({ agentName: "Scanner", status: "error", duration: scanDuration, details: errMsg });
      await flushAgentRuns(agentResults);
      finishCycle();
      return { marketsScanned: 0, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    if (scanResult.candidates.length === 0) {
      await flushAgentRuns(agentResults);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    // Top N matches scanner price-history enrichment slice. Rule-based only (no Anthropic).
    const topCandidates = scanResult.candidates.slice(0, SCANNER_ANALYSIS_SLICE);

    let analysisStart = Date.now();
    updateAgentStatus("Analyst", "running");
    let analyses;
    try {
      analyses = analyzeMarketsRuleBased(topCandidates);
      for (const a of analyses) {
        a.strategyMinEdgePp = isPriorityMacroAuditEdgeCandidate(a.candidate)
          ? PRIORITY_MACRO_AUDIT_MIN_EDGE_PP
          : settings.minEdge;
      }
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      const withEdge = analyses.filter((a) => a.edge > 0);
      const topForLog = topCandidates.slice(0, 8).map((c) => `${c.market.ticker}@${(c.yesPrice * 100).toFixed(0)}¢`);
      console.log(`[Enrichment] Using rule-based model on top ${topCandidates.length} candidates (pipeline slice ${topCandidates.length}). Snapshot: ${topForLog.join(" | ")}`);
      updateAgentStatus("Analyst", "idle", `Analyzed ${analyses.length} markets [rule-based], ${withEdge.length} with edge`);
      agentResults.push({ agentName: "Analyst", status: "success", duration: analysisDuration, details: `${withEdge.length}/${analyses.length} markets have edge [rule-based]` });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const analysisDuration = (Date.now() - analysisStart) / 1000;
      updateAgentStatus("Analyst", "error", undefined, errMsg);
      agentResults.push({ agentName: "Analyst", status: "error", duration: analysisDuration, details: errMsg });
      await flushAgentRuns(agentResults);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, tradesExecuted: 0, tradesSkipped: 0, totalDuration: (Date.now() - cycleStart) / 1000, agentResults };
    }

    let auditStart = Date.now();
    updateAgentStatus("Auditor", "running");
    const auditMinLiquidity = paperMode ? 0 : settings.minLiquidity;
    const auditResults = auditTrades(analyses, {
      minLiquidity: auditMinLiquidity,
      minTimeToExpiry: settings.minTimeToExpiry,
      confidencePenaltyPct: settings.confidencePenaltyPct,
      /** Sports / Economics / Other use DB minEdge; Weather/Politics/Mention/Crypto use analysis.auditMinEdge (4.5pp). */
      minEdge: settings.minEdge,
    });
    const approvedRaw = auditResults.filter((a) => a.approved);
    const approved = dedupeApprovedOnePerGame(approvedRaw);
    if (approvedRaw.length > approved.length) {
      console.log(
        `[Pipeline] Same-game dedupe: ${approvedRaw.length} auditor-approved -> ${approved.length} ` +
          `(1 per gameKey, kept higher edge / tie-break confidence)`,
      );
    }
    const auditDuration = (Date.now() - auditStart) / 1000;
    updateAgentStatus(
      "Auditor",
      "idle",
      `${approved.length} after game-dedupe (${approvedRaw.length} raw) / ${auditResults.length} analyzed`,
    );
    agentResults.push({
      agentName: "Auditor",
      status: "success",
      duration: auditDuration,
      details: `${approved.length} post-dedupe (${approvedRaw.length} raw approved, 1/gameKey) / ${auditResults.length} analyzed`,
    });

    try {
      await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) => {
        await tx.delete(marketOpportunitiesTable);
        if (auditResults.length > 0) {
          const rows = auditResults.map((audit) => {
            const { analysis } = audit;
            return {
              kalshiTicker: analysis.candidate.market.ticker,
              title: analysis.candidate.market.title || analysis.candidate.market.ticker,
              category: opportunityCategoryLabel(
                analysis.candidate.market.ticker,
                analysis.candidate.market.category,
                analysis.candidate.market.event_ticker,
                analysis.candidate.market.series_ticker,
              ),
              currentYesPrice: analysis.candidate.yesPrice,
              modelProbability: analysis.modelProbability,
              edge: analysis.edge,
              confidence: audit.adjustedConfidence,
              side: analysis.side,
              volume24h: analysis.candidate.volume24h,
              expiresAt: new Date(
                analysis.candidate.market.expected_expiration_time ||
                  analysis.candidate.market.expiration_time ||
                  analysis.candidate.market.close_time,
              ),
            };
          });
          await tx.insert(marketOpportunitiesTable).values(rows);
        }
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[Pipeline] market_opportunities refresh failed:", msg);
    }

    if (approved.length === 0) {
      await flushAgentRuns(agentResults);
      finishCycle();
      return { marketsScanned: scanResult.totalScanned, opportunitiesFound: auditResults.length, tradesExecuted: 0, tradesSkipped: auditResults.length, totalDuration: (Date.now() - cycleStart) / 1000, agentResults, paperMode };
    }

    let riskStart = Date.now();
    updateAgentStatus("Risk Manager", "running");
    let bankroll: number;
    if (paperMode) {
      // True paper bankroll: $5,000 + sum of settled P&L (pnl column). Open stakes are
      // deducted from paper_balance in the executor; wins credit full $1/contract (minus fee) on settle.
      // Formula: $5,000 starting capital + all settled net P&L.
      // Open positions don't reduce available cash in paper mode — they are
      // virtual, so we only anchor on realised results.
      try {
        const [sumRow] = await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) =>
          tx
            .select({ total: sql<string>`coalesce(sum(${paperTradesTable.pnl}), 0)::text` })
            .from(paperTradesTable)
            .where(inArray(paperTradesTable.status, ["won", "lost"])),
        );
        const settledPnl = parseFloat(String(sumRow?.total ?? "0")) || 0;
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
    let spreadCapSkipped = 0;
    // Tracks trades approved THIS cycle so the reverse middle detector can see
    // intra-cycle positions before they are written to the DB.
    const intraCycleTrades: Array<{ kalshiTicker: string; side: string }> = [];

    const startOfUtcDay = new Date();
    startOfUtcDay.setUTCHours(0, 0, 0, 0);
    const tradedTodaySet = new Set<string>();
    if (paperMode) {
      try {
        const todayRows = await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) =>
          tx
            .select({ kalshiTicker: paperTradesTable.kalshiTicker })
            .from(paperTradesTable)
            .where(gte(paperTradesTable.createdAt, startOfUtcDay)),
        );
        for (const r of todayRows) tradedTodaySet.add(r.kalshiTicker);
      } catch {
        /* non-fatal */
      }
    }

    // Build a game-key → count map from currently open DB positions.
    // This prevents adding a 3rd bet on a game where we already have 2 open.
    const openGameCounts = new Map<string, number>();
    const openTickers = new Set<string>();
    try {
      const openTrades = await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) => {
        if (paperMode) {
          return tx
            .select({ kalshiTicker: paperTradesTable.kalshiTicker })
            .from(paperTradesTable)
            .where(eq(paperTradesTable.status, "open"));
        }
        return tx
          .select({ kalshiTicker: tradesTable.kalshiTicker })
          .from(tradesTable)
          .where(eq(tradesTable.status, "open"));
      });
      for (const t of openTrades) {
        openTickers.add(t.kalshiTicker);
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
        const c = audit.analysis.candidate;
        const m = c.market;
        const cat = m.category || "Unknown";
        const sportFine = kalshiSportLabel(m.ticker);
        const sportBucket = kalshiSportBucket(m.ticker);
        const diag = diagnoseStrategyMiss(audit.analysis, enabledStrategies);
        const ya = c.yesAsk != null ? c.yesAsk.toFixed(4) : "?";
        const na = c.noAsk != null ? c.noAsk.toFixed(4) : "?";
        console.log(
          `[Pipeline] No-strategy skip: ticker=${m.ticker} sportBucket=${sportBucket} sportLabel=${sportFine} category=${cat} ` +
            `side=${audit.analysis.side} edge=${audit.analysis.edge.toFixed(2)}pp ` +
            `modelConf=${(audit.analysis.confidence * 100).toFixed(1)}% adjConf=${(audit.adjustedConfidence * 100).toFixed(1)}% ` +
            `yesMid=${(c.yesPrice ?? 0).toFixed(3)} yesAsk=${ya} noAsk=${na} | ${diag}`,
        );
        continue;
      }

      // Confidence ceiling: empirically, win rate collapses above 75% confidence.
      // Skip the trade but record the ticker so the dashboard can display why.
      if (audit.adjustedConfidence > CONFIDENCE_CEILING) {
        confidenceCapped++;
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
          const cat = audit.analysis.candidate.market.category || "Unknown";
          const strat = strategyMatches[0]?.strategyName ?? "?";
          const sf = kalshiSportLabel(ticker);
          const sb = kalshiSportBucket(ticker);
          console.log(
            `[Pipeline] Game-cap skip: ticker=${ticker} sportBucket=${sb} sportLabel=${sf} category=${cat} ` +
              `side=${audit.analysis.side} gameKey=${gameKey} strategy=${strat} ` +
              `dbPositionsOnGame=${dbCount} queuedThisCycle=${cycleCount} total=${totalGamePositions} max=${MAX_POSITIONS_PER_GAME} ` +
              `edge=${audit.analysis.edge.toFixed(2)}pp conf=${(audit.adjustedConfidence * 100).toFixed(1)}% — per-game open limit`,
          );
          continue;
        }
      }

      if (openTickers.has(ticker) || intraCycleTrades.some((x) => x.kalshiTicker === ticker)) {
        console.log(`[Pipeline] Same-ticker skip: already open or queued ${ticker}`);
        continue;
      }

      if (paperMode && tradedTodaySet.has(ticker)) {
        console.log(`[Pipeline] Same-day ticker skip: ${ticker} already had a paper trade today (1-per-ticker/day)`);
        continue;
      }

      const maxSpreadDollars = (settings.maxSpreadCents ?? 5) / 100;
      const spreadD = takerSpreadDollars(audit.analysis.candidate, audit.analysis.side);
      if (spreadD > maxSpreadDollars + 1e-9) {
        spreadCapSkipped++;
        console.log(
          `[Pipeline] Spread cap skip: ${ticker} side=${audit.analysis.side} spread=$${spreadD.toFixed(4)} (>${maxSpreadDollars.toFixed(2)} max)`,
        );
        continue;
      }

      const strategyName = strategyMatches[0].strategyName;
      const strategyReason = strategyMatches[0].reason;
      const decision = await assessRisk(audit, {
        maxPositionPct: settings.maxPositionPct,
        kellyFraction: settings.kellyFraction,
        maxConsecutiveLosses: settings.maxConsecutiveLosses,
        maxDrawdownPct: settings.maxDrawdownPct,
        maxSimultaneousPositions: settings.maxSimultaneousPositions,
        targetBetUsd: settings.targetBetUsd ?? 15,
      }, effectiveBankroll, {
        strategyName,
        strategyReason,
        paperMode,
        additionalOpenPositions: approvedThisCycle,
        intraCycleTrades,
      });
      riskDecisions.push(decision);
      if (decision.approved) {
        const entryPrice =
          decision.audit.analysis.side === "yes"
            ? decision.audit.analysis.candidate.yesAsk
            : decision.audit.analysis.candidate.noAsk;
        if (entryPrice != null) {
          effectiveBankroll -= decision.positionSize * entryPrice;
        }
        approvedThisCycle++;
        intraCycleTrades.push({
          kalshiTicker: audit.analysis.candidate.market.ticker,
          side: audit.analysis.side,
        });
        if (paperMode) tradedTodaySet.add(audit.analysis.candidate.market.ticker);
      }
    }
    const riskApproved = riskDecisions.filter((d) => d.approved);
    const riskDuration = (Date.now() - riskStart) / 1000;
    const riskExtras = [
      strategySkipped > 0 ? `${strategySkipped} no-strategy` : null,
      confidenceCapped > 0 ? `${confidenceCapped} conf>${(CONFIDENCE_CEILING * 100).toFixed(0)}% capped` : null,
      noPriceCapped > 0 ? `${noPriceCapped} NO>${(NO_MAX_ENTRY_PRICE * 100).toFixed(0)}¢ capped` : null,
      gameCapSkipped > 0 ? `${gameCapSkipped} game-cap (max ${MAX_POSITIONS_PER_GAME}/game)` : null,
      spreadCapSkipped > 0 ? `${spreadCapSkipped} spread-cap (>${(settings.maxSpreadCents ?? 5)}¢)` : null,
    ].filter(Boolean).join(", ");
    const riskDetails = riskExtras
      ? `${riskApproved.length}/${riskDecisions.length} risk-approved, ${riskExtras}`
      : `${riskApproved.length}/${riskDecisions.length} risk-approved`;
    updateAgentStatus("Risk Manager", "idle", riskDetails);
    agentResults.push({ agentName: "Risk Manager", status: "success", duration: riskDuration, details: riskDetails });

    let execStart = Date.now();
    updateAgentStatus("Executor", "running");
    let executed = 0;
    let thinBookSkips = 0;
    if (paperMode && riskApproved.length > 0) {
      console.info(`[Pipeline] Paper execution queue (pre depth): ${riskApproved.length} risk-approved candidate(s)`);
    }
    for (const decision of riskApproved) {
      const result = await executeTrade(decision, paperMode);
      if (result.executed) executed++;
      else if (result.thinBookSkipped) thinBookSkips++;
      else if (result.error) {
        const t = decision.audit.analysis.candidate.market.ticker;
        console.warn(`[Executor] skipped ${t}: ${result.error}`);
      }
    }
    const execDuration = (Date.now() - execStart) / 1000;
    const modeLabel = paperMode ? " (paper)" : "";
    if (paperMode && riskApproved.length > 0) {
      console.info(
        `[Pipeline] Paper depth gate: ${executed} executed, ${thinBookSkips} thin-book skip(s), ${riskApproved.length} candidate(s) pre-depth`,
      );
    }
    updateAgentStatus("Executor", "idle", `Executed ${executed}/${riskApproved.length} trades${modeLabel}`);
    agentResults.push({ agentName: "Executor", status: "success", duration: execDuration, details: `${executed}/${riskApproved.length} executed${modeLabel}` });

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

    await flushAgentRuns(agentResults);

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
    await flushAgentRuns(agentResults);
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

  // Optional delay (ms) so `PUT /api/settings` can run before the first cycle reads `trading_settings`.
  const rawDelay = process.env.PIPELINE_INITIAL_DELAY_MS;
  const parsedDelay = rawDelay !== undefined ? Number(rawDelay) : 0;
  const initialDelayMs = Math.min(60_000, Math.max(0, Number.isFinite(parsedDelay) ? parsedDelay : 0));
  if (initialDelayMs > 0) {
    console.log(`[Pipeline] First cycle delayed ${initialDelayMs}ms`);
    setTimeout(() => {
      runTradingCycle().catch((err) => console.error("Pipeline initial cycle error:", err));
    }, initialDelayMs);
  } else {
    runTradingCycle().catch((err) => console.error("Pipeline initial cycle error:", err));
  }

  pipelineInterval = setInterval(() => {
    runTradingCycle().catch((err) => console.error("Pipeline cycle error:", err));
  }, intervalMinutes * 60 * 1000);

  console.log(`[Pipeline] Started: runs every ${intervalMinutes} min (first cycle immediate)`);
  if (intervalMinutes === 2) {
    console.log("[Pipeline] Using aggressive 2-minute scan — monitoring rate limits");
  }
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
        const [settings] = await db.select().from(tradingSettingsTable).limit(1);
        const intervalMin = settings?.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES;
        startPipeline(intervalMin);
        console.log(`[Watchdog] Pipeline restarted with ${intervalMin} min interval`);
      } catch (err) {
        console.error("[Watchdog] Failed to restart pipeline:", err instanceof Error ? err.message : err);
      }
    }
  }, WATCHDOG_CHECK_MS);

  console.log("[Watchdog] Dead-man's switch started (checks every 1 min, threshold 15 min)");
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
  const scanResult = await scanMarkets(settings.sportFilters as string[], {
    crypto: settings.cryptoPriorityWeight ?? 3.2,
    weather: settings.weatherPriorityWeight ?? 3.2,
    politics: settings.politicsPriorityWeight ?? 3.2,
    mention: settings.mentionPriorityWeight ?? 3.2,
    maxSpreadCents: settings.maxSpreadCents ?? 5,
  });
  updateAgentStatus("Scanner", "idle", `Scanned ${scanResult.totalScanned} markets, found ${scanResult.candidates.length} candidates`);

  if (scanResult.candidates.length === 0) {
    return { marketsScanned: scanResult.totalScanned, opportunitiesFound: 0, scanDuration: (Date.now() - start) / 1000 };
  }

  const topCandidates = scanResult.candidates.slice(0, 20);

  updateAgentStatus("Analyst", "running");
  const analyses = analyzeMarketsRuleBased(topCandidates);
  for (const a of analyses) {
    a.strategyMinEdgePp = isPriorityMacroAuditEdgeCandidate(a.candidate)
      ? PRIORITY_MACRO_AUDIT_MIN_EDGE_PP
      : settings.minEdge;
  }
  updateAgentStatus("Analyst", "idle", `Analyzed ${analyses.length} markets`);

  updateAgentStatus("Auditor", "running");
  const auditResults = auditTrades(analyses, {
    minLiquidity: settings.minLiquidity,
    minTimeToExpiry: settings.minTimeToExpiry,
    confidencePenaltyPct: settings.confidencePenaltyPct,
    minEdge: settings.minEdge,
  });
  updateAgentStatus("Auditor", "idle", `${auditResults.filter(a => a.approved).length}/${auditResults.length} approved`);

  try {
    await withTransactionStatementTimeout(PIPELINE_DB_MS, async (tx: DbClient) => {
      await tx.delete(marketOpportunitiesTable);
      if (auditResults.length > 0) {
        const rows = auditResults.map((audit) => {
          const { analysis } = audit;
          return {
            kalshiTicker: analysis.candidate.market.ticker,
            title: analysis.candidate.market.title || analysis.candidate.market.ticker,
            category: opportunityCategoryLabel(
              analysis.candidate.market.ticker,
              analysis.candidate.market.category,
              analysis.candidate.market.event_ticker,
              analysis.candidate.market.series_ticker,
            ),
            currentYesPrice: analysis.candidate.yesPrice,
            modelProbability: analysis.modelProbability,
            edge: analysis.edge,
            confidence: audit.adjustedConfidence,
            side: analysis.side,
            volume24h: analysis.candidate.volume24h,
            expiresAt: new Date(
              analysis.candidate.market.expected_expiration_time ||
                analysis.candidate.market.expiration_time ||
                analysis.candidate.market.close_time,
            ),
          };
        });
        await tx.insert(marketOpportunitiesTable).values(rows);
      }
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[scanAndDiscover] market_opportunities refresh failed:", msg);
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
    const interval = settings.scanIntervalMinutes ?? DEFAULT_SCAN_INTERVAL_MINUTES;
    startPipeline(interval);
    console.log(`Pipeline rehydrated from DB: active with ${interval} minute interval`);
  } else {
    console.log("Pipeline rehydration: not active in DB settings");
  }
  startStrategyLearnerSchedule();
}
