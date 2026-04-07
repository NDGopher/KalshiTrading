import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { backtestResultsDir } from "./paths.js";

function clampNum(val: unknown, min: number, max: number, fallback: number): number {
  const n = Number(val);
  if (Number.isNaN(n) || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Apply `suggestedSettingsPatch` from `multi/last-ranked.json` to Postgres `trading_settings`
 * (same clamps as api-server `apply-backtest-rank`). Requires `DATABASE_URL`.
 */
export async function tryApplyMultiBacktestRankPatch(dataRoot: string): Promise<{
  applied: boolean;
  detail: string;
}> {
  const file = path.join(backtestResultsDir(dataRoot), "multi", "last-ranked.json");
  let st: { mtimeMs: number };
  try {
    st = await fs.stat(file);
  } catch {
    return { applied: false, detail: "no last-ranked.json" };
  }
  if (Date.now() - st.mtimeMs > 48 * 3600 * 1000) {
    return { applied: false, detail: "rank report older than 48h" };
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    return { applied: false, detail: "DATABASE_URL not set" };
  }

  type PatchFile = {
    suggestedSettingsPatch?: {
      minEdge?: number;
      kellyFraction?: number;
      confidencePenaltyPct?: number;
      rationale?: string;
    };
  };

  let parsed: PatchFile;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8")) as PatchFile;
  } catch {
    return { applied: false, detail: "invalid rank JSON" };
  }

  const patch = parsed.suggestedSettingsPatch;
  if (!patch) return { applied: false, detail: "no suggestedSettingsPatch" };

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: number;
      min_edge: number;
      kelly_fraction: number;
      confidence_penalty_pct: number;
    }>("SELECT id, min_edge, kelly_fraction, confidence_penalty_pct FROM trading_settings LIMIT 1");

    const current = rows[0];
    if (!current) return { applied: false, detail: "no trading_settings row" };

    const minEdge =
      patch.minEdge !== undefined
        ? clampNum(patch.minEdge, 2, 25, current.min_edge)
        : undefined;
    const kellyFraction =
      patch.kellyFraction !== undefined
        ? clampNum(patch.kellyFraction, 0.05, 1, current.kelly_fraction)
        : undefined;
    const confidencePenaltyPct =
      patch.confidencePenaltyPct !== undefined
        ? clampNum(patch.confidencePenaltyPct, 0, 40, current.confidence_penalty_pct)
        : undefined;

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (minEdge !== undefined) {
      sets.push(`min_edge = $${i++}`);
      vals.push(minEdge);
    }
    if (kellyFraction !== undefined) {
      sets.push(`kelly_fraction = $${i++}`);
      vals.push(kellyFraction);
    }
    if (confidencePenaltyPct !== undefined) {
      sets.push(`confidence_penalty_pct = $${i++}`);
      vals.push(confidencePenaltyPct);
    }

    if (sets.length === 0) {
      return { applied: false, detail: "nothing to apply (patch fields empty or unchanged)" };
    }

    vals.push(current.id);
    await client.query(`UPDATE trading_settings SET ${sets.join(", ")} WHERE id = $${i}`, vals);

    return {
      applied: true,
      detail: `Applied multi-backtest patch — ${patch.rationale ?? ""}`.trim(),
    };
  } finally {
    await client.end();
  }
}
