import express from "express";
import * as path from "path";
import config from "./config";
import { loadData, scrapeAll, scrapeSingleMatch } from "./scraper";
import { STAT_LABELS, STAT_LABELS_NL } from "./types";

const app = express();

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

/**
 * GET /api/stats
 * Haal alle opgeslagen statistieken op.
 * Filtering op gevolgde teams gebeurt client-side.
 */
app.get("/api/stats", (_req, res) => {
  const data = loadData();
  res.json({
    lastUpdated: data?.lastUpdated || null,
    matches: data?.matches || [],
    config: {
      allTeams: config.allTeams,
      defaultFollowedTeams: config.defaultFollowedTeams,
      enabledStats: config.enabledStats,
      statLabels: STAT_LABELS,
      statLabelsNL: STAT_LABELS_NL,
      tournamentName: config.tournamentName,
    },
  });
});

/**
 * POST /api/scrape
 * Start een nieuwe scrape-sessie
 */
app.post("/api/scrape", async (_req, res) => {
  try {
    console.log("Starting scrape...");
    const data = await scrapeAll();
    res.json({ success: true, matchCount: data.matches.length });
  } catch (error: any) {
    console.error("Scrape failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/scrape-match
 * Scrape een specifieke wedstrijd via URL
 */
app.post("/api/scrape-match", async (req, res) => {
  const { url } = req.body;
  if (!url) {
    res.status(400).json({ success: false, error: "URL is required" });
    return;
  }

  try {
    console.log(`Scraping single match: ${url}`);
    const match = await scrapeSingleMatch(url);
    if (match) {
      res.json({ success: true, match });
    } else {
      res.json({ success: false, error: "Could not extract match data" });
    }
  } catch (error: any) {
    console.error("Scrape match failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/config
 * Haal de huidige configuratie op
 */
app.get("/api/config", (_req, res) => {
  res.json({
    allTeams: config.allTeams,
    defaultFollowedTeams: config.defaultFollowedTeams,
    enabledStats: config.enabledStats,
    statLabels: STAT_LABELS,
    statLabelsNL: STAT_LABELS_NL,
    tournamentName: config.tournamentName,
    tournamentUrl: config.tournamentUrl,
  });
});

// Start server
app.listen(config.port, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   Opta WK Stats Dashboard                ║
  ║   http://localhost:${config.port}                  ║
  ╠═══════════════════════════════════════════╣
  ║   ${config.allTeams.length} teams | ${config.enabledStats.map((s) => STAT_LABELS[s]).join(", ").padEnd(28)}║
  ╚═══════════════════════════════════════════╝
  `);
});
