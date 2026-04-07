# Pipeline Documentation

> **Last verified:** 2026-04-07

## The Autonomous Trading Cycle

The Kalshi Trading System runs a continuous autonomous pipeline. This document explains every step in detail — what triggers it, what decisions are made, what data flows between agents, and what thresholds gate each stage.

---

## Trigger

The pipeline runs on a configurable interval set in `trading_settings.scan_interval_minutes` (default: 60 minutes). The scheduler is initialized in `artifacts/api-server/src/index.ts` and managed in `pipeline.ts`:

```
setInterval(runTradingCycle, scanIntervalMinutes * 60 * 1000)
```

A **watchdog** timer checks every 10 minutes whether the interval is still firing. If not, it restarts the scheduler. This guards against silent failures.

The pipeline can also be triggered **on-demand** via the dashboard's "Run Now" button, which calls `POST /api/pipeline/run`.

**Concurrency guard**: If a cycle is already running when the interval fires, the new invocation returns immediately with `status: skipped`. Only one cycle runs at a time.

---

## Pre-flight: Budget Check

**Code:** `checkBudget()` in `analyst.ts`

Before any API calls, the system reads cumulative Claude API costs from the `api_costs` table:
- Daily spend vs `daily_budget_usd` (default: $5.00)
- Monthly spend vs `monthly_budget_usd` (default: $50.00)

If either limit is exceeded, the cycle is aborted with status `skipped`. This prevents runaway API costs if the pipeline runs more cycles than expected.

---

## Step 1: Pre-scan Reconcile

**Code:** `reconcilePaperTrades()` / `reconcileOpenTrades()` in `reconciler.ts`

Before sizing new positions, the system closes any already-resolved positions:
- Queries Kalshi API to check if open market tickers have settled
- Updates `paper_trades.status` to `won` or `lost`
- Computes P&L: `(exitPrice - entryPrice) * quantity` for YES; `(1 - exitPrice) * quantity - cost` for NO
- Optionally records Closing Line Value (CLV)

This is non-fatal — errors are swallowed so a Kalshi API hiccup doesn't block the cycle.

---

## Step 2: Scanner

**Code:** `scanMarkets()` in `scanner.ts`

### Market Fetch
Calls `getAllLiquidMarkets()` which hits `GET /markets` on the Kalshi API, fetching all active markets regardless of category.

### Hard Filters (applied per market)
| Filter | Threshold | Reason |
|---|---|---|
| YES price floor | ≥ 10¢ | Below this, market has already priced in outcome |
| YES price ceiling | ≤ 90¢ | Above this, market is near-certain, no information advantage |
| Min expiry | ≥ 30 minutes | Too close to expiry for meaningful analysis |
| Max expiry | ≤ 720 hours (30 days) | Beyond this, signal-to-noise is too low |
| Min activity | volume > 0 OR liquidity ≥ $50 | No price discovery signal in dead markets |

### Composite Scoring
Each surviving candidate is scored:
```
score = proximityScore(hoursToExpiry) * 3
      + min(volume24h / 10000, 1) * 1.5
      + min(liquidity / 50000, 1) * 0.5
      + spreadQuality * 0.5
      + dipBonus (0.8 if price dip/surge detected)
      + sharpBonus (1.5 if Pinnacle edge detected)
      + nonSportsBonus (2.5 if non-sports with volume > 100)
```

Proximity scores: ≤6h → 5.0, ≤24h → 4.0, ≤48h → 3.0, ≤96h → 2.0, ≤168h → 1.0, ≤336h → 0.5, ≤720h → 0.2.

### Category Diversity
To prevent sports markets from crowding out non-sports:
1. Take top-60 by composite score (naturally sports-heavy)
2. For each non-sports category (Politics, Economics, Financials, Entertainment, Weather, Crypto, Finance): inject up to 5 additional candidates from outside the top-60 that have `volume > 10` or `liquidity > 100`
3. Sort diversity extras by composite score
4. **Prepend diversity extras before the sports pool** so they survive the pipeline's top-35 analysis slice

### Enrichment
For the top 40 candidates:
- **Price history**: fetches last 24h of snapshots from `historical_markets`, detects dips (> 5% below rolling mean) and surges (> 5% above rolling mean), classifies as liquidity-flush vs informed-selling
- **Sharp book**: compares Kalshi YES price to Pinnacle's no-vig probability for the same event; if ≥3pp gap exists, flags the direction

