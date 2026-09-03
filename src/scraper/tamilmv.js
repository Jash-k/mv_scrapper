import axios from 'axios';
import * as cheerio from 'cheerio';
import crypto from 'crypto';
import { config } from '../config.js';
import { filterMovieQualities } from '../services/filter.js';

let activeBaseUrl = config.tamilmvMirrors[0];

export const makeId = (rawTitle) =>
  crypto.createHash('md5').update(String(rawTitle || '').toLowerCase().trim()).digest('hex');

export function appendTrackers(magnetUrl) {
  if (!magnetUrl.startsWith('magnet:')) return magnetUrl;
  const existingLower = magnetUrl.toLowerCase();
  const trackersToAdd = config.trackers.filter((tr) => !existingLower.includes(tr.toLowerCase()));
  if (trackersToAdd.length > 0) {
    const sep = magnetUrl.includes('?') ? '&' : '?';
    return `${magnetUrl}${sep}${trackersToAdd.map((t) => `tr=${encodeURIComponent(t)}`).join('&')}`;
  }
  return magnetUrl;
}

export function parseTitleAndYear(rawTitle) {
  const yearMatch = rawTitle.match(/\b(19|20)\d{2}\b/);
  const yearGuess = yearMatch ? parseInt(yearMatch[0], 10) : undefined;

  let titleGuess = rawTitle;
  if (yearMatch && yearMatch.index !== undefined) {
    titleGuess = rawTitle.substring(0, yearMatch.index);
  } else {
    titleGuess = rawTitle.split(/-|\[/)[0] || rawTitle;
  }

  titleGuess = titleGuess.replace(/[\(\[\-\)\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return { titleGuess, yearGuess };
}

export function detectLanguages(rawText) {
  const found = [];
  if (/Tamil|\bTAM\b/i.test(rawText)) found.push('Tamil');
  if (/Malayalam|\bMAL\b/i.test(rawText)) found.push('Malayalam');
  if (/Telugu|\bTEL\b|Teugu/i.test(rawText)) found.push('Telugu');
  if (/Kannada|Kanada|\bKAN\b/i.test(rawText)) found.push('Kannada');
  if (/Hindi|\bHIN\b/i.test(rawText)) found.push('Hindi');

  if (/(multi|dual)[\s-]*audio/i.test(rawText) || found.length > 1) {
    if (!found.includes('Multi-Lang')) found.push('Multi-Lang');
  }

  return found.length > 0 ? found : ['Tamil'];
}

export async function fetchTamilMVHomepageHtml() {
  const mirrors = Array.from(new Set(config.tamilmvMirrors.map((m) => m.replace(/\/+$/, ''))));

  for (const mirror of mirrors) {
    try {
      console.log(`[TamilMV] Trying mirror: ${mirror}`);
      const response = await axios.get(mirror, {
        headers: config.browserHeaders,
        timeout: 12000,
        maxRedirects: 5,
      });

      const html = String(response.data || '');
      if (response.status === 200 && html.includes('forums/topic/')) {
        console.log(`[TamilMV] Mirror connected successfully: ${mirror} (${html.length} bytes)`);
        activeBaseUrl = mirror;
        return { html, activeBaseUrl: mirror };
      }
    } catch (err) {
      console.warn(`[TamilMV] Mirror ${mirror} failed (${err.message}). Trying next mirror...`);
    }
  }

  throw new Error('All 1TamilMV mirrors failed to respond.');
}

export async function scrapeMoviePageForMagnets(targetUrl) {
  try {
    const response = await axios.get(targetUrl, {
      headers: config.browserHeaders,
      timeout: 10000,
      maxRedirects: 5,
    });

    const $ = cheerio.load(response.data);
    const results = [];

    $('a[href^="magnet:"]').each((_, el) => {
      const link = $(el);
      const href = link.attr('href');
      if (!href) return;

      // Extract details from 'dn' magnet name or surrounding tags
      const dnMatch = href.match(/dn=([^&]+)/);
      let textToScan = dnMatch && dnMatch[1] ? decodeURIComponent(dnMatch[1]) : '';
      if (!textToScan) {
        textToScan = link.prevAll('strong').first().text() || link.text();
      }

      // Extract size
      let size = '';
      const sizeMatch = textToScan.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|GiB|MiB))/i);
      if (sizeMatch && sizeMatch[1]) {
        size = sizeMatch[1].replace(/\s+/g, '').toUpperCase();
      }

      results.push({
        quality: textToScan,
        size,
        type: 'magnet',
        url: appendTrackers(href),
        seeders: 100, // baseline seeder discovery
        leechers: 10,
      });
    });

    return results;
  } catch (error) {
    console.warn(`[TamilMV] Could not scrape topic ${targetUrl}: ${error.message}`);
    return [];
  }
}

export async function scrapeTamilMV(limit = config.maxScrapeLimit) {
  const { html, activeBaseUrl } = await fetchTamilMVHomepageHtml();
  const movieMap = new Map();

  const chunks = html.split(/<br\s*\/?>|<\/?p[^>]*>|<\/?div[^>]*>|<\/?tr[^>]*>|<\/?li[^>]*>/i);
  console.log(`[TamilMV] Scanning ${chunks.length} HTML layout blocks...`);

  for (const chunk of chunks) {
    if (!chunk.includes('/index.php?/forums/topic/')) continue;

    const $chunk = cheerio.load(chunk);
    const linkNode = $chunk('a[href*="/index.php?/forums/topic/"]').first();
    let pageUrl = linkNode.attr('href');
    if (!pageUrl) continue;

    if (!pageUrl.startsWith('http')) {
      pageUrl = `${activeBaseUrl.replace(/\/+$/, '')}/${pageUrl.replace(/^\/+/, '')}`;
    }

    const rawText = $chunk.text().replace(/\s+/g, ' ').trim();
    if (rawText.length < 10) continue;

    // Exclude TV serials and Telegram spam
    if (/\bS\d{2}\b/i.test(rawText) || /EP\s*\(\d+(?:\s*-\s*\d+)?\)/i.test(rawText) || /Telegram/i.test(rawText)) {
      continue;
    }

    const { titleGuess, yearGuess } = parseTitleAndYear(rawText);
    if (!titleGuess) continue;

    const rawTitle = `${titleGuess} ${yearGuess ? `(${yearGuess})` : ''}`.trim();
    const id = makeId(rawTitle);
    const topicLangs = detectLanguages(rawText);

    if (movieMap.has(id)) {
      const entry = movieMap.get(id);
      if (!entry.topics.some((t) => t.pageUrl === pageUrl)) {
        entry.topics.push({ pageUrl, languages: topicLangs, rawText });
      }
      entry.movie.languages = Array.from(new Set([...entry.movie.languages, ...topicLangs]));
    } else {
      if (movieMap.size >= limit) break;

      movieMap.set(id, {
        movie: {
          id,
          rawTitle,
          titleGuess,
          yearGuess,
          pageUrl,
          qualities: [],
          rawText,
          languages: topicLangs,
        },
        topics: [{ pageUrl, languages: topicLangs, rawText }],
      });
    }
  }

  console.log(`[TamilMV] Found ${movieMap.size} unique movies. Extracting & filtering 720p/1080p magnets...`);

  const resultMovies = [];

  for (const { movie, topics } of movieMap.values()) {
    const rawQualities = [];
    for (const topic of topics) {
      const pageMagnets = await scrapeMoviePageForMagnets(topic.pageUrl);
      for (const q of pageMagnets) {
        q.languages = topic.languages;
        rawQualities.push(q);
      }
    }

    // STRICT QUALITY FILTER: Keep ONLY 720p & 1080p magnets!
    const filteredQualities = filterMovieQualities(rawQualities);

    if (filteredQualities.length > 0) {
      movie.qualities = filteredQualities;
      resultMovies.push(movie);
      console.log(` ✓ ${movie.titleGuess} (${movie.yearGuess || '2026'}) -> ${filteredQualities.length} magnets (720p/1080p only)`);
    }
  }

  return resultMovies;
}
