/**
 * Learner Agent
 *
 * Runs after every N pipeline cycles (or on demand). Reads the full closed-trade
 * history, computes performance slices across every meaningful dimension, sends the
 * structured data to Claude Haiku for synthesis, then writes the resulting insights
 * and a ready-to-inject analyst blurb back to the DB.
 *
 * The analyst reads the most recent learnings row at the start of each analysis and
 * appends it as a "Prior System Learnings" section — giving it actual empirical
 * calibration data rather than having it fly blind every time.
 */

import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  db,
  paperTradesTable,
  agentLearningsTable,
  apiCostsTable,
} from "@workspace/db";
import { desc, gte } from "drizzle-orm";
import type { LearningInsight } from "@workspace/db";

const HAIKU_INPUT_COST_PER_M = 0.25;
const HAIKU_OUTPUT_COST_PER_M = 0.80;

interface TradeBucket {
  label: string;
  trades: number;
  wins: number;
  totalPnl: number;
}

function bucket(map: Map<string, TradeBucket>, key: string, won: boolean, pnl: number) {
  const existing = map.get(key) ?? { label: key, trades: 0, wins: 0, totalPnl: 0 };
  existing.trades++;
  if (won) existing.wins++;
  existing.totalPnl += pnl;
  map.set(key, existing);
}

function winPct(b: TradeBucket): number {
  return b.trades > 0 ? Math.round((b.wins / b.trades) * 100) : 0;
}

function avgPnl(b: TradeBucket): number {
  return b.trades > 0 ? parseFloat((b.totalPnl / b.trades).toFixed(2)) : 0;
}

function bucketsToText(label: string, map: Map<string, TradeBucket>): string {
  const sorted = [...map.values()].sort((a, b) => b.trades - a.trades);
  const rows = sorted.map(
    (b) =>
      `  ${b.label}: ${b.trades} trades, ${winPct(b)}% win rate, avg P&L $${avgPnl(b)}`
  );
  return `${label}:\n${rows.join("\n")}`;
}

