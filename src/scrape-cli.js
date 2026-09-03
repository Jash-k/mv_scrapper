import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { scrapeTamilMV } from './scraper/tamilmv.js';
import { enrichMoviesWithImdb } from './services/imdb.js';
import { config } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');

async function main() {
  console.log('===============================================================');
  console.log('🚀 Starting 1TamilMV Scraper (720p & 1080p Quality Filter Only)');
  console.log('===============================================================');

  const startTime = Date.now();
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    // 1. Scrape 1TamilMV with quality filtering applied
    const scraped = await scrapeTamilMV(config.maxScrapeLimit);
    console.log(`[Scraper] Successfully scraped ${scraped.length} movies.`);

    // 2. Enrich with Cinemeta / IMDb metadata
    console.log('[Cinemeta] Enriching movie metadata (IMDb IDs, posters, genres)...');
    const enriched = await enrichMoviesWithImdb(scraped);

    // 3. Calculate statistics
    const totalMagnets = enriched.reduce((acc, m) => acc + (m.qualities?.length || 0), 0);
    const predvdCount = enriched.filter((m) =>
      /predvd|cam|dvdscr|hdtc|telesync|ts\b/i.test(m.rawText || '')
    ).length;

    const stats = {
      updatedAt: new Date().toISOString(),
      timestamp: Date.now(),
      durationSeconds: Math.round((Date.now() - startTime) / 1000),
      totalMovies: enriched.length,
      totalMagnets,
      predvdMoviesCount: predvdCount,
      allowedQualities: ['720p', '1080p'],
    };

    // 4. Save data files
    const moviesJsonPath = path.join(DATA_DIR, 'movies.json');
    const statsJsonPath = path.join(DATA_DIR, 'stats.json');

    await fs.writeFile(moviesJsonPath, JSON.stringify(enriched, null, 2), 'utf-8');
    await fs.writeFile(statsJsonPath, JSON.stringify(stats, null, 2), 'utf-8');

    console.log('===============================================================');
    console.log(`✅ Scrape Completed in ${stats.durationSeconds}s!`);
    console.log(`📁 Saved: ${moviesJsonPath} (${enriched.length} movies, ${totalMagnets} 720p/1080p magnets)`);
    console.log(`🔥 PreDVD Titles Detected: ${predvdCount}`);
    console.log('===============================================================');
  } catch (err) {
    console.error('❌ Scrape failed with error:', err);
    process.exit(1);
  }
}

main();
