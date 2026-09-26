/**
 * MoviesDa extractor — Tamil movies → direct MP4 + embed tiers.
 *
 * Ported and hardened from the working pipeline in Roshan00008/moviesdastream
 * (MIT), reduced to the MOVIES-ONLY scope this repo ships, and extended with:
 *   - mirror fallback (moviesda34.com -> movies.downloadpage.xyz)
 *   - per-request timeout + retry (2 attempts, polite delay)
 *   - iframe-tier capture: onestream player pages become { type: 'iframe' }
 *     entries for JaSH ViBeS' watch page (Stremio never sees them)
 *   - strict quality allowlist kept consistent with the TamilMV scraper
 *
 * Pipeline (verified working 2026-09):
 *   /tamil-latest-updates/ or /tamil-YYYY-movies/
 *     -> movie folders -> resolution subfolders (360p/720p/1080p)
 *     -> download.moviespage.xyz server list
 *     -> fastbytes/download.php links --302--> Cloudflare R2 direct .mp4
 *   onestream.today/stream/page/<id> links are captured as embeds instead.
 */
import * as cheerio from 'cheerio';

const BASES = ['https://moviesda34.com', 'https://movies.downloadpage.xyz'];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ta;q=0.8',
};
const DELAY_MS = Number(process.env.MOVIESDA_DELAY_MS || 900);
const TIMEOUT_MS = Number(process.env.MOVIESDA_TIMEOUT_MS || 15000);
const RETRIES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { attempt = 0 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (attempt < RETRIES) {
      await sleep(1200 * (attempt + 1));
      return fetchWithRetry(url, { attempt: attempt + 1 });
    }
    throw error;
  }
}

/** Try every mirror until one answers. */
async function fetchFromMirrors(path) {
  let lastError;
  for (const base of BASES) {
    try {
      const html = await fetchWithRetry(base + path);
      if (html && html.length > 500) return { html, base };
      throw new Error(`thin response (${html?.length || 0}B)`);
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw lastError || new Error('all mirrors failed');
}

function absolute(base, href) {
  if (!href) return '';
  try { return new URL(href, base).href; } catch { return ''; }
}

/** Stage 1: folder links from a listing/movie page (div.f blocks). */
export async function getMovieFolders(listPath) {
  const isFull = /^https?:\/\//i.test(listPath);
  const { html, base } = isFull
    ? { html: await fetchWithRetry(listPath), base: new URL(listPath).origin }
    : await fetchFromMirrors(listPath);
  const $ = cheerio.load(html);
  const folders = [];
  $('div.f, div.folder').each((_, el) => {
    const a = $(el).find('a').first();
    const href = absolute(base, a.attr('href') || '');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (href && text) folders.push({ url: href, label: text.slice(0, 160) });
  });
  return folders;
}

/** Fetch a path (mirrored) or an absolute URL (as-is). */
async function fetchPage(urlOrPath) {
  if (/^https?:\/\//i.test(urlOrPath)) {
    const u = new URL(urlOrPath);
    return { html: await fetchWithRetry(urlOrPath), base: u.origin };
  }
  return fetchFromMirrors(urlOrPath);
}

/** Stage 2: resolution subfolder links inside one movie folder page. */
export async function getResolutionSubfolders(movieUrl) {
  const { html, base } = await fetchPage(movieUrl);
  const $ = cheerio.load(html);
  const out = [];
  $('div.f a, div.folder a, a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).text().replace(/\s+/g, ' ').trim();
    if (!href || href === '/' || href.startsWith('#') || href.startsWith('mailto:')) return;
    if (/telegram|t\.me|whatsapp|instagram/i.test(label + href)) return;
    if (href.includes('-movies/') || href.includes('collection') || href.includes('isaidub')) return;
    const hasQuality = /\d+p|hd|predvd|dvd|blu/i.test(label) || /\d+p|hd-|predvd|dvd|blu/i.test(href);
    if (!hasQuality) return;
    const abs = absolute(base, href);
    if (abs) out.push({ url: abs, label });
  });
  const seen = new Set();
  return out.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

/** Stage 3: /download/<id> selection links on a resolution page. */
export async function getDownloadSelectionUrls(resolutionUrl) {
  const { html, base } = await fetchPage(resolutionUrl);
  const $ = cheerio.load(html);
  const set = new Set();
  $('a, div.f a, div.folder a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.startsWith('/download/')) set.add(absolute(base, href));
  });
  return [...set];
}

/** Stage 3b: server links on a /download/<id> page. */
export async function getIntermediateServerUrls(selectionUrl) {
  const { html, base } = await fetchPage(selectionUrl);
  const $ = cheerio.load(html);
  const out = [];
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('moviespage.xyz/download/file/') || href.includes('/download/file/')) {
      out.push(absolute(base, href));
    }
  });
  return [...new Set(out)];
}

/** Stage 4: candidate file links on a download/file or download/page URL. */
export async function getServerCandidates(serverPageUrl) {
  const extract = (html, base) => {
    const $ = cheerio.load(html);
    const out = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      if (href && (/\.mp4/i.test(href) || /cdnserver|download\.php|fastbytes|onestream|uptodl/i.test(href))) {
        out.push({ url: absolute(base, href), label: label || 'server' });
      }
    });
    return out;
  };

  // download/file/<id> pages are bare redirect stubs pointing at
  // download/page/<id> — follow that hop when the first page is empty.
  let { html, base } = await fetchPage(serverPageUrl);
  let candidates = extract(html, base);
  if (!candidates.length) {
    const $ = cheerio.load(html);
    const nextHop = $('a[href*="download/page/"]').first().attr('href');
    if (nextHop) {
      const pageUrl = absolute(base, nextHop);
      const inner = await fetchWithRetry(pageUrl);
      candidates = extract(inner, pageUrl);
    }
  }
  return candidates;
}

