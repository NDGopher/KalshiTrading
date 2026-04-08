import { anthropic } from "@workspace/integrations-anthropic-ai";
import { db, apiCostsTable, tradingSettingsTable } from "@workspace/db";
import { sql, gte } from "drizzle-orm";
import type { ScanCandidate } from "./scanner.js";
import { getRelevantNews } from "./news-fetcher.js";
import { fetchLiveScore } from "../live-scores.js";
import { fetchSportsIntel } from "../sports-intel.js";
import { getLatestAnalystInjection } from "./learner.js";

export interface AnalysisResult {
  candidate: ScanCandidate;
  modelProbability: number;
  edge: number;
  confidence: number;
  side: "yes" | "no";
  reasoning: string;
}

function deterministicHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const HAIKU_INPUT_COST_PER_M = 0.25;
const HAIKU_OUTPUT_COST_PER_M = 0.80;

export { checkBudget };

async function checkBudget(): Promise<{ allowed: boolean; reason?: string }> {
  const [settings] = await db.select().from(tradingSettingsTable).limit(1);
  if (!settings) return { allowed: true };

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [dailyResult] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
    .from(apiCostsTable)
    .where(gte(apiCostsTable.createdAt, startOfDay));
  const dailySpend = Number(dailyResult?.total || 0);

  const [monthlyResult] = await db
    .select({ total: sql<number>`coalesce(sum(${apiCostsTable.costUsd}), 0)` })
    .from(apiCostsTable)
    .where(gte(apiCostsTable.createdAt, startOfMonth));
  const monthlySpend = Number(monthlyResult?.total || 0);

  if (settings.dailyBudgetUsd > 0 && dailySpend >= settings.dailyBudgetUsd) {
    return { allowed: false, reason: `Daily API budget exceeded: $${dailySpend.toFixed(2)} / $${settings.dailyBudgetUsd}` };
  }
  if (settings.monthlyBudgetUsd > 0 && monthlySpend >= settings.monthlyBudgetUsd) {
    return { allowed: false, reason: `Monthly API budget exceeded: $${monthlySpend.toFixed(2)} / $${settings.monthlyBudgetUsd}` };
  }

  return { allowed: true };
}

