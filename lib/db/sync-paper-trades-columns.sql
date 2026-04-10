-- Optional one-shot repair if paper trade INSERT fails with "column ... does not exist"
-- (hosted DB created before the app added these fields). Requires PostgreSQL 11+.
-- Prefer: pnpm db:push  (from repo root, with DATABASE_URL in .env)

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS strategy_name text;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS model_probability real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS edge real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS confidence real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS analyst_reasoning text;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS auditor_flags jsonb DEFAULT '[]'::jsonb;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS risk_score real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS kelly_fraction real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS simulated_balance real;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_spread_cents integer NOT NULL DEFAULT 0;
