/**
 * Sharp Book Odds Comparison
 *
 * Fetches Pinnacle lines via The Odds API (the-odds-api.com) and compares
 * them to Kalshi's implied probabilities. When Kalshi misprices a market vs
 * the sharpest books in the world, it's a near-certain edge.
 *
 * Requires: ODDS_API_KEY environment variable (free tier = 500 req/month)
 * Cache: 30 min per sport to conserve quota
 *
 * Matching strategy:
 *   - Parse BOTH team codes from the Kalshi game slug (e.g. VILRSO → VIL + RSO)
 *   - Require BOTH teams present in the same Pinnacle game
 *   - Match game date within ±2 days (handles timezone differences)
 *   - Handles TIE markets (soccer draws) explicitly
 */

export interface SharpLine {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  /** Pinnacle's raw implied probability for YES */
  pinnacleYesProb: number;
  /** No-vig (true fair) probability for YES */
  noVigYesProb: number;
  /** Kalshi YES price minus no-vig probability, in pp. Negative = Kalshi underpriced (buy YES). */
  kalshiEdgeVsSharp: number;
  edgeSide: "YES" | "NO" | "NONE";
  bookmaker: string;
  updatedAt: number;
}

// ─── Sport prefix → Odds API sport key ───────────────────────────────────────

const SPORT_MAP: Record<string, string> = {
  KXNHLGAME:      "icehockey_nhl",
  KXNHLTOTAL:     "icehockey_nhl",
  KXNBAGAME:      "basketball_nba",
  KXNBATOTAL:     "basketball_nba",
  KXMLBGAME:      "baseball_mlb",
  KXLALIGAGAME:   "soccer_spain_la_liga",
  KXSERIEAGAME:   "soccer_italy_serie_a",
  KXUECLGAME:     "soccer_uefa_europa_league",
  KXUCLGAME:      "soccer_uefa_champions_league",
  KXMLS:          "soccer_usa_mls",
  KXBUNDESLIGAGAME: "soccer_germany_bundesliga",
  KXPREMGAME:     "soccer_epl",
};

// ─── Team code → full name ───────────────────────────────────────────────────

const NHL_TEAMS: Record<string, string> = {
  ANA:"Anaheim Ducks",ARI:"Arizona Coyotes",BOS:"Boston Bruins",BUF:"Buffalo Sabres",
  CAR:"Carolina Hurricanes",CBJ:"Columbus Blue Jackets",CGY:"Calgary Flames",
  CHI:"Chicago Blackhawks",COL:"Colorado Avalanche",DAL:"Dallas Stars",
  DET:"Detroit Red Wings",EDM:"Edmonton Oilers",FLA:"Florida Panthers",
  LAK:"Los Angeles Kings",MIN:"Minnesota Wild",MTL:"Montreal Canadiens",
  NJD:"New Jersey Devils",NSH:"Nashville Predators",NYI:"New York Islanders",
  NYR:"New York Rangers",OTT:"Ottawa Senators",PHI:"Philadelphia Flyers",
  PIT:"Pittsburgh Penguins",SEA:"Seattle Kraken",SJS:"San Jose Sharks",
  STL:"St. Louis Blues",TB:"Tampa Bay Lightning",TOR:"Toronto Maple Leafs",
  UTA:"Utah Hockey Club",VAN:"Vancouver Canucks",VGK:"Vegas Golden Knights",
  WPG:"Winnipeg Jets",WSH:"Washington Capitals",
};

const NBA_TEAMS: Record<string, string> = {
  ATL:"Atlanta Hawks",BKN:"Brooklyn Nets",BOS:"Boston Celtics",CHA:"Charlotte Hornets",
  CHI:"Chicago Bulls",CLE:"Cleveland Cavaliers",DAL:"Dallas Mavericks",DEN:"Denver Nuggets",
  DET:"Detroit Pistons",GSW:"Golden State Warriors",HOU:"Houston Rockets",IND:"Indiana Pacers",
  LAC:"Los Angeles Clippers",LAL:"Los Angeles Lakers",MEM:"Memphis Grizzlies",
  MIA:"Miami Heat",MIL:"Milwaukee Bucks",MIN:"Minnesota Timberwolves",
  NOP:"New Orleans Pelicans",NYK:"New York Knicks",OKC:"Oklahoma City Thunder",
  ORL:"Orlando Magic",PHI:"Philadelphia 76ers",PHX:"Phoenix Suns",
  POR:"Portland Trail Blazers",SAC:"Sacramento Kings",SAS:"San Antonio Spurs",
  TOR:"Toronto Raptors",UTA:"Utah Jazz",WAS:"Washington Wizards",
};

