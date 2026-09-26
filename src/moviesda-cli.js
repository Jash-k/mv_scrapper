#!/usr/bin/env node
/**
 * MoviesDa scraper CLI — additive module for mv_scrapper.
 *
 *   node src/moviesda-cli.js                 latest + MOVIESDA_YEARS_BACK years
 *   node src/moviesda-cli.js --limit=5       small test run
 *
 * Writes (NEVER touches data/movies.json or any TamilMV file):
 *   data/moviesda.json     direct MP4 tier   (byte-verified)
 *   data/embeds.json       iframe tier       (embed-probed)
 *   data/moviesda.m3u      M3U twin of the MP4 tier
 *   stremio/**             static Stremio addon (manifest/catalog/streams)
 *   data/moviesda-stats.json
 *
 * Env:
 *   MOVIESDA_YEARS_BACK=2   crawl tamil-YYYY-movies for the last N years
 *   MOVIESDA_MAX_MOVIES=60  max movie pages per run (delay-friendly)
 *   MOVIESDA_LATEST=25      max items from tamil-latest-updates
 *   TMDB_API_KEY=...        enables TMDB id/poster/imdb resolution (Stremio ids)
 *   MOVIESDA_SKIP_VERIFY=1  emergency: commit unverified (NEVER in CI)
 */
import { readFileSync } from 'node:fs';
import { scrapeLatest, scrapeYear, scrapeMovie } from './moviesda/extractor.js';
import { verifyAll, verifyMp4, verifyEmbed } from './moviesda/verify.js';
import { buildOutputs } from './moviesda/build.js';

const YEARS_BACK = Number(process.env.MOVIESDA_YEARS_BACK ?? 2);
const MAX_MOVIES = Number(process.env.MOVIESDA_MAX_MOVIES ?? 60);
const LATEST = Number(process.env.MOVIESDA_LATEST ?? 25);
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || 0);

const started = Date.now();
const currentYear = new Date().getFullYear();
const years = Array.from({ length: YEARS_BACK + 1 }, (_, i) => currentYear - i);

console.log(`[moviesda] scope: latest≤${LATEST} + years ${years.join(', ')} · cap ${MAX_MOVIES} movies`);

// ---- 1. collect candidate movie pages (dedupe) ----
const candidates = new Map();
const addAll = (list) => {
  for (const item of list || []) {
    if (!item?.url) continue;
    // Movies-only scope: latest updates also carry Web Series entries.
    if (/web[- ]?series/i.test(item.type || '') || /web[- ]?series/i.test(item.url || '')) continue;
    if (!candidates.has(item.url)) candidates.set(item.url, item);
  }
};
addAll(await scrapeLatest({ limit: LATEST }).catch((e) => { console.warn('latest failed:', e.message); return []; }));
for (const year of years) {
  addAll(await scrapeYear(year, { limit: 30 }).catch((e) => { console.warn(`year ${year} failed:`, e.message); return []; }));
}
let queue = [...candidates.values()];
if (LIMIT) queue = queue.slice(0, LIMIT);
queue = queue.slice(0, MAX_MOVIES);
console.log(`[moviesda] ${queue.length} movie pages queued`);

// ---- 2. scrape each page ----
const scraped = [];
for (const [index, page] of queue.entries()) {
  try {
    const movie = await scrapeMovie(page);
    if (movie.mp4s.length || movie.embeds.length) scraped.push(movie);
    console.log(`  [${index + 1}/${queue.length}] ${movie.title || page.label} → mp4:${movie.mp4s.length} embed:${movie.embeds.length}`);
  } catch (error) {
    console.warn(`  [${index + 1}/${queue.length}] failed: ${error.message}`);
  }
}

// ---- 3. verify every URL before it may enter the data files ----
const mp4Urls = scraped.flatMap((m) => m.mp4s.map((q) => q.url));
const embedUrls = scraped.flatMap((m) => m.embeds.map((q) => q.url));
console.log(`[moviesda] verifying ${mp4Urls.length} mp4 + ${embedUrls.length} embed urls…`);

