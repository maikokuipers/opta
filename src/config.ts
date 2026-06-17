import { AppConfig, GroupMap, StatType } from "./types";

/**
 * WK 2026 groepen (team namen exact zoals ESPN API ze noemt)
 */
const groups: GroupMap = {
  A: ["Mexico", "Czechia", "South Korea", "South Africa"],
  B: ["Canada", "Bosnia-Herzegovina", "Switzerland", "Qatar"],
  C: ["Brazil", "Scotland", "Haiti", "Morocco"],
  D: ["Paraguay", "Türkiye", "Australia", "United States"],
  E: ["Ecuador", "Germany", "Ivory Coast", "Curaçao"],
  F: ["Netherlands", "Sweden", "Japan", "Tunisia"],
  G: ["Belgium", "Iran", "Egypt", "New Zealand"],
  H: ["Spain", "Uruguay", "Saudi Arabia", "Cape Verde"],
  I: ["Norway", "France", "Senegal", "Iraq"],
  J: ["Argentina", "Austria", "Algeria", "Jordan"],
  K: ["Colombia", "Portugal", "Uzbekistan", "Congo DR"],
  L: ["England", "Croatia", "Panama", "Ghana"],
};

/** Alle 48 teams alfabetisch */
const allTeams = Object.values(groups).flat().sort((a, b) =>
  a.localeCompare(b, "en", { sensitivity: "base" })
);

const config: AppConfig = {
  allTeams,
  groups,

  // ---- Standaard geselecteerde teams ----
  defaultFollowedTeams: [
    "Netherlands",
    "Mexico",
    "Germany",
    "Brazil",
    "Argentina",
    "France",
  ],

  // ---- Statistieken om te tonen ----
  enabledStats: [
    "goals",
    "assists",
    "totalShots",
    "shotsOnTarget",
    "possession",
    "corners",
    "fouls",
    "yellowCards",
    "redCards",
    "offsides",
    "saves",
  ] as StatType[],

  // ---- WK 2026 toernooi ----
  tournamentUrl:
    "https://www.espn.com/soccer/schedule/_/league/fifa.world",
  tournamentId: "fifa.world",
  tournamentName: "FIFA World Cup 2026",

  // ---- Server instellingen ----
  port: parseInt(process.env.PORT || "3333", 10),

  // ---- Browser instellingen ----
  headless: true,
};

export default config;
