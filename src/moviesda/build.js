/**
 * Output builder — turns verified scrapes into the four artifacts:
 *
 *   data/moviesda.json        MP4 tier       (JaSH ViBeS ReTro + Stremio)
 *   data/embeds.json          iframe tier    (JaSH ViBeS watch page ONLY)
 *   data/moviesda.m3u         M3U twin of the MP4 tier (ReTro alternative)
 *   stremio/**                static Stremio addon (Pages) — MP4 + magnets
 *   data/moviesda-stats.json  run metadata
 *
 * Identity contract: titleGuess + yearGuess (+ tmdbId when resolved) are the
 * same keys across both JSON files, so JaSH ViBeS' sync merges a movie's MP4s
 * and embeds into ONE VodItem. Magnets are READ from the existing
 * data/movies.json (never written here) and only enter the stremio/ output —
 * the Render-hosted app must never receive torrent links.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { verifyAll, verifyMp4, verifyEmbed } from './verify.js';

const ROOT = process.cwd();
const DATA = path.join(ROOT, 'data');
const STREMIO = path.join(ROOT, 'stremio');

const TMDB_API = process.env.TMDB_API_KEY || '';
const TMDB_LANG = 'en-US';

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

async function resolveTmdb(title, year) {
  if (!TMDB_API) return null;
  try {
    const url = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API}&query=${encodeURIComponent(title)}${year ? `&year=${year}` : ''}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const hit = data.results?.[0];
    if (!hit) return null;
    let imdbId = '';
    try {
      const ext = await (await fetch(`https://api.themoviedb.org/3/movie/${hit.id}/external_ids?api_key=${TMDB_API}`, { signal: AbortSignal.timeout(10000) })).json();
      imdbId = ext.imdb_id || '';
    } catch { /* catalog still works on tmdb id */ }
    return {
      tmdbId: hit.id,
      imdbId,
      poster: hit.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : '',
      rating: hit.vote_average || 0,
    };
  } catch {
    return null;
  }
}

