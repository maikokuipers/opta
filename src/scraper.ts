import * as fs from "fs";
import * as path from "path";
import config from "./config";
import { MatchData, PlayerStat, ScrapedData, StatType } from "./types";

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

/**
 * ESPN stat namen op speler-niveau die we willen extraheren.
 * Deze komen uit de rosters[].roster[].stats[] array.
 */
const ESPN_PLAYER_STAT_MAP: Record<string, StatType> = {
  totalShots: "totalShots",
  shotsOnTarget: "shotsOnTarget",
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
 * Fetcht meerdere dagen om zowel gespeelde als toekomstige wedstrijden te dekken.
 */
async function fetchScoreboard(): Promise<any[]> {
  const allEvents: any[] = [];
  const seenIds = new Set<string>();

  // Tournament start: 11 juni 2026, eindigt 19 juli 2026
  const tournamentStart = new Date("2026-06-11");
  const tournamentEnd = new Date("2026-07-19");
  const today = new Date();

  // Fetch van start tot vandaag + 7 dagen vooruit (of tot einde toernooi)
  const fetchEnd = new Date(Math.min(
    today.getTime() + 7 * 24 * 60 * 60 * 1000,
    tournamentEnd.getTime()
  ));
  const fetchStart = new Date(Math.max(tournamentStart.getTime(), today.getTime() - 60 * 24 * 60 * 60 * 1000));

  // Genereer datums in YYYYMMDD formaat
  const dates: string[] = [];
  const current = new Date(fetchStart);
  while (current <= fetchEnd) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, "0");
    const d = String(current.getDate()).padStart(2, "0");
    dates.push(`${y}${m}${d}`);
    current.setDate(current.getDate() + 1);
  }

  console.log(`Fetching scoreboard for ${dates.length} days (${dates[0]} - ${dates[dates.length - 1]})`);

  for (const date of dates) {
    try {
      const data = await fetchJSON(`${ESPN_BASE}/scoreboard?dates=${date}`);
      for (const event of data.events || []) {
        if (!seenIds.has(event.id)) {
          seenIds.add(event.id);
          allEvents.push(event);
        }
      }
    } catch (err: any) {
      console.log(`  Skipping date ${date}: ${err.message}`);
    }
  }

  return allEvents;
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
 * Parse per-speler stats uit een ESPN roster.
 * Retourneert een map van StatType -> gesorteerde lijst van spelers met waarde > 0.
 */
function parsePlayerStats(
  rosterPlayers: any[]
): Partial<Record<StatType, PlayerStat[]>> {
  const result: Partial<Record<StatType, PlayerStat[]>> = {};

  for (const player of rosterPlayers) {
    const name: string = player.athlete?.displayName || "";
    if (!name) continue;

    const playerStats: Record<string, number> = {};
    for (const s of player.stats || []) {
      playerStats[s.name] = s.value ?? 0;
    }

    // Map relevante stats
    for (const [espnName, statType] of Object.entries(ESPN_PLAYER_STAT_MAP)) {
      const val = playerStats[espnName];
      if (val && val > 0) {
        if (!result[statType]) {
          result[statType] = [];
        }
        result[statType]!.push({ name, value: val });
      }
    }
  }

  // Sorteer elke stat-lijst op waarde (hoog -> laag)
  for (const statType of Object.keys(result) as StatType[]) {
    result[statType]!.sort((a, b) => b.value - a.value);
  }

  return result;
}

/**
 * Voeg gedetailleerde stats toe aan een match via de summary endpoint.
 */
async function enrichWithStats(match: MatchData): Promise<MatchData> {
  try {
    const summary = await fetchMatchSummary(match.matchId);
    const boxscoreTeams = summary.boxscore?.teams || [];

    // ---- Team-totaal stats ----
    if (boxscoreTeams.length >= 2) {
      for (const espnTeam of boxscoreTeams) {
        const teamName = espnTeam.team?.displayName || "";
        const stats = parseTeamStats(espnTeam);

        if (teamName === match.homeTeam.teamName) {
          match.homeTeam.stats = stats;
        } else if (teamName === match.awayTeam.teamName) {
          match.awayTeam.stats = stats;
        }
      }

      // Fallback op volgorde
      if (Object.keys(match.homeTeam.stats).length === 0 && boxscoreTeams[0]) {
        match.homeTeam.stats = parseTeamStats(boxscoreTeams[0]);
      }
      if (Object.keys(match.awayTeam.stats).length === 0 && boxscoreTeams[1]) {
        match.awayTeam.stats = parseTeamStats(boxscoreTeams[1]);
      }
    }

    // ---- Per-speler stats uit rosters ----
    const rosters = summary.rosters || [];
    for (const roster of rosters) {
      const teamName = roster.team?.displayName || "";
      const rosterPlayers = roster.roster || [];
      const players = parsePlayerStats(rosterPlayers);

      if (teamName === match.homeTeam.teamName) {
        match.homeTeam.players = players;
      } else if (teamName === match.awayTeam.teamName) {
        match.awayTeam.players = players;
      }
    }

    // Fallback op volgorde als naam-matching niet lukte
    if (
      Object.keys(match.homeTeam.players).length === 0 &&
      Object.keys(match.awayTeam.players).length === 0 &&
      rosters.length >= 2
    ) {
      match.homeTeam.players = parsePlayerStats(rosters[0].roster || []);
      match.awayTeam.players = parsePlayerStats(rosters[1].roster || []);
    }

    // Log
    console.log(
      `  ${match.homeTeam.teamName} ${match.score} ${match.awayTeam.teamName} [${match.status}]`
    );
    for (const stat of config.enabledStats) {
      const home = match.homeTeam.stats[stat] || "-";
      const away = match.awayTeam.stats[stat] || "-";
      if (home !== "-" || away !== "-") {
        console.log(`    ${stat}: ${home} - ${away}`);
      }
      // Log spelers
      const homePlayers = match.homeTeam.players[stat] || [];
      const awayPlayers = match.awayTeam.players[stat] || [];
      if (homePlayers.length > 0) {
        console.log(
          `      Home: ${homePlayers.map((p) => `${p.name} (${p.value})`).join(", ")}`
        );
      }
      if (awayPlayers.length > 0) {
        console.log(
          `      Away: ${awayPlayers.map((p) => `${p.name} (${p.value})`).join(", ")}`
        );
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

    // Team stats toevoegen
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

    // Per-speler stats uit rosters
    const rosters = summary.rosters || [];
    for (const roster of rosters) {
      const teamName = roster.team?.displayName || "";
      const players = parsePlayerStats(roster.roster || []);

      if (teamName === match.homeTeam.teamName) {
        match.homeTeam.players = players;
      } else if (teamName === match.awayTeam.teamName) {
        match.awayTeam.players = players;
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
