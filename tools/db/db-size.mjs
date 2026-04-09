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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const r1 = await pool.query(
  "SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size",
);
console.log("Database:", r1.rows[0].db_size);
const r2 = await pool.query(`
  SELECT relname, pg_size_pretty(pg_total_relation_size(c.oid)) AS total
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
  ORDER BY pg_total_relation_size(c.oid) DESC
  LIMIT 20
`);
console.table(r2.rows);
await pool.end();
