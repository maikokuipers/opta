import * as fs from "fs";
import * as path from "path";
import config from "./config";
import { MatchData, ScrapedData, StatType } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "stats.json");

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

/**
 * Mapping van ESPN stat namen naar onze StatType
 */
const ESPN_STAT_MAP: Record<string, StatType> = {
  totalShots: "totalShots",
  shotsOnTarget: "shotsOnTarget",
  wonCorners: "corners",
  possessionPct: "possession",
  foulsCommitted: "fouls",
  yellowCards: "yellowCards",
  redCards: "redCards",
  offsides: "offsides",
  saves: "saves",
};

// ==============================
//  ESPN API Fetching
// ==============================

async function fetchJSON(url: string): Promise<any> {
  console.log(`  Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Haal alle wedstrijden op van het ESPN scoreboard.
 * Dit geeft alle WK 2026 wedstrijden met scores.
 */
async function fetchScoreboard(): Promise<any[]> {
  // Haal meerdere datumranges op om alle wedstrijden te dekken
  const data = await fetchJSON(`${ESPN_BASE}/scoreboard`);
  return data.events || [];
}

/**
 * Haal gedetailleerde statistieken op voor een specifieke wedstrijd.
 */
async function fetchMatchSummary(eventId: string): Promise<any> {
  return fetchJSON(`${ESPN_BASE}/summary?event=${eventId}`);
}

/**
 * Parse ESPN team stats naar onze StatType format.
 */
function parseTeamStats(espnTeam: any): Partial<Record<StatType, string>> {
  const stats: Partial<Record<StatType, string>> = {};
  const espnStats = espnTeam.statistics || [];

  for (const stat of espnStats) {
    const mapped = ESPN_STAT_MAP[stat.name];
    if (mapped) {
      // Possession als percentage weergeven
      if (mapped === "possession") {
        stats[mapped] = `${stat.displayValue}%`;
      } else {
        stats[mapped] = stat.displayValue;
      }
    }
  }

  return stats;
}

/**
 * Parse een ESPN event naar ons MatchData format.
 */
function parseBasicMatch(event: any): MatchData | null {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  // ESPN: homeAway property bepaalt thuis/uit
  const home = competitors.find((c: any) => c.homeAway === "home") || competitors[0];
  const away = competitors.find((c: any) => c.homeAway === "away") || competitors[1];

  if (!home || !away) return null;

  const statusType = competition.status?.type;
  let status = "Upcoming";
  if (statusType?.completed) {
    status = "FT";
  } else if (statusType?.state === "in") {
    const clock = competition.status?.displayClock || "";
    const period = competition.status?.period || 0;
    status = clock ? `Live ${clock}'` : "Live";
    if (period === 2) status = `Live 2H ${clock}'`;
  } else if (statusType?.state === "post") {
    status = statusType?.detail || "FT";
  }

  const homeScore = home.score || "0";
  const awayScore = away.score || "0";
  const score = statusType?.state === "pre" ? "" : `${homeScore} - ${awayScore}`;

  // Datum formatteren
  const dateStr = event.date || competition.date || "";
  let formattedDate = "";
  if (dateStr) {
    const d = new Date(dateStr);
    formattedDate = d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  return {
    matchId: event.id || "",
    matchUrl: `https://www.espn.com/soccer/match/_/gameId/${event.id}`,
    homeTeam: {
      teamName: home.team?.displayName || home.team?.name || "Unknown",
      stats: {},
      players: {},
    },
    awayTeam: {
      teamName: away.team?.displayName || away.team?.name || "Unknown",
      stats: {},
      players: {},
    },
    score,
    date: formattedDate,
    status,
    competition: config.tournamentName,
  };
}

/**
 * Voeg gedetailleerde stats toe aan een match via de summary endpoint.
 */
async function enrichWithStats(match: MatchData): Promise<MatchData> {
  try {
    const summary = await fetchMatchSummary(match.matchId);
    const boxscoreTeams = summary.boxscore?.teams || [];

    if (boxscoreTeams.length >= 2) {
      // ESPN boxscore teams volgorde kan verschillen, match op naam
      for (const espnTeam of boxscoreTeams) {
        const teamName = espnTeam.team?.displayName || "";
        const stats = parseTeamStats(espnTeam);

        if (teamName === match.homeTeam.teamName) {
          match.homeTeam.stats = stats;
        } else if (teamName === match.awayTeam.teamName) {
          match.awayTeam.stats = stats;
        }
      }

      // Als matching op naam niet lukte, gebruik volgorde
      if (Object.keys(match.homeTeam.stats).length === 0 && boxscoreTeams[0]) {
        match.homeTeam.stats = parseTeamStats(boxscoreTeams[0]);
      }
      if (Object.keys(match.awayTeam.stats).length === 0 && boxscoreTeams[1]) {
        match.awayTeam.stats = parseTeamStats(boxscoreTeams[1]);
      }
    }

    // Log de stats
    console.log(
      `  ${match.homeTeam.teamName} ${match.score} ${match.awayTeam.teamName} [${match.status}]`
    );
    for (const stat of config.enabledStats) {
      const home = match.homeTeam.stats[stat] || "-";
      const away = match.awayTeam.stats[stat] || "-";
      if (home !== "-" || away !== "-") {
        console.log(`    ${stat}: ${home} - ${away}`);
      }
    }
  } catch (err: any) {
    console.log(`  Could not fetch stats for ${match.matchId}: ${err.message}`);
  }

  return match;
}

// ==============================
//  Data Persistence
// ==============================

function saveData(data: ScrapedData): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
  console.log(`\nData saved to ${DATA_FILE}`);
}

