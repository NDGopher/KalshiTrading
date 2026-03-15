# Kalshi Sports AI Trading System

## Overview

Multi-agent automated sports trading system for Kalshi prediction markets. Features a 6-agent pipeline (Scanner → Analyst → Auditor → Risk Manager → Executor → Reconciler) with Claude AI analysis, running on a configurable schedule. Includes a React dashboard for monitoring P&L, trades, market opportunities, agent status, backtesting, paper trading, API cost tracking, and risk/credential settings.

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
│   │       │   ├── backtester.ts       # Backtesting engine
│   │       │   ├── strategies/         # Multi-strategy framework
│   │       │   │   └── index.ts        # 5 strategies: Pure Value, Dip Buyer, Fade the Public, Momentum, Late Efficiency
│   │       │   └── agents/             # 6-agent pipeline
│   │       │       ├── scanner.ts      # Market scanner (finds sports markets)
│   │       │       ├── analyst.ts      # Claude AI analyst (evaluates edge) + API cost tracking
│   │       │       ├── auditor.ts      # Constraint validator (hard-blocks flagged trades)
│   │       │       ├── risk-manager.ts # Position sizing (Quarter Kelly, max 8 positions, 5% max, 20% drawdown)
│   │       │       ├── executor.ts     # Order execution (live + paper trading mode)
│   │       │       ├── reconciler.ts   # Trade settlement reconciliation
│   │       │       └── pipeline.ts     # Orchestrator + scheduler + strategy evaluation
│   │       └── routes/                 # Express route handlers
│   └── dashboard/            # React + Vite frontend (port from PORT env)
│       └── src/
│           ├── pages/        # Dashboard, Opportunities, Trades, Agents, Backtest, Settings
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

- **trades**: Trade history with market ticker, side, price, quantity, P&L, strategy name, CLV, agent reasoning. Status: open | won | lost | pending | cancelled | failed
- **positions**: Persisted portfolio positions synced from Kalshi
- **agent_runs**: Log of each agent execution
- **trading_settings**: Risk parameters, sport filters, Kalshi credentials, paper trading mode, API budget caps
- **market_opportunities**: Detected opportunities with edge analysis from AI
- **api_costs**: Per-call API cost tracking (provider, model, tokens, cost, agent, market)
- **backtest_runs**: Backtest run results (strategy, period, P&L, win rate, Sharpe ratio, max drawdown)
- **backtest_trades**: Individual simulated trades within a backtest run
- **paper_trades**: Simulated trades in paper trading mode ($5,000 initial balance)

## API Endpoints (all under /api)

### Core
- `GET /api/dashboard/overview` — Portfolio balance, P&L, win rate, paper mode indicator
- `GET /api/portfolio/positions` — Current open positions with unrealized P&L
- `GET /api/trades` — Trade history with optional status filter
- `GET /api/trades/stats` — Win rate, ROI, streaks
- `GET /api/markets/opportunities` — AI-detected market opportunities
- `POST /api/markets/scan` — Scan-only (Scanner→Analyst→Auditor, no execution)
- `GET /api/agents/status` — Status of all 6 agents
- `GET /api/agents/runs` — Recent agent run logs
- `POST /api/agents/run-cycle` — Trigger a single full pipeline cycle
- `POST /api/agents/toggle` — Start/stop the pipeline
- `GET /api/settings` — Current settings (kalshiApiKeySet boolean, never exposes key)
- `PUT /api/settings` — Update settings
- `POST /api/settings/test-connection` — Test Kalshi API connection

### Backtesting
- `GET /api/backtest/strategies` — List available strategy names
- `POST /api/backtest/run` — Run a backtest (strategy, date range, bankroll, AI toggle)
- `GET /api/backtest/results` — List past backtest runs
- `GET /api/backtest/trades/:runId` — Trades from a specific backtest run

### API Costs
- `GET /api/costs` — Daily, monthly, all-time cost breakdown + recent calls

### Paper Trading
- `GET /api/paper-trades` — List paper trades
- `GET /api/paper-trades/stats` — Paper trading statistics
- `POST /api/paper-trades/reconcile` — Settle open paper trades
- `POST /api/paper-trades/reset` — Reset paper balance to $5,000

