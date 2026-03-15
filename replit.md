# Kalshi Sports AI Trading System

## Overview

Multi-agent automated sports trading system for Kalshi prediction markets. Features a 5-agent pipeline (Scanner → Analyst → Auditor → Risk Manager → Executor) with Claude AI analysis, running on a configurable schedule. Includes a React dashboard for monitoring P&L, trades, market opportunities, agent status, and risk settings.

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
│   │       │   └── agents/             # 5-agent pipeline
│   │       │       ├── scanner.ts      # Market scanner (finds sports markets)
│   │       │       ├── analyst.ts      # Claude AI analyst (evaluates edge)
│   │       │       ├── auditor.ts      # Constraint validator
│   │       │       ├── risk-manager.ts # Position sizing (Quarter Kelly)
│   │       │       ├── executor.ts     # Order execution on Kalshi
│   │       │       └── pipeline.ts     # Orchestrator + scheduler
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

- **trades**: Trade history with market ticker, side, price, quantity, P&L, agent reasoning
- **agent_runs**: Log of each agent execution (scanner, analyst, auditor, risk_manager, executor)
- **trading_settings**: Risk parameters (Kelly fraction, max drawdown, position limits, sport filters)
- **market_opportunities**: Detected opportunities with edge analysis from AI

## API Endpoints (all under /api)

- `GET /api/dashboard/overview` — Portfolio balance, P&L, win rate, open positions count
- `GET /api/positions` — Current open positions with unrealized P&L
- `GET /api/trades` — Trade history with optional status filter
- `GET /api/markets/opportunities` — AI-detected market opportunities
- `GET /api/agents/status` — Status of all 5 agents
- `GET /api/agents/logs` — Recent agent run logs
- `POST /api/agents/run-cycle` — Trigger a single pipeline cycle
- `POST /api/agents/halt` — Emergency halt the pipeline
- `GET /api/settings` — Current risk/trading settings
- `PUT /api/settings` — Update risk/trading settings
- `POST /api/pipeline/start` — Start the automated scheduler
- `POST /api/pipeline/stop` — Stop the automated scheduler

## Agent Pipeline

1. **Scanner**: Fetches active sports markets from Kalshi API, filters by sport/liquidity/time
2. **Analyst**: Uses Claude AI to evaluate each market, estimate true probability, calculate edge
3. **Auditor**: Validates against constraints (min edge, min liquidity, min time to expiry)
4. **Risk Manager**: Sizes positions using Quarter Kelly criterion, checks drawdown limits
5. **Executor**: Places limit orders on Kalshi via their REST API

**Risk Controls**: 3-loss streak circuit breaker, 15% max drawdown halt, 10% max position size

## Key Configuration

- **Kalshi API**: `KALSHI_API_KEY` secret, base URL `https://api.elections.kalshi.com/trade-api/v2`
- **AI**: Anthropic via Replit AI Integrations (no separate key needed)
- **Scan Interval**: Default 60 minutes (configurable in Settings)
- **Sport Filters**: NFL, NBA, MLB, Soccer (configurable in Settings)

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
