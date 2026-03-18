/**
 * Sharp Book Odds Comparison
 *
 * Fetches Pinnacle / NoVig lines from The Odds API (the-odds-api.com) and
 * compares them to Kalshi's implied probabilities. When Kalshi misprices a
 * market vs. the sharpest books in the world, it's a near-certain edge.
 *
 * Requires: ODDS_API_KEY environment variable (free tier = 500 req/month)
 * Get a key at: https://the-odds-api.com
 *
 * Usage:
 *   - Returns null gracefully when no key is set (non-fatal)
 *   - Caches results for 30 min to avoid burning free quota
 *   - Maps Kalshi ticker patterns to Odds API sport keys + team names
 */

export interface SharpLine {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  /** Pinnacle's implied probability for YES (home/team referenced in the Kalshi ticker) */
  pinnacleYesProb: number;
  /** No-vig (true fair) probability for YES */
  noVigYesProb: number;
  /** How far Kalshi's YES price deviates from the no-vig probability (pp) */
  kalshiEdgeVsSharp: number;
  /** Which side has the edge: "YES" | "NO" | "NONE" */
  edgeSide: "YES" | "NO" | "NONE";
  bookmaker: string;
  updatedAt: number;
}

// ─── Sport prefix → Odds API sport key ───────────────────────────────────────

const SPORT_MAP: Record<string, string> = {
  KXNHLGAME: "icehockey_nhl",
  KXNHLTOTAL: "icehockey_nhl",
  KXNBAGAME: "basketball_nba",
  KXNBATOTAL: "basketball_nba",
  KXMLBGAME: "baseball_mlb",
  KXLALIGAGAME: "soccer_spain_la_liga",
  KXSERIEAGAME: "soccer_italy_serie_a",
  KXUECLGAME: "soccer_uefa_europa_league",
  KXMLS: "soccer_usa_mls",
  KXBUNDESLIGAGAME: "soccer_germany_bundesliga",
  KXPREMGAME: "soccer_epl",
};

// ─── 3-letter team code → full name (major NA sports) ────────────────────────

const NHL_TEAMS: Record<string, string> = {
  ANA: "Anaheim Ducks", ARI: "Arizona Coyotes", BOS: "Boston Bruins",
  BUF: "Buffalo Sabres", CAR: "Carolina Hurricanes", CBJ: "Columbus Blue Jackets",
  CGY: "Calgary Flames", CHI: "Chicago Blackhawks", COL: "Colorado Avalanche",
  DAL: "Dallas Stars", DET: "Detroit Red Wings", EDM: "Edmonton Oilers",
  FLA: "Florida Panthers", LAK: "Los Angeles Kings", MIN: "Minnesota Wild",
  MTL: "Montreal Canadiens", NJD: "New Jersey Devils", NSH: "Nashville Predators",
  NYI: "New York Islanders", NYR: "New York Rangers", OTT: "Ottawa Senators",
  PHI: "Philadelphia Flyers", PIT: "Pittsburgh Penguins", SEA: "Seattle Kraken",
  SJS: "San Jose Sharks", STL: "St. Louis Blues", TB: "Tampa Bay Lightning",
  TOR: "Toronto Maple Leafs", UTA: "Utah Hockey Club", VAN: "Vancouver Canucks",
  VGK: "Vegas Golden Knights", WPG: "Winnipeg Jets", WSH: "Washington Capitals",
};

const NBA_TEAMS: Record<string, string> = {
  ATL: "Atlanta Hawks", BKN: "Brooklyn Nets", BOS: "Boston Celtics",
  CHA: "Charlotte Hornets", CHI: "Chicago Bulls", CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks", DEN: "Denver Nuggets", DET: "Detroit Pistons",
  GSW: "Golden State Warriors", HOU: "Houston Rockets", IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers", LAL: "Los Angeles Lakers", MEM: "Memphis Grizzlies",
  MIA: "Miami Heat", MIL: "Milwaukee Bucks", MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans", NYK: "New York Knicks", OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic", PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers", SAC: "Sacramento Kings", SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors", UTA: "Utah Jazz", WAS: "Washington Wizards",
};

