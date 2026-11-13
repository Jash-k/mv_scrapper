/**
 * Output builder — turns verified scrapes into:
 *
 *   data/moviesda.json        direct MP4 tier (720p/1080p only, byte-verified)
 *   data/moviesda.m3u         M3U twin of the MP4 tier
 *   stremio/**                static Stremio addon (Pages) — direct MP4 only
 *   data/moviesda-stats.json  run metadata
 *
 * Embeds are intentionally NOT produced.
 * The independent TamilMV magnet feed is never read or modified here.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';



const TMDB_API = process.env.TMDB_API_KEY || '';

function slug(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  );
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
      const ext = await (
        await fetch(
          `https://api.themoviedb.org/3/movie/${hit.id}/external_ids?api_key=${TMDB_API}`,
          { signal: AbortSignal.timeout(10000) }
        )
      ).json();
      imdbId = ext.imdb_id || '';
    } catch {
      /* catalog still works on tmdb id */
    }
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

/** Collapse mirror copies of the same file (same host + filename, token-only diffs). */
function dedupeStreams(streams) {
  const seen = new Set();
  const out = [];
  for (const q of streams || []) {
    try {
      const u = new URL(q.url);
      const sig = u.href;
      if (seen.has(sig)) continue;
      seen.add(sig);
    } catch {
      continue;
    }
    out.push(q);
  }
  return out;
}

function normalizeIdentity(movie) {
  const raw = String(movie.label || '');
  const m = raw.match(/(.+?)[\s_-]*[\(\[]?((19|20)\d{2})[\)\]]?/);
  return {
    title:
      (movie.title ||
        (m ? m[1].trim() : raw.replace(/[\(\[]?(19|20)\d{2}[\)\]]?/, '').trim())) ||
      'Untitled',
    year: Number(movie.year || (m ? m[2] : '')) || '',
  };
}

/**
 * @param scraped  array of scrapeMovie() results
 * @param opts     { mp4Verify: Map<url,bool> }
 */