### Sibling Leg Injection
For soccer/football multi-outcome markets (team A wins / draw / team B wins), the scanner injects missing "legs" from the DB cache so the Probability Arb strategy can compute the full YES-sum overpricing across all three outcomes.

### DB Cache Fallback
If Kalshi API returns a 429 (rate limit) or 401/403 (auth error), `scanFromCachedDb()` is called instead, using the most recent non-settled market snapshots from `historical_markets`. Cached data is marked `hasLiveData: false`, which prevents volume-sensitive strategies (Sharp Money, Late Efficiency) from firing on synthetic data.

**Output:** Up to 100 `ScanCandidate[]` sorted by composite score, plus `totalScanned` count.

---

## Step 3: Analyst

**Code:** `analyzeMarkets()` → `analyzeMarket()` in `analyst.ts`

### Candidate Selection
The pipeline takes the top 35 candidates from the Scanner output. 35 was chosen to allow a diverse category mix (sports + crypto + politics + weather) after diversity injection, while keeping Claude API costs manageable.

### Per-market Analysis
Each of the top 35 candidates gets an individual Claude Haiku call. The calls run concurrently (Promise.all).

### Prompt Construction
Each prompt includes (in order):
1. **Date context**: today's date to prevent stale reasoning
2. **Market metadata**: ticker, title, category, YES price, spread, volume, liquidity, hours to expiry
3. **Market signals**: implied probability, spread %, volume/liquidity ratio, time category, price region, market efficiency
4. **Category-specific guidance**: different analytical frameworks for Sports, Soccer (3-way structure), MLB (pitchers/parks/weather), Politics, Crypto, Economics, General
5. **Empirical learnings injection**: the most recent `analystInjection` from `agent_learnings` (calibration data from closed trades)
6. **Breaking news**: up to 3 relevant headlines from the News Fetcher
7. **Sports intel**: pre-game data if available (starting pitchers, goalie confirmations, injury reports)
8. **Live game score**: for sports markets with ≤4h to expiry, fetched from ESPN
9. **Price history signal**: dip/surge detection with interpretation guidance
10. **Sharp book comparison**: Pinnacle vs Kalshi price comparison if available

### AI Response Format
Claude Haiku is instructed to respond in JSON:
```json
{
  "modelProbability": 0.68,
  "edge": 13.5,
  "confidence": 0.72,
  "side": "yes",
  "reasoning": "..."
}
```

`edge = (modelProbability - marketPrice) * 100`. Positive edge = YES is underpriced; negative = NO is underpriced. The system flips to NO if edge is negative and absolute value exceeds threshold.

### Cost Logging
Every Claude call logs input tokens, output tokens, and USD cost to `api_costs`. Current model: `claude-haiku-4-5` at $0.25/M input, $0.80/M output.

**Output:** `AnalysisResult[]` — one per candidate, including model's probability estimate, computed edge, confidence, side, and reasoning.

---

## Step 4: Auditor

**Code:** `auditTrades()` in `auditor.ts`

Rule-based filter. For each `AnalysisResult`:

| Check | Default Threshold | Paper Mode Override |
|---|---|---|
| Minimum edge | `minEdge` (5%) | `max(3, minEdge - 2)` |
| Minimum liquidity | `minLiquidity` ($100) | 0 (waived) |
| Minimum time to expiry | `minTimeToExpiry` (10 min) | same |
| Confidence penalty | `confidencePenaltyPct` (8%) | applied if structural flags present |

Flags examples: "Near expiry", "Low volume", "Wide spread", "Low confidence".

`adjustedConfidence = confidence - (confidencePenaltyPct * flagCount / 100)`

**Output:** `AuditResult[]` with `approved: boolean`, `flags: string[]`, `adjustedConfidence`.

All candidates (approved and rejected) are written to `market_opportunities` table for dashboard display.

---

## Step 5: Strategy Matching

**Code:** `evaluateStrategies()` in `strategies/index.ts`

Before risk assessment, each audit-approved market is matched against the active strategy list from `trading_settings.enabled_strategies`. If no strategy fires, the trade is skipped (counted as `strategySkipped`).

Strategies:

