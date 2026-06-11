import { chromium, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import config from "./config";
import { MatchData, PlayerStat, ScrapedData, StatType } from "./types";

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "stats.json");
const BROWSER_DATA_DIR = path.join(__dirname, "..", "data", "browser-profile");

/**
 * Mapping van Opta kolom-afkortingen naar onze StatType.
 * De volgorde in de header is: G, A, RC, YC, Crn, S, SOnT, BS, P, C, Tk, O, FC, FW, SAV
 */
const OPTA_ABBR_TO_STAT: Record<string, StatType> = {
  S: "totalShots",
  SOnT: "shotsOnTarget",
  // Toekomstige uitbreidingen:
  BS: "blockedShots",
  Crn: "corners",
  FC: "fouls", // Fouls conceded
  YC: "yellowCards",
  RC: "redCards",
  O: "offsides",
  SAV: "saves",
};

/**
 * Leesbare stat labels voor logging
 */
const STAT_DISPLAY: Record<StatType, string> = {
  totalShots: "Shots",
  shotsOnTarget: "Shots on Target",
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

// ==============================
//  Browser Management
// ==============================

async function createBrowserContext(): Promise<{
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  if (!fs.existsSync(BROWSER_DATA_DIR)) {
    fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  }

  const context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: config.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
    locale: "en-GB",
    ignoreHTTPSErrors: true,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    (window as any).chrome = { runtime: {}, loadTimes: () => ({}), csi: () => ({}) };
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-GB", "en-US", "en"] });
  });

  return { context, close: () => context.close() };
}

async function waitForRealContent(page: Page, timeout = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const title = await page.title();
    if (title === "Access Denied" || title === "Forbidden") {
      return false;
    }
    if (title.trim().length > 1 && !title.includes("\u00a0")) {
      await page.waitForTimeout(2000);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// ==============================
//  Tournament Page Scraping
// ==============================

interface MatchLink {
  url: string;
  matchId: string;
  teamSlug: string; // bijv. "mexico-vs-south-africa"
}

async function scrapeMatchList(page: Page): Promise<MatchLink[]> {
  console.log(`Navigating to tournament: ${config.tournamentUrl}`);
  await page.goto(config.tournamentUrl, { waitUntil: "domcontentloaded" });

  const ready = await waitForRealContent(page);
  if (!ready) {
    console.log("  Could not load tournament page (Access Denied).");
    console.log('  Tip: set headless: false in src/config.ts and try again.');
    return [];
  }

  await page.waitForTimeout(3000);

  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("a[href*='/match/']"))
      .map((a) => (a as HTMLAnchorElement).href)
      .filter((href) => href.includes("/match/"));
  });

  // Deduplicate en parse
  const seen = new Set<string>();
  const results: MatchLink[] = [];

  for (const href of links) {
    // Patronen:
    //   .../match/view/{matchId}
    //   .../match/{team-vs-team}/{matchId}/live-match
    const viewMatch = href.match(/\/match\/view\/([a-z0-9]+)/);
    const namedMatch = href.match(/\/match\/([a-z-]+)-vs-([a-z-]+)\/([a-z0-9]+)/);

    let matchId = "";
    let teamSlug = "";

    if (viewMatch) {
      matchId = viewMatch[1];
      teamSlug = "";
    } else if (namedMatch) {
      matchId = namedMatch[3];
      teamSlug = `${namedMatch[1]}-vs-${namedMatch[2]}`;
    }

    if (matchId && !seen.has(matchId)) {
      seen.add(matchId);
      results.push({ url: href, matchId, teamSlug });
    }
  }

  console.log(`  Found ${results.length} unique matches`);
  return results;
}

// ==============================
//  Match Page Scraping
// ==============================

/**
 * Scrape de live-match pagina.
 *
 * De Opta live-match pagina bevat per-team tabellen:
 * - Eerste tabel: "All" (beide teams gecombineerd)
 * - Tweede tabel: Home team
 * - Derde tabel: Away team
 *
 * Elke tabel heeft:
 * - Header: abbr elementen met stat-afkortingen (S, SOnT, BS, etc.)
 * - Body: per speler een rij
 * - Footer/last row: Opta-Total rij met team totalen
 */