export async function runLearner(): Promise<{
  skipped?: boolean;
  reason?: string;
  totalClosedTrades?: number;
  insights?: LearningInsight[];
}> {
  // Load all closed trades
  const allTrades = await db
    .select()
    .from(paperTradesTable)
    .orderBy(desc(paperTradesTable.closedAt));

  const closed = allTrades.filter((t) => t.status === "won" || t.status === "lost");

  if (closed.length < 10) {
    return { skipped: true, reason: `Only ${closed.length} closed trades — need ≥10 to learn` };
  }

  // Slice across every dimension
  const byCategory = new Map<string, TradeBucket>();
  const byEdgeBucket = new Map<string, TradeBucket>();
  const byConfBucket = new Map<string, TradeBucket>();
  const bySide = new Map<string, TradeBucket>();
  const byPriceRange = new Map<string, TradeBucket>();
  const byTimeRange = new Map<string, TradeBucket>();
  const byStrategy = new Map<string, TradeBucket>();

  let totalPnl = 0;

  for (const t of closed) {
    const won = t.status === "won";
    const pnl = t.pnl ?? 0;
    totalPnl += pnl;

    // Category from ticker prefix
    const ticker = t.kalshiTicker.toUpperCase();
    const cat =
      ticker.startsWith("KXNBA") || ticker.startsWith("KXNFL") ||
      ticker.startsWith("KXNHL") || ticker.startsWith("KXMLB") ||
      ticker.startsWith("KXNWSL") || ticker.startsWith("KXUFC") ||
      ticker.startsWith("KXLALIGA") || ticker.startsWith("KXSERIEA") ||
      ticker.startsWith("KXEPL") || ticker.startsWith("KXCHAMPIONS") ||
      ticker.startsWith("KXMLS") || ticker.startsWith("KXUCL")
        ? "Sports"
        : ticker.startsWith("KXBTC") || ticker.startsWith("KXETH") ||
          ticker.startsWith("KXCRYPTO") || ticker.startsWith("KXSOLANA")
        ? "Crypto"
        : ticker.startsWith("KXPRES") || ticker.startsWith("KXSEN") ||
          ticker.startsWith("KXGOV") || ticker.startsWith("KXELECT")
        ? "Politics"
        : ticker.startsWith("KXCPI") || ticker.startsWith("KXGDP") ||
          ticker.startsWith("KXFED") || ticker.startsWith("KXUNEMPLOYMENT") ||
          ticker.startsWith("KXINF")
        ? "Economics"
        : ticker.startsWith("KXWX") || ticker.startsWith("KXWEATHER") ||
          ticker.startsWith("KXHURR") || ticker.startsWith("KXTEMP")
        ? "Weather"
        : "Other";
    bucket(byCategory, cat, won, pnl);

    // Edge bucket
    const edge = t.edge ?? 0;
    const edgeKey =
      edge < 5 ? "0-5%"
      : edge < 10 ? "5-10%"
      : edge < 20 ? "10-20%"
      : edge < 30 ? "20-30%"
      : edge < 50 ? "30-50%"
      : "50%+";
    bucket(byEdgeBucket, edgeKey, won, pnl);

    // Confidence bucket
    const conf = (t.confidence ?? 0) * 100;
    const confKey =
      conf < 30 ? "<30%"
      : conf < 40 ? "30-40%"
      : conf < 50 ? "40-50%"
      : conf < 60 ? "50-60%"
      : "≥60%";
    bucket(byConfBucket, confKey, won, pnl);

    // Side
    bucket(bySide, t.side === "yes" ? "YES bets" : "NO bets", won, pnl);

    // Entry price range
    const ep = t.entryPrice ?? 0;
    const priceKey =
      ep < 0.15 ? "0-15c (heavy underdog)"
      : ep < 0.30 ? "15-30c (underdog)"
      : ep < 0.50 ? "30-50c (toss-up)"
      : ep < 0.70 ? "50-70c (favorite)"
      : "70c+ (heavy favorite)";
    bucket(byPriceRange, priceKey, won, pnl);

    // Strategy
    bucket(byStrategy, t.strategyName ?? "Unknown", won, pnl);
  }

  const winRate = closed.filter((t) => t.status === "won").length / closed.length;

  // Build the data summary for Claude
  const summary = [
    `TOTAL: ${closed.length} closed trades | ${Math.round(winRate * 100)}% win rate | $${totalPnl.toFixed(2)} net P&L`,
    "",
    bucketsToText("BY CATEGORY", byCategory),
    "",
    bucketsToText("BY EDGE BUCKET", byEdgeBucket),
    "",
    bucketsToText("BY AI CONFIDENCE", byConfBucket),
    "",
    bucketsToText("BY SIDE (YES/NO)", bySide),
    "",
    bucketsToText("BY ENTRY PRICE RANGE", byPriceRange),
    "",
    bucketsToText("BY STRATEGY", byStrategy),
  ].join("\n");

  // Ask Claude Haiku to synthesize patterns
  const prompt = `You are the self-learning module of an automated prediction market trading system. 
Below is empirical performance data from the paper trading history. Analyze it and produce:

1. A JSON array of "insights" — concrete, actionable findings from the data
2. An "analystInjection" — a short text block (≤300 words) that will be prepended to every future analysis prompt to guide calibration

The system trades Kalshi prediction markets: politics, economics, crypto, weather, and some sports.

## PERFORMANCE DATA
${summary}

## CONTEXT
- A 50% win rate is break-even (binary markets, $1 payout, ~50¢ average entry)
- Win rate > 55% on a bucket with ≥10 trades is a strong positive signal
- Win rate < 40% on a bucket with ≥10 trades means the AI is systematically wrong there
- "Edge" is the model's estimated mispricing (model prob - market price). High stated edge that produces low win rate = miscalibrated model.
- Current NBA spread markets have been blocked; remaining data reflects non-spread markets

Respond in EXACTLY this JSON format (no other text):
{
  "insights": [
    {
      "dimension": "<what was measured, e.g. 'category:Politics'>",
      "finding": "<1-2 sentence fact from the data>",
      "action": "<concrete instruction for the analyst, e.g. 'FAVOR: raise edge threshold to 8%' or 'AVOID: do not bet YES when entry price < 15¢'>",
      "signal": "<one of: favor | avoid | caution | neutral>",
      "trades": <number>,
      "winRate": <decimal 0-1>,
      "avgPnl": <number>
    }
  ],
  "analystInjection": "<text block to inject into analyst prompts. Start with 'SYSTEM LEARNINGS (empirical, updated automatically):\\n'. Use plain text, bullet points ok. Describe what's working, what's failing, and calibration corrections.>"
}

Only include insights for buckets with ≥5 closed trades. Focus on the most actionable findings. Aim for 5-10 insights.`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const inputTokens = message.usage?.input_tokens || 0;
  const outputTokens = message.usage?.output_tokens || 0;
  const costUsd = (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;

  await db.insert(apiCostsTable).values({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens,
    outputTokens,
    costUsd,
    agentName: "Learner",
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";

  // Sanitise special characters that break JSON.parse, then extract the JSON block
  const sanitised = text
    .replace(/[\u00A2\u00A3\u00A5\u20AC]/g, "") // strip currency symbols
    .replace(/[\u2018\u2019]/g, "'")             // smart apostrophes
    .replace(/[\u201C\u201D]/g, '"');            // smart quotes

  const jsonMatch = sanitised.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[Learner] Claude did not return valid JSON — skipping this run");
    return { skipped: true, reason: "Claude response parse failed" };
  }

  let parsed: { insights: LearningInsight[]; analystInjection: string };
  try {
    parsed = JSON.parse(jsonMatch[0]) as {
      insights: LearningInsight[];
      analystInjection: string;
    };
  } catch (parseErr) {
    console.warn("[Learner] JSON.parse failed:", parseErr);
    return { skipped: true, reason: "JSON parse error in Claude response" };
  }

  await db.insert(agentLearningsTable).values({
    totalClosedTrades: closed.length,
    winRate,
    totalPnl,
    insights: parsed.insights,
    analystInjection: parsed.analystInjection,
    rawAnalysis: summary,
  });

  console.log(
    `[Learner] Wrote ${parsed.insights.length} insights from ${closed.length} closed trades (win rate ${Math.round(winRate * 100)}%)`
  );

  return {
    totalClosedTrades: closed.length,
    insights: parsed.insights,
  };
}

/**
 * Fetch the most recent analyst injection text to embed in analyst prompts.
 * Returns null if no learnings exist yet (first few cycles).
 */
export async function getLatestAnalystInjection(): Promise<string | null> {
  const [latest] = await db
    .select({ analystInjection: agentLearningsTable.analystInjection })
    .from(agentLearningsTable)
    .orderBy(desc(agentLearningsTable.createdAt))
    .limit(1);
  return latest?.analystInjection ?? null;
}

/**
 * Fetch the most recent full learning row for display on the dashboard.
 */
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

/**
 * Fetch recent learning history (for the dashboard sparkline).
 */
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