| Strategy | Signal Requirements |
|---|---|
| Pure Value | Edge ≥ minEdge AND confidence ≥ 40% |
| Sharp Money | `hasLiveData: true` AND volume/liquidity ratio ≥ 1.4× baseline AND Pinnacle edge signal |
| Dip Buyer | `priceHistory.isDip = true` AND `isLiquidityFlush = true` |
| Momentum | `priceHistory.isSurge = true` AND rising volume trend |
| Late Efficiency | hoursToExpiry < 24 AND edge ≥ minEdge * 1.5 |
| Probability Arb | Soccer market AND sum of YES prices across all legs > 1.0 |
| Fade the Public | Market is a heavy public favorite (high volume, tight spread) but AI gives lower probability |

---

## Step 6: Pipeline-Level Pre-filters

Before calling Risk Manager, three hard caps are checked in pipeline.ts:

### Confidence Ceiling
```
CONFIDENCE_CEILING = 0.75
```
If `audit.adjustedConfidence > 0.75`, trade is skipped. Reason: empirical data shows win rate collapses above this level (80%+ confidence = 30% win rate). The market has already absorbed the "obvious" signal that Claude is pricing.

### NO-side Price Cap
```
NO_MAX_ENTRY_PRICE = 0.80
```
If `side === "no"` and `noAsk > 0.80`, trade is skipped. Reason: buying NO at 80¢ means only a 20¢ payout when right. You need >83% win rate just to break even — that's not achievable for most markets.

### Per-game Position Cap
```
MAX_POSITIONS_PER_GAME = 2
```
Extracts a "game key" from the ticker (e.g., `KXNBASPREAD-26MAR25DALDEN-DEN8` → `26MAR25DALDEN`). If the system already has 2+ open positions on the same game (from DB open trades + current cycle approvals), the new trade is skipped. Prevents correlated spread stacking where one game outcome resolves multiple bets the same way.

---

## Step 7: Risk Manager

**Code:** `assessRisk()` in `risk-manager.ts`

### Context Loading
- Loads recent trades (last `maxConsecutiveLosses + 5`) to count consecutive losses
- Loads all trades to compute total P&L and drawdown %
- Loads open trades to count simultaneous positions

### Streak Gap Reset
If the most recent settled trade is > 3 days old, consecutive losses are reset to 0. This prevents stale losing streaks (from server outages) from permanently blocking trading.

### Portfolio-level Checks
| Check | Default | Action on Trigger |
|---|---|---|
| Consecutive losses | 3 | Halt: reject all new trades |
| Drawdown % | 20% | Halt: reject all new trades |
| Simultaneous positions | 8 | Reject this trade only |
| Reverse middle | — | Reject: YES on opposite outcome of existing YES position |

### Position Sizing (Kelly Criterion)
```
p = modelProbability (adjusted for side)
b = (1 / marketPrice) - 1    // payout odds
fullKelly = (b*p - (1-p)) / b
quarterKelly = fullKelly * kellyFraction  // default: 0.25
```

Effective position size:
```
positionDollars = min(
  quarterKelly * bankroll,
  maxPositionPct/100 * bankroll,
  $30 hard cap
)
positionSize = floor(positionDollars / costPerContract)  // minimum 1 contract
```

**$30 hard cap rationale**: Kelly on a miscalibrated model can produce catastrophically large positions. $30 is enough to generate meaningful P&L signal while keeping drawdowns bounded until calibration is validated over 200+ closed trades.

### Bankroll Computation (Paper Mode)
True bankroll = `$5,000 + sum(paper_trades.pnl WHERE status IN ('won', 'lost'))`
This avoids the drift in `paper_balance` (executor deducts stake; reconciler credits net profit rather than full stake).

### Intra-cycle Accounting
Each approved position within a cycle reduces `effectiveBankroll` by `positionSize * entryPrice` before the next trade is assessed. Prevents over-committing capital within a single cycle.

**Output:** `RiskDecision[]` with `approved`, `positionSize`, `kellyFraction`, `riskScore`, `rejectReason`.

---

## Step 8: Executor

**Code:** `executeTrade()` in `executor.ts`

For each risk-approved decision:

**Paper mode:**
1. Check for existing open position in the same ticker (deduplicate)
2. Check sufficient paper balance
3. Insert into `paper_trades` with `status: 'open'`
4. Deduct cost from `trading_settings.paper_balance`

**Live mode:**
1. Insert into `trades` with `status: 'pending'`
2. Submit limit order to Kalshi API: `POST /portfolio/orders`
3. Order is placed at current ask price (YES ask for YES bets, NO ask for NO bets)
4. On success: update status to `'open'`, store `kalshi_order_id`
5. On failure: retry up to 3 times with 2s exponential backoff, then mark `'failed'`

