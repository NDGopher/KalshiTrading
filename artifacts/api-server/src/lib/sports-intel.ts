/**
 * Pre-game sports intelligence fetcher.
 * Uses free public APIs — no API key required.
 *
 * Sources:
 *   MLB probable pitchers  → MLB Stats API (statsapi.mlb.com)
 *   NBA injury reports     → ESPN public injury endpoint
 *   NHL starting goalies   → NHL official API (api-web.nhle.com)
 *   Soccer lineups         → ESPN soccer API (within 2h of kickoff)
 *
 * All calls are cached per sport per hour to avoid hammering APIs on every
 * analyst invocation. Failures are silent — we degrade gracefully.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  ts: number;
}

function freshEntry<T>(data: T): CacheEntry<T> {
  return { data, ts: Date.now() };
}

function cacheHit<T>(entry: CacheEntry<T> | undefined, ttlMs: number): boolean {
  return !!entry && Date.now() - entry.ts < ttlMs;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function safeFetch(url: string, timeoutMs = 5000): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KalshiAI/1.0)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Parse team abbreviations from a Kalshi ticker.
 * KXMLBTOTAL-26MAR16NYYSF  → ["NYY","SF"]
 * KXNBASPREAD-26MAR16ORLATL → ["ORL","ATL"]
 */
function extractTeamAbbrs(ticker: string): [string, string] | null {
  const parts = ticker.split("-");
  if (parts.length < 2) return null;
  const mid = parts[1]; // "26MAR16NYYSF" or "26MAR16ORLATL"
  const afterDate = mid.slice(7); // strip "26MAR16" (7 chars)
  if (afterDate.length < 4) return null;
  if (afterDate.length === 5) return [afterDate.slice(0, 2), afterDate.slice(2)];
  if (afterDate.length === 6) return [afterDate.slice(0, 3), afterDate.slice(3)];
  if (afterDate.length >= 7) return [afterDate.slice(0, 3), afterDate.slice(3, 6)];
  return null;
}

// ─── MLB Probable Pitchers ────────────────────────────────────────────────────

interface MLBPitcher {
  fullName: string;
  throwingHand?: string;
  era?: string;
  whip?: string;
  wins?: number;
  losses?: number;
  strikeOuts?: number;
  inningsPitched?: string;
  note?: string; // sometimes includes "day-to-day", "scratched", etc.
}

interface MLBGamePitchers {
  homeTeam: string;
  awayTeam: string;
  homePitcher: MLBPitcher | null;
  awayPitcher: MLBPitcher | null;
}

const mlbPitcherCache = new Map<string, CacheEntry<MLBGamePitchers[]>>();
const MLB_CACHE_TTL = 30 * 60 * 1000; // 30 minutes (pitchers set change rarely)

interface MLBProbablePitcher {
  id?: number;
  fullName?: string;
  pitchHand?: { code?: string; description?: string };
  note?: string;
}

interface MLBTeamGame {
  team?: { abbreviation?: string; name?: string };
  probablePitcher?: MLBProbablePitcher;
}

interface MLBGame {
  teams?: { home?: MLBTeamGame; away?: MLBTeamGame };
}

interface MLBScheduleDate {
  date?: string;
  games?: MLBGame[];
}

interface MLBScheduleResponse {
  dates?: MLBScheduleDate[];
}

// Kalshi uses city-based 2-3 letter codes; MLB API returns full team names.
// This map normalizes Kalshi abbreviations → substrings found in MLB team names.
const KALSHI_MLB_ABBR: Record<string, string> = {
  NYY: "yankees", NYM: "mets", BOS: "red sox", TB: "rays", BAL: "orioles",
  TOR: "blue jays", CWS: "white sox", CLE: "guardians", DET: "tigers",
  KC: "royals", MIN: "twins", HOU: "astros", LAA: "angels", OAK: "athletics",
  SEA: "mariners", TEX: "rangers", ATL: "braves", MIA: "marlins",
  NYM2: "mets", PHI: "phillies", WSH: "nationals", CHC: "cubs",
  CIN: "reds", MIL: "brewers", PIT: "pirates", STL: "cardinals",
  ARI: "diamondbacks", COL: "rockies", LAD: "dodgers", SD: "padres",
  SF: "giants", OAK2: "athletics",
};