export async function buildOutputs(scraped, { mp4Verify, root = process.cwd() }) {
  const DATA = path.join(root, "data");
  const STREMIO = path.join(root, "stremio");
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(path.join(STREMIO, 'catalog', 'movie'), { recursive: true });
  await fs.mkdir(path.join(STREMIO, 'stream', 'movie'), { recursive: true });

  // Wipe old embed file permanently (direct-links only mode)
  await fs.writeFile(path.join(DATA, 'embeds.json'), '[]\n');

  // Clear previous stream files so stale ids don't linger
  try {
    const streamDir = path.join(STREMIO, 'stream', 'movie');
    const existing = await fs.readdir(streamDir);
    await Promise.all(existing.map((f) => fs.unlink(path.join(streamDir, f)).catch(() => {})));
  } catch {
    /* dir may not exist yet */
  }


  const movies = [];

  for (const movie of scraped) {
    const { title: parsedTitle, year: parsedYear } = normalizeIdentity(movie);
    const goodMp4 = dedupeStreams(
      (movie.mp4s || [])
        .filter((q) => q.type === 'mp4' && mp4Verify.get(q.url)?.ok === true)
        .map(q => {
          const verified = mp4Verify.get(q.url);
          return { ...q, url: verified.url || q.url, size_bytes: verified.size_bytes,
            verifiedAt: verified.verifiedAt };
        })
        .filter((q) => /720p|1080p/i.test(q.quality || ''))
    );
    if (!goodMp4.length) continue;

    // Prefer 1080p then 720p
    goodMp4.sort((a, b) => {
      const a1080 = /1080p/i.test(a.quality) ? 2 : 1;
      const b1080 = /1080p/i.test(b.quality) ? 2 : 1;
      return b1080 - a1080;
    });

    const tmdb = await resolveTmdb(parsedTitle, parsedYear);
    const entry = {
      id: slug(`${parsedTitle}-${parsedYear || 'na'}`),
      rawTitle: movie.label || `${parsedTitle}${parsedYear ? ` (${parsedYear})` : ''}`,
      titleGuess: parsedTitle,
      yearGuess: parsedYear,
      pageUrl: movie.sourcePage || '',
      ...(tmdb
        ? {
            tmdbId: tmdb.tmdbId,
            imdbId: tmdb.imdbId,
            poster: tmdb.poster || movie.poster || '',
            rating: tmdb.rating,
          }
        : { poster: movie.poster || '' }),
      qualities: goodMp4,
    };
    movies.push(entry);
  }

  // ---- data/moviesda.json ----
  await fs.writeFile(path.join(DATA, 'moviesda.json'), `${JSON.stringify(movies, null, 1)}\n`);

  // ---- data/moviesda.m3u ----
  const lines = ['#EXTM3U'];
  for (const movie of movies) {
    for (const q of movie.qualities) {
      lines.push(
        `#EXTINF:-1 tvg-logo="${movie.poster || ''}" group-title="Movies / Tamil / ${movie.yearGuess || 'NA'}",${movie.titleGuess}${movie.yearGuess ? ` (${movie.yearGuess})` : ''} [${q.quality}]`
      );
      lines.push(q.url);
    }
  }
  await fs.writeFile(path.join(DATA, 'moviesda.m3u'), `${lines.join('\n')}\n`);

  // ---- Stremio static addon ----
  const addonId = 'jash-moviesda-pages';
  const catalog = movies
    .slice(0, 300)
    .map((m) => ({
      id: m.imdbId || (m.tmdbId ? `tmdb:${m.tmdbId}` : `moviesda:${m.id}`),
      type: "movie",
      name: m.titleGuess,
      poster: m.poster || '',
      releaseInfo: m.yearGuess ? String(m.yearGuess) : '',
    }));
  const manifest = {
    id: addonId,
    version: '1.1.0',
    name: 'MoviesDa Direct (Jash)',
    description:
      'Tamil movies — direct 720p/1080p MP4 streams only. Static, serverless, rebuilt by GitHub Actions.',
    types: ['movie'],
    catalogs: [{ type: 'movie', id: 'moviesda-tamil', name: 'MoviesDa Tamil' }],
    resources: [
      { name: 'catalog', types: ['movie'], idPrefixes: ['tt', 'tmdb', 'moviesda:'] },
      { name: 'stream', types: ['movie'], idPrefixes: ['tt', 'tmdb', 'moviesda:'] },
    ],
    idPrefixes: ['tt', 'tmdb', 'moviesda:'],
    background: 'https://images.unsplash.com/photo-1440404653325-ab127d49abc1',
    behaviorHints: { configurable: false },
  };
  await fs.writeFile(path.join(STREMIO, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(
    path.join(STREMIO, 'catalog', 'movie', 'moviesda-tamil.json'),
    `${JSON.stringify({ metas: catalog }, null, 1)}\n`
  );

  const byId = new Map();
  for (const movie of movies) {
    const ids = [...new Set([`moviesda:${movie.id}`, movie.imdbId, movie.tmdbId ? `tmdb:${movie.tmdbId}` : ''].filter(Boolean))];
    for (const id of ids) {
      const streams = byId.get(id) || [];
      for (const q of movie.qualities) {
        streams.push({
          title: `${q.quality} • MoviesDa`,
          url: q.url,
          behaviorHints: { notProxy: true },
        });
      }
      byId.set(id, streams);
    }
  }
  for (const [id, streams] of byId) {
    await fs.writeFile(
      path.join(STREMIO, 'stream', 'movie', `${id}.json`),
      `${JSON.stringify({ streams }, null, 1)}\n`
    );
  }

  const stats = {
    updatedAt: new Date().toISOString(),
    mode: 'direct-mp4-only',
    qualitiesAllowed: ['720p', '1080p'],
    movies: movies.length,
    mp4Streams: movies.reduce((n, m) => n + m.qualities.length, 0),
    stremioStreamFiles: byId.size,
    stremioCatalog: catalog.length,
  };
  await fs.writeFile(path.join(DATA, 'moviesda-stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}
