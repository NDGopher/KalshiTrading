# Kalshi Sports AI Trading System

## Overview

Multi-agent automated sports trading system for Kalshi prediction markets. Features a 6-agent pipeline (Scanner → Analyst → Auditor → Risk Manager → Executor → Reconciler) with Claude AI analysis, running on a configurable schedule. Includes a React dashboard for monitoring P&L, trades, market opportunities, agent status, and risk/credential settings.

**Target Sports**: NFL, NBA, MLB, Soccer (all major sports)

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite (Tailwind CSS v4, wouter routing, React Query, framer-motion)
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **AI**: Anthropic Claude (claude-haiku-4-5 via Replit AI Integrations)
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/           # Express API server (port 8080)
│   │   └── src/
│   │       ├── lib/
│   │       │   ├── kalshi-client.ts    # Kalshi REST API v2 client
│   │       │   └── agents/             # 6-agent pipeline
│   │       │       ├── scanner.ts      # Market scanner (finds sports markets)
│   │       │       ├── analyst.ts      # Claude AI analyst (evaluates edge)
│   │       │       ├── auditor.ts      # Constraint validator (hard-blocks flagged trades)
│   │       │       ├── risk-manager.ts # Position sizing (Quarter Kelly)
│   │       │       ├── executor.ts     # Order execution on Kalshi (3 retries, "failed" terminal)
│   │       │       ├── reconciler.ts   # Trade settlement reconciliation
│   │       │       └── pipeline.ts     # Orchestrator + scheduler + scanAndDiscover
│   │       └── routes/                 # Express route handlers
│   └── dashboard/            # React + Vite frontend (port from PORT env)
│       └── src/
│           ├── pages/        # Dashboard, Opportunities, Trades, Agents, Settings
│           └── components/   # Layout, UI components (shadcn-style)
├── lib/
│   ├── api-spec/             # OpenAPI 3.1 spec + Orval codegen config
│   ├── api-client-react/     # Generated React Query hooks
│   ├── api-zod/              # Generated Zod schemas
│   ├── db/                   # Drizzle ORM schema + DB connection
│   └── integrations-anthropic-ai/  # Anthropic AI integration
├── scripts/
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## Database Schema

- **trades**: Trade history with market ticker, side, price, quantity, P&L, agent reasoning. Status: open | won | lost | pending | cancelled | failed
- **positions**: Persisted portfolio positions synced from Kalshi (ticker, side, qty, avg price, current price, unrealized P&L, market status)
- **agent_runs**: Log of each agent execution (scanner, analyst, auditor, risk_manager, executor, reconciler)
- **trading_settings**: Risk parameters, sport filters, Kalshi API credentials (kalshi_api_key, kalshi_base_url)
- **market_opportunities**: Detected opportunities with edge analysis from AI

## API Endpoints (all under /api)

- `GET /api/dashboard/overview` — Portfolio balance, P&L, win rate, open positions count
- `GET /api/positions` — Current open positions with unrealized P&L
- `GET /api/trades` — Trade history with optional status filter
- `GET /api/markets/opportunities` — AI-detected market opportunities
- `POST /api/markets/scan` — Scan-only (Scanner→Analyst→Auditor, no execution)
- `GET /api/agents/status` — Status of all 6 agents
- `GET /api/agents/logs` — Recent agent run logs
- `POST /api/agents/run-cycle` — Trigger a single full pipeline cycle
- `POST /api/agents/halt` — Emergency halt the pipeline
- `GET /api/settings` — Current risk/trading settings (kalshiApiKeySet boolean, never exposes key)
- `PUT /api/settings` — Update risk/trading settings and Kalshi credentials
- `POST /api/settings/test-connection` — Test Kalshi API connection
- `POST /api/pipeline/start` — Start the automated scheduler
- `POST /api/pipeline/stop` — Stop the automated scheduler

## Agent Pipeline

1. **Scanner**: Fetches active sports markets from Kalshi API, filters by sport/liquidity/time
2. **Analyst**: Uses Claude AI to evaluate each market, estimate true probability, calculate edge
3. **Auditor**: Hard-blocks any flagged trades (zero-flag pass only). Flags: low liquidity, close expiry, wide spread, insufficient edge, low confidence, hallucination pattern, short reasoning
4. **Risk Manager**: Sizes positions using Quarter Kelly criterion, checks drawdown limits
5. **Executor**: Places limit orders on Kalshi via their REST API. 3 retries; exhausted retries → "failed" status
6. **Reconciler**: Checks open trades with kalshiOrderId against Kalshi API for settlement. Cancelled orders → "cancelled" status

**Risk Controls**: 3-loss streak circuit breaker, 15% max drawdown halt, 10% max position size

## Auth

- API_SECRET: auto-generated random secret on startup if not set in env. Always enforced — all POST/PUT/DELETE require `Authorization: Bearer <token>`.
- Dashboard auto-fetches the token from `GET /api/auth/token` and injects it into all mutations via the `customFetch` layer.
- Kalshi credentials: stored in DB settings (write-only, never returned in reads). Falls back to KALSHI_API_KEY env var.

## Background Operation

- The API server workflow IS the background process. When `pipelineActive` is true in settings, `rehydratePipeline()` restarts the scheduler on server boot.
- Pipeline runs via `setInterval` inside the Node process. First cycle runs immediately on start, then repeats at the configured interval.
- All agent runs (including early-exit and error paths) are persisted to the `agent_runs` table for full observability.

## Key Configuration

- **Kalshi API**: Configurable via dashboard Settings page or KALSHI_API_KEY env var. Base URL configurable (default: trading-api.kalshi.com)
- **AI**: Anthropic via Replit AI Integrations (no separate key needed)
- **Scan Interval**: Default 60 minutes (configurable in Settings)
- **Sport Filters**: NFL, NBA, MLB, Soccer (configurable in Settings)
- **Confidence Penalty**: Default 8% (configurable in Settings)

## Development Commands

- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/dashboard run dev` — Start frontend dev server
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks/schemas
- `pnpm --filter @workspace/db run push` — Push schema changes to DB
- `pnpm run typecheck` — Full workspace typecheck

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — `pnpm run typecheck`
- **`emitDeclarationOnly`** — only `.d.ts` files emitted during typecheck; JS bundling by esbuild/vite
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array
- **After editing generated schemas**: rebuild api-client-react declarations before dashboard typecheck

## Trade Status Values

`open | won | lost | pending | cancelled | failed` — all 6 must be in OpenAPI spec, `lib/api-zod/src/generated/api.ts` (two places), `lib/api-client-react/src/generated/api.schemas.ts` (TradeStatus and ListTradesStatus)

## Important Notes

- scanAndDiscover() runs Scanner→Analyst→Auditor only (no Risk/Executor/Reconciler). Used by /markets/scan.
- runTradingCycle() runs full 6-agent pipeline. Used by /agents/run-cycle and the automated scheduler.
- Edge values are already in percent units (e.g. 15 means 15%). Do not multiply by 100 when displaying.
- Win rate calculation excludes cancelled, pending, and failed trades.
- Pipeline active state is read from overview.pipelineActive API field, not inferred from agent statuses.