## Multi-Strategy Framework

Five pluggable strategies in `artifacts/api-server/src/lib/strategies/index.ts`:
1. **Pure Value**: Trades when model probability diverges significantly from market price
2. **Dip Buyer**: Buys underdogs whose price has dropped below model estimate
3. **Fade the Public**: Bets against heavily favored outcomes when public bias inflates prices
4. **Momentum**: Follows strong volume-backed price movements in high-activity markets
5. **Late Efficiency**: Exploits pricing inefficiencies in markets approaching expiry

Each strategy implements `selectCandidates()` and `shouldTrade()`. The pipeline evaluates all strategies and tags trades with the matching strategy name.

## Agent Pipeline

1. **Scanner**: Fetches active sports markets from Kalshi API, filters by sport/liquidity/time
2. **Analyst**: Uses Claude AI to evaluate each market, estimate true probability, calculate edge. Tracks token usage and costs in api_costs table. Respects daily/monthly budget caps.
3. **Auditor**: Hard-blocks any flagged trades (zero-flag pass only)
4. **Risk Manager**: Sizes positions using Quarter Kelly criterion, enforces max 8 simultaneous positions, 5% max position, 20% drawdown halt, 3-loss streak circuit breaker, correlation caps
5. **Executor**: Places limit orders on Kalshi (live mode) or logs to paper_trades table (paper mode). 3 retries; exhausted retries → "failed" status
6. **Reconciler**: Checks open trades against Kalshi API for settlement (skipped in paper mode)

## Paper Trading Mode

- Toggle via Settings page or `PUT /api/settings { paperTradingMode: true }`
- Uses simulated $5,000 balance (configurable)
- Trades logged to `paper_trades` table instead of real orders
- Pipeline sidebar shows "PAPER MODE" indicator
- Header shows "Paper Balance" instead of "Portfolio Balance"
- Reset via `POST /api/paper-trades/reset`

## API Cost Tracking

- Every Anthropic API call logs input/output tokens and cost to `api_costs` table
- Haiku pricing: $0.80/M input, $4.00/M output
- Budget caps: daily ($5 default) and monthly ($50 default) configurable in Settings
- When budget exceeded, analyst returns market-price defaults (no API call)
- Live cost dashboard in Settings page (today, this month, all time)

## Auth

- Same-origin validation: mutations from the dashboard are allowed automatically
- API_SECRET env var: optional, for programmatic access
- CORS locked to REPLIT_DEV_DOMAIN origin in dev
- Kalshi credentials: stored in DB settings (write-only)

## Background Operation

- Pipeline defaults to active (`pipelineActive: true`)
- On server boot, `rehydratePipeline()` checks DB settings and restarts automatically
- Pipeline runs via `setInterval`. First cycle immediate, then at configured interval (default: 60 min)
- All agent runs persisted to `agent_runs` table

## Key Configuration

- **Kalshi API**: KALSHI_API_KEY env secret (preferred) or dashboard Settings
- **AI**: Anthropic via Replit AI Integrations (no separate key needed)
- **Scan Interval**: Default 60 minutes (configurable)
- **Risk Defaults**: 5% max position, 0.25 Kelly, 20% drawdown, 8 max positions
- **API Budget**: $5/day, $50/month (configurable)
- **Paper Trading**: Off by default, $5,000 simulated balance

## Development Commands

- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/dashboard run dev` — Start frontend dev server
- `pnpm --filter @workspace/api-spec exec orval` — Regenerate API hooks/schemas
- `pnpm --filter @workspace/db run push` — Push schema changes to DB
- `pnpm run typecheck` — Full workspace typecheck

## Important Notes

- scanAndDiscover() runs Scanner→Analyst→Auditor only (no Risk/Executor/Reconciler)
- runTradingCycle() runs full 6-agent pipeline with strategy evaluation
- Edge values are already in percent units (e.g. 15 means 15%). Do not multiply by 100
- Win rate calculation excludes cancelled, pending, and failed trades
- Pipeline active state is read from overview.pipelineActive API field
- Backtest can run with simulated analysis (random noise) or real AI analysis (costs credits)
- CLV field on trades table tracks closing line value for trade quality assessment