async function logApiCost(model: string, inputTokens: number, outputTokens: number, agentName: string, marketTicker?: string): Promise<void> {
  const costUsd = (inputTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M + (outputTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
  await db.insert(apiCostsTable).values({
    provider: "anthropic",
    model,
    inputTokens,
    outputTokens,
    costUsd,
    agentName,
    marketTicker,
  });
}

function deriveMarketSignals(candidate: ScanCandidate) {
  const { yesPrice, volume24h, liquidity, hoursToExpiry, spread } = candidate;
  const impliedProb = yesPrice * 100;
  const spreadPct = yesPrice > 0 ? (spread / yesPrice) * 100 : 0;
  const volumeToLiquidity = liquidity > 0 ? volume24h / liquidity : 0;
  const isHighVolume = volume24h > 500;
  const isNarrowSpread = spreadPct < 5;
  const timeCategory =
    hoursToExpiry < 2 ? "imminent" :
    hoursToExpiry < 12 ? "near-term" :
    hoursToExpiry < 48 ? "medium-term" : "long-term";
  const priceRegion =
    impliedProb < 20 ? "heavy-underdog" :
    impliedProb < 40 ? "underdog" :
    impliedProb < 60 ? "toss-up" :
    impliedProb < 80 ? "favorite" : "heavy-favorite";
  const marketEfficiency =
    isHighVolume && isNarrowSpread ? "high" :
    isHighVolume || isNarrowSpread ? "medium" : "low";

  // Open price comparison for drift analysis
  const rawOpenPrice = (candidate.market as unknown as Record<string, number>).open_price;
  const openPrice = rawOpenPrice != null && rawOpenPrice > 0 ? rawOpenPrice / 100 : null;
  const priceChange = openPrice != null ? ((yesPrice - openPrice) / openPrice) * 100 : null;

  return { impliedProb, spreadPct, volumeToLiquidity, timeCategory, priceRegion, marketEfficiency, openPrice, priceChange };
}

/**
 * Returns true if the market is a soccer/football match — which uses a 3-way
 * outcome structure (win / draw / loss) rather than a binary market.
 */
function isMLBMarket(candidate: ScanCandidate): boolean {
  const ticker = candidate.market.ticker.toUpperCase();
  const title = (candidate.market.title || "").toLowerCase();
  return (
    ticker.startsWith("KXMLB") ||
    !!title.match(/\b(mlb|baseball|yankees|red sox|dodgers|giants|cubs|mets|braves|astros|phillies|padres|rangers|mariners|tigers|cardinals|brewers|reds|pirates|rockies|diamondbacks|angels|athletics|white sox|blue jays|rays|orioles|nationals|marlins|twins|royals)\b/)
  );
}

function getMLBMarketType(candidate: ScanCandidate): "total" | "spread" | "moneyline" {
  const ticker = candidate.market.ticker.toUpperCase();
  const title = (candidate.market.title || "").toLowerCase();
  if (ticker.includes("TOTAL") || title.includes("over") || title.includes("under") || title.includes("runs scored")) return "total";
  if (ticker.includes("SPREAD") || title.includes("run line") || title.includes("-1.5") || title.includes("+1.5")) return "spread";
  return "moneyline";
}

function isSoccerMarket(candidate: ScanCandidate): boolean {
  const ticker = candidate.market.ticker.toUpperCase();
  const cat = (candidate.market.category || "").toLowerCase();
  const title = (candidate.market.title || "").toLowerCase();
  return (
    ticker.startsWith("KXSERIEA") ||
    ticker.startsWith("KXLALIGA") ||
    ticker.startsWith("KXUECL") ||
    ticker.startsWith("KXCHAMPIONS") ||
    ticker.startsWith("KXNWSL") ||
    ticker.startsWith("KXEPL") ||
    ticker.startsWith("KXMLS") ||
    ticker.startsWith("KXBUNDES") ||
    ticker.startsWith("KXLIGUE") ||
    ticker.startsWith("KXWCUP") ||
    ticker.startsWith("KXEURO") ||
    ticker.startsWith("KXCOPA") ||
    ticker.startsWith("KXUCL") ||
    cat.includes("soccer") ||
    cat.includes("football") ||
    !!title.match(/\b(serie a|la liga|premier league|bundesliga|ligue 1|mls|champions league|europa league|world cup|euros|copa america|ucl|epl|nwsl)\b/)
  );
}

/**
 * Detect market category for tailored AI analysis.
 */
function detectCategory(candidate: ScanCandidate): string {
  const rawCat = (candidate.market.category || "").toLowerCase();
  const ticker = candidate.market.ticker.toLowerCase();
  const title = (candidate.market.title || "").toLowerCase();

  if (rawCat.includes("sport") || ticker.startsWith("kxnfl") || ticker.startsWith("kxnba") ||
      ticker.startsWith("kxmlb") || ticker.startsWith("kxnhl") || ticker.startsWith("kxsoc") ||
      ticker.startsWith("kxufc") || title.match(/\b(nfl|nba|mlb|nhl|ufc|soccer|football|basketball|baseball|hockey|tennis|golf)\b/)) {
    return "Sports";
  }
  if (rawCat.includes("polit") || rawCat.includes("elect") || ticker.includes("pres") ||
      ticker.includes("senate") || ticker.includes("congress") || ticker.includes("gop") || ticker.includes("dem") ||
      title.match(/\b(president|election|senate|house|congress|democrat|republican|trump|biden|harris|vote)\b/)) {
    return "Politics";
  }
  if (rawCat.includes("crypto") || rawCat.includes("bitcoin") || ticker.includes("btc") ||
      ticker.includes("eth") || ticker.includes("crypto") || title.match(/\b(bitcoin|ethereum|crypto|btc|eth|solana|xrp)\b/)) {
    return "Crypto";
  }
  if (rawCat.includes("econ") || rawCat.includes("financ") || rawCat.includes("market") ||
      title.match(/\b(gdp|inflation|cpi|fed|interest rate|unemployment|recession|sp500|nasdaq|dow)\b/)) {
    return "Economics";
  }
  if (rawCat.includes("weather") || title.match(/\b(hurricane|temperature|rain|storm|earthquake|weather)\b/)) {
    return "Weather";
  }
  if (rawCat.includes("entertain") || rawCat.includes("pop") ||
      title.match(/\b(oscars|grammy|emmy|award|box office|movie|album|chart)\b/)) {
    return "Entertainment";
  }
  return rawCat || "General";
}

/**
 * Category-specific reasoning guidance for the AI.
 */
function getCategoryGuidance(category: string, signals: ReturnType<typeof deriveMarketSignals>, soccer = false, mlb = false, mlbType: "total" | "spread" | "moneyline" = "moneyline"): string {
  switch (category) {
    case "Sports":
      if (mlb) {
        if (mlbType === "total") {
          return `⚾ MLB TOTALS — STARTING PITCHERS ARE THE #1 FACTOR. Without knowing tonight's pitching matchup you cannot analyze this market.

ANALYSIS HIERARCHY FOR MLB OVER/UNDER:
1. **Starting Pitchers** (50% of your estimate):
   - Identify the probable starters from the market title or ticker if possible.
   - Ace starters (sub-3.00 ERA, 200+ innings) suppress scoring by 1-2 runs vs average.
   - High walk rate (BB/9 > 4) pitchers allow more traffic and elevate scoring.
   - Short-rest (3 days) starters have ~0.5+ ERA inflation and shorter outings.
   - If pitcher info is not available in the title, acknowledge the uncertainty and widen your confidence interval.

2. **Ballpark Run Factor** (20% of your estimate):
   - Extreme parks: Coors Field (Colorado Rockies home) adds ~2-3 runs — treat any Coors game as HIGH-scoring.
   - Pitcher-friendly parks: Petco Park (San Diego), Oracle Park (SF Giants), Tropicana Field — subtract 0.5-1 run.
   - The Giants play at Oracle Park (San Francisco) — a notoriously pitcher-friendly park due to marine layer and cold air.
   - Neutral/average parks: Fenway, Wrigley (when wind is calm), Yankee Stadium.

3. **Weather** (15% of your estimate):
   - Wind blowing OUT (e.g., 15+ mph to centerfield) at open stadiums: add 0.5-1.5 runs to expectation.
   - Wind blowing IN: subtract 0.5-1 run. Cold temperatures (<50°F) deaden the ball — subtract 0.5 runs.
   - Dome/retractable-roof stadiums: weather-neutral.

4. **Market Structure** (15%):
   - Volume/Liquidity ratio: ${signals.volumeToLiquidity.toFixed(2)} — sharp books set totals lines with high accuracy.
   - The over/under total line in the title tells you the market-implied combined run expectation.
   - MLB totals markets are HIGHLY efficient. You need a clear factor (ace pitcher, extreme weather, Coors) to deviate from the market.

BASE RATES:
- Average MLB game: 8.5-9.5 combined runs
- With two aces: 6.5-8.0 runs
- Coors Field: 11-14 runs
- Cold weather outdoor game (<45°F): subtract 1-1.5 runs

COMMON MISTAKES TO AVOID:
- Do NOT call any MLB game "spring training" unless the title explicitly says so. The Kalshi MLB series (KXMLB) tracks REGULAR SEASON games.
- Do NOT assume teams play differently in April vs July — starting pitchers are more reliable than "early season" narratives.`;
        }
        if (mlbType === "spread") {
          return `⚾ MLB RUN LINE (±1.5 RUNS) — Key structural insight: covering a -1.5 spread requires winning by 2+ runs, which happens in only ~55% of games for heavy favorites. A team can be a -200 moneyline favorite and still lose the run line.

ANALYSIS HIERARCHY:
1. **Starting Pitcher Quality**: Same ace analysis as totals. A dominant ace makes covering -1.5 much more likely.
2. **Blowout Potential**: Teams with high-power offenses vs weak starters have higher cover rates.
3. **Bullpen**: Late runs matter for run line. A shaky bullpen on the leading team can blow a +2 lead.
4. **Market Price**: ${signals.impliedProb.toFixed(0)}% implied probability. Run line favorites above 70% are near-certain covers on paper but still fail ~30% of the time in baseball.
5. **Do NOT call this spring training** unless the title says so — KXMLB series = regular season.`;
        }
        return `⚾ MLB MONEYLINE — Binary win/lose, no spread.

ANALYSIS HIERARCHY:
1. **Starting Pitchers**: The single most important factor. A Cy Young-caliber ace vs a #4/5 starter shifts win probability by 15-20pp.
2. **Home Field**: MLB home teams win ~54% — modest but consistent advantage.
3. **Recent Bullpen Usage**: A team using 3-4 relievers last night has a tired bullpen tonight.
4. **Market Efficiency**: MLB moneylines are among the most efficient in sports — look for ace-vs-replacement matchups or weather extremes as the primary edge sources.
5. **Do NOT call this spring training** unless the title explicitly says so. KXMLB = regular season.`;
      }
      if (soccer) {
        return `⚽ SOCCER / FOOTBALL — CRITICAL: This is a 3-way market (Win / Draw / Loss).

MARKET STRUCTURE:
- YES pays $1 if the specific condition in the title is TRUE (e.g., one team wins outright).
- NO pays $1 if FALSE — which includes BOTH a draw AND the other team winning.
- A YES price of 10% does NOT mean the other team wins with 90% probability. That 90% is split across draw + other team win.
- Example: "Will Sassuolo beat Juventus?" YES=Sassuolo wins. NO=draw (≈25-30%) + Juventus wins (≈60-70%).

BASE RATES (top European leagues):
- Strong favorite to win outright: 55-65% | Draw: 20-25% | Underdog outright: 15-25%
- Medium favorite: 45-55% | Draw: 25-30% | Other: 20-30%
- True toss-up: ~35% each outcome

Apply these lenses:
0. **YES-Team First**: Identify exactly which team/outcome is on the YES side from the title. State it before analyzing.
1. **3-Way Probability**: Estimate P(YES team wins outright), P(draw), P(other team wins). They must sum to 100%. Your output is P(YES outright win).
2. **Matchup & Form**: Recent league form (last 5 games), head-to-head record, home/away advantage (home teams win ~45% in top leagues), injuries, fatigue.
3. **Market Microstructure**: ${signals.volumeToLiquidity.toFixed(2)} volume/liquidity ratio. Sharp money in soccer markets often reflects team news (lineup leaks, injury updates).
4. **Line Movement**: ${signals.priceChange != null ? `Price moved ${signals.priceChange > 0 ? "up" : "down"} ${Math.abs(signals.priceChange).toFixed(1)}% from open.` : "No open price drift data."}`;
      }
      return `Apply these sports-specific lenses:
0. **YES-Team First**: Before any analysis, re-read the title and identify which team/outcome is on the YES side. Your probability must reflect P(that specific team/outcome succeeds). A strong team on the NO side means a LOW probability, not a high one.
1. **Matchup & Form**: Consider recent team/player performance, head-to-head history, home/away advantage, injury reports, and travel fatigue.
2. **Market Microstructure**: High volume/liquidity ratio (${signals.volumeToLiquidity.toFixed(2)}) can signal sharp money. Pre-game betting patterns often reflect insider knowledge.
3. **Public Bias**: Public bettors overvalue favorites, popular teams, and overs. Fade the public when volume doesn't support the price.
4. **Line Movement**: ${signals.priceChange != null ? `Price has moved ${signals.priceChange > 0 ? "up" : "down"} ${Math.abs(signals.priceChange).toFixed(1)}% from open — this reflects market opinion updating.` : "No open price available for drift comparison."}`;

    case "Politics":
      return `Apply these political market lenses:
1. **Polling Accuracy**: Historical polling errors favor incumbents or the candidate currently trending. Base rates matter — consider state-level electoral history.
2. **Media & Narrative**: Breaking news, endorsements, and debate performance can shift markets temporarily but markets often overcorrect.
3. **Timing**: ${signals.timeCategory === "imminent" ? "Imminent resolution — strong weight on the most recent data." : "Still time for events to shift — weight current polls but discount single data points."}
4. **Market Efficiency**: Political prediction markets are often informationally efficient — look for cases where the news cycle hasn't caught up yet.`;

    case "Crypto":
      return `Apply these crypto market lenses:
1. **On-Chain Signals**: Large wallet movements and exchange flows often precede price moves. High volume in the prediction market may reflect on-chain activity.
2. **Macro Context**: Interest rates, risk appetite, and regulatory news move all crypto. If macro is risk-off, crypto resolves are harder.
3. **Price Momentum**: Crypto tends to trend. A market at ${signals.impliedProb.toFixed(0)}% implied probability — assess whether current spot price momentum supports this.
4. **Volatility**: Crypto events often resolve at extremes. Widen your confidence interval accordingly.`;

    case "Economics":
      return `Apply these economic indicator lenses:
1. **Data Revisions**: Economic data is frequently revised. Consider whether the initial release or revised figure matters for settlement.
2. **Consensus vs. Surprise**: Markets price in consensus expectations. A ${signals.priceRegion} market may already reflect a large expected surprise — assess if the base case is fully priced.
3. **Fed Reaction Function**: Economic releases are interpreted through the lens of Fed policy. A strong print may be bad if it delays rate cuts.
4. **Leading vs. Lagging**: GDP and unemployment are lagging. PMI and jobless claims are leading. Weight accordingly.`;

    default:
      return `Apply these general prediction market lenses:
1. **Base Rates**: What percentage of similar events historically resolve YES? Use this as your anchor.
2. **Recent Evidence**: What new information in the last 48 hours is most relevant to resolution?
3. **Market Sentiment**: The ${signals.priceRegion} pricing (${signals.impliedProb.toFixed(0)}% implied) — is this well-calibrated given the evidence?
4. **Resolution Criteria**: Consider edge cases in how this market could resolve that participants may have overlooked.`;
  }
}

export async function analyzeMarket(candidate: ScanCandidate): Promise<AnalysisResult> {
  const budgetCheck = await checkBudget();
  if (!budgetCheck.allowed) {
    console.warn(`[Analyst] ${budgetCheck.reason}`);
    return createDefaultResult(candidate);
  }

  const { market, yesPrice, volume24h, liquidity, hoursToExpiry, spread } = candidate;
  const signals = deriveMarketSignals(candidate);
  const category = detectCategory(candidate);
  const soccer = isSoccerMarket(candidate);
  const mlb = isMLBMarket(candidate);
  const mlbType = mlb ? getMLBMarketType(candidate) : "moneyline";
  const categoryGuidance = getCategoryGuidance(category, signals, soccer, mlb, mlbType);
  const todayStr = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  // Fetch the most recent empirical learnings from the Learner agent — these are
  // injected before the analysis prompt so the AI calibrates on actual track record
  const learningsInjection = await getLatestAnalystInjection().catch(() => null);

  // Inject relevant breaking news headlines
  const newsContext = getRelevantNews(market.title || market.ticker, 3);
  const newsSection = newsContext
    ? `\n## Breaking News Context\n${newsContext}\nConsider whether these headlines are relevant to this market's resolution.`
    : "";

  // Inject sport-specific pre-game intel (pitchers, injuries, goalies, lineups)
  // Run in parallel with other async fetches — fails silently on timeout/error
  const sportsIntel = await fetchSportsIntel(market.ticker, hoursToExpiry).catch(() => null);
  const sportsIntelSection = sportsIntel?.section ? `\n${sportsIntel.section}` : "";

  const openPriceSection = signals.openPrice != null
    ? `- Open Price: $${signals.openPrice.toFixed(4)} → Current: $${yesPrice.toFixed(4)} (${signals.priceChange! > 0 ? "+" : ""}${signals.priceChange!.toFixed(1)}% drift)`
    : "";

  // ── Price dip/surge signal ────────────────────────────────────────────────
  let priceHistorySection = "";
  if (candidate.priceHistory) {
    const ph = candidate.priceHistory;
    // Build a mini chart of recent prices (last 8 snapshots, oldest→newest)
    const chartStr = ph.series.length > 0
      ? ph.series.slice(0, 8).reverse().map((s) => `${(s.price * 100).toFixed(0)}¢`).join(" → ")
      : "";
    const chartLine = chartStr ? `\n- Price chart (oldest→newest): ${chartStr}` : "";

    if (ph.isDip) {
      const flushLabel = ph.isLiquidityFlush
        ? `\n- ✅ LIQUIDITY FLUSH SIGNATURE: spread widened ${(ph.spreadWidening * 100).toFixed(0)}% during drop (bid retreated, not a wave of sellers) | volume trend: ${ph.volumeTrend}`
        : `\n- ⚠️ No flush signature — volume trend: ${ph.volumeTrend} (rising volume = possible informed selling, be cautious)`;
      const peakLine = ph.hoursSincePeak != null
        ? `\n- Last at pre-dip level: ${ph.hoursSincePeak.toFixed(1)}h ago`
        : "";
      priceHistorySection = `
## ⚠️ PRICE DIP DETECTED — Mean Reversion Signal
Price dropped ${Math.abs(ph.currentVsMeanPct).toFixed(1)}% below its ${ph.snapshots}-snapshot rolling mean.
- Mean: ${(ph.recentMean * 100).toFixed(1)}¢ | Range: ${(ph.recentMin * 100).toFixed(1)}¢–${(ph.recentMax * 100).toFixed(1)}¢ | StdDev: ${(ph.stdDev * 100).toFixed(1)}¢
- Current YES price: ${(yesPrice * 100).toFixed(1)}¢ (${Math.abs(ph.currentVsMeanPct).toFixed(1)}% below mean)${flushLabel}${peakLine}${chartLine}

INTERPRETATION:
- LIQUIDITY FLUSH (spread widens, volume flat/falling): A single large seller dumped contracts with no new information. The bid retreats, spread widens, then recovers once absorbed. HIGH-CONFIDENCE BUY YES opportunity.
- INFORMED SELLING (volume rising, tight spread stays low): New information pushed fair value down. DO NOT treat as a dip — update your probability estimate downward.
- If you cannot identify a news catalyst for the drop, default to treating it as a liquidity flush.`;
    } else if (ph.isSurge) {
      const surgeLabel = ph.volumeTrend === "rising"
        ? "Volume is RISING → likely informed buying (momentum, not a fade)"
        : `Volume is ${ph.volumeTrend} → may be a single large buyer (potential fade — NO is underpriced)`;
      priceHistorySection = `
## ⚠️ PRICE SURGE DETECTED — Potential Fade Signal
Price is ${ph.currentVsMeanPct.toFixed(1)}% above its ${ph.snapshots}-snapshot rolling mean.
- Mean: ${(ph.recentMean * 100).toFixed(1)}¢ | Range: ${(ph.recentMin * 100).toFixed(1)}¢–${(ph.recentMax * 100).toFixed(1)}¢${chartLine}
- ${surgeLabel}
INTERPRETATION: Rising volume + sustained price = informed momentum, follow it. Spike without volume = single buyer, consider NO.`;
    } else {
      priceHistorySection = `
## Price History (${ph.snapshots} snapshots)
- Mean: ${(ph.recentMean * 100).toFixed(1)}¢ | Range: ${(ph.recentMin * 100).toFixed(1)}¢–${(ph.recentMax * 100).toFixed(1)}¢ | Deviation: ${ph.currentVsMeanPct > 0 ? "+" : ""}${ph.currentVsMeanPct.toFixed(1)}% | Volume: ${ph.volumeTrend}${chartLine}`;
    }
  }

  // ── Sharp book comparison ─────────────────────────────────────────────────
  let sharpOddsSection = "";
  if (candidate.sharpLine) {
    const sl = candidate.sharpLine;
    const edgeDir = sl.kalshiEdgeVsSharp < 0 ? "Kalshi UNDERPRICED vs sharp → BUY YES" : "Kalshi OVERPRICED vs sharp → BUY NO";
    sharpOddsSection = `
## Sharp Book Comparison (${sl.bookmaker})
- Pinnacle implied YES probability: ${(sl.pinnacleYesProb * 100).toFixed(1)}%
- No-vig fair probability (YES): ${(sl.noVigYesProb * 100).toFixed(1)}%
- Kalshi YES price: ${(yesPrice * 100).toFixed(1)}%
- Edge vs sharp: ${sl.kalshiEdgeVsSharp > 0 ? "+" : ""}${sl.kalshiEdgeVsSharp.toFixed(1)}pp (${edgeDir})
⚡ Pinnacle is one of the sharpest books globally. When Kalshi deviates ≥3pp from Pinnacle's no-vig line, it is near-certainly mispriced. Weight this heavily in your analysis.`;
  }

  // For near-expiry sports markets, attempt to fetch the live game score
  let liveScoreSection = "";
  const isNearExpirySports = category === "Sports" && hoursToExpiry < 4;
  if (isNearExpirySports) {
    try {
      const score = await fetchLiveScore(market.ticker);
      if (score) {
        liveScoreSection = `\n## Live Game Score (from ESPN)\n${score}\n⚠️ CRITICAL: Use this live score as your PRIMARY input. The market price should reflect current game state. Re-evaluate the spread/total against this real score.`;
      } else {
        liveScoreSection = `\n## Live Game Score\n⚠️ CRITICAL: This game is likely in progress (${hoursToExpiry.toFixed(1)}h to expiry) but we could not retrieve the current score. YOU HAVE NO LIVE GAME STATE. Do NOT invent scores or assume game progress. Set confidence ≤ 20% due to missing live context.`;
      }
    } catch {
      liveScoreSection = `\n## Live Game Score\n⚠️ CRITICAL: Score fetch failed. This game may be live. Set confidence ≤ 20%.`;
    }
  }

  const soccerContractNote = soccer ? `
⚽ SOCCER 3-WAY MARKET — EXTRA CAUTION:
Soccer matches have three outcomes: Team A wins, draw, Team B wins.
- YES pays $1 only if the one specific condition named in the title is TRUE.
- NO covers ALL other outcomes — including draws AND the other team winning.
- A YES price of ~10% is REASONABLE for an underdog outright win (draws alone are ~25-30%).
- Do NOT treat YES price as symmetric: P(YES=10%) ≠ P(other team wins=90%).
  The correct reading is: P(YES team wins outright) ≈ 10%, P(draw) ≈ 25-30%, P(other team wins) ≈ 60-65%.` : "";

  const learningsSection = learningsInjection
    ? `\n## Prior System Learnings\n${learningsInjection}\n`
    : "";

  const prompt = `You are a quantitative prediction market analyst with expertise in sports, politics, economics, crypto, and current events. Analyze this Kalshi prediction market to find mispricing opportunities.

## IMPORTANT CONTEXT
Today's date: **${todayStr}**
- The MLB 2026 regular season is underway. Any MLB market on Kalshi (KXMLB series) is a REGULAR SEASON game unless the title explicitly says "spring training." Spring training concluded in mid-March 2026.
- NHL 2025-26 regular season is in its final weeks heading toward the playoffs.
- NBA 2025-26 regular season continues through mid-April.
- March Madness (NCAA Tournament) is active through early April.
${learningsSection}
## ⚠️ CONTRACT DEFINITION — READ FIRST
The market title IS the YES resolution condition. Read it literally:
- YES pays $1 if the exact condition stated in the title is TRUE.
- NO pays $1 if that condition is FALSE.
- Your "probability" output = P(title condition is TRUE), i.e. P(YES resolves).
${soccerContractNote}
For all sports markets:
- If the title says "Will [Team A] beat [Team B]?" → YES = Team A wins outright, NO = anything else.
- If you believe Team B is likely to win, return a LOW probability (below the YES price).
- NEVER swap teams. The team/outcome named as the subject of the title question is the YES side.
- Before writing your reasoning, state: "YES resolves if: [exact condition]."

## Market Data
- Title: ${market.title || market.ticker}
- Ticker: ${market.ticker}
- Category: ${category}${soccer ? " (Soccer/Football — 3-way market)" : ""}
- YES Contract: pays $1 if the title condition is TRUE
- NO Contract: pays $1 if the title condition is FALSE${soccer ? " (includes draw AND other team winning)" : ""}
- Yes Price: $${yesPrice.toFixed(4)} (market-implied P(YES) = ${signals.impliedProb.toFixed(1)}%)
- Spread: $${spread.toFixed(4)} (${signals.spreadPct.toFixed(1)}% relative)
- 24h Volume: ${volume24h} contracts
- Liquidity: $${liquidity.toFixed(2)}
- Time to Expiry: ${hoursToExpiry.toFixed(1)} hours (${signals.timeCategory})
${openPriceSection}

## Market Structure Signals
- Price Region: ${signals.priceRegion} (${signals.impliedProb.toFixed(1)}% implied)
- Volume/Liquidity Ratio: ${signals.volumeToLiquidity.toFixed(2)} (${signals.volumeToLiquidity > 3 ? "⚡ heavy flow — possible informed trading" : signals.volumeToLiquidity > 1 ? "moderate activity" : "light flow"})
- Market Efficiency: ${signals.marketEfficiency} (${signals.marketEfficiency === "high" ? "tight spread + high volume — edge is rare" : signals.marketEfficiency === "low" ? "wide spread or low volume — mispricing more likely" : "moderate efficiency"})
${priceHistorySection}${sharpOddsSection}${liveScoreSection}${sportsIntelSection}${newsSection}

## Analysis Framework (${category})
${categoryGuidance}

## Instructions
Return the probability that the YES condition (as defined by the title) resolves true. Your reasoning MUST begin by stating "YES resolves if: [condition]" then explain whether you believe that condition is likely or unlikely. If you believe the opposite side is more likely, return a probability BELOW the Yes Price above. Never argue that the favorite/stronger team should win and then return a high probability if that team is on the NO side.

Respond in EXACTLY this JSON format (no other text):
{"probability": <number 0-100>, "confidence": <number 0-100>, "reasoning": "<Start with 'YES resolves if: [condition].' Then 2-3 sentences on whether that condition is likely, referencing team form, live score, or other signals.>"}`;

  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const inputTokens = message.usage?.input_tokens || 0;
    const outputTokens = message.usage?.output_tokens || 0;
    await logApiCost("claude-haiku-4-5", inputTokens, outputTokens, "Analyst", market.ticker);

    const text = message.content[0].type === "text" ? message.content[0].text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return createDefaultResult(candidate);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const modelProb = Math.max(1, Math.min(99, parsed.probability)) / 100;
    const confidence = Math.max(1, Math.min(100, parsed.confidence)) / 100;

    const yesSide = modelProb > yesPrice;
    const side: "yes" | "no" = yesSide ? "yes" : "no";
    // Edge in PROBABILITY POINTS (pp): simple absolute difference between
    // model's estimate and market price. Old formula divided by market price,
    // which caused 625pp claims on 8¢ markets that had only a 50pp real edge.
    // Max possible is 100pp (model says 99%, market says 1%).
    const edge = Math.abs(modelProb - yesPrice) * 100;

    return {
      candidate,
      modelProbability: modelProb,
      edge: Math.max(0, edge),
      confidence,
      side,
      reasoning: parsed.reasoning || "No reasoning provided",
    };
  } catch (error) {
    console.error("Analyst error:", error);
    return createDefaultResult(candidate);
  }
}

/** Paper / keeper path: blind pricing math aligned with JBecker replay (`blindReplayAnalysisForTick`). No Anthropic. */
export function analyzeMarketRuleBased(candidate: ScanCandidate): AnalysisResult {
  const yesPrice = candidate.yesPrice;
  const ph = candidate.priceHistory;
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const hash = deterministicHash(candidate.market.ticker + String(hourBucket));
  const hashFrac = (hash % 1000) / 1000;

  let skew = 0;
  if (ph) {
    skew = -(ph.currentVsMeanPct / 100) * 0.12;
  }
  const noise = ((hash % 100) - 50) / 2200;
  const modelProb = Math.max(0.04, Math.min(0.96, yesPrice + skew + noise + (hashFrac - 0.5) * 0.06));
  const side: "yes" | "no" = modelProb > yesPrice ? "yes" : "no";
  const edge = Math.abs(modelProb - yesPrice) * 100;
  const volumeBoost = Math.min(0.1, Math.max(0, candidate.volume24h) / 7000);
  const confidence = Math.min(0.88, 0.34 + edge / 110 + volumeBoost + hashFrac * 0.05);

  return {
    candidate,
    modelProbability: modelProb,
    edge,
    confidence,
    side,
    reasoning: `Rule-based (no AI): mid=${(yesPrice * 100).toFixed(1)}¢ model=${(modelProb * 100).toFixed(1)}¢ edge=${edge.toFixed(1)}pp`,
  };
}

export function analyzeMarketsRuleBased(candidates: ScanCandidate[]): AnalysisResult[] {
  return candidates.map(analyzeMarketRuleBased);
}

function createDefaultResult(candidate: ScanCandidate): AnalysisResult {
  return {
    candidate,
    modelProbability: candidate.yesPrice,
    edge: 0,
    confidence: 0,
    side: "yes",
    reasoning: "Analysis failed - using market price as default",
  };
}

export async function analyzeMarkets(candidates: ScanCandidate[]): Promise<AnalysisResult[]> {
  const results: AnalysisResult[] = [];
  const batchSize = 3;

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(analyzeMarket));
    results.push(...batchResults);
  }

  return results;
}

/** @deprecated Use `analyzeMarketsRuleBased` — paper stack is rule-based only. */
export async function analyzeMarketsSimulated(candidates: ScanCandidate[]): Promise<AnalysisResult[]> {
  return analyzeMarketsRuleBased(candidates);
}