---

## Step 9: Learner (every 10 cycles)

**Code:** `runLearner()` in `learner.ts`

Triggered when `pipelineCycleCount % LEARNER_CYCLE_INTERVAL === 0` (every 10 cycles).

**Requires ≥10 closed trades.** Returns `{skipped: true}` if insufficient data.

### Data Collection
Loads all closed trades from `paper_trades` (status: `won` or `lost`).

### Bucketing
Performance is sliced across 7 dimensions:
- **Category**: Sports / Crypto / Politics / Economics / Weather / Other (inferred from ticker prefix)
- **Edge bucket**: 0-5%, 5-10%, 10-20%, 20-30%, 30-50%, 50%+
- **Confidence bucket**: <30%, 30-40%, 40-50%, 50-60%, ≥60%
- **Side**: YES bets vs NO bets
- **Entry price range**: 0-15¢, 15-30¢, 30-50¢, 50-70¢, 70¢+
- **Time to expiry range**: imminent (<2h), near-term (<12h), medium (<48h), long-term
- **Strategy**: Pure Value, Sharp Money, Dip Buy, Momentum, etc.

### Synthesis
Structured performance summary sent to Claude Haiku with instructions to produce:
- `insights[]`: array of `{dimension, finding, action, signal, trades, winRate, avgPnl}` — only for buckets with ≥5 closed trades
- `analystInjection`: 300-word calibration block for the analyst prompt

### Injection
Written to `agent_learnings`. On the next cycle, `getLatestAnalystInjection()` retrieves this text and prepends it to every analyst prompt.

---

## Data Flow Summary

```
Kalshi API
    │
    ▼
Scanner (composite score, filters, enrichment)
    │ ScanCandidate[]
    ▼
Analyst (Claude AI, one call per candidate)
    │ AnalysisResult[]
    ▼
Auditor (rule-based edge/liquidity/time filters)
    │ AuditResult[]
    ▼
Strategy Matcher (Pure Value / Sharp Money / Dip Buyer / ...)
    │ filtered AuditResult[]
    ▼
Pipeline Pre-filters (confidence ceiling, NO price cap, game cap)
    │ filtered AuditResult[]
    ▼
Risk Manager (Kelly sizing, streak/drawdown checks, reverse middle)
    │ RiskDecision[]
    ▼
Executor (paper insert or live Kalshi order)
    │
    ▼
paper_trades / trades table
    │
    ▼ (async, next cycles)
Reconciler → Learner → analystInjection → next Analyst cycle
```

---

## Key Constants Reference

| Constant | Value | Location | Purpose |
|---|---|---|---|
| `CONFIDENCE_CEILING` | 0.75 | `pipeline.ts` | Hard block for high-confidence trades |
| `NO_MAX_ENTRY_PRICE` | 0.80 | `pipeline.ts` | Hard block for expensive NO bets |
| `MAX_POSITIONS_PER_GAME` | 2 | `pipeline.ts` | Correlated spread stacking limit |
| `LEARNER_CYCLE_INTERVAL` | 10 | `pipeline.ts` | Cycles between learner runs |
| `STREAK_GAP_RESET_MS` | 3 days | `risk-manager.ts` | Forgives stale losing streaks |
| `HARD_MAX_TRADE_DOLLARS` | $30 | `risk-manager.ts` | Per-trade position size hard cap |
| `MAX_HOURS_TO_EXPIRY` | 720 (30 days) | `scanner.ts` | Maximum market age |
| `TOP_CANDIDATES_FOR_ANALYSIS` | 35 | `pipeline.ts` | Markets sent to analyst per cycle |
| `DIVERSITY_SLOTS_PER_CAT` | 5 | `scanner.ts` | Non-sports slots per category |
| Default `kellyFraction` | 0.25 | `trading_settings` | Quarter-Kelly default |
| Default `maxConsecutiveLosses` | 3 | `trading_settings` | Streak halt threshold |
| Default `maxDrawdownPct` | 20% | `trading_settings` | Drawdown halt threshold |
| Default `dailyBudgetUsd` | $5 | `trading_settings` | Daily Claude API cap |
| Default `monthlyBudgetUsd` | $50 | `trading_settings` | Monthly Claude API cap |
