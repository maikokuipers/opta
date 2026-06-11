import { AppConfig, StatType } from "./types";

/**
 * ============================================
 *  CONFIGURATIE - PAS DIT AAN NAAR WENS
 * ============================================
 */

const config: AppConfig = {
  // ---- Alle WK 2026 deelnemers (48 landen) ----
  allTeams: [
    // Groep A
    "Mexico",
    "Czech Republic",
    "South Korea",
    "South Africa",
    // Groep B
    "Canada",
    "Bosnia and Herzegovina",
    "Qatar",
    "Switzerland",
    // Groep C
    "Brazil",
    "Morocco",
    "Haiti",
    "Scotland",
    // Groep D
    "United States",
    "Paraguay",
    "Australia",
    "Turkey",
    // Groep E
    "Germany",
    "Curacao",
    "Ivory Coast",
    "Ecuador",
    // Groep F
    "Netherlands",
    "Japan",
    "Sweden",
    "Tunisia",
    // Groep G
    "Belgium",
    "Egypt",
    "Iran",
    "New Zealand",
    // Groep H
    "Spain",
    "Cape Verde",
    "Saudi Arabia",
    "Uruguay",
    // Groep I
    "France",
    "Panama",
    "Cameroon",
    "Indonesia",
    // Groep J
    "Argentina",
    "Venezuela",
    "Nigeria",
    "Algeria",
    // Groep K
    "England",
    "Senegal",
    "Colombia",
    "Slovenia",
    // Groep L
    "Portugal",
    "Serbia",
    "Italy",
    "Peru",
  ],

  // ---- Standaard geselecteerde teams (als er geen localStorage is) ----
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
    "totalShots",
    "shotsOnTarget",
    // Voeg hier meer toe als je wilt, bijv:
    // "corners",
    // "possession",
    // "fouls",
    // "yellowCards",
  ] as StatType[],

  // ---- WK 2026 toernooi ----
  tournamentUrl:
    "https://optaplayerstats.statsperform.com/en_GB/soccer/fifa-world-cup-2026-canada-mexico-usa/873cbl9cd9butm4air0mugxzo",
  tournamentId: "873cbl9cd9butm4air0mugxzo",
  tournamentName: "FIFA World Cup 2026",

  // ---- Server instellingen ----
  port: parseInt(process.env.PORT || "3333", 10),

  // ---- Browser instellingen ----
  headless: process.env.HEADLESS !== "false",
};

export default config;
