import config from "./config";
import { MatchData, PlayerStat, ScrapedData, StatType } from "./types";

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
//  Public API
// ==============================

/**
 * Haal alle wedstrijden op via de ESPN API.
 * Geen disk I/O - caching wordt door de server afgehandeld.
 */
export async function fetchAllMatches(): Promise<ScrapedData> {
  console.log(`Fetching WK 2026 data from ESPN API...`);

  const events = await fetchScoreboard();
  console.log(`Found ${events.length} matches\n`);

  const matches: MatchData[] = [];

  for (const event of events) {
    const match = parseBasicMatch(event);
    if (!match) continue;

    // Alleen detail-stats ophalen voor gespeelde of live wedstrijden
    if (match.status !== "Upcoming") {
      await enrichWithStats(match);
    }

    matches.push(match);
  }

  console.log(`Done: ${matches.length} matches (${matches.filter(m => m.status !== "Upcoming").length} with stats)`);

  return {
    lastUpdated: new Date().toISOString(),
    matches,
  };
}

/**
 * Ververs alleen live/actieve wedstrijden.
 * Pakt bestaande cached data en update alleen de matches
 * die live zijn of vandaag gespeeld worden.
 */
export async function refreshLiveMatches(
  existing: ScrapedData
): Promise<ScrapedData> {
  console.log("Refreshing live matches only...");

  const events = await fetchScoreboard();
  const updatedMatches = [...existing.matches];
  let refreshed = 0;

  for (const event of events) {
    const fresh = parseBasicMatch(event);
    if (!fresh) continue;

    const isLiveOrRecent =
      fresh.status !== "Upcoming" && fresh.status !== "FT";
    // Ook FT wedstrijden van vandaag verversen (score kan net veranderd zijn)
    const todayStr = new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    const isToday = fresh.date === todayStr;

    if (isLiveOrRecent || isToday) {
      await enrichWithStats(fresh);
      refreshed++;

      // Bestaande match updaten of toevoegen
      const idx = updatedMatches.findIndex((m) => m.matchId === fresh.matchId);
      if (idx >= 0) {
        updatedMatches[idx] = fresh;
      } else {
        updatedMatches.push(fresh);
      }
    } else {
      // Niet-live match: alleen basis-info updaten (score/status)
      // als die nog niet in de cache zit
      const idx = updatedMatches.findIndex((m) => m.matchId === fresh.matchId);
      if (idx < 0) {
        updatedMatches.push(fresh);
      } else if (updatedMatches[idx].status === "Upcoming" && fresh.status !== "Upcoming") {
        // Was upcoming, is nu gespeeld -> vol ophalen
        await enrichWithStats(fresh);
        updatedMatches[idx] = fresh;
        refreshed++;
      }
    }
  }

  console.log(`Refreshed ${refreshed} live/today matches`);

  return {
    lastUpdated: new Date().toISOString(),
    matches: updatedMatches,
  };
}
