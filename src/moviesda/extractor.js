/**
 * MoviesDa extractor — Tamil MOVIES only → direct MP4 links (720p + 1080p).
 *
 * No embeds / onestream / iframe tier.
 *
 * Pipeline:
 *   /tamil-latest-updates/ or /tamil-YYYY-movies/
 *     -> movie folders -> resolution subfolders (720p/1080p only)
 *     -> /download/<id> server list
 *     -> fastbytes/download.php or bare .mp4 hosts
 *     -> 302 / direct Cloudflare R2 (or durable hotshare/biggshare) MP4 URL
 */
import * as cheerio from 'cheerio';

const BASES = ['https://moviesda34.com', 'https://movies.downloadpage.xyz'];
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ta;q=0.8',
};
const DELAY_MS = Number(process.env.MOVIESDA_DELAY_MS || 900);
const TIMEOUT_MS = Number(process.env.MOVIESDA_TIMEOUT_MS || 15000);
const RETRIES = 2;

/** Strict quality allowlist (matches TamilMV scraper). */
const ALLOWED_QUALITIES = new Set(['720p', '1080p']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isWebSeries(text = '') {
  return /web[- ]?series|\bseason\b|\bS\d{2}\b|\bepi(?:sode)?\b/i.test(String(text));
}

function qualityFromText(text = '') {
  const t = String(text);
  if (/1080p/i.test(t)) return '1080p';
  if (/720p/i.test(t)) return '720p';
  return null;
}

async function fetchWithRetry(url, { attempt = 0 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: 'follow',
        signal: controller.signal,
      });
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
  try {
    return new URL(href, base).href;
  } catch {
    return '';
  }
}

/** Fetch a path (mirrored) or an absolute URL (as-is). */
async function fetchPage(urlOrPath) {
  if (/^https?:\/\//i.test(urlOrPath)) {
    const u = new URL(urlOrPath);
    return { html: await fetchWithRetry(urlOrPath), base: u.origin };
  }
  return fetchFromMirrors(urlOrPath);
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
    if (!href || !text) return;
    // Hard skip web series / seasons / episodes at listing level
    if (isWebSeries(text) || isWebSeries(href)) return;
    folders.push({ url: href, label: text.slice(0, 160) });
  });
  return folders;
}

/** Stage 2: resolution subfolder links — 720p / 1080p only. */
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
    if (isWebSeries(label) || isWebSeries(href)) return;

    const quality = qualityFromText(`${label} ${href}`);
    if (!quality || !ALLOWED_QUALITIES.has(quality)) return;

    const abs = absolute(base, href);
    if (abs) out.push({ url: abs, label, quality });
  });

  // Prefer 1080p first, then 720p; dedupe by URL
  const seen = new Set();
  return out
    .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)))
    .sort((a, b) => (b.quality === '1080p' ? 1 : 0) - (a.quality === '1080p' ? 1 : 0));
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

/**
 * Rank candidates so durable bare-.mp4 hosts win over short-lived token gates.
 * Higher score = preferred.
 */
function candidateScore(url) {
  let score = 0;
  const u = String(url);
  // Bare durable CDNs (no htag/etag expiry)
  if (/biggshare|hotshare\.(cyou|link)|r2\.cloudflarestorage\.com/i.test(u)) score += 50;
  if (/\.mp4(\?|$)/i.test(u) && !/[?&](htag|etag|ztag|token|exp)=/i.test(u)) score += 30;
  // Signed R2 from fastbytes is real video but expires ~48h — still good within cron
  if (/cloudflarestorage\.com|X-Amz-Signature/i.test(u)) score += 20;
  if (/fastbytes|download\.php/i.test(u)) score += 10;
  // Tokenized gate hosts (often rot into HTML between runs)
  if (/[?&](htag|etag|ztag)=/i.test(u)) score -= 15;
  if (/kollybytes|skyvault|fileraja|cloudbytes|fastspot|datapulse|pixelharbor|orbitcore|streamnest|cloudforge/i.test(u)) {
    score -= 5;
  }
  return score;
}

/**
 * Stage 4: candidate DIRECT file links only.
 * Skips onestream / watch-online / iframe hosts entirely.
 * Sorted durable-first so scrapeMovie prefers long-lived URLs.
 */
