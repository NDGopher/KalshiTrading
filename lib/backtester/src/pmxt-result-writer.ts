import fs from "node:fs/promises";
import path from "node:path";
import type { BacktestMetrics, SimulatedTrade } from "./types.js";
import { backtestResultsDir, latestBacktestResultPath } from "./paths.js";

const MAX_TRADES_STORED = 50_000;

export function pmxtBacktestRunsDir(dataRoot: string): string {
  return path.join(backtestResultsDir(dataRoot), "runs");
}

export function buildPmxtBacktestRunFilename(opts: {
  strategyName: string;
  sourceDate: string | null;
  hourUtc: number | undefined;
  fileLabel?: string;
}): string {
  const slug = opts.strategyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "strategy";
  const datePart = opts.sourceDate?.replace(/[^\d-]/g, "") || "custom";
  let scope: string;
  if (opts.hourUtc !== undefined) scope = `h${String(opts.hourUtc).padStart(2, "0")}`;
  else if (opts.fileLabel) scope = `file_${opts.fileLabel.slice(0, 36).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  else scope = "fullday";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `pmxt-${slug}_${datePart}_${scope}_${stamp}.json`;
}

export type PmxtBacktestFilePayload = {
  runId: string;
  runFilename: string;
  generatedAt: string;
  source: Record<string, unknown>;
  metrics: BacktestMetrics;
  trades: SimulatedTrade[];
  tradesPreview: SimulatedTrade[];
};

export async function writePmxtBacktestOutputs(
  dataRoot: string,
  input: Omit<PmxtBacktestFilePayload, "runId" | "runFilename" | "tradesPreview"> & {
    trades: SimulatedTrade[];
  },
  filenameOpts: {
    strategyName: string;
    sourceDate: string | null;
    hourUtc: number | undefined;
    fileLabel?: string;
  },
): Promise<{ runFilename: string; runPath: string; latestPath: string }> {
  const runFilename = buildPmxtBacktestRunFilename(filenameOpts);
  const runId = runFilename.replace(/\.json$/i, "");
  const tradesStored = input.trades.slice(0, MAX_TRADES_STORED);
  const payload: PmxtBacktestFilePayload = {
    ...input,
    runId,
    runFilename,
    trades: tradesStored,
    tradesPreview: tradesStored.slice(0, 200),
  };

  const runsDir = pmxtBacktestRunsDir(dataRoot);
  await fs.mkdir(runsDir, { recursive: true });
  const runPath = path.join(runsDir, runFilename);
  const latestPath = latestBacktestResultPath(dataRoot);
  const json = JSON.stringify(payload, null, 2);
  await fs.writeFile(runPath, json, "utf8");
  await fs.writeFile(latestPath, json, "utf8");
  return { runFilename, runPath, latestPath };
}
