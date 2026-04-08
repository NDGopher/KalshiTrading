/**
 * Learner — **LLM disabled** in keeper-only mode (no Anthropic fees).
 * DB read helpers for dashboard history are unchanged.
 */

import { db, agentLearningsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { LearningInsight } from "@workspace/db";

export async function runLearner(): Promise<{
  skipped?: boolean;
  reason?: string;
  totalClosedTrades?: number;
  insights?: LearningInsight[];
}> {
  console.info("[Learner] Skipped — keeper-only stack (no Anthropic / no LLM fees).");

  if (process.env.PMXT_NIGHTLY_BACKTEST === "1") {
    try {
      const { runPmxtNightlyBacktestIfEnabled } = await import("@workspace/backtester/nightly");
      await runPmxtNightlyBacktestIfEnabled();
    } catch (e) {
      console.warn("[Learner] PMXT archive backtest hook failed:", e);
    }
  }

  try {
    const { tryApplyMultiBacktestRankToSettings } = await import("../apply-backtest-rank.js");
    const rankApply = await tryApplyMultiBacktestRankToSettings();
    if (rankApply.applied) {
      console.log("[Learner] Multi-strategy backtest rank →", rankApply.detail);
    }
  } catch (e) {
    console.warn("[Learner] apply-backtest-rank failed:", e);
  }

  return { skipped: true, reason: "Learner LLM disabled in keeper-only stack." };
}

export async function getLatestAnalystInjection(): Promise<string | null> {
  const [latest] = await db
    .select({ analystInjection: agentLearningsTable.analystInjection })
    .from(agentLearningsTable)
    .orderBy(desc(agentLearningsTable.createdAt))
    .limit(1);
  return latest?.analystInjection ?? null;
}

export async function getLatestLearnings(): Promise<{
  createdAt: string;
  totalClosedTrades: number;
  winRate: number;
  totalPnl: number;
  insights: LearningInsight[];
  analystInjection: string;
} | null> {
  const [row] = await db
    .select()
    .from(agentLearningsTable)
    .orderBy(desc(agentLearningsTable.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    createdAt: row.createdAt.toISOString(),
    totalClosedTrades: row.totalClosedTrades,
    winRate: row.winRate,
    totalPnl: row.totalPnl,
    insights: row.insights as LearningInsight[],
    analystInjection: row.analystInjection,
  };
}

export async function getLearningHistory(): Promise<
  Array<{ createdAt: string; winRate: number; totalPnl: number; totalClosedTrades: number }>
> {
  const rows = await db
    .select({
      createdAt: agentLearningsTable.createdAt,
      winRate: agentLearningsTable.winRate,
      totalPnl: agentLearningsTable.totalPnl,
      totalClosedTrades: agentLearningsTable.totalClosedTrades,
    })
    .from(agentLearningsTable)
    .orderBy(desc(agentLearningsTable.createdAt))
    .limit(20);

  return rows.map((r) => ({
    createdAt: r.createdAt.toISOString(),
    winRate: r.winRate,
    totalPnl: r.totalPnl,
    totalClosedTrades: r.totalClosedTrades,
  }));
}
