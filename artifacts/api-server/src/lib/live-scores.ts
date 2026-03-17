/**
 * Live score fetcher using the public ESPN CDN API.
 * No API key required. Supports NBA, NFL, NHL, MLB, and major soccer leagues.
 */

interface ESPNCompetitor {
  team: { abbreviation: string; displayName: string };
  score: string;
  homeAway: "home" | "away";
}

interface ESPNStatus {
  period: number;
  displayClock: string;
  type: { completed: boolean; name: string; description: string };
}

interface ESPNEvent {
  id: string;
  name: string;
  competitions: Array<{
    competitors: ESPNCompetitor[];
    status: ESPNStatus;
  }>;
}

interface ESPNScoreboard {
  events?: ESPNEvent[];
}

type SportKey = "nba" | "nfl" | "nhl" | "mlb" | "laliga" | "seriea" | "ucl" | "nwsl";

const ESPN_URLS: Record<SportKey, string> = {
  nba:    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  nfl:    "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  nhl:    "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard",
  mlb:    "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  laliga: "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard",
  seriea: "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard",
  ucl:    "https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.CHAMPIONS/scoreboard",
  nwsl:   "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.nwsl/scoreboard",
};

// Cache ESPN responses for 90 seconds to avoid hammering the API on every analyst call
const scoreCache = new Map<string, { data: ESPNScoreboard; ts: number }>();
const CACHE_TTL_MS = 90_000;

async function fetchScoreboard(sport: SportKey): Promise<ESPNScoreboard> {
  const cached = scoreCache.get(sport);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const res = await fetch(ESPN_URLS[sport], {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KalshiAI/1.0)" },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`ESPN ${sport} API returned ${res.status}`);
  const data = (await res.json()) as ESPNScoreboard;
  scoreCache.set(sport, { data, ts: Date.now() });
  return data;
}

function detectSport(ticker: string): SportKey | null {
  const t = ticker.toUpperCase();
  if (t.startsWith("KXNBA")) return "nba";
  if (t.startsWith("KXNFL") || t.startsWith("KXNFCAFC")) return "nfl";
  if (t.startsWith("KXNHL")) return "nhl";
  if (t.startsWith("KXMLB")) return "mlb";
  if (t.startsWith("KXLALIGA")) return "laliga";
  if (t.startsWith("KXSERIEA")) return "seriea";
  if (t.startsWith("KXUECL") || t.startsWith("KXCHAMPIONS")) return "ucl";
  return null;
}

/**
 * Parses two team abbreviations out of a Kalshi market ticker.
 * Pattern: KXNBASPREAD-26MAR16ORLATL-ORL3
 *   Middle segment after stripping 7-char date: ORLATL → [ORL, ATL]
 */
function extractTeams(ticker: string): [string, string] | null {
  const parts = ticker.split("-");
  if (parts.length < 2) return null;
  const mid = parts[1]; // e.g. "26MAR16ORLATL"
  // Date is DDMMMYY = 7 chars
  const afterDate = mid.slice(7); // e.g. "ORLATL"
  if (afterDate.length < 4) return null;
  // NBA teams are always 3 letters; try 3+3 split
  if (afterDate.length === 6) return [afterDate.slice(0, 3), afterDate.slice(3)];
  if (afterDate.length === 5) return [afterDate.slice(0, 2), afterDate.slice(2)]; // rare 2+3
  if (afterDate.length === 7) return [afterDate.slice(0, 3), afterDate.slice(3)]; // 3+4 (rare)
  if (afterDate.length >= 6) return [afterDate.slice(0, 3), afterDate.slice(3, 6)];
  return null;
}

function formatGameState(event: ESPNEvent): string {
  const comp = event.competitions[0];
  if (!comp) return "";
  const status = comp.status;
  const scores = comp.competitors
    .map((c) => `${c.team.abbreviation} ${c.score}`)
    .join(" — ");

  if (status.type.completed) {
    return `FINAL: ${scores}`;
  }
  if (status.type.name === "STATUS_SCHEDULED") {
    return `Scheduled (not yet started): ${event.name}`;
  }
  return `LIVE Q${status.period} ${status.displayClock}: ${scores}`;
}

/**
 * Fetches the live game score for a given Kalshi market ticker.
 * Returns a human-readable string like "LIVE Q3 4:22: ORL 89 — ATL 94"
 * or "FINAL: ORL 109 — ATL 112", or null if not found / not a game market.
 */
export async function fetchLiveScore(ticker: string): Promise<string | null> {
  const sport = detectSport(ticker);
  if (!sport) return null;

  const teams = extractTeams(ticker);
  if (!teams) return null;
  const [team1, team2] = teams;

  try {
    const scoreboard = await fetchScoreboard(sport);
    for (const event of scoreboard.events ?? []) {
      const comp = event.competitions[0];
      if (!comp) continue;
      const abbrs = comp.competitors.map((c) => c.team.abbreviation.toUpperCase());
      if (abbrs.includes(team1.toUpperCase()) && abbrs.includes(team2.toUpperCase())) {
        return formatGameState(event);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[LiveScores] Failed to fetch ${sport} scores: ${msg}`);
  }

  return null;
}
