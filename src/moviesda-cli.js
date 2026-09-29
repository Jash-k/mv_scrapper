#!/usr/bin/env node
/**
 * MoviesDa scraper CLI — direct MP4 only (720p + 1080p), movies only.
 *
 *   node src/moviesda-cli.js                 latest + MOVIESDA_YEARS_BACK years
 *   node src/moviesda-cli.js --limit=5       small test run
 *
 * Writes (NEVER touches data/movies.json or any TamilMV file):
 *   data/moviesda.json       direct MP4 tier (byte-verified, 720p/1080p)
 *   data/embeds.json         always []  (embeds disabled)
 *   data/moviesda.m3u        M3U twin of the MP4 tier
 *   stremio/**               static Stremio addon (manifest/catalog/streams)
 *   data/moviesda-stats.json
 *
 * Fresh rebuild every run — no carry-over of previous (often expired) URLs.
 *
 * Env:
 *   MOVIESDA_YEARS_BACK=2   crawl tamil-YYYY-movies for the last N years
 *   MOVIESDA_MAX_MOVIES=60  max movie pages per run (delay-friendly)
 *   MOVIESDA_LATEST=25      max items from tamil-latest-updates
 *   TMDB_API_KEY=...        enables TMDB id/poster/imdb resolution (Stremio ids)
 *   MOVIESDA_SKIP_VERIFY=1  emergency: commit unverified (NEVER in CI)
 */
import { scrapeLatest, scrapeYear, scrapeMovie } from './moviesda/extractor.js';
import { verifyAll, verifyMp4 } from './moviesda/verify.js';
import { buildOutputs } from './moviesda/build.js';

const YEARS_BACK = Number(process.env.MOVIESDA_YEARS_BACK ?? 2);
const MAX_MOVIES = Number(process.env.MOVIESDA_MAX_MOVIES ?? 60);
const LATEST = Number(process.env.MOVIESDA_LATEST ?? 25);
const LIMIT = Number(
  (process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0
);

const started = Date.now();
const currentYear = new Date().getFullYear();
const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => currentYear - i);

console.log(
  `[moviesda] mode=direct-mp4-only · qualities=720p,1080p · movies-only · fresh-rebuild`
);
console.log(
  `[moviesda] scope: latest≤${LATEST} + years ${years.join(', ')} · cap ${MAX_MOVIES} movies`
);

// ---- 1. collect candidate movie pages (dedupe, movies only) ----
const isSeries = (item) =>
  /web[- ]?series|\bseason\b|\bS\d{2}\b|\bepi(?:sode)?\b/i.test(
    `${item?.type || ''} ${item?.url || ''} ${item?.label || ''}`
  );

const candidates = new Map();
const addAll = (list) => {
  for (const item of list || []) {
    if (!item?.url) continue;
    if (isSeries(item)) continue;
    if (!candidates.has(item.url)) candidates.set(item.url, item);
  }
};

addAll(
  await scrapeLatest({ limit: LATEST }).catch((e) => {
    console.warn('latest failed:', e.message);
    return [];
  })
);
for (const year of years) {
  addAll(
    await scrapeYear(year, { limit: 30 }).catch((e) => {
      console.warn(`year ${year} failed:`, e.message);
      return [];
    })
  );
}

let queue = [...candidates.values()];
if (LIMIT) queue = queue.slice(0, LIMIT);
queue = queue.slice(0, MAX_MOVIES);
console.log(`[moviesda] ${queue.length} movie pages queued`);

// ---- 2. scrape each page (direct MP4s only) ----
const scraped = [];
for (const [index, page] of queue.entries()) {
  try {
    const movie = await scrapeMovie(page);
    if (movie.mp4s?.length) {
      scraped.push(movie);
      console.log(
        `  [${index + 1}/${queue.length}] ${movie.title || page.label} → mp4:${movie.mp4s.length}`
      );
    } else {
      console.log(
        `  [${index + 1}/${queue.length}] ${movie.title || page.label} → no direct mp4s${movie.error ? ` (${movie.error})` : ''}`
      );
    }
  } catch (error) {
    console.warn(`  [${index + 1}/${queue.length}] failed: ${error.message}`);
  }
}

// ---- 3. verify every URL before it may enter the data files ----
const mp4Urls = scraped.flatMap((m) => m.mp4s.map((q) => q.url));
console.log(`[moviesda] verifying ${mp4Urls.length} direct mp4 urls…`);

const mp4Verify = new Map();
if (process.env.MOVIESDA_SKIP_VERIFY === '1') {
  console.warn('[moviesda] VERIFY DISABLED — emergency mode, never use in CI');
  for (const u of mp4Urls) mp4Verify.set(u, true);
} else {
  const unique = [...new Set(mp4Urls)].map((url) => ({ url }));
  const results = await verifyAll(unique, verifyMp4, {
    concurrency: 4,
    onProgress: (d, t) => process.stdout.write(`\r  mp4 ${d}/${t}   `),
  });
  for (const r of results) mp4Verify.set(r.item.url, r.ok);
  console.log('');
  const alive = [...mp4Verify.values()].filter(Boolean).length;
  const dead = unique.length - alive;
  console.log(`[moviesda] verify result: ${alive} alive / ${dead} dead of ${unique.length}`);
}

// ---- 4. safety gate BEFORE writing anything ----
const aliveMp4 = [...mp4Verify.values()].filter(Boolean).length;
if (!aliveMp4 && !process.env.MOVIESDA_SKIP_VERIFY) {
  console.error(
    '[moviesda] ZERO verified MP4s — upstream layout probably changed. NOT overwriting good data with empty files.'
  );
  process.exit(2);
}

// ---- 5. build outputs (fresh rebuild, no carry-over, no embeds) ----
const stats = await buildOutputs(scraped, { mp4Verify });
stats.durationSeconds = Math.round((Date.now() - started) / 1000);
stats.queued = queue.length;
stats.scrapedWithMp4 = scraped.length;
stats.verifiedAlive = aliveMp4;
console.log('[moviesda] DONE', JSON.stringify(stats, null, 2));