const MLB_TEAMS: Record<string, string> = {
  ARI:"Arizona Diamondbacks",ATL:"Atlanta Braves",BAL:"Baltimore Orioles",
  BOS:"Boston Red Sox",CHC:"Chicago Cubs",CHW:"Chicago White Sox",
  CIN:"Cincinnati Reds",CLE:"Cleveland Guardians",COL:"Colorado Rockies",
  DET:"Detroit Tigers",HOU:"Houston Astros",KCR:"Kansas City Royals",
  LAA:"Los Angeles Angels",LAD:"Los Angeles Dodgers",MIA:"Miami Marlins",
  MIL:"Milwaukee Brewers",MIN:"Minnesota Twins",NYM:"New York Mets",
  NYY:"New York Yankees",OAK:"Oakland Athletics",PHI:"Philadelphia Phillies",
  PIT:"Pittsburgh Pirates",SDP:"San Diego Padres",SEA:"Seattle Mariners",
  SFG:"San Francisco Giants",STL:"St. Louis Cardinals",TB:"Tampa Bay Rays",
  TEX:"Texas Rangers",TOR:"Toronto Blue Jays",WSN:"Washington Nationals",
};

// Soccer: Kalshi uses custom 2-3 letter abbreviations per league
// La Liga
const LALIGA_TEAMS: Record<string, string> = {
  BAR:"Barcelona",REA:"Real Madrid",ATM:"Atletico Madrid",SEV:"Sevilla",
  VIL:"Villarreal",RSO:"Real Sociedad",BET:"Real Betis",VAL:"Valencia",
  CEL:"Celta Vigo",ATH:"Athletic Bilbao",OSA:"Osasuna",RMA:"Real Madrid",
  GIR:"Girona",MAL:"Mallorca",LAP:"Las Palmas",LPA:"Las Palmas",
  ALA:"Alaves",LEV:"Levante",ESP:"Espanyol",GET:"Getafe",
  RAY:"Rayo Vallecano",RET:"Rayo Vallecano",ELC:"Elche",OVI:"Oviedo",
  MIR:"Mirandes",VAD:"Valladolid",DEP:"Deportivo",GRA:"Granada",
  ALM:"Almeria",CAD:"Cadiz",VDA:"Valladolid",EIB:"Eibar",HUE:"Huesca",
  COR:"Cordoba",CAR:"Cartagena",ALC:"Alcorcon",MUR:"Murcia",
};

// Serie A
const SERIEA_TEAMS: Record<string, string> = {
  INT:"Inter Milan",JUV:"Juventus",MIL:"AC Milan",NAP:"Napoli",
  FIO:"Fiorentina",ROM:"Roma",LAZ:"Lazio",ATA:"Atalanta",
  BOL:"Bologna",TOR:"Torino",EMP:"Empoli",UDI:"Udinese",
  PAR:"Parma",COM:"Como",MON:"Monza",CAG:"Cagliari",
  VEN:"Venezia",GEN:"Genoa",LEC:"Lecce",CRE:"Cremonese",
  SAL:"Salernitana",HEL:"Hellas Verona",VER:"Hellas Verona",
  SPE:"Spezia",SAM:"Sampdoria",SAS:"Sassuolo",
};

// Europa/Champions League: mixture of clubs from all countries
const UCL_TEAMS: Record<string, string> = {
  MCI:"Manchester City",LIV:"Liverpool",ARS:"Arsenal",CHE:"Chelsea",
  MUN:"Manchester United",TOT:"Tottenham",NEW:"Newcastle",
  BAR:"Barcelona",REA:"Real Madrid",ATM:"Atletico Madrid",
  VIL:"Villarreal",RSO:"Real Sociedad",SEV:"Sevilla",
  BAY:"Bayern Munich",BVB:"Borussia Dortmund",FRA:"Eintracht Frankfurt",
  LEV:"Bayer Leverkusen",RBL:"RB Leipzig",STU:"Stuttgart",
  PSG:"Paris Saint-Germain",LYO:"Lyon",OLY:"Olympique Marseille",
  INT:"Inter Milan",JUV:"Juventus",MIL:"AC Milan",NAP:"Napoli",
  FIO:"Fiorentina",ROM:"Roma",ATA:"Atalanta",
  AJA:"Ajax",PSV:"PSV Eindhoven",FEY:"Feyenoord",
  BEN:"Benfica",SPO:"Sporting CP",POR:"Porto",
  CEL:"Celtic",RAN:"Rangers",
  GAL:"Galatasaray",FEN:"Fenerbahce",BES:"Besiktas",
  ZEN:"Zenit",SHA:"Shakhtar Donetsk",DYN:"Dynamo Kyiv",
  SHE:"Shakhtar",MAC:"PAOK",OLM:"Olympiakos",
};

