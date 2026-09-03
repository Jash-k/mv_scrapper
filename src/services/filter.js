import { config } from '../config.js';

/**
 * Checks if a quality label belongs to 720p or 1080p.
 * Excludes 2160p/4K, 480p, 360p, and SD mobile rips.
 */
export function isAllowedQuality(qualityText = '') {
  const text = String(qualityText || '').toLowerCase();

  // Exclude 4K / 2160p
  if (config.exclude4k && (/2160p|4k|uhd/i.test(text))) {
    return false;
  }

  // Exclude SD / 480p / 400MB low-res
  if (config.excludeSd && (/480p|360p|\bsd\b|dvdrip/i.test(text) && !/720p|1080p/i.test(text))) {
    return false;
  }

  // Keep ONLY 720p and 1080p
  const is1080p = /1080p/i.test(text);
  const is720p = /720p/i.test(text);

  return is1080p || is720p;
}

/**
 * Formats and cleans quality string with codec & audio details.
 */
export function normalizeQualityString(rawText = '') {
  let base = '720p';
  if (/1080p/i.test(rawText)) {
    base = '1080p';
  } else if (/720p/i.test(rawText)) {
    base = '720p';
  } else {
    return null;
  }

  const parts = [base];

  if (/hevc|x265|h\.?265/i.test(rawText)) {
    parts.push('HEVC');
  } else if (/avc|x264|h\.?264/i.test(rawText)) {
    parts.push('AVC');
  }

  if (/multi[\s-]*audio/i.test(rawText)) {
    parts.push('Multi-Audio');
  }

  return parts.join(' ');
}

/**
 * Filter movie qualities array so only 720p and 1080p magnet links remain.
 */
export function filterMovieQualities(qualities = []) {
  const allowed = [];
  const seenUrls = new Set();

  for (const q of qualities) {
    if (!q.url || !q.url.startsWith('magnet:')) continue;
    if (seenUrls.has(q.url)) continue;

    const fullText = `${q.quality || ''} ${decodeURIComponent(q.url || '')}`;

    if (!isAllowedQuality(fullText)) {
      continue;
    }

    const cleanLabel = normalizeQualityString(fullText) || q.quality || '720p AVC';

    seenUrls.add(q.url);
    allowed.push({
      quality: cleanLabel,
      size: q.size || '',
      type: 'magnet',
      url: q.url,
      languages: q.languages || ['Tamil'],
      seeders: parseInt(q.seeders || 0, 10),
      leechers: parseInt(q.leechers || 0, 10),
    });
  }

  // Sort: 1080p first, then 720p, ordered by seeders
  allowed.sort((a, b) => {
    const a1080 = a.quality.includes('1080p') ? 2 : 1;
    const b1080 = b.quality.includes('1080p') ? 2 : 1;
    if (a1080 !== b1080) return b1080 - a1080;
    return (b.seeders || 0) - (a.seeders || 0);
  });

  return allowed;
}
