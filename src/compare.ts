import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const BROWSER_DATA_DIR = path.join(__dirname, "..", "data", "browser-profile");
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

// Wedstrijden om te vergelijken (Opta URL + ESPN event ID)
const MATCHES = [
  {
    name: "Mexico vs South Africa",
    optaUrl:
      "https://optaplayerstats.statsperform.com/en_GB/soccer/fifa-world-cup-2026-canada-mexico-usa/873cbl9cd9butm4air0mugxzo/match/mexico-vs-south-africa/4tcpns1nwyc0jtpucgzj9dp90/live-match",
    espnId: "760415",
  },
  {
    name: "South Korea vs Czechia",
    optaUrl:
      "https://optaplayerstats.statsperform.com/en_GB/soccer/fifa-world-cup-2026-canada-mexico-usa/873cbl9cd9butm4air0mugxzo/match/south-korea-vs-czech-republic/9hjlhmip7tn4qgpwr47txpafo/live-match",
    espnId: "760414",
  },
];

interface PlayerStat {
  name: string;
  shots: number;
  shotsOnTarget: number;
}

interface TeamData {
  teamName: string;
  totalShots: number;
  shotsOnTarget: number;
  corners: number;
  fouls: number;
  yellowCards: number;
  redCards: number;
  offsides: number;
  saves: number;
  players: PlayerStat[];
}

interface MatchComparison {
  source: string;
  home: TeamData;
  away: TeamData;
}

// ==============================
//  ESPN Data
// ==============================

async function fetchESPN(eventId: string): Promise<MatchComparison> {
  const res = await fetch(`${ESPN_BASE}/summary?event=${eventId}`);
  const data = await res.json();

  function parseTeam(
    boxscoreTeam: any,
    rosterTeam: any
  ): TeamData {
    const teamName = boxscoreTeam?.team?.displayName || "?";
    const stats: Record<string, number> = {};
    for (const s of boxscoreTeam?.statistics || []) {
      stats[s.name] = parseFloat(s.displayValue) || 0;
    }

    const players: PlayerStat[] = [];
    for (const p of rosterTeam?.roster || []) {
      const pStats: Record<string, number> = {};
      for (const s of p.stats || []) {
        pStats[s.name] = s.value || 0;
      }
      if (pStats.totalShots > 0 || pStats.shotsOnTarget > 0) {
        players.push({
          name: p.athlete.displayName,
          shots: pStats.totalShots || 0,
          shotsOnTarget: pStats.shotsOnTarget || 0,
        });
      }
    }
    players.sort((a, b) => b.shots - a.shots);

    return {
      teamName,
      totalShots: stats.totalShots || 0,
      shotsOnTarget: stats.shotsOnTarget || 0,
      corners: stats.wonCorners || 0,
      fouls: stats.foulsCommitted || 0,
      yellowCards: stats.yellowCards || 0,
      redCards: stats.redCards || 0,
      offsides: stats.offsides || 0,
      saves: stats.saves || 0,
      players,
    };
  }

  const bTeams = data.boxscore?.teams || [];
  const rosters = data.rosters || [];

  return {
    source: "ESPN",
    home: parseTeam(bTeams[0], rosters[0]),
    away: parseTeam(bTeams[1], rosters[1]),
  };
}

// ==============================
//  Opta Data (Playwright)
// ==============================