function getTeamName(code: string, sport: string): string | null {
  const c = code.toUpperCase();
  if (sport.includes("nhl")) return NHL_TEAMS[c] ?? null;
  if (sport.includes("nba")) return NBA_TEAMS[c] ?? null;
  if (sport.includes("mlb")) return MLB_TEAMS[c] ?? null;
  if (sport.includes("la_liga")) return LALIGA_TEAMS[c] ?? null;
  if (sport.includes("serie_a")) return SERIEA_TEAMS[c] ?? null;
  if (sport.includes("europa") || sport.includes("champions")) return UCL_TEAMS[c] ?? LALIGA_TEAMS[c] ?? SERIEA_TEAMS[c] ?? null;
  // Fallback: try all soccer maps
  return LALIGA_TEAMS[c] ?? SERIEA_TEAMS[c] ?? UCL_TEAMS[c] ?? null;
}

// ─── Parse Kalshi game ticker ─────────────────────────────────────────────────

interface ParsedGameTicker {
  prefix: string;
  sport: string;
  isTie: boolean;       // TIE market (soccer draw)
  targetTeamCode: string;
  opponentTeamCode: string;
  targetTeamName: string | null;
  opponentTeamName: string | null;
  gameDate: Date | null; // parsed game date for matching
  gameSlug: string;
}

// Months: Kalshi uses uppercase abbreviations (MAR, APR, etc.)
const MONTHS: Record<string, number> = {
  JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11,
};

function parseGameTicker(ticker: string): ParsedGameTicker | null {
  const parts = ticker.split("-");
  if (parts.length < 3) return null;

  const prefix = parts[0];
  const sport = SPORT_MAP[prefix];
  if (!sport) return null;

  const lastPart = parts[parts.length - 1].toUpperCase();
  const isTie = lastPart === "TIE";
  const targetTeamCode = isTie ? "TIE" : lastPart;

  // Middle segment = date + game slug, e.g. "26MAR21VILRSO"
  const gamePart = parts.slice(1, -1).join("-");
  const dateMatch = gamePart.match(/^(\d{2})([A-Z]{3})(\d{2})(.+)$/);
  if (!dateMatch) return null;

  const [, yy, mon, dd, gameSlug] = dateMatch;
  const monthNum = MONTHS[mon];
  const gameDate = monthNum !== undefined
    ? new Date(2000 + parseInt(yy), monthNum, parseInt(dd))
    : null;

  // Split game slug into two team codes — usually 3+3 chars
  // For soccer: VILRSO → VIL + RSO; ESPGET → ESP + GET
  // For NA sports: WPGBOS → WPG + BOS; NJRNY → NJD + NYR (doesn't split cleanly)
  let code1 = "", code2 = "";
  if (isTie) {
    // For TIE markets we know: slug = team1 + team2
    code1 = gameSlug.slice(0, Math.ceil(gameSlug.length / 2));
    code2 = gameSlug.slice(Math.ceil(gameSlug.length / 2));
  } else {
    // Non-TIE: one team IS targetTeamCode, the other is the remainder
    if (gameSlug.startsWith(targetTeamCode)) {
      code1 = targetTeamCode;
      code2 = gameSlug.slice(targetTeamCode.length);
    } else if (gameSlug.endsWith(targetTeamCode)) {
      code1 = gameSlug.slice(0, gameSlug.length - targetTeamCode.length);
      code2 = targetTeamCode;
    } else {
      // Fallback: split at midpoint
      code1 = gameSlug.slice(0, Math.ceil(gameSlug.length / 2));
      code2 = gameSlug.slice(Math.ceil(gameSlug.length / 2));
    }
  }

  const opponentTeamCode = isTie
    ? code1 // doesn't matter which we call target vs opponent for TIE
    : (code1 === targetTeamCode ? code2 : code1);

  return {
    prefix, sport, isTie, targetTeamCode, opponentTeamCode,
    targetTeamName: isTie ? null : getTeamName(targetTeamCode, sport),
    opponentTeamName: getTeamName(opponentTeamCode, sport),
    gameDate,
    gameSlug,
  };
}

