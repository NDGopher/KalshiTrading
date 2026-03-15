import { db, tradesTable, paperTradesTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
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
}

export interface CoreRiskResult {
  approved: boolean;
  positionSize: number;
  kellyFraction: number;
  riskScore: number;
  rejectReason?: string;
}

export function computeRisk(
  analysis: AnalysisResult,
  params: RiskParams,
  bankroll: number,
  context: {
    consecutiveLosses: number;
    drawdownPct: number;
    openPositions: number;
    correlatedPositions: number;
    adjustedConfidence: number;
    auditApproved: boolean;
  },
): CoreRiskResult {
  if (context.consecutiveLosses >= params.maxConsecutiveLosses) {
    return { approved: false, positionSize: 0, kellyFraction: 0, riskScore: 1,
      rejectReason: `Streak halt: ${context.consecutiveLosses} consecutive losses (max ${params.maxConsecutiveLosses})` };
  }

  if (context.drawdownPct >= params.maxDrawdownPct) {
    return { approved: false, positionSize: 0, kellyFraction: 0, riskScore: 1,
      rejectReason: `Drawdown halt: ${context.drawdownPct.toFixed(1)}% (max ${params.maxDrawdownPct}%)` };
  }

  if (context.openPositions >= params.maxSimultaneousPositions) {
    return { approved: false, positionSize: 0, kellyFraction: 0, riskScore: 0.9,
      rejectReason: `Position cap: ${context.openPositions} open positions (max ${params.maxSimultaneousPositions})` };
  }

  if (context.correlatedPositions >= 3) {
    return { approved: false, positionSize: 0, kellyFraction: 0, riskScore: 0.8,
      rejectReason: `Correlation cap: ${context.correlatedPositions} positions in same category (max 3)` };
  }

  const rawP = analysis.modelProbability;
  const p = analysis.side === "yes" ? rawP : 1 - rawP;
  const marketPrice = analysis.side === "yes" ? analysis.candidate.yesPrice : analysis.candidate.noPrice;
  const b = (1 / marketPrice) - 1;
  const q = 1 - p;
  const fullKelly = b > 0 ? (b * p - q) / b : 0;
  const quarterKelly = Math.max(0, fullKelly * params.kellyFraction);

  const maxPositionDollars = bankroll * (params.maxPositionPct / 100);
  const kellyPositionDollars = bankroll * quarterKelly;
  const positionDollars = Math.min(kellyPositionDollars, maxPositionDollars);
  const costPerContract = Math.max(0.01, marketPrice);
  const positionSize = Math.max(1, Math.floor(positionDollars / costPerContract));

  const riskScore = Math.min(1,
    (context.consecutiveLosses / params.maxConsecutiveLosses) * 0.4 +
    (context.drawdownPct / params.maxDrawdownPct) * 0.4 +
    (1 - context.adjustedConfidence) * 0.2);

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
  },
  bankroll: number,
  options?: { strategyName?: string; paperMode?: boolean }
): Promise<RiskDecision> {
  const tradeSource = options?.paperMode ? paperTradesTable : tradesTable;

  const recentTrades = await db
    .select()
    .from(tradeSource)
    .orderBy(desc(tradeSource.createdAt))
    .limit(settings.maxConsecutiveLosses + 5);

  let consecutiveLosses = 0;
  for (const trade of recentTrades) {
    if (trade.status === "lost") {
      consecutiveLosses++;
    } else if (trade.status === "won") {
      break;
    }
  }

  const allTrades = await db.select().from(tradeSource);
  const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const initialBankroll = bankroll - totalPnl;
  const drawdownPct = initialBankroll > 0 ? (-Math.min(0, totalPnl) / initialBankroll) * 100 : 0;

  const openTrades = allTrades.filter((t) => t.status === "open");

  const openTickerCategories = new Set(openTrades.map((t) => t.kalshiTicker.split("-").slice(0, 2).join("-")));
  const candidateCategory = audit.analysis.candidate.market.ticker.split("-").slice(0, 2).join("-");
  const correlatedPositions = openTickerCategories.has(candidateCategory)
    ? openTrades.filter((t) => t.kalshiTicker.split("-").slice(0, 2).join("-") === candidateCategory).length
    : 0;

  const result = computeRisk(
    audit.analysis,
    {
      maxPositionPct: settings.maxPositionPct,
      kellyFraction: settings.kellyFraction,
      maxConsecutiveLosses: settings.maxConsecutiveLosses,
      maxDrawdownPct: settings.maxDrawdownPct,
      maxSimultaneousPositions: settings.maxSimultaneousPositions || 8,
    },
    bankroll,
    {
      consecutiveLosses,
      drawdownPct,
      openPositions: openTrades.length,
      correlatedPositions,
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
