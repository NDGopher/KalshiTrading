# Kalshi Trading Dashboard

> **Last verified:** 2026-04-07

An autonomous AI-powered trading system for [Kalshi](https://kalshi.com) prediction markets. The system runs a continuous pipeline of specialized AI agents that scan markets, analyze opportunities using Claude AI, manage risk, and execute trades — all with a real-time dashboard for monitoring.

---

## What It Does

The system autonomously identifies and trades mispriced prediction market contracts on Kalshi. It scans hundreds of active markets (sports, politics, crypto, economics, weather, and more), runs each opportunity through a multi-agent pipeline powered by Claude Haiku, and places paper or live orders when the risk-adjusted edge is sufficient.

A self-learning feedback loop closes the loop: after enough trades settle, the Learner agent analyzes the trade history and injects empirical calibration data back into every future analyst prompt — so the system improves over time based on its own track record.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        React Dashboard (port $PORT)                  │
│  Live cycle view · Agent status · Trade log · P&L · Learnings       │
└───────────────────────────┬─────────────────────────────────────────┘
                            │ REST API
┌───────────────────────────▼─────────────────────────────────────────┐
│                     Express API Server (port $PORT)                  │
│                                                                      │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │  Scanner  │→ │  Analyst  │→ │  Auditor  │→ │  Risk Manager   │ │
│  └───────────┘  └───────────┘  └───────────┘  └────────┬─────────┘ │
│                                                          │           │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────────┐│           │
│  │  Learner  │← │Reconciler │← │       Executor       ││           │
│  └───────────┘  └───────────┘  └──────────────────────┘│           │
│                                          ▲               │           │
│                                          └───────────────┘           │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ Drizzle ORM
┌──────────────────────────────────▼──────────────────────────────────┐
│                         PostgreSQL Database                          │
│  trades · paper_trades · agent_learnings · agent_runs · api_costs   │
│  market_opportunities · historical_markets · trading_settings        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Agents

### 1. Scanner
**File:** `artifacts/api-server/src/lib/agents/scanner.ts`

Fetches all active markets from the Kalshi API and filters them to viable candidates using a composite score based on:
- Time to expiry (proximity bonus for imminent markets)
- 24h volume and liquidity depth
- Bid-ask spread quality
- Price dip/surge signals (from rolling snapshot history)
- Sharp book comparison (Pinnacle no-vig line vs Kalshi price)
- Category diversity injection (ensures non-sports markets get analyzed alongside sports)

Hard filters: YES price must be between 10¢ and 90¢, expiry must be ≥30 min and ≤30 days out, market must have minimum trading activity.

Falls back to a cached DB snapshot if the Kalshi API is rate-limited or returns an auth error.

### 2. Analyst
**File:** `artifacts/api-server/src/lib/agents/analyst.ts`

Sends the top 35 candidates to **Claude Haiku** for probability estimation. Each market gets a tailored prompt with:
- Category-specific guidance (sports, soccer, MLB totals, politics, crypto, economics)
- Live game scores for near-expiry sports markets
- Breaking news context (from the News Fetcher)
- Sport-specific pre-game intel (starting pitchers, goalie confirmations, injury reports)
- Price dip/surge detection with liquidity-flush vs informed-selling interpretation
- Sharp book comparison vs Pinnacle
- Empirical learnings from the Learner agent (injected as a calibration block)

Output: modelProbability, edge (model prob - market price), confidence, side (YES/NO), and reasoning.

### 3. Auditor
**File:** `artifacts/api-server/src/lib/agents/auditor.ts`

Rule-based filter applied after AI analysis. Checks:
- Minimum edge threshold (configurable, 3–5% default; relaxed in paper mode)
- Minimum liquidity ($100+ default, waived in paper mode)
- Minimum time to expiry (configurable)
- Confidence penalty: reduces effective confidence if auditor flags structural issues
- Approves or rejects each trade with a set of human-readable flags

### 4. Risk Manager
**File:** `artifacts/api-server/src/lib/agents/risk-manager.ts`

Position sizing and portfolio-level risk controls:
- **Kelly Criterion**: sizes positions using fractional Kelly (default 25% of full Kelly)
- **Hard cap**: never risk more than $30 per paper trade
- **Max position %**: configurable cap per trade as % of bankroll
- **Streak halt**: pauses trading after N consecutive losses (default: 3)
- **Drawdown halt**: pauses if portfolio drawdown exceeds threshold (default: 20%)
- **Position cap**: limits simultaneous open trades
- **Confidence ceiling**: hard blocks trades where AI confidence > 75% (empirically correlated with win-rate collapse above this level)
- **NO-side price cap**: blocks NO bets priced above 80¢ (math doesn't work above this level)
- **Per-game cap**: max 2 positions on the same game (prevents correlated spread stacking)
- **Reverse middle detection**: blocks YES bets on opposite outcomes of the same game
- **Streak gap reset**: forgives losing streaks older than 3 days (prevents permanent outage-induced blocks)

### 5. Executor
**File:** `artifacts/api-server/src/lib/agents/executor.ts`

Places approved trades either as:
- **Paper trades**: recorded in the `paper_trades` DB table with simulated balance tracking
- **Live orders**: submitted to Kalshi API as limit orders at the current ask price with retry logic (3 attempts, 2s backoff)

Deduplication: never opens a second paper position in the same ticker while one is already open.

### 6. Learner
**File:** `artifacts/api-server/src/lib/agents/learner.ts`

Runs every 10 pipeline cycles (or on demand). Reads all closed trades and computes performance slices across: category, edge bucket, confidence bucket, side, entry price range, and strategy. Sends the structured summary to Claude Haiku and receives back:
- An array of `LearningInsight` objects (dimension → finding → action → signal)
- An `analystInjection` text block that gets prepended to every future analyst prompt

Requires ≥10 closed trades to run.

### 7. Reconciler
**File:** `artifacts/api-server/src/lib/agents/reconciler.ts`

Polls open positions (paper or live) against Kalshi API to check if markets have resolved. Updates trade status to `won` or `lost`, computes P&L, and optionally calculates Closing Line Value (CLV).

---

## Trading Strategies

Each approved market is evaluated against a set of named strategies. A trade only proceeds if at least one strategy fires:

| Strategy | Description |
|---|---|
| **Pure Value** | AI model edge exceeds minimum threshold |
| **Sharp Money** | Sharp volume/liquidity ratio signals informed money flow |
| **Dip Buyer** | Price dip below rolling mean with liquidity-flush signature |
| **Momentum** | Price surge with rising volume (follow informed momentum) |
| **Late Efficiency** | Near-expiry markets where model has stronger signal than market |
| **Probability Arb** | Soccer 3-way markets where YES-sum exceeds 100% (sum-of-parts overpricing) |
| **Fade the Public** | Counter-trade public-biased markets in opposite direction |

---

## Dashboard Features

- **Real-time pipeline status**: active agent, cycle progress, last heartbeat
- **Agent health panel**: per-agent status, last run time, last result
- **Live cycle view**: all markets from the last scan with disposition (executed / skipped + reason)
- **Trade log**: full history of paper and live trades with P&L
- **Market opportunities**: current top opportunities by edge
- **Learner panel**: latest AI-generated insights, analyst injection block, learning history
- **Cost tracker**: per-agent API costs, daily/monthly spend vs budget
- **Settings**: configure all risk parameters, budget limits, strategies, paper vs live mode

---

## Paper vs Live Mode

Toggle in Settings. **Paper mode** (default):
- All trades are simulated in the `paper_trades` table
- Starts with a virtual $5,000 bankroll
- Full pipeline runs with real AI analysis — only execution is simulated
- Reconciler checks Kalshi for market resolution to score paper trades
- True bankroll computed from $5,000 + all settled net P&L (not the drifting `paper_balance` field)

**Live mode**:
- Real limit orders placed on Kalshi API
- Requires valid `KALSHI_API_KEY` set in settings
- Tracks real balance from Kalshi API

---

## Cost Tracking

Every Claude API call is logged to `api_costs` with:
- Provider, model, input/output tokens
- Cost in USD
- Calling agent and market ticker

Configurable daily and monthly budget caps. Pipeline pauses automatically when budget is exceeded.

**Typical cost**: ~$0.01–0.03 per full pipeline cycle (35 markets analyzed with Claude Haiku).

---

## Required Environment Variables

Set these as secrets (not in `.env` files committed to git):

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude (managed via Replit integration) |

Kalshi API credentials are stored in the `trading_settings` DB table (set via the dashboard Settings page), not in environment variables.

---

## How to Run Locally

### Prerequisites
- Node.js 20+
- pnpm 9+
- PostgreSQL database

### Setup

```bash
# Install dependencies
pnpm install

# Set up database
export DATABASE_URL="postgresql://user:pass@localhost:5432/kalshi"
pnpm --filter @workspace/db run db:push

# Start all services
pnpm --filter @workspace/api-server run dev   # API on $PORT
pnpm --filter @workspace/dashboard run dev    # UI on $PORT
```

### Project Structure

```
/
├── artifacts/
│   ├── api-server/          # Express API + all agents
│   └── dashboard/           # React + Vite dashboard
├── lib/
│   ├── db/                  # Drizzle schema + migrations
│   ├── api-spec/            # OpenAPI spec
│   ├── api-client-react/    # Generated React Query hooks
│   └── integrations-anthropic-ai/  # Anthropic client
└── pnpm-workspace.yaml
```

---

## Contributing

1. All agents are in `artifacts/api-server/src/lib/agents/`
2. DB schema lives in `lib/db/src/schema/`
3. After schema changes, run `pnpm --filter @workspace/db run db:push`
4. Dashboard components are in `artifacts/dashboard/src/`
5. The OpenAPI spec at `lib/api-spec/openapi.yaml` drives the React Query client generation

Do not commit `.env` files, API keys, or secrets. Use the Replit secrets manager or equivalent.
