import { db, tradesTable, paperTradesTable } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import type { AuditResult } from "./auditor.js";

export interface RiskDecision {
  audit: AuditResult;
  approved: boolean;
  positionSize: number;
  kellyFraction: number;
  riskScore: number;
  rejectReason?: string;
  strategyName?: string;
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

  if (consecutiveLosses >= settings.maxConsecutiveLosses) {
    return {
      audit,
      approved: false,
      positionSize: 0,
      kellyFraction: 0,
      riskScore: 1,
      rejectReason: `Streak halt: ${consecutiveLosses} consecutive losses (max ${settings.maxConsecutiveLosses})`,
      strategyName: options?.strategyName,
    };
  }

  const allTrades = await db.select().from(tradeSource);
  const totalPnl = allTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const initialBankroll = bankroll - totalPnl;
  const drawdown = initialBankroll > 0 ? (-Math.min(0, totalPnl) / initialBankroll) * 100 : 0;

  if (drawdown >= settings.maxDrawdownPct) {
    return {
      audit,
      approved: false,
      positionSize: 0,
      kellyFraction: 0,
      riskScore: 1,
      rejectReason: `Drawdown halt: ${drawdown.toFixed(1)}% (max ${settings.maxDrawdownPct}%)`,
      strategyName: options?.strategyName,
    };
  }

  const maxPositions = settings.maxSimultaneousPositions || 8;
  const openTrades = allTrades.filter((t) => t.status === "open");
  if (openTrades.length >= maxPositions) {
    return {
      audit,
      approved: false,
      positionSize: 0,
      kellyFraction: 0,
      riskScore: 0.9,
      rejectReason: `Position cap: ${openTrades.length} open positions (max ${maxPositions})`,
      strategyName: options?.strategyName,
    };
  }

  const { analysis } = audit;
  const rawP = analysis.modelProbability;
  const p = analysis.side === "yes" ? rawP : 1 - rawP;
  const marketPrice = analysis.side === "yes" ? analysis.candidate.yesPrice : analysis.candidate.noPrice;
  const b = (1 / marketPrice) - 1;
  const q = 1 - p;
  const fullKelly = b > 0 ? (b * p - q) / b : 0;
  const quarterKelly = Math.max(0, fullKelly * settings.kellyFraction);

  const openTickerCategories = new Set(openTrades.map((t) => t.kalshiTicker.split("-").slice(0, 2).join("-")));
  const candidateCategory = analysis.candidate.market.ticker.split("-").slice(0, 2).join("-");
  const correlatedPositions = openTickerCategories.has(candidateCategory) ? openTrades.filter((t) => t.kalshiTicker.split("-").slice(0, 2).join("-") === candidateCategory).length : 0;
  const maxCorrelatedPositions = 3;

  if (correlatedPositions >= maxCorrelatedPositions) {
    return {
      audit,
      approved: false,
      positionSize: 0,
      kellyFraction: 0,
      riskScore: 0.8,
      rejectReason: `Correlation cap: ${correlatedPositions} positions in same event category "${candidateCategory}" (max ${maxCorrelatedPositions})`,
      strategyName: options?.strategyName,
    };
  }

  const maxPositionDollars = bankroll * (settings.maxPositionPct / 100);
  const kellyPositionDollars = bankroll * quarterKelly;
  const positionDollars = Math.min(kellyPositionDollars, maxPositionDollars);

  const costPerContract = Math.max(0.01, marketPrice);
  const positionSize = Math.max(1, Math.floor(positionDollars / costPerContract));

  const riskScore = Math.min(1, (consecutiveLosses / settings.maxConsecutiveLosses) * 0.4 + (drawdown / settings.maxDrawdownPct) * 0.4 + (1 - audit.adjustedConfidence) * 0.2);

  return {
    audit,
    approved: quarterKelly > 0 && audit.approved,
    positionSize,
    kellyFraction: quarterKelly,
    riskScore,
    strategyName: options?.strategyName,
  };
}
