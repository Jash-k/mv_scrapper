#!/usr/bin/env node
/**
 * src/check.js — fail fast when an import has no matching dependency.
 *
 * The failure this exists to prevent (GitHub Actions, 29 Sep 2026):
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'axios' imported from
 *   /home/runner/work/mv_scrapper/mv_scrapper/src/scraper/tamilmv.js
 *
 * The code imported axios and dotenv, package.json declared neither, so the
 * workflow's `npm ci` installed a dependency set that could not run — and the
 * error only appeared once the scraper actually executed. This walks every
 * module under src/ and reports the package by name plus the exact install line,
 * so the job fails in ~2 seconds with a message that says what to do.
 *
 *   npm run check
 *
 * Entry points (`*-cli.js`) are skipped: importing them would start a scrape.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return entry.name.endsWith('.js') ? [full] : [];
});

const files = walk(SRC)
  .filter((file) => !/-cli\.js$/.test(file) && file !== fileURLToPath(import.meta.url))
  .sort();

const failures = [];
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    const moduleNotFound = /Cannot find package '([^']+)'/.exec(error.message);
    const localMissing = /Cannot find module '([^']+)'/.exec(error.message);
    failures.push({
      file: path.relative(process.cwd(), file),
      missing: moduleNotFound?.[1] || '',
      message: String(error.message).split('\n')[0],
      local: localMissing && !moduleNotFound ? localMissing[1] : '',
    });
  }
}

if (failures.length) {
  console.error(`\n  ${failures.length} module(s) failed to load:\n`);
  for (const failure of failures) {
    console.error(`    ${failure.file}`);
    console.error(`      ${failure.message}`);
  }
  const packages = [...new Set(failures.map((failure) => failure.missing).filter(Boolean))];
  if (packages.length) {
    console.error(`\n  Missing dependenc${packages.length === 1 ? 'y' : 'ies'}: ${packages.join(', ')}`);
    console.error(`  Fix:  npm install ${packages.join(' ')}`);
    console.error('        then commit BOTH package.json and package-lock.json\n');
  } else {
    console.error('\n  A relative import points at a file that is not there (deleted or renamed).\n');
  }
  process.exit(1);
}

console.log(`  all ${files.length} modules under src/ load — every import resolves`);