async function fetchOpta(matchUrl: string): Promise<MatchComparison> {
  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-GB",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log(`  [Opta] Loading: ${matchUrl}`);
  await page.goto(matchUrl, { waitUntil: "domcontentloaded" });

  // Wacht op content
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const title = await page.title();
    if (
      title !== "Access Denied" &&
      title !== "Forbidden" &&
      title.trim().length > 1 &&
      !title.includes("\u00a0")
    ) {
      break;
    }
    await page.waitForTimeout(1000);
  }

  await page.waitForTimeout(3000);

  // Wacht op Opta tabellen
  try {
    await page.waitForSelector(".Opta-Striped", { timeout: 10000 });
  } catch {
    console.log("  [Opta] No stats tables found");
    await context.close();
    return {
      source: "Opta",
      home: emptyTeam("?"),
      away: emptyTeam("?"),
    };
  }

  await page.waitForTimeout(1000);

  const data = await page.evaluate(() => {
    interface PlayerRow {
      name: string;
      values: Record<string, number>;
    }

    interface TeamResult {
      name: string;
      totals: Record<string, string>;
      players: PlayerRow[];
    }

    const teams: TeamResult[] = [];
    const teamDivs = document.querySelectorAll(
      ".Opta-Team:not(.Opta-Team-Both)"
    );

    for (const teamDiv of teamDivs) {
      let teamName = "";
      const parentLi = teamDiv.closest("li");
      if (parentLi) {
        const h3 = parentLi.querySelector("h3 span");
        if (h3) teamName = h3.textContent?.trim() || "";
      }

      const headers: string[] = [];
      const thAbbrs = teamDiv.querySelectorAll("thead abbr");
      thAbbrs.forEach((abbr) => {
        headers.push(abbr.textContent?.trim() || "");
      });

      // Totaal rij
      const totalCells = teamDiv.querySelectorAll(
        "tr:last-child td.Opta-Total"
      );
      const totals: Record<string, string> = {};
      totalCells.forEach((cell, i) => {
        if (i < headers.length) {
          totals[headers[i]] = cell.textContent?.trim() || "0";
        }
      });

      // Speler rijen
      const players: PlayerRow[] = [];
      const playerRows = teamDiv.querySelectorAll("tbody tr[role='row']");
      for (const row of playerRows) {
        const nameEl = row.querySelector("th.Opta-Player");
        if (!nameEl) continue;
        const name = nameEl.textContent?.trim() || "";
        if (!name || name === "Total") continue;

        const cells = row.querySelectorAll("td.Opta-Stat");
        const values: Record<string, number> = {};
        cells.forEach((cell, i) => {
          if (i < headers.length) {
            const val = parseInt(cell.textContent?.trim() || "0", 10);
            if (val > 0) values[headers[i]] = val;
          }
        });
        players.push({ name, values });
      }

      if (teamName) teams.push({ name: teamName, totals, players });
    }

    return teams;
  });

  await context.close();

  function mapTeam(t: (typeof data)[0]): TeamData {
    const players: PlayerStat[] = t.players
      .filter((p: any) => (p.values["S"] || 0) > 0 || (p.values["SOnT"] || 0) > 0)
      .map((p: any) => ({
        name: p.name as string,
        shots: (p.values["S"] || 0) as number,
        shotsOnTarget: (p.values["SOnT"] || 0) as number,
      }))
      .sort((a: PlayerStat, b: PlayerStat) => b.shots - a.shots);

    return {
      teamName: t.name,
      totalShots: parseInt(t.totals["S"] || "0"),
      shotsOnTarget: parseInt(t.totals["SOnT"] || "0"),
      corners: parseInt(t.totals["Crn"] || "0"),
      fouls: parseInt(t.totals["FC"] || "0"),
      yellowCards: parseInt(t.totals["YC"] || "0"),
      redCards: parseInt(t.totals["RC"] || "0"),
      offsides: parseInt(t.totals["O"] || "0"),
      saves: parseInt(t.totals["SAV"] || "0"),
      players,
    };
  }

  return {
    source: "Opta",
    home: data[0] ? mapTeam(data[0]) : emptyTeam("?"),
    away: data[1] ? mapTeam(data[1]) : emptyTeam("?"),
  };
}

function emptyTeam(name: string): TeamData {
  return {
    teamName: name,
    totalShots: 0,
    shotsOnTarget: 0,
    corners: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0,
    offsides: 0,
    saves: 0,
    players: [],
  };
}

// ==============================
//  Vergelijking
// ==============================