const MLB_TEAMS: Record<string, string> = {
  ARI: "Arizona Diamondbacks", ATL: "Atlanta Braves", BAL: "Baltimore Orioles",
  BOS: "Boston Red Sox", CHC: "Chicago Cubs", CHW: "Chicago White Sox",
  CIN: "Cincinnati Reds", CLE: "Cleveland Guardians", COL: "Colorado Rockies",
  DET: "Detroit Tigers", HOU: "Houston Astros", KCR: "Kansas City Royals",
  LAA: "Los Angeles Angels", LAD: "Los Angeles Dodgers", MIA: "Miami Marlins",
  MIL: "Milwaukee Brewers", MIN: "Minnesota Twins", NYM: "New York Mets",
  NYY: "New York Yankees", OAK: "Oakland Athletics", PHI: "Philadelphia Phillies",
  PIT: "Pittsburgh Pirates", SDP: "San Diego Padres", SEA: "Seattle Mariners",
  SFG: "San Francisco Giants", STL: "St. Louis Cardinals", TB: "Tampa Bay Rays",
  TEX: "Texas Rangers", TOR: "Toronto Blue Jays", WSN: "Washington Nationals",
};

function getTeamName(code: string, sport: string): string | null {
  const c = code.toUpperCase();
  if (sport.includes("nhl")) return NHL_TEAMS[c] ?? null;
  if (sport.includes("nba")) return NBA_TEAMS[c] ?? null;
  if (sport.includes("mlb")) return MLB_TEAMS[c] ?? null;
  return null;
}

// ─── Parse Kalshi game ticker ─────────────────────────────────────────────────

interface ParsedGameTicker {
  prefix: string;
  sport: string;
  /** 3-letter code of the team this specific market represents ("YES wins") */
  targetTeamCode: string;
  /** The other team in the matchup */
  opponentTeamCode: string;
  targetTeamName: string | null;
  opponentTeamName: string | null;
  gameSlug: string; // e.g. "WPGBOS"
}

/**
 * Parse a Kalshi game ticker like KXNHLGAME-26MAR19WPGBOS-WPG or
 * KXLALIGAGAME-26MAR16RVCLEV-LEV into its components.
 */
