import fs from "node:fs/promises";
import path from "node:path";
import {
  latestBacktestResultPath,
  multiBacktestRankPath,
  pmxtBacktestRunsDir,
  defaultDataDir,
} from "@workspace/backtester";
import { Router, type IRouter } from "express";

const router: IRouter = Router();

function dataRoot(): string {
  return defaultDataDir();
}

/** Prevent path traversal; only simple .json basenames under runs/. */
function safeRunBasename(param: string): string | null {
  const base = path.basename(param);
  if (base !== param || base.includes("..")) return null;
  if (!/^[\w.-]+\.json$/i.test(base)) return null;
  return base;
}

router.get("/pmxt-backtests/latest", async (_req, res): Promise<void> => {
  const file = latestBacktestResultPath();
  try {
    const raw = await fs.readFile(file, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({
      error: "No pmxt parquet backtest result yet.",
      hint: "Run: pnpm --filter @workspace/backtester run backtest -- --date YYYY-MM-DD --hour 0",
    });
  }
});

async function summarizeRunFile(full: string, name: string) {
  const st = await fs.stat(full);
  const raw = await fs.readFile(full, "utf8");
  const j = JSON.parse(raw) as Record<string, unknown>;
  const metrics = j.metrics as Record<string, unknown> | undefined;
  return {
    runFilename: name,
    runId: typeof j.runId === "string" ? j.runId : name.replace(/\.json$/i, ""),
    generatedAt: typeof j.generatedAt === "string" ? j.generatedAt : st.mtime.toISOString(),
    strategyName: typeof metrics?.strategyName === "string" ? metrics.strategyName : null,
    trades: typeof metrics?.trades === "number" ? metrics.trades : null,
    totalPnlUsd: typeof metrics?.totalPnlUsd === "number" ? metrics.totalPnlUsd : null,
    winRate: typeof metrics?.winRate === "number" ? metrics.winRate : null,
    maxDrawdownPct: typeof metrics?.maxDrawdownPct === "number" ? metrics.maxDrawdownPct : null,
    mtimeMs: st.mtimeMs,
  };
}

async function summaryFromLatestFile() {
  const latestPath = latestBacktestResultPath();
  try {
    const raw = await fs.readFile(latestPath, "utf8");
    const j = JSON.parse(raw) as Record<string, unknown>;
    const name = typeof j.runFilename === "string" ? j.runFilename : "latest.json";
    return await summarizeRunFile(latestPath, name);
  } catch {
    return null;
  }
}

router.get("/pmxt-backtests/runs", async (_req, res): Promise<void> => {
  const dir = pmxtBacktestRunsDir(dataRoot());
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".json")).map((e) => e.name);
  } catch {
    names = [];
  }

  const summaries = await Promise.all(
    names.map(async (name) => {
      const full = path.join(dir, name);
      try {
        return await summarizeRunFile(full, name);
      } catch {
        return {
          runFilename: name,
          runId: name.replace(/\.json$/i, ""),
          generatedAt: null,
          strategyName: null,
          trades: null,
          totalPnlUsd: null,
          winRate: null,
          maxDrawdownPct: null,
          mtimeMs: 0,
        };
      }
    }),
  );

  const latestRow = await summaryFromLatestFile();
  if (latestRow && !summaries.some((s) => s.runFilename === latestRow.runFilename)) {
    summaries.push(latestRow);
  }

  summaries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  res.json({ runs: summaries.map(({ mtimeMs: _, ...rest }) => rest) });
});

/** Latest historical multi-strategy JSON (`data/backtest-results/multi/last-ranked.json`). */
router.get("/pmxt-backtests/multi/latest", async (_req, res): Promise<void> => {
  const file = multiBacktestRankPath(dataRoot());
  try {
    const raw = await fs.readFile(file, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({
      error: "No historical multi backtest yet.",
      hint: 'Run: pnpm --filter @workspace/backtester run historical-multi -- --from YYYY-MM-DD --to YYYY-MM-DD',
    });
  }
});

router.get("/pmxt-backtests/runs/:runFile", async (req, res): Promise<void> => {
  const safe = safeRunBasename(req.params.runFile ?? "");
  if (!safe) {
    res.status(400).json({ error: "Invalid run file name." });
    return;
  }
  if (safe.toLowerCase() === "latest.json") {
    try {
      const raw = await fs.readFile(latestBacktestResultPath(), "utf8");
      res.type("application/json").send(raw);
      return;
    } catch {
      res.status(404).json({ error: "Run not found.", runFile: safe });
      return;
    }
  }
  const full = path.join(pmxtBacktestRunsDir(dataRoot()), safe);
  try {
    const raw = await fs.readFile(full, "utf8");
    res.type("application/json").send(raw);
  } catch {
    res.status(404).json({ error: "Run not found.", runFile: safe });
  }
});

export default router;