function printComparison(
  matchName: string,
  opta: MatchComparison,
  espn: MatchComparison
) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`  ${matchName}`);
  console.log("=".repeat(80));

  // Team stats vergelijken
  const statKeys: Array<{ key: keyof TeamData; label: string }> = [
    { key: "totalShots", label: "Total Shots" },
    { key: "shotsOnTarget", label: "Shots on Target" },
    { key: "corners", label: "Corners" },
    { key: "fouls", label: "Fouls" },
    { key: "yellowCards", label: "Yellow Cards" },
    { key: "redCards", label: "Red Cards" },
    { key: "offsides", label: "Offsides" },
    { key: "saves", label: "Saves" },
  ];

  const homeLabel = `${opta.home.teamName}`;
  const awayLabel = `${opta.away.teamName}`;

  console.log(
    `\n  ${"Stat".padEnd(20)} | ${"Opta".padStart(6)} ${"ESPN".padStart(6)}  | ${"Opta".padStart(6)} ${"ESPN".padStart(6)}  | Match?`
  );
  console.log(
    `  ${"".padEnd(20)} | ${homeLabel.padStart(13)}  | ${awayLabel.padStart(13)}  |`
  );
  console.log(`  ${"-".repeat(74)}`);

  for (const { key, label } of statKeys) {
    const oh = opta.home[key];
    const eh = espn.home[key];
    const oa = opta.away[key];
    const ea = espn.away[key];
    const homeMatch = oh === eh ? "  " : "!!";
    const awayMatch = oa === ea ? "  " : "!!";
    const allMatch = oh === eh && oa === ea ? "OK" : "DIFF";

    console.log(
      `  ${label.padEnd(20)} | ${String(oh).padStart(6)} ${String(eh).padStart(6)}${homeMatch} | ${String(oa).padStart(6)} ${String(ea).padStart(6)}${awayMatch} | ${allMatch}`
    );
  }

  // Speler-vergelijking voor shots
  console.log(`\n  --- Player Shots Comparison ---`);

  for (const side of ["home", "away"] as const) {
    const teamName = side === "home" ? opta.home.teamName : opta.away.teamName;
    const optaPlayers = side === "home" ? opta.home.players : opta.away.players;
    const espnPlayers = side === "home" ? espn.home.players : espn.away.players;

    console.log(`\n  ${teamName}:`);
    console.log(
      `  ${"Player".padEnd(25)} | ${"Opta S".padStart(7)} ${"ESPN S".padStart(7)} | ${"Opta SoT".padStart(9)} ${"ESPN SoT".padStart(9)} | Match?`
    );
    console.log(`  ${"-".repeat(78)}`);

    // Combineer spelers van beide bronnen
    const allNames = new Set([
      ...optaPlayers.map((p: PlayerStat) => p.name),
      ...espnPlayers.map((p: PlayerStat) => p.name),
    ]);

    for (const name of allNames) {
      const op = optaPlayers.find((p: PlayerStat) => p.name === name);
      const ep = espnPlayers.find((p: PlayerStat) => p.name === name);

      // Probeer fuzzy match als exacte naam niet matcht
      const epFuzzy =
        ep ||
        espnPlayers.find((p: PlayerStat) => {
          const last1 = name.split(" ").pop()?.toLowerCase();
          const last2 = p.name.split(" ").pop()?.toLowerCase();
          return last1 && last2 && last1 === last2;
        });

      const oShots = op?.shots ?? "-";
      const eShots = epFuzzy?.shots ?? "-";
      const oSoT = op?.shotsOnTarget ?? "-";
      const eSoT = epFuzzy?.shotsOnTarget ?? "-";

      const shotsMatch = oShots === eShots ? "  " : "!!";
      const sotMatch = oSoT === eSoT ? "  " : "!!";
      const match = oShots === eShots && oSoT === eSoT ? "OK" : "DIFF";

      const displayName = op
        ? name
        : `${epFuzzy?.name || name} (ESPN only)`;

      console.log(
        `  ${displayName.padEnd(25)} | ${String(oShots).padStart(7)} ${String(eShots).padStart(7)}${shotsMatch}| ${String(oSoT).padStart(9)} ${String(eSoT).padStart(9)}${sotMatch}| ${match}`
      );
    }
  }
}

// ==============================
//  Main
// ==============================

async function main() {
  console.log("=== Opta vs ESPN Data Vergelijking ===\n");

  for (const match of MATCHES) {
    console.log(`\nFetching: ${match.name}...`);

    // Fetch ESPN (snel, geen browser nodig)
    console.log("  [ESPN] Fetching via API...");
    const espn = await fetchESPN(match.espnId);

    // Fetch Opta (browser nodig)
    const opta = await fetchOpta(match.optaUrl);

    // Vergelijk
    printComparison(match.name, opta, espn);
  }

  console.log("\n\nDone!");
}

main().catch(console.error);