function mlbTeamMatches(kalshiAbbr: string, teamName: string): boolean {
  const name = teamName.toLowerCase();
  const abbr = kalshiAbbr.toUpperCase();
  const mapped = KALSHI_MLB_ABBR[abbr];
  if (mapped && name.includes(mapped)) return true;
  // Fallback: abbreviation appears in name (e.g. "SF" in "San Francisco Giants")
  if (name.includes(abbr.toLowerCase())) return true;
  // Common direct matches
  if (abbr === "SF" && name.includes("giants") && name.includes("san francisco")) return true;
  if (abbr === "NYY" && name.includes("yankees")) return true;
  if (abbr === "LAD" && name.includes("dodgers")) return true;
  return false;
}

async function fetchMLBProbablePitchers(): Promise<MLBGamePitchers[]> {
  const date = todayStr();
  const cached = mlbPitcherCache.get(date);
  if (cacheHit(cached, MLB_CACHE_TTL)) return cached!.data;

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note)`;
  const raw = await safeFetch(url) as MLBScheduleResponse | null;

  const games: MLBGamePitchers[] = [];
  for (const dateBlock of (raw?.dates ?? [])) {
    for (const game of (dateBlock.games ?? [])) {
      const home = game.teams?.home;
      const away = game.teams?.away;
      const buildPitcher = (t: MLBTeamGame | undefined): MLBPitcher | null => {
        if (!t?.probablePitcher?.fullName) return null;
        const p = t.probablePitcher;
        return {
          fullName: p.fullName,
          throwingHand: p.pitchHand?.description ?? p.pitchHand?.code,
          note: p.note,
        };
      };
      games.push({
        // Use full team name for matching; label will be the name
        homeTeam: home?.team?.name ?? "",
        awayTeam: away?.team?.name ?? "",
        homePitcher: buildPitcher(home),
        awayPitcher: buildPitcher(away),
      });
    }
  }

  mlbPitcherCache.set(date, freshEntry(games));
  return games;
}

interface MLBStatValue {
  era?: string;
  whip?: string;
  wins?: number;
  losses?: number;
  strikeOuts?: number;
  inningsPitched?: string;
}

interface MLBStatGroup {
  type?: { displayName?: string };
  stats?: MLBStatValue;
}

interface MLBPlayerStatsResponse {
  people?: Array<{
    stats?: MLBStatGroup[];
  }>;
}

async function enrichMLBPitcherStats(games: MLBGamePitchers[]): Promise<void> {
  // Collect all non-null pitcher names and look up their season stats
  // MLB Stats API: /api/v1/people/{id}/stats?stats=season&group=pitching
  // Since we don't get the pitcher ID from the schedule hydrate, skip ID-based lookup.
  // We still have names and hand — enough for good prompting.
  // TODO: If we switch to hydrate=probablePitcher(note,stats(type=season,group=pitching)) the schedule
  //       call should return stats inline. For now the name + hand is already useful.
  void games; // placeholder
}

function findMLBGame(games: MLBGamePitchers[], team1: string, team2: string): MLBGamePitchers | null {
  for (const g of games) {
    const homeMatchesT1 = mlbTeamMatches(team1, g.homeTeam) || mlbTeamMatches(team1, g.awayTeam);
    const homeMatchesT2 = mlbTeamMatches(team2, g.homeTeam) || mlbTeamMatches(team2, g.awayTeam);
    if (homeMatchesT1 && homeMatchesT2) return g;
  }
  return null;
}

function formatMLBPitcherSummary(game: MLBGamePitchers): string {
  const fmtPitcher = (p: MLBPitcher | null, label: string): string => {
    if (!p) return `${label} SP: TBD`;
    const hand = p.throwingHand ? ` (${p.throwingHand[0]}HP)` : "";
    const note = p.note ? ` ⚠️ ${p.note}` : "";
    return `${label} SP: ${p.fullName}${hand}${note}`;
  };
  return [
    fmtPitcher(game.awayPitcher, game.awayTeam),
    fmtPitcher(game.homePitcher, game.homeTeam),
  ].join("\n");
}

// ─── NBA Injury Reports ───────────────────────────────────────────────────────

interface NBAInjury {
  athlete: string;
  status: string; // "Out", "Questionable", "Doubtful", "Day-To-Day"
  description?: string;
}

interface NBATeamInjuries {
  teamAbbr: string;
  injuries: NBAInjury[];
}

const nbaInjuryCache = new Map<string, CacheEntry<NBATeamInjuries[]>>();
const NBA_INJURY_TTL = 30 * 60 * 1000; // 30 min

interface ESPNInjuryAthlete {
  displayName?: string;
}

interface ESPNInjuryEntry {
  athlete?: ESPNInjuryAthlete;
  status?: string;
  details?: { fantasyStatus?: { description?: string } };
  longComment?: string;
}

interface ESPNInjuryTeam {
  abbreviation?: string;
  injuries?: ESPNInjuryEntry[];
}

interface ESPNInjuryResponse {
  injuries?: ESPNInjuryTeam[];
}

async function fetchNBAInjuries(): Promise<NBATeamInjuries[]> {
  const cacheKey = todayStr();
  const cached = nbaInjuryCache.get(cacheKey);
  if (cacheHit(cached, NBA_INJURY_TTL)) return cached!.data;

  const url = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries";
  const raw = await safeFetch(url) as ESPNInjuryResponse | null;

  const result: NBATeamInjuries[] = [];
  for (const team of (raw?.injuries ?? [])) {
    const abbr = team.abbreviation ?? "";
    const injuries: NBAInjury[] = (team.injuries ?? [])
      .filter((inj) => {
        const s = (inj.status ?? "").toLowerCase();
        return s === "out" || s === "questionable" || s === "doubtful" || s === "day-to-day";
      })
      .map((inj) => ({
        athlete: inj.athlete?.displayName ?? "Unknown",
        status: inj.status ?? "Unknown",
        description: inj.longComment ?? inj.details?.fantasyStatus?.description,
      }));
    if (injuries.length > 0) {
      result.push({ teamAbbr: abbr, injuries });
    }
  }

  nbaInjuryCache.set(cacheKey, freshEntry(result));
  return result;
}

function findNBATeamInjuries(all: NBATeamInjuries[], abbr: string): NBAInjury[] {
  const target = abbr.toUpperCase();
  const match = all.find((t) => t.teamAbbr.toUpperCase() === target);
  return match?.injuries ?? [];
}

function formatNBAInjuries(injuries: NBAInjury[], teamLabel: string): string {
  if (injuries.length === 0) return `${teamLabel}: No injury report`;
  const critical = injuries.filter((i) => i.status.toLowerCase() === "out" || i.status.toLowerCase() === "doubtful");
  const questionable = injuries.filter((i) => i.status.toLowerCase() === "questionable" || i.status.toLowerCase() === "day-to-day");
  const lines: string[] = [];
  if (critical.length > 0) lines.push(`  OUT/Doubtful: ${critical.map((i) => `${i.athlete}`).join(", ")}`);
  if (questionable.length > 0) lines.push(`  Questionable/DTD: ${questionable.map((i) => `${i.athlete}`).join(", ")}`);
  return `${teamLabel}:\n${lines.join("\n")}`;
}

// ─── NHL Starting Goalies ─────────────────────────────────────────────────────

interface NHLGoalie {
  name: string;
  confirmed: boolean; // true = official lineup posted, false = probable/expected
  savePct?: string;
  gaa?: string;
}

interface NHLGameGoalies {
  homeTeam: string;
  awayTeam: string;
  homeGoalie: NHLGoalie | null;
  awayGoalie: NHLGoalie | null;
}

const nhlGoalieCache = new Map<string, CacheEntry<NHLGameGoalies[]>>();
const NHL_GOALIE_TTL = 15 * 60 * 1000; // 15 min (goalies can change late)

interface NHLGameTeam {
  abbrev?: string;
}

interface NHLGame {
  homeTeam?: NHLGameTeam;
  awayTeam?: NHLGameTeam;
  id?: number;
}

interface NHLScheduleResponse {
  gameWeek?: Array<{
    date?: string;
    games?: NHLGame[];
  }>;
}

interface NHLBoxscorePlayer {
  name?: { default?: string };
  position?: string;
  toi?: string;
}

interface NHLBoxscoreTeam {
  skaters?: NHLBoxscorePlayer[];
  goalies?: NHLBoxscorePlayer[];
}

interface NHLBoxscoreTeams {
  homeTeam?: NHLBoxscoreTeam;
  awayTeam?: NHLBoxscoreTeam;
}

interface NHLBoxscoreResponse {
  homeTeam?: { abbrev?: string };
  awayTeam?: { abbrev?: string };
  playerByGameStats?: NHLBoxscoreTeams;
}

async function fetchNHLGoalies(): Promise<NHLGameGoalies[]> {
  const cacheKey = todayStr();
  const cached = nhlGoalieCache.get(cacheKey);
  if (cacheHit(cached, NHL_GOALIE_TTL)) return cached!.data;

  // Step 1: Get today's schedule
  const scheduleUrl = `https://api-web.nhle.com/v1/schedule/${cacheKey}`;
  const schedRaw = await safeFetch(scheduleUrl) as NHLScheduleResponse | null;

  const games: NHLGameGoalies[] = [];
  const todayGames: NHLGame[] = [];
  for (const week of (schedRaw?.gameWeek ?? [])) {
    if (week.date === cacheKey) {
      todayGames.push(...(week.games ?? []));
    }
  }

  for (const game of todayGames) {
    const gameId = game.id;
    const homeAbbr = game.homeTeam?.abbrev ?? "";
    const awayAbbr = game.awayTeam?.abbrev ?? "";

    let homeGoalie: NHLGoalie | null = null;
    let awayGoalie: NHLGoalie | null = null;

    if (gameId) {
      // Step 2: Try to get confirmed starters from boxscore (available 1-2h before puck drop)
      const boxUrl = `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`;
      const box = await safeFetch(boxUrl) as NHLBoxscoreResponse | null;
      if (box?.playerByGameStats) {
        const home = box.playerByGameStats.homeTeam;
        const away = box.playerByGameStats.awayTeam;
        const pickGoalie = (team: NHLBoxscoreTeam | undefined): NHLGoalie | null => {
          const g = (team?.goalies ?? [])[0];
          if (!g) return null;
          return { name: g.name?.default ?? "Unknown", confirmed: true };
        };
        homeGoalie = pickGoalie(home);
        awayGoalie = pickGoalie(away);
      }
    }

    games.push({ homeTeam: homeAbbr, awayTeam: awayAbbr, homeGoalie, awayGoalie });
  }

  nhlGoalieCache.set(cacheKey, freshEntry(games));
  return games;
}