function parseGameTicker(ticker: string): ParsedGameTicker | null {
  const parts = ticker.split("-");
  if (parts.length < 3) return null;

  const prefix = parts[0];
  const sport = SPORT_MAP[prefix];
  if (!sport) return null;

  // Last segment = the team this market is for (YES = this team wins)
  const targetTeamCode = parts[parts.length - 1].toUpperCase();

  // Middle segments contain date + game slug, e.g. "26MAR19WPGBOS"
  // Extract by removing date prefix (6-9 chars: YYMMMdd)
  const gamePart = parts.slice(1, -1).join("-");
  const dateMatch = gamePart.match(/^\d{2}[A-Z]{3}\d{2}(.+)$/);
  if (!dateMatch) return null;

  const gameSlug = dateMatch[1]; // e.g. "WPGBOS" or "RVCLEV"
  // Opponent = the other team codes in the slug (remove our target from it)
  const opponentCode = gameSlug.replace(targetTeamCode, "");

  return {
    prefix,
    sport,
    targetTeamCode,
    opponentTeamCode: opponentCode,
    targetTeamName: getTeamName(targetTeamCode, sport),
    opponentTeamName: getTeamName(opponentCode, sport),
    gameSlug,
  };
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const cache = new Map<string, { data: OddsApiGame[]; fetchedAt: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

interface OddsApiBookmaker {
  key: string;
  title: string;
  markets: Array<{
    key: string;
    outcomes: Array<{ name: string; price: number }>;
  }>;
}

interface OddsApiGame {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  commence_time: string;
  bookmakers: OddsApiBookmaker[];
}

async function fetchOddsForSport(sport: string): Promise<OddsApiGame[]> {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return [];

  const cached = cache.get(sport);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "h2h");
    url.searchParams.set("bookmakers", "pinnacle");
    url.searchParams.set("oddsFormat", "decimal");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn(`[sharp-odds] Odds API ${sport} returned ${res.status}`);
      return [];
    }

    const data = (await res.json()) as OddsApiGame[];
    cache.set(sport, { data, fetchedAt: Date.now() });
    return data;
  } catch (err) {
    console.warn("[sharp-odds] fetch failed:", err);
    return [];
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Look up sharp book odds for a Kalshi game ticker.
 * Returns null if:
 *   - No ODDS_API_KEY env var is set
 *   - Ticker doesn't match a supported sport/game format
 *   - No matching game found in Pinnacle's feed
 */
export async function getSharpLine(
  ticker: string,
  kalshiYesPrice: number
): Promise<SharpLine | null> {
  if (!process.env.ODDS_API_KEY) return null;

  const parsed = parseGameTicker(ticker);
  if (!parsed || !parsed.targetTeamName) return null;

  const games = await fetchOddsForSport(parsed.sport);
  if (!games.length) return null;

  // Find the game that mentions our target team
  const targetName = parsed.targetTeamName.toLowerCase();
  const game = games.find((g) => {
    const home = g.home_team.toLowerCase();
    const away = g.away_team.toLowerCase();
    return home.includes(targetName.split(" ").pop()!) || away.includes(targetName.split(" ").pop()!);
  });

  if (!game) return null;

  // Find Pinnacle's h2h market
  const bookmaker = game.bookmakers.find((b) => b.key === "pinnacle") ?? game.bookmakers[0];
  if (!bookmaker) return null;

  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (!h2h || h2h.outcomes.length < 2) return null;

  // Determine which outcome corresponds to our target team
  const targetOutcome = h2h.outcomes.find((o) =>
    o.name.toLowerCase().includes(targetName.split(" ").pop()!)
  );
  if (!targetOutcome) return null;

  // Convert decimal odds to implied probabilities, then remove vig
  const implied = h2h.outcomes.map((o) => 1 / o.price);
  const totalImplied = implied.reduce((s, p) => s + p, 0);
  const targetImplied = 1 / targetOutcome.price;
  const noVigYesProb = totalImplied > 0 ? targetImplied / totalImplied : targetImplied;
  const pinnacleYesProb = targetImplied;

  // Edge = how far Kalshi is from the no-vig fair probability
  const kalshiEdgeVsSharp = (kalshiYesPrice - noVigYesProb) * 100; // in pp
  const MIN_EDGE_PP = 3;
  const edgeSide: "YES" | "NO" | "NONE" =
    kalshiEdgeVsSharp <= -MIN_EDGE_PP ? "YES"  // Kalshi is CHEAPER than fair → buy YES
      : kalshiEdgeVsSharp >= MIN_EDGE_PP ? "NO"  // Kalshi is MORE EXPENSIVE than fair → buy NO
        : "NONE";

  return {
    sport: parsed.sport,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    pinnacleYesProb: parseFloat(pinnacleYesProb.toFixed(4)),
    noVigYesProb: parseFloat(noVigYesProb.toFixed(4)),
    kalshiEdgeVsSharp: parseFloat(kalshiEdgeVsSharp.toFixed(2)),
    edgeSide,
    bookmaker: bookmaker.title,
    updatedAt: Date.now(),
  };
}

/**
 * Batch sharp line lookup for an array of scan candidates.
 */
export async function batchGetSharpLines(
  candidates: Array<{ ticker: string; yesPrice: number }>
): Promise<Map<string, SharpLine>> {
  const result = new Map<string, SharpLine>();
  if (!process.env.ODDS_API_KEY) return result;

  const results = await Promise.all(
    candidates.map(async ({ ticker, yesPrice }) => {
      const line = await getSharpLine(ticker, yesPrice).catch(() => null);
      return { ticker, line };
    })
  );

  for (const { ticker, line } of results) {
    if (line) result.set(ticker, line);
  }

  return result;
}