// ─── Odds API fetch + cache ───────────────────────────────────────────────────

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
    // Soccer markets need eu region for Pinnacle to have lines
    const isSoccer = sport.startsWith("soccer_");
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`);
    url.searchParams.set("apiKey", apiKey);
    url.searchParams.set("regions", isSoccer ? "eu" : "us");
    url.searchParams.set("markets", "h2h");
    url.searchParams.set("bookmakers", "pinnacle");
    url.searchParams.set("oddsFormat", "decimal");

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
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

// ─── Game matching ─────────────────────────────────────────────────────────────

function nameContains(fullName: string, fragment: string | null): boolean {
  if (!fragment) return false;
  const f = fullName.toLowerCase();
  const words = fragment.toLowerCase().split(" ");
  // Match if ANY word of the team name is found in the Pinnacle name
  return words.some((w) => w.length > 3 && f.includes(w));
}

function findMatchingGame(
  parsed: ParsedGameTicker,
  games: OddsApiGame[]
): OddsApiGame | null {
  const { targetTeamName, opponentTeamName, gameDate, isTie, gameSlug } = parsed;

  // For TIE markets, we need to find the game using the slug codes
  // We split the slug in half and look up both team names
  const sportMap = parsed.sport;
  let name1: string | null = targetTeamName;
  let name2: string | null = opponentTeamName;

  if (isTie) {
    const half = Math.ceil(gameSlug.length / 2);
    const c1 = gameSlug.slice(0, half);
    const c2 = gameSlug.slice(half);
    name1 = getTeamName(c1, sportMap);
    name2 = getTeamName(c2, sportMap);
  }

  if (!name1 && !name2) return null;

  return games.find((g) => {
    // Both teams must be present in the game (home or away)
    const teams = [g.home_team, g.away_team];
    const matchTarget = name1 ? teams.some((t) => nameContains(t, name1)) : true;
    const matchOpponent = name2 ? teams.some((t) => nameContains(t, name2)) : true;
    if (!matchTarget || !matchOpponent) return false;

    // Date check: game must be within ±3 days of Kalshi game date
    if (gameDate) {
      const pinnDate = new Date(g.commence_time);
      const diffDays = Math.abs(pinnDate.getTime() - gameDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays > 3) return false;
    }

    return true;
  }) ?? null;
}

// ─── Main exports ──────────────────────────────────────────────────────────────

export async function getSharpLine(
  ticker: string,
  kalshiYesPrice: number
): Promise<SharpLine | null> {
  if (!process.env.ODDS_API_KEY) return null;

  const parsed = parseGameTicker(ticker);
  if (!parsed) return null;

  // For non-TIE markets we need at least the target team name
  if (!parsed.isTie && !parsed.targetTeamName && !parsed.opponentTeamName) return null;

  const games = await fetchOddsForSport(parsed.sport);
  if (!games.length) return null;

  const game = findMatchingGame(parsed, games);
  if (!game) return null;

  const bookmaker = game.bookmakers.find((b) => b.key === "pinnacle") ?? game.bookmakers[0];
  if (!bookmaker) return null;

  const h2h = bookmaker.markets.find((m) => m.key === "h2h");
  if (!h2h || h2h.outcomes.length < 2) return null;

  // Compute no-vig probabilities
  const implied = h2h.outcomes.map((o) => ({ name: o.name, imp: 1 / o.price }));
  const totalImplied = implied.reduce((s, p) => s + p.imp, 0);
  const noVigProbs = implied.map((o) => ({ name: o.name, noVig: o.imp / totalImplied, raw: o.imp }));

  let targetOutcome: { name: string; noVig: number; raw: number } | undefined;

  if (parsed.isTie) {
    // Soccer draw market — look for "Draw" outcome
    targetOutcome = noVigProbs.find((o) => o.name.toLowerCase().includes("draw"));
  } else {
    // Team win market — match by team name
    const tName = parsed.targetTeamName!;
    targetOutcome = noVigProbs.find((o) => nameContains(o.name, tName));
  }

  if (!targetOutcome) return null;

  const noVigYesProb = targetOutcome.noVig;
  const pinnacleYesProb = targetOutcome.raw;
  const kalshiEdgeVsSharp = (kalshiYesPrice - noVigYesProb) * 100;
  const MIN_EDGE_PP = 3;

  const edgeSide: "YES" | "NO" | "NONE" =
    kalshiEdgeVsSharp <= -MIN_EDGE_PP ? "YES"
    : kalshiEdgeVsSharp >= MIN_EDGE_PP ? "NO"
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