function findNHLGame(games: NHLGameGoalies[], team1: string, team2: string): NHLGameGoalies | null {
  const t1 = team1.toUpperCase();
  const t2 = team2.toUpperCase();
  for (const g of games) {
    if ((g.homeTeam.toUpperCase() === t1 || g.awayTeam.toUpperCase() === t1) &&
        (g.homeTeam.toUpperCase() === t2 || g.awayTeam.toUpperCase() === t2)) {
      return g;
    }
  }
  return null;
}

function formatNHLGoalies(game: NHLGameGoalies): string {
  const fmt = (goalie: NHLGoalie | null, label: string): string => {
    if (!goalie) return `${label}: Goalie TBD (not yet confirmed)`;
    const conf = goalie.confirmed ? "✅ CONFIRMED" : "📋 Expected";
    return `${label}: ${goalie.name} — ${conf}`;
  };
  return [
    fmt(game.awayGoalie, game.awayTeam),
    fmt(game.homeGoalie, game.homeTeam),
  ].join("\n");
}

// ─── Soccer Lineups (ESPN, within 2h of kickoff) ──────────────────────────────

interface SoccerLineup {
  homeTeam: string;
  awayTeam: string;
  homeStarting: string[];
  awayStarting: string[];
  confirmed: boolean;
}