const mp4Verify = new Map();
const embedVerify = new Map();
if (process.env.MOVIESDA_SKIP_VERIFY === '1') {
  console.warn('[moviesda] VERIFY DISABLED — emergency mode, never use in CI');
  for (const u of mp4Urls) mp4Verify.set(u, true);
  for (const u of embedUrls) embedVerify.set(u, true);
} else {
  let done = 0;
  for (const r of await verifyAll([...new Set(mp4Urls)].map((url) => ({ url })), verifyMp4, { concurrency: 4, onProgress: (d, t) => process.stdout.write(`\r  mp4 ${d}/${t}   `) })) {
    mp4Verify.set(r.item.url, r.ok);
  }
  for (const r of await verifyAll([...new Set(embedUrls)].map((url) => ({ url })), verifyEmbed, { concurrency: 4, onProgress: (d, t) => process.stdout.write(`\r  embed ${d}/${t}   `) })) {
    embedVerify.set(r.item.url, r.ok);
  }
  console.log('');
}

// ---- 3.5 carry over previous entries (re-verified) so the catalog grows ----
// Fresh scrape wins on identity conflicts; carried URLs are re-verified because
// upstream tokens (htag/etag) expire.
const KEEP = Number(process.env.MOVIESDA_KEEP || 120);
const slugify = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const idOf = (title, year) => `${slugify(title)}${year ? `-${year}` : ''}`;
const freshIds = new Set(scraped.map((m) => idOf(m.title, m.year)));

let carried = [];
try {
  const prevMp4 = JSON.parse(readFileSync('data/moviesda.json', 'utf8'));
  let prevEmbed = [];
  try { prevEmbed = JSON.parse(readFileSync('data/embeds.json', 'utf8')); } catch { /* older run may lack it */ }
  const byId = new Map();
  for (const j of [...(Array.isArray(prevMp4) ? prevMp4 : []), ...(Array.isArray(prevEmbed) ? prevEmbed : [])]) {
    if (!j?.titleGuess || freshIds.has(j.id)) continue;
    const id = j.id || idOf(j.titleGuess, j.yearGuess);
    const cur = byId.get(id) || {
      sourcePage: j.pageUrl || '', label: j.rawTitle || j.titleGuess, title: j.titleGuess,
      year: j.yearGuess || '', poster: j.poster || '', mp4s: [], embeds: [], carried: true,
    };
    for (const q of j.qualities || []) {
      if (q.type === 'iframe') cur.embeds.push(q); else cur.mp4s.push(q);
    }
    byId.set(id, cur);
  }
  carried = [...byId.values()].slice(0, KEEP);
  const cMp4 = carried.flatMap((m) => m.mp4s.map((q) => q.url));
  const cEmb = carried.flatMap((m) => m.embeds.map((q) => q.url));
  if (cMp4.length || cEmb.length) {
    console.log(`[moviesda] carrying ${carried.length} previous movies (${cMp4.length} mp4 / ${cEmb.length} embed urls) — re-verifying…`);
    for (const r of await verifyAll([...new Set(cMp4)].map((url) => ({ url })), verifyMp4, { concurrency: 4 })) {
      mp4Verify.set(r.item.url, r.ok);
    }
    for (const r of await verifyAll([...new Set(cEmb)].map((url) => ({ url })), verifyEmbed, { concurrency: 4 })) {
      embedVerify.set(r.item.url, r.ok);
    }
    // Drop carried movies whose URLs all died.
    carried = carried.filter((m) => m.mp4s.some((q) => mp4Verify.get(q.url)) || m.embeds.some((q) => embedVerify.get(q.url)));
  }
} catch (e) {
  if (e.code !== 'ENOENT') console.warn(`[moviesda] carry-over skipped: ${e.message}`);
}

// ---- 4. safety gate BEFORE writing anything ----
const aliveMp4 = [...mp4Verify.values()].filter(Boolean).length;
if (!aliveMp4 && !process.env.MOVIESDA_SKIP_VERIFY) {
  console.error('[moviesda] ZERO verified MP4s — upstream layout probably changed. NOT overwriting good data with empty files.');
  process.exit(2);
}

// ---- 5. build outputs ----
const stats = await buildOutputs([...scraped, ...carried], { mp4Verify, embedVerify });
stats.carriedMovies = carried.length;
stats.durationSeconds = Math.round((Date.now() - started) / 1000);
console.log('[moviesda] DONE', JSON.stringify(stats, null, 1));
