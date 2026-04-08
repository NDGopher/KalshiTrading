import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const poolMax = Math.min(50, Math.max(2, Number(process.env.PG_POOL_MAX) || 20));
const connectTimeout = Math.min(120_000, Math.max(3_000, Number(process.env.PG_CONNECTION_TIMEOUT_MS) || 15_000));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS) || 30_000,
  connectionTimeoutMillis: connectTimeout,
  allowExitOnIdle: false,
});

export const db = drizzle(pool, { schema });

/** Drizzle DB handle (also used to type transaction callbacks). */
export type DbClient = typeof db;

export * from "./schema";

/** Wait until a simple query succeeds (Neon cold start / network). */
export async function waitForDatabase(options?: {
  maxWaitMs?: number;
  intervalMs?: number;
}): Promise<void> {
  const maxWaitMs = options?.maxWaitMs ?? (Number(process.env.DB_STARTUP_MAX_WAIT_MS) || 120_000);
  const intervalMs = options?.intervalMs ?? (Number(process.env.DB_PING_INTERVAL_MS) || 2_500);
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1 AS ok");
      if (attempt > 0) {
        console.info(`[DB] Ready after ${attempt + 1} attempt(s)`);
      }
      return;
    } catch (e) {
      lastErr = e;
      attempt++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[DB] Ping failed (attempt ${attempt}): ${msg}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Database not reachable within ${maxWaitMs}ms (last error: ${msg})`);
}

/**
 * Runs work inside a transaction with PostgreSQL `SET LOCAL statement_timeout`
 * so a slow Neon query aborts server-side and releases the connection instead of
 * wedging the pool for minutes.
 */
export async function withTransactionStatementTimeout<T>(
  timeoutMs: number,
  run: (tx: DbClient) => Promise<T>,
): Promise<T> {
  const ms = Math.min(Math.max(50, Math.floor(timeoutMs)), 600_000);
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${ms}`));
    return run(tx as unknown as DbClient);
  });
}