export async function getServerCandidates(serverPageUrl) {
  const extract = (html, base) => {
    const $ = cheerio.load(html);
    const out = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const label = $(el).text().replace(/\s+/g, ' ').trim();
      if (!href) return;
      // Explicitly reject embed / watch-online hosts
      if (/onestream|watch\s*online|iframe|embed/i.test(href + ' ' + label)) return;
      if (
        /\.mp4(\?|$)/i.test(href) ||
        /cdnserver|download\.php|fastbytes|uptodl|biggshare|hotshare/i.test(href)
      ) {
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
  // Dedupe by URL, then durable hosts first
  const seen = new Set();
  return candidates
    .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .sort((a, b) => candidateScore(b.url) - candidateScore(a.url));
}

/**
 * Stage 5: resolve the final direct MP4.
 * - onestream / iframe → rejected (null)
 * - fastbytes/download.php → follow 302 Location to R2 MP4
 * - bare .mp4 URL → keep as-is (verified later)
 */
export async function resolveServerLink(url) {
  if (!url) return null;
  if (/onestream\.today|play\.onestream|iframe|embed/i.test(url)) return null;

  // Already a bare/direct mp4 host — keep (byte-verify later)
  if (/\.mp4(\?|$)/i.test(url) && !/download\.php/i.test(url)) {
    return { type: 'mp4', url };
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
          // Follow one more hop if still a gateway, else return
          if (/download\.php|fastbytes|uptodl/i.test(location) && !/\.mp4/i.test(location)) {
            const hop = await fetch(location, {
              method: 'GET',
              headers: { ...HEADERS, Referer: url },
              redirect: 'manual',
              signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const loc2 = hop.headers.get('location');
            if (loc2 && /^https?:\/\//.test(loc2)) return { type: 'mp4', url: loc2 };
          }
          return { type: 'mp4', url: location };
        }
        // Some servers 200 with the FILE itself — never buffer a video body.
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (res.ok && /video\/|octet-stream/.test(ctype)) {
          try {
            await res.body.cancel();
          } catch {
            /* already drained */
          }
          return { type: 'mp4', url };
        }
        // Otherwise 200 with a meta-refresh or HTML page; sniff the first 4 KiB.
        if (res.ok) {
          const body = await readCapped(res, 4096);
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
  return m
    ? { title: m[1].replace(/[-–]\s*$/, '').trim(), year: Number(m[2]) }
    : { title: t, year: '' };
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
  try {
    await reader.cancel();
  } catch {
    /* closed */
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/**
 * Full extraction for one movie page → direct MP4s only (720p/1080p).
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
  };

  // Bail early on series that slipped past listing filter
  if (isWebSeries(moviePage.label) || isWebSeries(moviePage.url)) {
    base.error = 'web-series-skipped';
    return base;
  }

  try {
    let folderGroups = [];
    try {
      folderGroups = await getMovieFolders(moviePage.url);
    } catch {
      /* some item pages link resolutions directly */
    }
    // Also filter folder groups
    folderGroups = folderGroups.filter((g) => !isWebSeries(g.label) && !isWebSeries(g.url));

    const groupPages = folderGroups.length
      ? folderGroups.slice(0, 2)
      : [{ url: moviePage.url, label: moviePage.label }];

    const seen = new Set();
    for (const group of groupPages) {
      await sleep(DELAY_MS);
      let resolutions = [];
      try {
        resolutions = await getResolutionSubfolders(group.url);
      } catch {
        continue;
      }

      for (const res of resolutions.slice(0, maxQualities)) {
        await sleep(DELAY_MS);
        const quality = res.quality || qualityFromText(res.label) || 'HD';
        if (!ALLOWED_QUALITIES.has(quality)) continue;

        let selections = [];
        try {
          selections = await getDownloadSelectionUrls(res.url);
        } catch {
          continue;
        }

        for (const selection of selections.slice(0, 2)) {
          await sleep(400);
          let serverPages = [];
          try {
            serverPages = await getIntermediateServerUrls(selection);
          } catch {
            continue;
          }

          for (const serverPage of serverPages.slice(0, 2)) {
            await sleep(400);
            let candidates = [];
            try {
              candidates = await getServerCandidates(serverPage);
            } catch {
              continue;
            }

            for (const candidate of candidates.slice(0, maxPerRes)) {
              try {
                const resolved = await resolveServerLink(candidate.url);
                if (!resolved || resolved.type !== 'mp4') continue;
                if (seen.has(resolved.url)) continue;
                seen.add(resolved.url);
                base.mp4s.push({
                  quality,
                  size: '',
                  type: 'mp4',
                  url: resolved.url,
                });
              } catch {
                /* dead server — skip */
              }
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

/** Latest-updates listing (movies only). */
export async function scrapeLatest({ limit = 25 } = {}) {
  const folders = await getMovieFolders('/tamil-latest-updates/');
  return folders.filter((f) => !isWebSeries(f.label) && !isWebSeries(f.url)).slice(0, limit);
}

/** Year listing (/tamil-YYYY-movies/) — movies only. */
export async function scrapeYear(year, { limit = 30, page = 1 } = {}) {
  const path = page > 1 ? `/tamil-${year}-movies/?page=${page}` : `/tamil-${year}-movies/`;
  const folders = await getMovieFolders(path);
  return folders.filter((f) => !isWebSeries(f.label) && !isWebSeries(f.url)).slice(0, limit);
}