const soccerLineupCache = new Map<string, CacheEntry<SoccerLineup | null>>();
const SOCCER_LINEUP_TTL = 10 * 60 * 1000; // 10 min (lineups post ~1h before kickoff)

const SOCCER_ESPN_URLS: Record<string, string> = {
  laliga:    "https://site.api.espn.com/apis/site/v2/sports/soccer/esp.1/scoreboard",
  seriea:    "https://site.api.espn.com/apis/site/v2/sports/soccer/ita.1/scoreboard",
  epl:       "https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard",
  bundesliga:"https://site.api.espn.com/apis/site/v2/sports/soccer/ger.1/scoreboard",
  ucl:       "https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.CHAMPIONS/scoreboard",
  europa:    "https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.EUROPA/scoreboard",
  confleague:"https://site.api.espn.com/apis/site/v2/sports/soccer/UEFA.CONFERENCE/scoreboard",
  mls:       "https://site.api.espn.com/apis/site/v2/sports/soccer/usa.1/scoreboard",
};

function detectSoccerLeague(ticker: string): string | null {
  const t = ticker.toUpperCase();
  if (t.startsWith("KXLALIGA")) return "laliga";
  if (t.startsWith("KXSERIEA")) return "seriea";
  if (t.startsWith("KXEPL")) return "epl";
  if (t.startsWith("KXBUNDES")) return "bundesliga";
  if (t.startsWith("KXUCL") || t.startsWith("KXCHAMPIONS")) return "ucl";
  if (t.startsWith("KXEUROPA")) return "europa";
  if (t.startsWith("KXUECL") || t.startsWith("KXCONF")) return "confleague";
  if (t.startsWith("KXMLS")) return "mls";
  return null;
}

