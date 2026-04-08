import { db, tradesTable, paperTradesTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { AuditResult } from "./auditor.js";
import type { AnalysisResult } from "./analyst.js";

export interface RiskDecision {
  audit: AuditResult;
  approved: boolean;
  positionSize: number;
  kellyFraction: number;
  riskScore: number;
  rejectReason?: string;
  strategyName?: string;
}

export interface RiskParams {
  maxPositionPct: number;
  kellyFraction: number;
  maxConsecutiveLosses: number;
  maxDrawdownPct: number;
  maxSimultaneousPositions: number;
  /** Center of ~$10–$20 notional band (half-Kelly still capped at 6% bankroll). */
  targetBetUsd?: number;
}

export interface CoreRiskResult {
  approved: boolean;
  positionSize: number;
  kellyFraction: number;
  riskScore: number;
  rejectReason?: string;
}

/**
 * Extracts the outcome team/identifier from a Kalshi spread ticker suffix.
 * KXNBASPREAD-26MAR16ORLATL-ORL3  → "ORL"
 * KXLALIGAGAME-26MAR16RVCLEV-TIE  → "TIE"
 * KXNBA-26-BOS                    → "BOS"
 * Returns null for unrecognised formats.
 */
function extractOutcomeTeam(ticker: string): string | null {
  const parts = ticker.split("-");
  if (parts.length < 3) return null;
  const suffix = parts[parts.length - 1];
  // Take the leading alpha block: "ORL3"→"ORL", "TIE"→"TIE", "LEV"→"LEV"
  const match = suffix.match(/^([A-Z]+)/);
  return match ? match[1] : null;
}

/**
 * Returns true when placing a new YES trade on `newTicker` would create a
 * reverse middle against an existing YES trade on `existingTicker` within
 * the same game/event.
 *
 * A reverse middle = YES on outcome A + YES on outcome B in the same game
 * where A and B are different teams/results (mutually exclusive winners).
 *
 * Safe combinations allowed:
 *   - Same outcome YES + YES  → doubling down
 *   - Any outcome YES + NO    → middle / hedge (winning window exists)
 *   - Different outcome NO+NO → fine (both can be true simultaneously)
 */
function isReverseMiddle(
  existingTicker: string,
  existingSide: string,
  newTicker: string,
  newSide: string,
): boolean {
  if (existingSide !== "yes" || newSide !== "yes") return false;

  const existingTeam = extractOutcomeTeam(existingTicker);
  const newTeam = extractOutcomeTeam(newTicker);

  if (!existingTeam || !newTeam) return false;

  // Different outcome both YES → reverse middle
  return existingTeam !== newTeam;
}

export function computeRisk(
  analysis: AnalysisResult,
  params: RiskParams,
  bankroll: number,
  context: {
    consecutiveLosses: number;
    drawdownPct: number;
    openPositions: number;
    reverseMiddleDetected: boolean;
    adjustedConfidence: number;
    auditApproved: boolean;
  },
): CoreRiskResult {
  if (context.consecutiveLosses >= params.maxConsecutiveLosses) {
    return {
      approved: false, positionSize: 0, kellyFraction: 0, riskScore: 1,
      rejectReason: `Streak halt: ${context.consecutiveLosses} consecutive losses (max ${params.maxConsecutiveLosses})`,
    };
  }

  if (context.drawdownPct >= params.maxDrawdownPct) {
    return {
      approved: false, positionSize: 0, kellyFraction: 0, riskScore: 1,
      rejectReason: `Drawdown halt: ${context.drawdownPct.toFixed(1)}% (max ${params.maxDrawdownPct}%)`,
    };
  }

  if (params.maxSimultaneousPositions > 0 && context.openPositions >= params.maxSimultaneousPositions) {
    return {
      approved: false, positionSize: 0, kellyFraction: 0, riskScore: 0.9,
      rejectReason: `Position cap: ${context.openPositions} open positions (max ${params.maxSimultaneousPositions})`,
    };
  }

  if (context.reverseMiddleDetected) {
    return {
      approved: false, positionSize: 0, kellyFraction: 0, riskScore: 0.85,
      rejectReason: `Reverse middle blocked: would bet YES on opposite outcomes in the same game`,
    };
  }

  const rawP = analysis.modelProbability;
  const p = analysis.side === "yes" ? rawP : 1 - rawP;
  const marketPrice = analysis.side === "yes" ? analysis.candidate.yesAsk : analysis.candidate.noAsk;
  if (marketPrice == null || marketPrice < 0.01 || marketPrice > 0.99) {
    return {
      approved: false,
      positionSize: 0,
      kellyFraction: 0,
      riskScore: 0.2,
      rejectReason: "Missing or invalid taker ask (YES/NO) — cannot size Kelly at realistic fill",
    };
  }

  const b = (1 / marketPrice) - 1;
  const q = 1 - p;
  const fullKelly = b > 0 ? (b * p - q) / b : 0;
  const quarterKelly = Math.max(0, fullKelly * params.kellyFraction);

  const maxPositionDollars = bankroll * (params.maxPositionPct / 100);
  const kellyPositionDollars = bankroll * quarterKelly;
  const target = params.targetBetUsd ?? 15;
  const bandLo = Math.max(8, (target * 10) / 15);
  const bandHi = Math.min(22, (target * 20) / 15);
  let positionDollars = Math.min(kellyPositionDollars, maxPositionDollars);
  positionDollars = Math.min(Math.max(positionDollars, bandLo), bandHi);
  positionDollars = Math.min(positionDollars, bankroll * 0.06);
  const costPerContract = Math.max(0.01, marketPrice);
  const positionSize = Math.round(positionDollars / costPerContract);

  const riskScore = Math.min(1,
    (context.consecutiveLosses / params.maxConsecutiveLosses) * 0.4 +
    (context.drawdownPct / params.maxDrawdownPct) * 0.4 +
    (1 - context.adjustedConfidence) * 0.2);

  if (positionSize < 1) {
    return {
      approved: false,
      positionSize: 0,
      kellyFraction: quarterKelly,
      riskScore,
      rejectReason: "Kelly sizing rounds to < 1 contract at current ask",
    };
  }

  return {
    approved: quarterKelly > 0 && context.auditApproved,
    positionSize,
    kellyFraction: quarterKelly,
    riskScore,
  };
}

export async function assessRisk(
  audit: AuditResult,
  settings: {
    maxPositionPct: number;
    kellyFraction: number;
    maxConsecutiveLosses: number;
    maxDrawdownPct: number;
    maxSimultaneousPositions?: number;
    targetBetUsd?: number;
  },
  bankroll: number,
  options?: {
    strategyName?: string;
    paperMode?: boolean;
    additionalOpenPositions?: number;
    /** Trades approved earlier within the same pipeline cycle (not yet in DB) */
    intraCycleTrades?: Array<{ kalshiTicker: string; side: string }>;
  }
): Promise<RiskDecision> {
  const tradeSource = options?.paperMode ? paperTradesTable : tradesTable;

  const recentTrades = await db
    .select()
    .from(tradeSource)
    .orderBy(desc(tradeSource.createdAt))
    .limit(settings.maxConsecutiveLosses + 5);

  // Time-gap streak reset: if the most recent settled trade is older than 3 days,
  // the losing streak almost certainly ended before the pipeline went offline.
  // Carrying a stale streak across a multi-day outage would permanently block trading.
  // Root cause of March 30–April 7 outage: 3 consecutive losses at 23:40–23:50 on
  // March 29 hit maxConsecutiveLosses=3; the server crashed ~1 hour later; when it
  // came back up 8 days later the streak was still 3 and blocked every trade.
  const STREAK_GAP_RESET_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
  const mostRecentSettled = recentTrades.find((t) => t.status === "lost" || t.status === "won");
  const streakGapExpired = mostRecentSettled
    ? Date.now() - new Date(mostRecentSettled.createdAt).getTime() > STREAK_GAP_RESET_MS
    : false;

  let consecutiveLosses = 0;
  if (!streakGapExpired) {
    for (const trade of recentTrades) {
      if (trade.status === "lost") {
        consecutiveLosses++;
      } else if (trade.status === "won") {
        break;
      }
    }
  }
  // If streak gap expired: consecutiveLosses remains 0, streak is forgiven.

  const allTrades = await db.select().from(tradeSource);
  const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const initialBankroll = bankroll - totalPnl;
  const drawdownPct = initialBankroll > 0 ? (-Math.min(0, totalPnl) / initialBankroll) * 100 : 0;

  const openTrades = allTrades.filter((t) => t.status === "open");

  const newTicker = audit.analysis.candidate.market.ticker;
  const newSide = audit.analysis.side;
  const newGameKey = newTicker.split("-").slice(0, 2).join("-");

  // Build a combined list of all existing same-game positions:
  // DB open trades + intra-cycle trades approved this scan cycle
  const sameGameDbTrades = openTrades
    .filter((t) => t.kalshiTicker.split("-").slice(0, 2).join("-") === newGameKey)
    .map((t) => ({ kalshiTicker: t.kalshiTicker, side: t.side }));

  const sameGameCycleTrades = (options?.intraCycleTrades ?? [])
    .filter((t) => t.kalshiTicker.split("-").slice(0, 2).join("-") === newGameKey);

  const allSameGameTrades = [...sameGameDbTrades, ...sameGameCycleTrades];

  // Detect reverse middle: any existing same-game trade that is YES on a
  // different outcome compared to the new trade which is also YES
  const reverseMiddleDetected = allSameGameTrades.some((existing) =>
    isReverseMiddle(existing.kalshiTicker, existing.side, newTicker, newSide)
  );

  const result = computeRisk(
    audit.analysis,
    {
      maxPositionPct: settings.maxPositionPct,
      kellyFraction: settings.kellyFraction,
      maxConsecutiveLosses: settings.maxConsecutiveLosses,
      maxDrawdownPct: settings.maxDrawdownPct,
      maxSimultaneousPositions: settings.maxSimultaneousPositions ?? 0,
      targetBetUsd: settings.targetBetUsd ?? 15,
    },
    bankroll,
    {
      consecutiveLosses,
      drawdownPct,
      openPositions: openTrades.length + (options?.additionalOpenPositions || 0),
      reverseMiddleDetected,
      adjustedConfidence: audit.adjustedConfidence,
      auditApproved: audit.approved,
    },
  );

  return {
    audit,
    ...result,
    strategyName: options?.strategyName,
  };
}
