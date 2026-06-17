import express from "express";
import * as path from "path";
import config from "./config";
import { fetchAllMatches, refreshLiveMatches } from "./scraper";
import { STAT_LABELS, STAT_LABELS_NL, ScrapedData } from "./types";

const app = express();

// Serve static files (dashboard)
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.json());

// ==============================
//  In-memory cache
// ==============================

const CACHE_TTL_MS = 60 * 1000; // 60 seconden

let cache: {
  data: ScrapedData;
  timestamp: number;
} | null = null;

async function getCachedStats(forceRefresh = false): Promise<ScrapedData> {
  const now = Date.now();

  if (!forceRefresh && cache && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }

  console.log(
    forceRefresh
      ? "Force refresh: fetching from ESPN API..."
      : "Cache expired: fetching from ESPN API..."
  );

  const data = await fetchAllMatches();

  cache = { data, timestamp: Date.now() };
  return data;
}

// ==============================
//  Routes
// ==============================

/**
 * GET /api/stats
 * Haalt live data op via ESPN API (met 60s in-memory cache).
 */
app.get("/api/stats", async (_req, res) => {
  try {
    const data = await getCachedStats();
    res.json({
      lastUpdated: data.lastUpdated,
      matches: data.matches,
      config: {
        allTeams: config.allTeams,
        groups: config.groups,
        defaultFollowedTeams: config.defaultFollowedTeams,
        enabledStats: config.enabledStats,
        statLabels: STAT_LABELS,
        statLabelsNL: STAT_LABELS_NL,
        tournamentName: config.tournamentName,
      },
    });
  } catch (error: any) {
    console.error("Failed to fetch stats:", error.message);
    // Fallback naar cache als die er is, ook al is hij verlopen
    if (cache) {
      res.json({
        lastUpdated: cache.data.lastUpdated,
        matches: cache.data.matches,
        config: {
          allTeams: config.allTeams,
          groups: config.groups,
          defaultFollowedTeams: config.defaultFollowedTeams,
          enabledStats: config.enabledStats,
          statLabels: STAT_LABELS,
          statLabelsNL: STAT_LABELS_NL,
          tournamentName: config.tournamentName,
        },
      });
    } else {
      res.status(500).json({ error: "Failed to fetch stats from ESPN" });
    }
  }
});

/**
 * POST /api/refresh
 * Forceer een volledige ophaling vanuit de ESPN API (invalideert cache).
 */
app.post("/api/refresh", async (_req, res) => {
  try {
    const data = await getCachedStats(true);
    res.json({ success: true, matchCount: data.matches.length });
  } catch (error: any) {
    console.error("Refresh failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/refresh-live
 * Ververs alleen live/actieve wedstrijden (veel sneller).
 * Hergebruikt cached data voor afgelopen en toekomstige wedstrijden.
 */
app.post("/api/refresh-live", async (_req, res) => {
  try {
    // Gebruik bestaande cache als basis, of doe een volledige fetch
    const existing = cache?.data || (await fetchAllMatches());
    const data = await refreshLiveMatches(existing);
    cache = { data, timestamp: Date.now() };
    const liveCount = data.matches.filter(
      (m) => m.status !== "Upcoming" && m.status !== "FT"
    ).length;
    res.json({ success: true, matchCount: data.matches.length, liveCount });
  } catch (error: any) {
    console.error("Live refresh failed:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/config
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

// Start server + pre-warm cache
app.listen(config.port, async () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   WK 2026 Stats Dashboard                ║
  ║   http://localhost:${config.port}                  ║
  ╠═══════════════════════════════════════════╣
  ║   Live data via ESPN API (${CACHE_TTL_MS / 1000}s cache)     ║
  ╚═══════════════════════════════════════════╝
  `);

  // Pre-warm de cache zodat de eerste page-load snel is
  try {
    await getCachedStats();
    console.log("Cache pre-warmed successfully.\n");
  } catch (err: any) {
    console.log(`Cache pre-warm failed: ${err.message}\n`);
  }
});
