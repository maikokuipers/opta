/**
 * Alle beschikbare statistiek-types die we kunnen scrapen.
 * Makkelijk uit te breiden: voeg hier een nieuw type toe en
 * update de STAT_LABELS mapping.
 */
export type StatType =
  | "goals"
  | "assists"
  | "totalShots"
  | "shotsOnTarget"
  | "shotsOffTarget"
  | "blockedShots"
  | "corners"
  | "possession"
  | "fouls"
  | "yellowCards"
  | "redCards"
  | "offsides"
  | "goalKicks"
  | "throwIns"
  | "saves";

/**
 * Labels zoals ze op de Opta website verschijnen.
 * Key = onze StatType, Value = tekst op de website.
 */
export const STAT_LABELS: Record<StatType, string> = {
  goals: "Goals",
  assists: "Assists",
  totalShots: "Total Shots",
  shotsOnTarget: "Shots On Target",
  shotsOffTarget: "Shots Off Target",
  blockedShots: "Blocked Shots",
  corners: "Corners",
  possession: "Possession",
  fouls: "Fouls",
  yellowCards: "Yellow Cards",
  redCards: "Red Cards",
  offsides: "Offsides",
  goalKicks: "Goal Kicks",
  throwIns: "Throw Ins",
  saves: "Saves",
};

/**
 * Nederlandse labels voor het dashboard
 */
export const STAT_LABELS_NL: Record<StatType, string> = {
  goals: "Doelpunten",
  assists: "Assists",
  totalShots: "Schoten (totaal)",
  shotsOnTarget: "Schoten op doel",
  shotsOffTarget: "Schoten naast",
  blockedShots: "Geblokte schoten",
  corners: "Corners",
  possession: "Balbezit",
  fouls: "Overtredingen",
  yellowCards: "Gele kaarten",
  redCards: "Rode kaarten",
  offsides: "Buitenspel",
  goalKicks: "Doeltrappen",
  throwIns: "Inworp",
  saves: "Reddingen",
};

/**
 * Per-speler bijdrage aan een statistiek
 */
export interface PlayerStat {
  name: string;
  value: number;
}

/**
 * Stats voor één team in één wedstrijd
 */
export interface TeamStats {
  teamName: string;
  stats: Partial<Record<StatType, string>>;
  /** Per stat de spelers die bijgedragen hebben (gesorteerd op waarde, aflopend) */
  players: Partial<Record<StatType, PlayerStat[]>>;
}

/**
 * Volledige wedstrijd-data
 */
export interface MatchData {
  matchId: string;
  matchUrl: string;
  homeTeam: TeamStats;
  awayTeam: TeamStats;
  score: string;
  date: string;
  status: string; // "live", "finished", "upcoming"
  competition: string;
}

/**
 * Alle opgeslagen data
 */
export interface ScrapedData {
  lastUpdated: string;
  matches: MatchData[];
}

/**
 * App configuratie
 */
export interface AppConfig {
  /** Alle landen die meedoen aan het toernooi */
  allTeams: string[];
  /** Landen die standaard aan staan in het filter (als er nog geen localStorage is) */
  defaultFollowedTeams: string[];
  /** Welke statistieken tonen in het dashboard */
  enabledStats: StatType[];
  /** Opta toernooi URL */
  tournamentUrl: string;
  /** Toernooi ID */
  tournamentId: string;
  /** Toernooi naam */
  tournamentName: string;
  /** Poort voor de webserver */
  port: number;
  /** Headless browser mode */
  headless: boolean;
}
