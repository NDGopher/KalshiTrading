/**
 * Truncates non-essential tables; keeps paper_trades + trading_settings.
 * Run automatically from start-paper-trading.bat after db:push.
 * Usage: node tools/db/purge-logs-except-paper.mjs
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

const sql = `
TRUNCATE TABLE
  backtest_trades,
  backtest_runs,
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
  console.log("OK: purged non-essential tables (paper_trades + trading_settings kept).");
} catch (e) {
  console.error("FAILED:", e.message, e.code || "");
  process.exitCode = 1;
} finally {
  await pool.end();
}
