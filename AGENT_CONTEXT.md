# Agent Context — Kalshi Trading Dashboard

> **For AI assistants (Cursor, Open WebUI, Claude Projects, etc.)**
> Read this before touching any code. It is the authoritative project brief.
>
> **Last verified:** 2026-04-07

---

## Mission

Build and improve an autonomous prediction market trading system that:
1. Finds genuinely mispriced contracts on [Kalshi](https://kalshi.com)
2. Sizes positions correctly using Kelly Criterion
3. Learns from its own trade history to improve over time
4. Never loses more than a defined drawdown threshold

The system currently runs in paper mode ($5,000 virtual bankroll). It has produced 276+ closed trades with a 55% win rate and $147 net P&L. The Learner has identified key patterns: high-confidence (≥60%) trades win 70%, Sharp Money signals win 75%, while toss-up markets (30–50¢ entry) win only 42%.

---

## Repository Structure

```
artifacts/
  api-server/
    src/
      index.ts                    ← Express server entry, pipeline scheduler
      lib/
        agents/
          pipeline.ts             ← MAIN: orchestrates the full cycle
          scanner.ts              ← Fetches & scores Kalshi markets
          analyst.ts              ← Claude AI probability estimation
          auditor.ts              ← Rule-based trade filter
          risk-manager.ts         ← Kelly sizing + portfolio guardrails
          executor.ts             ← Paper/live order placement
          learner.ts              ← Self-learning feedback loop
          reconciler.ts           ← Closes resolved positions
          news-fetcher.ts         ← Background news ingestion
        strategies/
          index.ts                ← Strategy matching (Pure Value, Sharp Money, etc.)
        kalshi-client.ts          ← Kalshi REST API wrapper
        price-history.ts          ← Dip/surge detection from snapshots
        sharp-odds.ts             ← Pinnacle no-vig line comparison
        live-scores.ts            ← ESPN live game score fetcher
        sports-intel.ts           ← Pre-game intel (pitchers, injuries, goalies)
  dashboard/
    src/
      pages/                      ← React pages (Brain, Trades, Learner, Settings, etc.)
      components/                 ← Reusable UI components

lib/
  db/
    src/schema/                   ← Drizzle ORM schema definitions
      trades.ts                   ← Live trades table
      paper-trades.ts             ← Paper trades table
      agent-learnings.ts          ← Learner output + insights
      agent-runs.ts               ← Per-agent execution log
      api-costs.ts                ← Claude API cost tracking
      trading-settings.ts         ← User-configurable parameters
      historical-markets.ts       ← Market snapshot cache
      market-opportunities.ts     ← Current cycle opportunities
  api-spec/
    openapi.yaml                  ← REST API contract
  api-client-react/               ← Auto-generated React Query hooks
  integrations-anthropic-ai/      ← Anthropic client (Replit-managed key)
```

---

## Full Trading Pipeline

### Trigger
The pipeline runs on a configurable interval (default: 60 minutes). It can also be triggered manually via the dashboard. A watchdog restarts the interval if it dies.

### Step 1: Budget Check
Before doing anything, `checkBudget()` reads daily and monthly API spend from `api_costs`. If either limit is exceeded, the pipeline skips the cycle entirely.

### Step 2: Pre-scan Reconcile
Calls `reconcilePaperTrades()` (or `reconcileOpenTrades()` in live mode) to close any positions that resolved since the last cycle. This ensures the bankroll is accurate before sizing new positions.

### Step 3: Scanner
`scanMarkets()` calls the Kalshi API for all active markets. Each market is passed through `buildCandidateFromKalshi()`:
- Hard filters: 10¢ < YES price < 90¢, 30min < expiry < 30 days, min activity
- Composite scoring: `proximityScore + volNorm + liqNorm + spreadQuality + dipBonus + sharpBonus + nonSportsBonus`
- Category diversity: top-60 sports by composite score, then up to 5 slots per non-sports category
- Non-sports extras prepended to the list so they survive the pipeline's top-35 slice
- Enriched with price history (dip/surge detection) and Pinnacle sharp line comparison

If the Kalshi API fails (429/401), falls back to `scanFromCachedDb()` using the `historical_markets` table.

### Step 4: Analyst
`analyzeMarkets()` sends top 35 candidates to Claude Haiku (one call per market, concurrent). Each prompt includes:
- Market metadata (ticker, price, spread, volume, expiry)
- Category-specific analysis guidance (soccer 3-way structure, MLB pitching hierarchy, etc.)
- Price dip/surge signal with interpretation framework
- Sharp book comparison vs Pinnacle no-vig line
- Live game score (for near-expiry sports, ≤4h to expiry)
- Breaking news headlines
- Sport-specific pre-game intel
- Empirical learnings injection from the Learner (calibration block)

Claude returns: `modelProbability`, `edge`, `confidence`, `side` (yes/no), `reasoning`.

API costs logged to `api_costs` table.

### Step 5: Auditor
`auditTrades()` applies rule-based filters:
- `minEdge`: computed edge must exceed this (paper mode: `max(3, minEdge - 2)`)
- `minLiquidity`: liquidity depth check (waived in paper mode)
- `minTimeToExpiry`: minutes remaining
- `confidencePenaltyPct`: reduces confidence by N% for structural flags

### Step 6: Risk Manager
For each audit-approved market, `assessRisk()`:
1. Loads recent trades to count consecutive losses and compute drawdown
2. Checks streak-gap reset (forgives stale losing streaks > 3 days old)
3. Detects reverse middles (YES on opposite outcomes in same game)
4. Computes full Kelly, applies `kellyFraction` (default 0.25 = quarter Kelly)
5. Caps at `maxPositionPct * bankroll` and hard cap $30 per trade
6. Returns `approved`, `positionSize`, `kellyFraction`, `riskScore`

**Pipeline-level pre-filters** applied before assessRisk:
- `CONFIDENCE_CEILING = 0.75`: blocks if AI confidence > 75%
- `NO_MAX_ENTRY_PRICE = 0.80`: blocks NO bets priced above 80¢
- `MAX_POSITIONS_PER_GAME = 2`: prevents correlated spread stacking

### Step 7: Executor
`executeTrade()` either:
- **Paper**: inserts into `paper_trades`, deducts from `paper_balance` in settings
- **Live**: places limit order on Kalshi API (3 retries, 2s backoff), stores order ID

### Step 8: Learner (every 10 cycles)
`runLearner()`:
1. Loads all closed trades from `paper_trades`
2. Buckets by: category, edge, confidence, side, entry price, strategy
3. Sends structured summary to Claude Haiku for synthesis
4. Writes `LearningInsight[]` + `analystInjection` text to `agent_learnings`
5. Next analyst cycle reads the latest injection via `getLatestAnalystInjection()`

---

## Database Schema

| Table | Purpose |
|---|---|
| `trades` | Live Kalshi orders (status: pending/open/won/lost/failed) |
| `paper_trades` | Simulated trades (status: open/won/lost) |
| `agent_learnings` | Learner output: insights + analystInjection + rawAnalysis |
| `agent_runs` | Per-agent execution log (name, status, duration, details) |
| `api_costs` | Claude API usage (tokens, cost, agent, market) |
| `trading_settings` | User config (risk params, budget, strategies, mode) |
| `historical_markets` | Market snapshots for DB fallback and price history |
| `market_opportunities` | Refreshed each cycle with audited candidates |

### Key fields in `paper_trades`
- `status`: `open` → `won` or `lost` (set by reconciler)
- `pnl`: null until settled; positive = won, negative = lost
- `strategyName`: which strategy fired for this trade
- `edge`, `confidence`, `modelProbability`: Analyst outputs
- `kellyFraction`, `riskScore`: Risk Manager outputs

### Key fields in `agent_learnings`
- `insights`: JSON array of `LearningInsight` (dimension, finding, action, signal, trades, winRate, avgPnl)
- `analystInjection`: text injected into every analyst prompt after generation
- `rawAnalysis`: plain-text performance breakdown used to generate insights

---

## Known Issues and Guardrails

### Confidence Ceiling (75%)
Empirical data: win rate collapses above 75% AI confidence. At 80%+, win rate drops to ~30%. The market has already priced in what Claude considers "obvious". Hard blocked in pipeline.ts.

### High Edge Miscalibration
Trades with model-claimed edge of 20–30% have only 17% win rate. The model is overconfident at high edges. The Learner now injects this into analyst prompts.

### NO-side Price Cap (80¢)
Buying NO above 80¢ requires >83% win rate to break even. Empirically, these bets had 100% win rate but nearly zero profit because losses wiped multiple wins. Hard blocked.

### Correlated Spread Stacking
Example: 7 bets on the same game at different spread lines where one game outcome resolves all of them the same way. Fixed with `MAX_POSITIONS_PER_GAME = 2` and `extractGameKey()`.

### Reverse Middle Detection
YES on two opposite outcomes of the same game (mutually exclusive) was occasionally getting through. Fixed in risk-manager.ts with `isReverseMiddle()`.

### Streak Gap Reset
A 3-consecutive-loss streak older than 3 days was permanently blocking trading after server restarts/outages. Fixed: streaks are forgiven if the most recent settled trade is > 3 days old.

### Paper Balance Drift
The `paper_balance` field in settings drifts because the executor deducts stake but the reconciler credits net profit rather than full stake recovery. True bankroll is computed in pipeline.ts as: `$5,000 + sum(settled PnL)`.

### Sports Over-dominance
95% of trades were sports because Kalshi has more sports markets. Non-sports (politics, crypto, economics) had 69% win rate vs 54% for sports. Fixed with diversity injection in scanner.ts.

---

## Improvement Opportunities

### High Priority
1. **Local LLM swap**: Replace Claude Haiku with a locally-hosted model (Ollama + Llama 3 or Mistral) to eliminate API costs entirely. The analyst.ts interface is clean — swap the `anthropic.messages.create()` call.
2. **Scan frequency tuning**: 60-minute interval may miss fast-moving markets. Consider 15–30 min for sports-heavy periods, longer for non-sports.
3. **Yes-side confidence calibration**: YES bets have 28% win rate historically but +$9.76 avg P&L when right. Need better signal filter before enabling YES bets more broadly.

### Medium Priority
4. **Prompt optimization**: The analyst prompt is long and expensive. Profile which sections add the most predictive value, prune the rest.
5. **Multi-model ensemble**: Run the same market through two different models, take the consensus probability, reduce single-model overconfidence.
6. **Live CLV tracking**: Closing Line Value measures how much better/worse our entry price was vs the final market price. Currently computed but not surfaced in the dashboard.
7. **Sports intel expansion**: Currently fetches starting pitchers (MLB) and goalie confirmations (NHL). Add NFL injury reports and NBA injury/rest data.

### Low Priority
8. **Strategy backtesting**: Add an offline backtest mode that replays historical markets through the full pipeline without placing trades.
9. **Alert system**: Webhook/email alerts when trades execute, pipeline stops, or drawdown threshold is approached.
10. **Multi-account support**: Support multiple Kalshi API keys with separate portfolios.

---

## Key Files to Edit for Each Area

| Area | File(s) |
|---|---|
| Scan logic, market filtering | `artifacts/api-server/src/lib/agents/scanner.ts` |
| AI analysis prompt, category guidance | `artifacts/api-server/src/lib/agents/analyst.ts` |
| Risk guardrails, Kelly sizing | `artifacts/api-server/src/lib/agents/risk-manager.ts` |
| Pipeline flow, ceiling constants | `artifacts/api-server/src/lib/agents/pipeline.ts` |
| Trade execution | `artifacts/api-server/src/lib/agents/executor.ts` |
| Self-learning, insight generation | `artifacts/api-server/src/lib/agents/learner.ts` |
| Strategy definitions | `artifacts/api-server/src/lib/strategies/index.ts` |
| DB schema | `lib/db/src/schema/*.ts` |
| API routes | `artifacts/api-server/src/index.ts` |
| Dashboard pages | `artifacts/dashboard/src/pages/` |
| Sharp odds comparison | `artifacts/api-server/src/lib/sharp-odds.ts` |
| Price history / dip detection | `artifacts/api-server/src/lib/price-history.ts` |
| Live scores | `artifacts/api-server/src/lib/live-scores.ts` |
| Pre-game sports intel | `artifacts/api-server/src/lib/sports-intel.ts` |

---

## Tech Stack

- **Runtime**: Node.js 20, TypeScript (ESM)
- **Monorepo**: pnpm workspaces
- **Backend**: Express.js
- **ORM**: Drizzle ORM
- **DB**: PostgreSQL (Replit-managed)
- **AI**: Anthropic Claude Haiku (via Replit AI integration)
- **Frontend**: React 18 + Vite + TanStack Query + shadcn/ui + Tailwind CSS
- **API contract**: OpenAPI 3.0 (generates React Query hooks via `openapi-typescript-codegen`)
