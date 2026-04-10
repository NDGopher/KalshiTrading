import {
  db,
  paperTradesTable,
  strategyPerformanceSnapshotsTable,
  tradingSettingsTable,
} from "@workspace/db";
import { and, count, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";

const LEARNER_TICK_MS = 6 * 60 * 60 * 1000;
const PRUNE_DAYS = 120;

let learnerInterval: ReturnType<typeof setInterval> | null = null;

function utcYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function sharpeApprox(pnls: number[]): number | null {
  if (pnls.length < 3) return null;
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  let v = 0;
  for (const x of pnls) v += (x - mean) ** 2;
  v = Math.sqrt(v / (pnls.length - 1));
  if (v < 1e-9) return null;
  return mean / v;
}

type ClosedRow = {
  strategyName: string;
  pnl: number;
  edge: number;
  status: string;
  closedAt: Date;
};

async function fetchClosedRowsSince(cutoff: Date): Promise<ClosedRow[]> {
  const rows = await db
    .select({
      strategyName: paperTradesTable.strategyName,
      pnl: paperTradesTable.pnl,
      edge: paperTradesTable.edge,
      status: paperTradesTable.status,
      closedAt: paperTradesTable.closedAt,
    })
    .from(paperTradesTable)
    .where(
      and(
        inArray(paperTradesTable.status, ["won", "lost"]),
        isNotNull(paperTradesTable.closedAt),
        gte(paperTradesTable.closedAt, cutoff),
        isNotNull(paperTradesTable.strategyName),
      ),
    );

  const out: ClosedRow[] = [];
  for (const r of rows) {
    if (r.pnl === null || r.closedAt === null || !r.strategyName) continue;
    out.push({
      strategyName: r.strategyName,
      pnl: r.pnl,
      edge: r.edge,
      status: r.status,
      closedAt: r.closedAt,
    });
  }
  return out;
}

function aggregateWindow(rows: ClosedRow[], windowStart: Date) {
  const filtered = rows.filter((r) => r.closedAt >= windowStart);
  const byStrat = new Map<string, { pnls: number[]; edges: number[]; wins: number }>();
  for (const r of filtered) {
    let g = byStrat.get(r.strategyName);
    if (!g) {
      g = { pnls: [], edges: [], wins: 0 };
      byStrat.set(r.strategyName, g);
    }
    g.pnls.push(r.pnl);
    g.edges.push(r.edge);
    if (r.status === "won") g.wins += 1;
  }

  const out: Array<{
    strategyName: string;
    trades: number;
    wins: number;
    pnlUsd: number;
    sharpeApprox: number | null;
    expectancy: number | null;
    avgEdge: number | null;
  }> = [];

  for (const [strategyName, g] of byStrat) {
    const n = g.pnls.length;
    if (n === 0) continue;
    const pnlUsd = g.pnls.reduce((a, b) => a + b, 0);
    out.push({
      strategyName,
      trades: n,
      wins: g.wins,
      pnlUsd,
      sharpeApprox: sharpeApprox(g.pnls),
      expectancy: pnlUsd / n,
      avgEdge: g.edges.length ? g.edges.reduce((a, b) => a + b, 0) / g.edges.length : null,
    });
  }
  return out;
}

function buildSuggestions(
  minEdge: number,
  kellyFraction: number,
  agg30: ReturnType<typeof aggregateWindow>,
): string {
  const parts: string[] = [];
  let totalN = 0;
  let totalWins = 0;
  let totalPnl = 0;
  for (const a of agg30) {
    totalN += a.trades;
    totalWins += a.wins;
    totalPnl += a.pnlUsd;
  }
  if (totalN < 8) {
    parts.push("insufficient closed trades for tuning (need ≥8 in 30d)");
    return parts.join("; ");
  }
  const wr = totalWins / totalN;
  const exp = totalPnl / totalN;
  if (exp < -0.05 && wr < 0.48) {
    parts.push(`consider minEdge +0.5 → ${(minEdge + 0.5).toFixed(1)} (manual apply only)`);
  } else if (exp > 0.12 && wr > 0.54) {
    const nextEdge = Math.max(3, minEdge - 0.5);
    if (nextEdge < minEdge) parts.push(`consider minEdge -0.5 → ${nextEdge} (floor 3)`);
    const nextKelly = Math.min(0.33, kellyFraction + 0.05);
    if (nextKelly > kellyFraction) parts.push(`consider kellyFraction +0.05 → ${nextKelly.toFixed(2)} (cap 0.33)`);
  } else {
    parts.push("no material tweak suggested — hold current minEdge / kelly");
  }
  return parts.join("; ");
}

export async function runDailyStrategyLearnerSnapshot(): Promise<void> {
  const now = new Date();
  const today = utcYmd(now);
  const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const all = await fetchClosedRowsSince(d30);
  const agg7 = aggregateWindow(all, d7);
  const agg30 = aggregateWindow(all, d30);

  const pruneCutoff = utcYmd(new Date(now.getTime() - PRUNE_DAYS * 24 * 60 * 60 * 1000));
  await db
    .delete(strategyPerformanceSnapshotsTable)
    .where(lt(strategyPerformanceSnapshotsTable.computedForDate, pruneCutoff));

  await db
    .delete(strategyPerformanceSnapshotsTable)
    .where(eq(strategyPerformanceSnapshotsTable.computedForDate, today));

  const rowsToInsert: Array<typeof strategyPerformanceSnapshotsTable.$inferInsert> = [];
  for (const periodDays of [7, 30] as const) {
    const agg = periodDays === 7 ? agg7 : agg30;
    for (const a of agg) {
      rowsToInsert.push({
        computedForDate: today,
        periodDays,
        strategyName: a.strategyName,
        trades: a.trades,
        wins: a.wins,
        pnlUsd: a.pnlUsd,
        sharpeApprox: a.sharpeApprox,
        expectancy: a.expectancy,
        avgEdge: a.avgEdge,
      });
    }
  }
  if (rowsToInsert.length > 0) {
    await db.insert(strategyPerformanceSnapshotsTable).values(rowsToInsert);
  } else {
    await db.insert(strategyPerformanceSnapshotsTable).values([
      {
        computedForDate: today,
        periodDays: 7,
        strategyName: "_daily_tick",
        trades: 0,
        wins: 0,
        pnlUsd: 0,
        sharpeApprox: null,
        expectancy: null,
        avgEdge: null,
      },
      {
        computedForDate: today,
        periodDays: 30,
        strategyName: "_daily_tick",
        trades: 0,
        wins: 0,
        pnlUsd: 0,
        sharpeApprox: null,
        expectancy: null,
        avgEdge: null,
      },
    ]);
  }

  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  const minEdge = settings?.minEdge ?? 6;
  const kelly = settings?.kellyFraction ?? 0.28;
  const suggestionText = buildSuggestions(minEdge, kelly, agg30);

  const stratBits = agg7.map((a) => `${a.strategyName} 7d n=${a.trades}`).join(", ");
  console.log(
    `[Learner] Daily stats computed — suggestions: ${suggestionText}${stratBits ? ` | sample: ${stratBits}` : ""}`,
  );
}

async function runLearnerIfDue(): Promise<void> {
  const today = utcYmd(new Date());
  const [row] = await db
    .select({ n: count() })
    .from(strategyPerformanceSnapshotsTable)
    .where(eq(strategyPerformanceSnapshotsTable.computedForDate, today));

  if (Number(row?.n ?? 0) > 0) return;

  try {
    await runDailyStrategyLearnerSnapshot();
  } catch (e) {
    console.error("[Learner] Snapshot failed:", e instanceof Error ? e.message : e);
  }
}

/** Background only — not tied to the 2-minute pipeline. At most one full run per UTC day. */
export function startStrategyLearnerSchedule(): void {
  if (learnerInterval) clearInterval(learnerInterval);
  void runLearnerIfDue();
  learnerInterval = setInterval(() => {
    void runLearnerIfDue();
  }, LEARNER_TICK_MS);
  console.log("[Learner] Schedule started (6h tick, max once/day UTC snapshot)");
}
