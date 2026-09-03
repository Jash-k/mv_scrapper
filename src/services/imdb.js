import axios from 'axios';

const CINEMETA_SEARCH_BASE = 'https://v3-cinemeta.strem.io/catalog/movie/top/search=';

function titleSimilarity(a, b) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const aNorm = norm(a);
  const bNorm = norm(b);
  if (!aNorm || !bNorm) return 0;

  const aTokens = new Set(aNorm.split(' '));
  const bTokens = new Set(bNorm.split(' '));

  let intersection = 0;
  aTokens.forEach((t) => {
    if (bTokens.has(t)) intersection += 1;
  });

  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

export async function searchCinemeta(cleanName, yearGuess) {
  const url = `${CINEMETA_SEARCH_BASE}${encodeURIComponent(cleanName)}.json`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    if (!data || !Array.isArray(data.metas) || data.metas.length === 0) {
      return null;
    }

    if (yearGuess) {
      const byYear = data.metas.find(
        (m) => m.year && Math.abs(parseInt(m.year, 10) - parseInt(yearGuess, 10)) <= 1
      );
      if (byYear) return byYear;
    }

    return data.metas[0] || null;
  } catch (err) {
    return null;
  }
}

export async function enrichMoviesWithImdb(movies = []) {
  const enrichOne = async (movie) => {
    const enriched = { ...movie };
    const cleanName = movie.titleGuess || movie.rawTitle || '';

    try {
      if (cleanName) {
        const meta = await searchCinemeta(cleanName, movie.yearGuess);
        if (meta) {
          const score = titleSimilarity(cleanName, meta.name);
          if (score >= 0.4) {
            enriched.imdbId = meta.id;
            enriched.name = meta.name || movie.rawTitle;
            enriched.year = meta.year || movie.yearGuess;
            enriched.poster = meta.poster || enriched.poster;
            enriched.thumbnail = meta.poster || enriched.thumbnail;
            enriched.genres = meta.genres || enriched.genres;
            enriched.description = meta.description || enriched.description;
            enriched.imdbRating = meta.imdbRating ? String(meta.imdbRating) : enriched.imdbRating;
          }
        }
      }
    } catch (err) {
      // Ignore Cinemeta failure and retain raw metadata
    }
    return enriched;
  };

  // Run in chunks of 15 concurrent requests for high speed
  const CHUNK_SIZE = 15;
  const results = [];
  for (let i = 0; i < movies.length; i += CHUNK_SIZE) {
    const chunk = movies.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.all(chunk.map(enrichOne));
    results.push(...settled);
  }

  return results;
}