export function loadData(): ScrapedData | null {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")) as ScrapedData;
  } catch {
    return null;
  }
}

// ==============================
//  Public API
// ==============================

/**
 * Haal alle wedstrijden op via ESPN API.
 */
export async function scrapeAll(): Promise<ScrapedData> {
  console.log("=== WK 2026 Stats (ESPN API) ===");
  console.log(`Stats: ${config.enabledStats.join(", ")}\n`);

  const events = await fetchScoreboard();
  console.log(`Found ${events.length} matches on scoreboard\n`);

  const matches: MatchData[] = [];

  for (const event of events) {
    const match = parseBasicMatch(event);
    if (!match) continue;

    // Alleen stats ophalen voor wedstrijden die al gespeeld zijn of live zijn
    if (match.status !== "Upcoming") {
      await enrichWithStats(match);
    } else {
      console.log(
        `  ${match.homeTeam.teamName} vs ${match.awayTeam.teamName} [${match.status}] - skipping stats`
      );
    }

    matches.push(match);
  }

  const result: ScrapedData = {
    lastUpdated: new Date().toISOString(),
    matches,
  };

  saveData(result);
  console.log(`\nDone! ${matches.length} matches fetched.`);
  return result;
}

/**
 * Haal een specifieke wedstrijd op via ESPN event ID of URL.
 */
export async function scrapeSingleMatch(input: string): Promise<MatchData | null> {
  // Extract event ID uit URL of gebruik direct
  let eventId = input.trim();
  const urlMatch = input.match(/gameId\/(\d+)/);
  if (urlMatch) {
    eventId = urlMatch[1];
  }
  // Als het puur een nummer is, gebruik het als event ID
  if (!/^\d+$/.test(eventId)) {
    console.log(`Invalid event ID: ${eventId}`);
    return null;
  }

  console.log(`Fetching match ${eventId} from ESPN...`);

  try {
    const summary = await fetchMatchSummary(eventId);
    const header = summary.header;

    if (!header) {
      console.log("No match data found");
      return null;
    }

    const competition = header.competitions?.[0];
    const competitors = competition?.competitors || [];
    const home = competitors.find((c: any) => c.homeAway === "home") || competitors[0];
    const away = competitors.find((c: any) => c.homeAway === "away") || competitors[1];

    if (!home || !away) return null;

    const statusType = competition?.status?.type;
    let status = "Upcoming";
    if (statusType?.completed) status = "FT";
    else if (statusType?.state === "in") status = "Live";

    const homeScore = home.score || "0";
    const awayScore = away.score || "0";

    const match: MatchData = {
      matchId: eventId,
      matchUrl: `https://www.espn.com/soccer/match/_/gameId/${eventId}`,
      homeTeam: {
        teamName: home.team?.displayName || "Unknown",
        stats: {},
        players: {},
      },
      awayTeam: {
        teamName: away.team?.displayName || "Unknown",
        stats: {},
        players: {},
      },
      score: `${homeScore} - ${awayScore}`,
      date: new Date(header.gameDate || "").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
      status,
      competition: config.tournamentName,
    };

    // Stats toevoegen
    const boxscoreTeams = summary.boxscore?.teams || [];
    for (const espnTeam of boxscoreTeams) {
      const teamName = espnTeam.team?.displayName || "";
      const stats = parseTeamStats(espnTeam);

      if (teamName === match.homeTeam.teamName) {
        match.homeTeam.stats = stats;
      } else if (teamName === match.awayTeam.teamName) {
        match.awayTeam.stats = stats;
      }
    }

    // Merge met bestaande data
    const existing = loadData() || { lastUpdated: "", matches: [] };
    const idx = existing.matches.findIndex((m) => m.matchId === match.matchId);
    if (idx >= 0) {
      existing.matches[idx] = match;
    } else {
      existing.matches.push(match);
    }
    existing.lastUpdated = new Date().toISOString();
    saveData(existing);

    return match;
  } catch (err: any) {
    console.error(`Failed to fetch match: ${err.message}`);
    return null;
  }
}

// Direct uitvoeren
if (require.main === module) {
  scrapeAll().catch(console.error);
}
