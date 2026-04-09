/**
 * Truncates bulky / log tables; keeps paper_trades and trading_settings.
 * Usage (repo root): node tools/db/purge-logs-except-paper.mjs
 * Requires DATABASE_URL in environment or .env at repo root.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const req = createRequire(path.join(root, "lib/db/package.json"));
const pg = req("pg");

for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (!m) continue;
  const k = m[1].trim();
  let v = m[2].trim().replace(/^["']|["']$/g, "");
  if (!process.env[k]) process.env[k] = v;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL missing");
  process.exit(1);
}

// Omit tables not created in this deployment (e.g. messages/conversations).
const sql = `
TRUNCATE TABLE
  backtest_trades,
  backtest_runs,
  agent_runs,
  agent_learnings,
  api_costs,
  historical_markets,
  market_opportunities,
  market_snapshots,
  positions,
  trades
RESTART IDENTITY CASCADE;
`;

const pool = new pg.Pool({ connectionString: url });
try {
  await pool.query(sql);
  console.log("OK: truncated log/history tables (paper_trades + trading_settings unchanged).");
} catch (e) {
  console.error("FAILED:", e.message, e.code || "");
  process.exitCode = 1;
} finally {
  await pool.end();
}
