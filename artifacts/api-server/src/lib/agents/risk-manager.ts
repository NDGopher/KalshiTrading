import { db, tradesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import type { AuditResult } from "./auditor.js";

export interface RiskDecision {
  audit: AuditResult;
  approved: boolean;
  positionSize: number;
  kellyFraction: number;
  riskScore: number;
  rejectReason?: string;
}

export async function assessRisk(
  audit: AuditResult,
  settings: {
    maxPositionPct: number;
    kellyFraction: number;
    maxConsecutiveLosses: number;
    maxDrawdownPct: number;
  },
  bankroll: number
): Promise<RiskDecision> {
  const recentTrades = await db
    .select()
    .from(tradesTable)
    .orderBy(desc(tradesTable.createdAt))
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
    };
  }

  const allTrades = await db.select().from(tradesTable);
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
    };
  }

  const { analysis } = audit;
  const p = analysis.modelProbability;
  const marketPrice = analysis.side === "yes" ? analysis.candidate.yesPrice : analysis.candidate.noPrice;
  const b = (1 / marketPrice) - 1;
  const q = 1 - p;
  const fullKelly = (b * p - q) / b;
  const quarterKelly = Math.max(0, fullKelly * settings.kellyFraction);

  const maxPosition = bankroll * (settings.maxPositionPct / 100);
  const kellyPosition = bankroll * quarterKelly;
  const positionDollars = Math.min(kellyPosition, maxPosition);

  const pricePerContract = analysis.side === "yes" ? analysis.candidate.yesPrice : analysis.candidate.noPrice;
  const positionSize = Math.max(1, Math.floor(positionDollars / Math.max(0.01, pricePerContract)));

  const riskScore = Math.min(1, (consecutiveLosses / settings.maxConsecutiveLosses) * 0.4 + (drawdown / settings.maxDrawdownPct) * 0.4 + (1 - audit.adjustedConfidence) * 0.2);

  return {
    audit,
    approved: quarterKelly > 0 && audit.approved,
    positionSize,
    kellyFraction: quarterKelly,
    riskScore,
  };
}