interface ESPNSoccerCompetitor {
  team?: { abbreviation?: string; displayName?: string };
  roster?: Array<{ athlete?: { displayName?: string; position?: { name?: string } }; starter?: boolean }>;
}

interface ESPNSoccerCompetition {
  competitors?: ESPNSoccerCompetitor[];
  date?: string;
  lineups?: boolean;
}

interface ESPNSoccerEvent {
  name?: string;
  competitions?: ESPNSoccerCompetition[];
}

interface ESPNSoccerScoreboard {
  events?: ESPNSoccerEvent[];
}

async function fetchSoccerLineup(ticker: string, hoursToKickoff: number): Promise<SoccerLineup | null> {
  if (hoursToKickoff > 3) return null; // only fetch lineups close to kickoff

  const league = detectSoccerLeague(ticker);
  if (!league) return null;

  const cacheKey = `${ticker}-${todayStr()}`;
  const cached = soccerLineupCache.get(cacheKey);
  if (cacheHit(cached, SOCCER_LINEUP_TTL)) return cached!.data ?? null;

  const url = SOCCER_ESPN_URLS[league];
  if (!url) return null;

  const raw = await safeFetch(url) as ESPNSoccerScoreboard | null;
  const teams = extractTeamAbbrs(ticker);

  let result: SoccerLineup | null = null;

  outer: for (const event of (raw?.events ?? [])) {
    const comp = event.competitions?.[0];
    if (!comp) continue;
    const competitors = comp.competitors ?? [];

    // Match teams
    if (teams) {
      const abbrs = competitors.map((c) => (c.team?.abbreviation ?? "").toUpperCase());
      const t1 = teams[0].toUpperCase();
      const t2 = teams[1].toUpperCase();
      if (!abbrs.some((a) => a.includes(t1)) && !abbrs.some((a) => a.includes(t2))) continue;
    } else {
      // Try matching by event name vs market title (caller has no team data from ticker)
      if (!event.name) continue;
    }

    const home = competitors.find((c) => c.team?.abbreviation);
    const away = competitors.find((c) => c !== home);

    const starters = (comp_: ESPNSoccerCompetitor | undefined): string[] => {
      if (!comp_?.roster) return [];
      return comp_.roster
        .filter((r) => r.starter)
        .map((r) => r.athlete?.displayName ?? "")
        .filter(Boolean)
        .slice(0, 11);
    };

    const homeStarters = starters(home);
    const awayStarters = starters(away);

    if (homeStarters.length > 0 || awayStarters.length > 0) {
      result = {
        homeTeam: home?.team?.displayName ?? "Home",
        awayTeam: away?.team?.displayName ?? "Away",
        homeStarting: homeStarters,
        awayStarting: awayStarters,
        confirmed: true,
      };
      break outer;
    }
  }

  soccerLineupCache.set(cacheKey, freshEntry(result));
  return result;
}