async function scrapeMatchPage(page: Page, matchUrl: string): Promise<MatchData | null> {
  // Zorg dat we naar /live-match gaan (niet /match-stats)
  let url = matchUrl;
  if (url.includes("/match/view/")) {
    // Converteer /match/view/{id} naar een URL die we kunnen laden
    // De view URL redirect naar de juiste pagina
  }
  if (!url.endsWith("/live-match")) {
    url = url
      .replace(/\/match-stats\/?$/, "/live-match")
      .replace(/\/preview\/?$/, "/live-match")
      .replace(/\/line-ups\/?$/, "/live-match")
      .replace(/\/commentary\/?$/, "/live-match");
    if (!url.endsWith("/live-match") && !url.includes("/match/view/")) {
      url = url.replace(/\/?$/, "/live-match");
    }
  }

  console.log(`  Loading: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const ready = await waitForRealContent(page);
  if (!ready) {
    const title = await page.title();
    console.log(`  Blocked (${title}), skipping.`);
    return null;
  }

  // Wacht op de Opta tabellen
  try {
    await page.waitForSelector(".Opta-Striped", { timeout: 10000 });
  } catch {
    console.log("  No Opta stats tables found, skipping.");
    return null;
  }

  await page.waitForTimeout(1000);

  // Extract alles uit de DOM
  const data = await page.evaluate(() => {
    // 1. Team namen en score uit de header
    //    De title is: "Mexico vs South Africa - 11 Jun 2026 - ..."
    const title = document.title;
    let homeTeam = "";
    let awayTeam = "";
    let matchDate = "";

    const titleMatch = title.match(/(.+?)\s+vs?\s+(.+?)\s*-\s*(\d+\s+\w+\s+\d+)/i);
    if (titleMatch) {
      homeTeam = titleMatch[1].trim();
      awayTeam = titleMatch[2].trim();
      matchDate = titleMatch[3].trim();
    }

    // 2. Score - zoek in de body text
    let score = "";
    const bodyText = document.body?.innerText || "";
    // Zoek patroon: "Mexico \n 1 \n - \n 0 \n South Africa" of vergelijkbaar
    const scoreMatch = bodyText.match(
      new RegExp(
        homeTeam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "\\s*(\\d+)\\s*-\\s*(\\d+)\\s*" +
          awayTeam.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      )
    );
    if (scoreMatch) {
      score = `${scoreMatch[1]} - ${scoreMatch[2]}`;
    }

    // 3. Status/minuut
    let status = "";
    // Zoek naar minuut-indicatie of "FT"/"HT" etc.
    const minuteMatch = bodyText.match(/(\d+:\d{2})\s*\n\s*LIVE MATCH/);
    if (minuteMatch) {
      status = `Live ${minuteMatch[1]}`;
    } else if (/\bFT\b/.test(bodyText) || /Full\s*Time/i.test(bodyText)) {
      status = "FT";
    } else if (/\bHT\b/.test(bodyText) || /Half\s*Time/i.test(bodyText)) {
      status = "HT";
    } else if (bodyText.includes("LIVE MATCH")) {
      status = "Live";
    } else {
      status = "Upcoming";
    }

    // 4. Per-team stats uit de Opta tabellen
    //    Er zijn 3 tabbladen: All, Home, Away
    //    We zoeken de per-team tabellen

    interface PlayerRow {
      name: string;
      values: Record<string, number>; // abbr -> getal
    }

    interface TeamData {
      name: string;
      totals: Record<string, string>;
      players: PlayerRow[];
    }

    const teams: TeamData[] = [];

    // Zoek alle Opta-Team divs (exclusief Opta-Team-Both die "All" is)
    const teamDivs = document.querySelectorAll(
      '.Opta-Team:not(.Opta-Team-Both)'
    );

    for (const teamDiv of teamDivs) {
      // Vind de team naam - staat in de voorgaande h3
      let teamName = "";
      const parentLi = teamDiv.closest("li");
      if (parentLi) {
        const h3 = parentLi.querySelector("h3 span");
        if (h3) teamName = h3.textContent?.trim() || "";
      }

      // Vind de header-kolommen (afkortingen: S, SOnT, BS, etc.)
      const headers: string[] = [];
      const thAbbrs = teamDiv.querySelectorAll("thead abbr");
      thAbbrs.forEach((abbr) => {
        headers.push(abbr.textContent?.trim() || "");
      });

      // Vind de Total rij
      const totalCells = teamDiv.querySelectorAll("tr:last-child td.Opta-Total");
      const totals: Record<string, string> = {};
      totalCells.forEach((cell, i) => {
        if (i < headers.length) {
          totals[headers[i]] = cell.textContent?.trim() || "0";
        }
      });

      // Vind per-speler rijen (alle tr[role="row"] in tbody)
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
            if (val > 0) {
              values[headers[i]] = val;
            }
          }
        });
        players.push({ name, values });
      }

      if (teamName && Object.keys(totals).length > 0) {
        teams.push({ name: teamName, totals, players });
      }
    }

    return {
      homeTeam,
      awayTeam,
      score,
      status,
      matchDate,
      teams,
      pageTitle: title,
      currentUrl: window.location.href,
    };
  });

  if (data.teams.length < 2) {
    console.log(`  Only found ${data.teams.length} team tables, need 2.`);
    console.log(`  Page: "${data.pageTitle}"`);
    return null;
  }

  // Map Opta afkortingen naar onze StatType
  function mapStats(
    totals: Record<string, string>
  ): Partial<Record<StatType, string>> {
    const result: Partial<Record<StatType, string>> = {};
    for (const [abbr, value] of Object.entries(totals)) {
      const statType = OPTA_ABBR_TO_STAT[abbr];
      if (statType) {
        result[statType] = value;
      }
    }
    return result;
  }

  // Map per-speler stats: voor elke StatType, geef de spelers
  // die waarde > 0 hebben, gesorteerd op waarde (hoog -> laag)
  function mapPlayers(
    players: Array<{ name: string; values: Record<string, number> }>
  ): Partial<Record<StatType, PlayerStat[]>> {
    const result: Partial<Record<StatType, PlayerStat[]>> = {};
    for (const [abbr, statType] of Object.entries(OPTA_ABBR_TO_STAT)) {
      const relevant = players
        .filter((p) => p.values[abbr] && p.values[abbr] > 0)
        .map((p) => ({ name: p.name, value: p.values[abbr] }))
        .sort((a, b) => b.value - a.value);
      if (relevant.length > 0) {
        result[statType] = relevant;
      }
    }
    return result;
  }

  const homeData = data.teams[0];
  const awayData = data.teams[1];

  // Extract match ID uit URL
  const idMatch = data.currentUrl.match(/\/([a-z0-9]+)\/live-match/);
  const matchId = idMatch?.[1] || "";

  const result: MatchData = {
    matchId,
    matchUrl: data.currentUrl,
    homeTeam: {
      teamName: homeData.name || data.homeTeam,
      stats: mapStats(homeData.totals),
      players: mapPlayers(homeData.players),
    },
    awayTeam: {
      teamName: awayData.name || data.awayTeam,
      stats: mapStats(awayData.totals),
      players: mapPlayers(awayData.players),
    },
    score: data.score,
    date: data.matchDate || new Date().toISOString().split("T")[0],
    status: data.status,
    competition: config.tournamentName,
  };

  // Log de gevonden stats
  console.log(
    `  ${result.homeTeam.teamName} ${result.score} ${result.awayTeam.teamName} [${result.status}]`
  );
  for (const stat of config.enabledStats) {
    const home = result.homeTeam.stats[stat] || "-";
    const away = result.awayTeam.stats[stat] || "-";
    console.log(`    ${STAT_DISPLAY[stat]}: ${home} - ${away}`);
  }

  return result;
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
 * Scrape alle wedstrijden van het toernooi.
 * Filtering op gevolgde teams gebeurt in de frontend.
 */
export async function scrapeAll(): Promise<ScrapedData> {
  console.log("=== Opta WK Stats Scraper ===");
  console.log(`Stats: ${config.enabledStats.map((s) => STAT_DISPLAY[s]).join(", ")}`);
  console.log(`Headless: ${config.headless}\n`);

  const { context, close } = await createBrowserContext();

  try {
    const page = context.pages()[0] || (await context.newPage());

    // 1. Haal wedstrijdlijst op
    const allMatches = await scrapeMatchList(page);

    console.log(`\nScraping ${allMatches.length} matches...\n`);

    const matches: MatchData[] = [];

    for (const match of allMatches) {
      const data = await scrapeMatchPage(page, match.url);

      if (data) {
        matches.push(data);
      }

      // Pauze tussen requests
      await page.waitForTimeout(1500 + Math.random() * 1000);
    }

    const result: ScrapedData = {
      lastUpdated: new Date().toISOString(),
      matches,
    };

    saveData(result);
    console.log(`Done! ${matches.length} matches scraped.`);
    return result;
  } finally {
    await close();
  }
}

/**
 * Scrape een specifieke wedstrijd via URL
 */
export async function scrapeSingleMatch(matchUrl: string): Promise<MatchData | null> {
  console.log(`Scraping: ${matchUrl}`);

  const { context, close } = await createBrowserContext();

  try {
    const page = context.pages()[0] || (await context.newPage());
    const data = await scrapeMatchPage(page, matchUrl);

    if (data) {
      // Merge met bestaande data
      const existing = loadData() || { lastUpdated: "", matches: [] };
      const idx = existing.matches.findIndex((m) => m.matchId === data.matchId);
      if (idx >= 0) {
        existing.matches[idx] = data;
      } else {
        existing.matches.push(data);
      }
      existing.lastUpdated = new Date().toISOString();
      saveData(existing);
    }

    return data;
  } finally {
    await close();
  }
}

// Direct uitvoeren
if (require.main === module) {
  scrapeAll().catch(console.error);
}