/** Read the existing TamilMV magnets file (read-only, never modified). */
async function loadMagnets() {
  try {
    const raw = await fs.readFile(path.join(DATA, 'movies.json'), 'utf8');
    const list = JSON.parse(raw);
    const map = new Map();
    for (const movie of Array.isArray(list) ? list : []) {
      const key = `${slug(movie.titleGuess || movie.rawTitle)}:${movie.yearGuess || ''}`;
      map.set(key, movie);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * @param scraped  array of scrapeMovie() results
 * @param opts     { verified: {mp4: Map<url,bool>, embed: Map<url,bool>} }
 */
/** Collapse mirror copies of the same file (same host + filename, token-only diffs). */
function dedupeStreams(streams) {
  const seen = new Set();
  const out = [];
  for (const q of streams || []) {
    try {
      const u = new URL(q.url);
      const sig = `${u.hostname}/${u.pathname.split('/').pop().toLowerCase()}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
    } catch { /* keep malformed URLs out anyway */ }
    out.push(q);
  }
  return out;
}

export async function buildOutputs(scraped, { mp4Verify, embedVerify }) {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(path.join(STREMIO, 'catalog', 'movie'), { recursive: true });
  await fs.mkdir(path.join(STREMIO, 'stream', 'movie'), { recursive: true });

  const magnets = await loadMagnets();
  const movies = [];
  const embedMovies = [];

  for (const movie of scraped) {
    const { title: parsedTitle, year: parsedYear } = normalizeIdentity(movie);
    const goodMp4 = dedupeStreams((movie.mp4s || []).filter((q) => mp4Verify.get(q.url)));
    const goodEmbeds = dedupeStreams((movie.embeds || []).filter((q) => embedVerify.get(q.url)));
    if (!goodMp4.length && !goodEmbeds.length) continue;

    const tmdb = await resolveTmdb(parsedTitle, parsedYear);
    const entry = {
      id: slug(`${parsedTitle}-${parsedYear || 'na'}`),
      rawTitle: movie.label || `${parsedTitle}${parsedYear ? ` (${parsedYear})` : ''}`,
      titleGuess: parsedTitle,
      yearGuess: parsedYear,
      pageUrl: movie.sourcePage || '',
      ...(tmdb ? { tmdbId: tmdb.tmdbId, imdbId: tmdb.imdbId, poster: tmdb.poster || movie.poster || '', rating: tmdb.rating } : { poster: movie.poster || '' }),
      qualities: goodMp4,
    };
    if (goodMp4.length) movies.push(entry);
    if (goodEmbeds.length) {
      embedMovies.push({ ...entry, qualities: goodEmbeds });
    }
  }

  // ---- data/moviesda.json + data/embeds.json ----
  await fs.writeFile(path.join(DATA, 'moviesda.json'), `${JSON.stringify(movies, null, 1)}\n`);
  await fs.writeFile(path.join(DATA, 'embeds.json'), `${JSON.stringify(embedMovies, null, 1)}\n`);

  // ---- data/moviesda.m3u (MP4 tier only — M3U cannot carry embeds) ----
  const lines = ['#EXTM3U'];
  for (const movie of movies) {
    for (const q of movie.qualities) {
      lines.push(`#EXTINF:-1 tvg-logo="${movie.poster || ''}" group-title="Movies / Tamil / ${movie.yearGuess || 'NA'}",${movie.titleGuess}${movie.yearGuess ? ` (${movie.yearGuess})` : ''} [${q.quality}]`);
      lines.push(q.url);
    }
  }
  await fs.writeFile(path.join(DATA, 'moviesda.m3u'), `${lines.join('\n')}\n`);

  // ---- Stremio static addon ----
  const addonId = 'jash-moviesda-pages';
  const catalog = movies
    .filter((m) => m.tmdbId)
    .slice(0, 300)
    .map((m) => ({
      id: `tmdb:${m.tmdbId}`,
      name: m.titleGuess,
      poster: m.poster || '',
      releaseInfo: m.yearGuess ? String(m.yearGuess) : '',
    }));
  const manifest = {
    id: addonId,
    version: '1.0.0',
    name: 'MoviesDa Direct (Jash)',
    description: 'Tamil movies — direct MP4 + magnet streams. Static, serverless, rebuilt by GitHub Actions.',
    types: ['movie'],
    catalogs: [{ type: 'movie', id: 'moviesda-tamil', name: 'MoviesDa Tamil' }],
    resources: [
      { name: 'catalog', types: ['movie'], idPrefixes: ['tmdb'] },
      { name: 'stream', types: ['movie'], idPrefixes: ['tt', 'tmdb'] },
    ],
    idPrefixes: ['tt', 'tmdb'],
    background: 'https://images.unsplash.com/photo-1440404653325-ab127d49abc1',
    behaviorHints: { configurable: false },
  };
  await fs.writeFile(path.join(STREMIO, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(STREMIO, 'catalog', 'movie', 'moviesda-tamil.json'), `${JSON.stringify({ metas: catalog }, null, 1)}\n`);

  // stream files: imdbId when we have it, tmdb:<id> as the fallback key
  const byId = new Map();
  for (const movie of movies) {
    const ids = [movie.imdbId, movie.tmdbId ? `tmdb:${movie.tmdbId}` : ''].filter(Boolean);
    for (const id of ids) {
      const streams = byId.get(id) || [];
      for (const q of movie.qualities) {
        streams.push({ title: `${q.quality} • MoviesDa`, url: q.url, behaviorHints: { notProxy: true } });
      }
      // merge the TamilMV magnets for the same title (Stremio ONLY)
      const mag = magnets.get(`${slug(movie.titleGuess)}:${movie.yearGuess || ''}`);
      if (mag) {
        for (const q of mag.qualities || []) {
          if (String(q.type) === 'magnet' && q.url) {
            streams.push({ title: `${q.quality} • Torrent`, infoHash: extractInfoHash(q.url), sources: [q.url.slice(0, 120)] });
          }
        }
      }
      byId.set(id, streams);
    }
  }
  for (const [id, streams] of byId) {
    await fs.writeFile(path.join(STREMIO, 'stream', 'movie', `${id}.json`), `${JSON.stringify({ streams }, null, 1)}\n`);
  }

  const stats = {
    updatedAt: new Date().toISOString(),
    movies: movies.length,
    embedMovies: embedMovies.length,
    mp4Streams: movies.reduce((n, m) => n + m.qualities.length, 0),
    embedStreams: embedMovies.reduce((n, m) => n + m.qualities.length, 0),
    stremioStreamFiles: byId.size,
    stremioCatalog: catalog.length,
  };
  await fs.writeFile(path.join(DATA, 'moviesda-stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}

function normalizeIdentity(movie) {
  const raw = String(movie.label || '');
  const m = raw.match(/(.+?)[\s_-]*[\(\[]?((19|20)\d{2})[\)\]]?/);
  return {
    title: (movie.title || (m ? m[1].trim() : raw.replace(/[\(\[]?(19|20)\d{2}[\)\]]?/, '').trim())) || 'Untitled',
    year: Number(movie.year || (m ? m[2] : '')) || '',
  };
}

function extractInfoHash(magnet) {
  const m = String(magnet || '').match(/btih:([a-f0-9]{32,40})/i);
  return m ? m[1] : '';
}

export { verifyAll, verifyMp4, verifyEmbed };