function formatSoccerLineup(lineup: SoccerLineup): string {
  const fmtTeam = (name: string, starters: string[]): string => {
    if (starters.length === 0) return `${name}: Starting XI not yet posted`;
    return `${name} Starting XI: ${starters.join(", ")}`;
  };
  return [
    fmtTeam(lineup.awayTeam, lineup.awayStarting),
    fmtTeam(lineup.homeTeam, lineup.homeStarting),
  ].join("\n");
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface SportsIntelResult {
  sport: "mlb" | "nba" | "nhl" | "soccer" | "other";
  section: string; // formatted text block ready for injection into the AI prompt
}

/**
 * Main entry point. Call this with the market ticker and hours to expiry;
 * returns a formatted intelligence block for AI prompt injection, or null
 * if no useful data is available.
 */
export async function fetchSportsIntel(
  ticker: string,
  hoursToExpiry: number,
): Promise<SportsIntelResult | null> {
  const t = ticker.toUpperCase();

  // ── MLB ──────────────────────────────────────────────────────────────────
  if (t.startsWith("KXMLB")) {
    try {
      const teams = extractTeamAbbrs(ticker);
      const games = await fetchMLBProbablePitchers();
      const game = teams ? findMLBGame(games, teams[0], teams[1]) : null;

      if (game) {
        const lines = [
          "## ⚾ Starting Pitcher Matchup (MLB Stats API)",
          formatMLBPitcherSummary(game),
        ];
        const hasTbd = !game.homePitcher || !game.awayPitcher;
        if (hasTbd) {
          lines.push("⚠️ TBD pitcher(s) indicate late lineup scratch or double-header — increase uncertainty on totals.");
        }
        lines.push(`\nIMPORTANT: Starting pitcher quality is the #1 factor for MLB totals/spreads. If you don't recognize a pitcher's name, assume they are a mid-rotation or bullpen arm with ERA ~4.50+. Named aces like Gerrit Cole, Logan Webb, Zac Gallen have ERA below 3.00 and heavily suppress totals.`);
        return { sport: "mlb", section: lines.join("\n") };
      }

      // No matching game found — still helpful to tell the model
      return {
        sport: "mlb",
        section: "## ⚾ Starting Pitcher Matchup\n⚠️ Could not retrieve probable pitcher data for this game. Treat as unknown pitching matchup — widen your confidence interval significantly and avoid high-confidence calls on totals.",
      };
    } catch {
      return null;
    }
  }

  // ── NBA ──────────────────────────────────────────────────────────────────
  if (t.startsWith("KXNBA")) {
    try {
      const teams = extractTeamAbbrs(ticker);
      if (!teams) return null;
      const allInjuries = await fetchNBAInjuries();
      const [t1, t2] = teams;
      const inj1 = findNBATeamInjuries(allInjuries, t1);
      const inj2 = findNBATeamInjuries(allInjuries, t2);

      const hasInjuries = inj1.length > 0 || inj2.length > 0;
      const lines = ["## 🏀 NBA Injury Report (ESPN)"];

      if (!hasInjuries) {
        lines.push(`${t1}: No players on injury report`);
        lines.push(`${t2}: No players on injury report`);
        lines.push("✅ No major absences — proceed with normal spread/total analysis.");
      } else {
        lines.push(formatNBAInjuries(inj1, t1));
        lines.push(formatNBAInjuries(inj2, t2));
        const hasStar = inj1.concat(inj2).some((i) => i.status.toLowerCase() === "out");
        if (hasStar) {
          lines.push("\n⚠️ CRITICAL: OUT players shift spread lines by 3-7 points in the NBA. A missing star (25+ PPG) moves the line more than ANY other factor. Factor this heavily — the market may have already priced it in if the injury was announced >12h ago.");
        }
      }

      return { sport: "nba", section: lines.join("\n") };
    } catch {
      return null;
    }
  }

  // ── NHL ──────────────────────────────────────────────────────────────────
  if (t.startsWith("KXNHL")) {
    try {
      const teams = extractTeamAbbrs(ticker);
      if (!teams) return null;
      const games = await fetchNHLGoalies();
      const game = findNHLGame(games, teams[0], teams[1]);

      const lines = ["## 🏒 NHL Starting Goalies (NHL Official API)"];
      if (game) {
        lines.push(formatNHLGoalies(game));
        const bothUnknown = !game.homeGoalie && !game.awayGoalie;
        if (bothUnknown) {
          lines.push("⚠️ Goalies not yet confirmed — lineup typically posts 1-2h before puck drop. High uncertainty on this market.");
        } else {
          lines.push("\nIMPORTANT: Starting goalie is the #1 factor in NHL. A starter vs backup goalie difference shifts win probability by 10-15pp. Backup goalies have save percentages ~.890 vs ~.915 for starters — that's roughly 1 extra goal allowed per game.");
        }
      } else {
        lines.push("⚠️ Could not match this game to today's NHL schedule — treat goalie situation as unknown.");
      }

      return { sport: "nhl", section: lines.join("\n") };
    } catch {
      return null;
    }
  }

  // ── Soccer ───────────────────────────────────────────────────────────────
  if (hoursToExpiry <= 3 && detectSoccerLeague(t)) {
    try {
      const lineup = await fetchSoccerLineup(ticker, hoursToExpiry);
      if (lineup?.confirmed) {
        return {
          sport: "soccer",
          section: `## ⚽ Confirmed Starting Lineups (ESPN)\n${formatSoccerLineup(lineup)}\n\nIMPORTANT: Analyze the absence of key attackers (strikers, #10) vs normal lineup. Missing a top scorer reduces goal expectation by 0.3-0.5 goals. Key defensive absences increase the other team's goal expectation.`,
        };
      }
      if (hoursToExpiry <= 1.5) {
        return {
          sport: "soccer",
          section: "## ⚽ Lineup Status\n⚠️ Game is within 90 minutes of kickoff but lineups are not yet confirmed on ESPN. Factor in lineup uncertainty — avoid high-confidence calls unless you have strong signal from other sources.",
        };
      }
    } catch {
      return null;
    }
  }

  return null;
}
