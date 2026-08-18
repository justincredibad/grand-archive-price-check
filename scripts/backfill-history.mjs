// One-off backfill for the full price-history archive. tcgcsv.com keeps a
// daily snapshot of TCGplayer's full price data (all games) going back to
// 2024-02-08, as https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z
// — this walks the last `--days` of those, pulls out just our categories,
// and rebuilds each game's history with real past prices instead of only
// starting to accumulate from whenever fetch-prices.mjs first ran.
//
// The full, unpruned result is written to EXTERNAL_HISTORY_DIR (a local-only
// folder, not part of the repo — a year of Pokemon history alone is ~90MB,
// which would rewrite the git repo by that much on every future daily commit
// if it were checked in). data/<game>-history.json — the copy actually
// shipped to the site — is then (re)built as just the most recent
// REPO_HISTORY_DAYS slice of that same full archive, matching what
// fetch-prices.mjs maintains day to day.
//
// This is NOT part of the daily GitHub Actions job — run it manually once
// (or again if you ever want to re-extend the window):
//   npm install && npm run backfill-history [-- --days=365]
//
// It downloads one ~4MB archive per day sequentially (be polite to
// tcgcsv.com's server) and can take a while for a full year — that's
// expected. It's safe to re-run; it always rebuilds the requested window
// from scratch and preserves today's live entry from the last fetch-prices.mjs run.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import seven from "7zip-min";

const GAMES = [
  { id: "grand-archive", categoryId: 74 },
  { id: "pokemon", categoryId: 3 },
];

const ARCHIVE_BASE = "https://tcgcsv.com/archive/tcgplayer";
const LIVE_BASE = "https://tcgcsv.com/tcgplayer";
const UA = "trading-card-price-checker/1.0 (+https://github.com/)";
const EXTERNAL_HISTORY_DIR = "E:\\Card price db";
const REPO_HISTORY_DAYS = 90;

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.split("=")[1]) : 365;

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchGroupIds(categoryId) {
  const res = await getJson(`${LIVE_BASE}/${categoryId}/groups`);
  return res.results.map((g) => g.groupId);
}

async function downloadArchive(dateString, destFile) {
  const url = `${ARCHIVE_BASE}/prices-${dateString}.ppmd.7z`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await fs.writeFile(destFile, Buffer.from(await res.arrayBuffer()));
  return true;
}

function unpack(file, destDir) {
  return new Promise((resolve, reject) => {
    seven.unpack(file, destDir, (err) => (err ? reject(err) : resolve()));
  });
}

async function readDayPrices(extractedDir, dateString, categoryId, groupIds) {
  const out = new Map();
  for (const groupId of groupIds) {
    const file = path.join(extractedDir, dateString, String(categoryId), String(groupId), "prices");
    let raw;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue; // set didn't exist yet on this date, or nothing recorded
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const p of json.results || []) {
      const display = p.marketPrice ?? p.midPrice ?? p.highPrice ?? p.lowPrice ?? null;
      if (display === null) continue;
      out.set(`${p.productId}:${p.subTypeName}`, display);
    }
  }
  return out;
}

async function main() {
  console.log(`Backfilling ${DAYS} day(s) of price history (tcgcsv.com archive, from 2024-02-08 onward).`);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tcg-backfill-"));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayStr = dateStr(today);

  const groupIdsByGame = {};
  for (const game of GAMES) {
    groupIdsByGame[game.id] = await fetchGroupIds(game.categoryId);
    console.log(`${game.id}: ${groupIdsByGame[game.id].length} sets to check per day`);
  }

  // Days strictly before today, oldest first; today itself is filled in from
  // the existing (live) history file below since that's already more
  // accurate than an end-of-day archive snapshot.
  const pastDates = [];
  for (let i = DAYS - 1; i >= 1; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    pastDates.push(dateStr(d));
  }
  const dates = [...pastDates, todayStr];

  const seriesByGame = { "grand-archive": {}, pokemon: {} };

  let ok = 0;
  let missing = 0;
  let failed = 0;
  for (let i = 0; i < pastDates.length; i++) {
    const dateString = pastDates[i];
    const archiveFile = path.join(tmpRoot, `${dateString}.7z`);
    const extractDir = path.join(tmpRoot, dateString);

    let downloaded = false;
    try {
      downloaded = await downloadArchive(dateString, archiveFile);
      if (downloaded) await unpack(archiveFile, extractDir);
    } catch (err) {
      failed++;
      console.error(`  ${dateString}: FAILED (${err.message})`);
    }
    if (!downloaded) missing++;
    else ok++;

    if (downloaded) {
      for (const game of GAMES) {
        const prices = await readDayPrices(extractDir, dateString, game.categoryId, groupIdsByGame[game.id]);
        for (const [key, value] of prices) {
          if (!seriesByGame[game.id][key]) seriesByGame[game.id][key] = new Array(dates.length).fill(null);
          seriesByGame[game.id][key][i] = value;
        }
      }
    }

    await fs.rm(archiveFile, { force: true });
    await fs.rm(extractDir, { recursive: true, force: true });

    if ((i + 1) % 20 === 0 || i === pastDates.length - 1) {
      console.log(`  ${i + 1}/${pastDates.length} days processed (through ${dateString}) — ok:${ok} missing:${missing} failed:${failed}`);
    }
  }

  const todayIndex = dates.length - 1;
  for (const game of GAMES) {
    let existing = { dates: [], series: {} };
    try {
      existing = JSON.parse(await fs.readFile(`data/${game.id}-history.json`, "utf8"));
    } catch {
      // No existing history — fine, today's column will just be empty.
    }
    const liveTodayIndex = existing.dates.indexOf(todayStr);
    const series = seriesByGame[game.id];

    for (const key of Object.keys(series)) {
      while (series[key].length <= todayIndex) series[key].push(null);
    }
    if (liveTodayIndex !== -1) {
      for (const [key, arr] of Object.entries(existing.series)) {
        const value = arr[liveTodayIndex];
        if (value === null || value === undefined) continue;
        if (!series[key]) series[key] = new Array(dates.length).fill(null);
        series[key][todayIndex] = value;
      }
    }

    const full = { dates, series };
    await fs.mkdir(EXTERNAL_HISTORY_DIR, { recursive: true });
    const externalFile = `${EXTERNAL_HISTORY_DIR}\\${game.id}-history.json`;
    await fs.writeFile(externalFile, JSON.stringify(full));
    console.log(`${game.id}: wrote ${dates.length}-day full archive to ${externalFile} (${Object.keys(series).length} series)`);

    const sliceFrom = Math.max(0, dates.length - REPO_HISTORY_DAYS);
    const repoDates = dates.slice(sliceFrom);
    const repoSeries = {};
    for (const [key, arr] of Object.entries(series)) {
      const sliced = arr.slice(sliceFrom);
      if (sliced.some((v) => v !== null && v !== undefined)) repoSeries[key] = sliced;
    }
    const repoOutput = { dates: repoDates, series: repoSeries };
    await fs.writeFile(`data/${game.id}-history.json`, JSON.stringify(repoOutput));
    console.log(`${game.id}: wrote ${repoDates.length}-day repo history, ${Object.keys(repoSeries).length} series`);
  }

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log("Backfill complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