/**
 * Stage 5: resolve the final file. fastbytes/download.php/uptodl links answer
 * a plain GET with a 302 straight to the MP4 on Cloudflare R2 (verified).
 * onestream links are NOT resolvable server-side (browser-gated) — returned
 * as embed candidates instead.
 */
export async function resolveServerLink(url) {
  if (/onestream\.today/i.test(url)) {
    return { type: 'iframe', url: url.includes('/stream/page/') ? url : url };
  }
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { ...HEADERS, Referer: 'https://movies.downloadpage.xyz/' },
          redirect: 'manual',
          signal: controller.signal,
        });
        const location = res.headers.get('location');
        if (location && /^https?:\/\//.test(location)) {
          return { type: 'mp4', url: location };
        }
        // Some servers 200 with the FILE itself — never buffer a video body.
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (res.ok && /video\/|octet-stream/.test(ctype)) {
          try { await res.body.cancel(); } catch { /* already drained */ }
          return { type: 'mp4', url };
        }
        // Otherwise 200 with a meta-refresh or HTML page; sniff the first 4 KiB.
        if (res.ok) {
          const body = (await readCapped(res, 4096));
          const meta = body.match(/https?:\/\/[^"'\s]+\.mp4[^"'\s]*/i);
          if (meta) return { type: 'mp4', url: meta[0] };
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      await sleep(600);
    }
  }
  return null;
}

/** Parse "Movie Name (2024)" style labels. */
export function parseTitleYear(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const m = t.match(/(.+?)[\s_-]*[\(\[]?((19|20)\d{2})[\)\]]?/);
  return m ? { title: m[1].replace(/[-–]\s*$/, '').trim(), year: Number(m[2]) } : { title: t, year: '' };
}

/** Read at most `max` bytes of a response body (CDNs ignore Range sometimes). */
async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  try { await reader.cancel(); } catch { /* closed */ }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/**
 * Full extraction for one movie page:
 *   item page -> folder groups -> resolution pages -> /download/<id> ->
 *   download/file pages -> server candidates -> 302-resolved direct MP4
 *   (onestream candidates become embeds instead).
 */
export async function scrapeMovie(moviePage, { maxQualities = 4, maxPerRes = 3 } = {}) {
  const parsed = parseTitleYear(moviePage.label);
  const base = {
    sourcePage: moviePage.url,
    label: moviePage.label,
    title: parsed.title,
    year: parsed.year,
    poster: '',
    mp4s: [],
    embeds: [],
  };

  try {
    let folderGroups = [];
    try {
      folderGroups = await getMovieFolders(moviePage.url);
    } catch { /* some item pages link resolutions directly */ }
    const groupPages = folderGroups.length
      ? folderGroups.slice(0, 2)
      : [{ url: moviePage.url, label: moviePage.label }];

    const seen = new Set();
    for (const group of groupPages) {
      await sleep(DELAY_MS);
      let resolutions = [];
      try {
        resolutions = await getResolutionSubfolders(group.url);
      } catch { continue; }

      for (const res of resolutions.slice(0, maxQualities)) {
        await sleep(DELAY_MS);
        const quality = (res.label.match(/(1080p|720p|480p|360p)/i) || ['HD'])[0];

        let selections = [];
        try {
          selections = await getDownloadSelectionUrls(res.url);
        } catch { continue; }

        for (const selection of selections.slice(0, 2)) {
          await sleep(400);
          let serverPages = [];
          try {
            serverPages = await getIntermediateServerUrls(selection);
          } catch { continue; }

          for (const serverPage of serverPages.slice(0, 2)) {
            await sleep(400);
            let candidates = [];
            try {
              candidates = await getServerCandidates(serverPage);
            } catch { continue; }

            for (const candidate of candidates.slice(0, maxPerRes)) {
              try {
                const resolved = await resolveServerLink(candidate.url);
                if (!resolved || seen.has(resolved.url)) continue;
                seen.add(resolved.url);
                if (resolved.type === 'mp4') {
                  base.mp4s.push({ quality, size: '', type: 'mp4', url: resolved.url });
                } else {
                  base.embeds.push({ quality, size: '', type: 'iframe', url: resolved.url });
                }
              } catch { /* dead server — skip */ }
            }
          }
        }
      }
    }
  } catch (error) {
    base.error = error.message;
  }
  return base;
}

/** Latest-updates listing (the freshest Tamil drops). */
export async function scrapeLatest({ limit = 25 } = {}) {
  const folders = await getMovieFolders('/tamil-latest-updates/');
  return folders.slice(0, limit);
}

/** Year listing (/tamil-YYYY-movies/). */
export async function scrapeYear(year, { limit = 30, page = 1 } = {}) {
  const path = page > 1 ? `/tamil-${year}-movies/?page=${page}` : `/tamil-${year}-movies/`;
  const folders = await getMovieFolders(path);
  return folders.slice(0, limit);
}
