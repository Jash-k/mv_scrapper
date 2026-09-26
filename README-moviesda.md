# MoviesDa Module — for `mv_scrapper` (additive, non-invasive)

Adds a **second scraper** to this repo: MoviesDa Tamil movies → **direct MP4**
links (byte-verified) + **iframe embeds**, committed as static files every
4 hours by its own workflow. **Nothing existing is touched** — `scrape.yml`,
`src/scraper/*`, `src/scrape-cli.js` and `data/movies.json` stay exactly as they are.

## What gets added (copy into the repo root)

```
src/moviesda/extractor.js      scraper pipeline (mirror fallback, retries, polite delays)
src/moviesda/verify.js         byte-verify MP4s (ftyp check) + embed probes
src/moviesda/build.js          emits all output files
src/moviesda-cli.js            orchestrator (node src/moviesda-cli.js)
.github/workflows/moviesda.yml its own cron (0 */4 * * *) — separate from TamilMV
```

## Outputs (all new files; existing data files are read-only to this module)

| File | Tier | Eaten by |
|---|---|---|
| `data/moviesda.json` | direct MP4s (verified) | **JaSH ViBeS** ReTro (JSON source) + Stremio builder |
| `data/embeds.json`   | iframe player pages | **JaSH ViBeS** watch page ONLY (embed tier) |
| `data/moviesda.m3u`  | M3U twin of the MP4 tier | JaSH ViBeS ReTro (alternative ingest) |
| `stremio/manifest.json` + `stremio/catalog/**` + `stremio/stream/**` | static Stremio addon (MP4 + your existing TamilMV magnets merged by title+year) | Stremio via GitHub Pages |
| `data/moviesda-stats.json` | run metadata | humans |

Guarantees baked into the build:
- **No magnet ever enters moviesda.json / embeds.json / moviesda.m3u.** Magnets
  are read from `data/movies.json` and only appear in the `stremio/` output.
  (Render prohibits torrent traffic — the app-side sync additionally rejects
  any `magnet:` URL at parse time.)
- **Zero unverified streams**: an MP4 ships only if a ranged GET just now
  returned real `ftyp` bytes; an embed ships only if its page still serves a
  `<video>` player and sends no `X-Frame-Options`.
- If a run verifies **zero** MP4s (upstream layout change), the CLI exits
  non-zero and commits nothing — your good data is never overwritten with junk.

## Install (5 minutes)

```bash
cd mv_scrapper
# copy the files from this package (same relative paths), then:
npm install            # adds cheerio (already in package.json deps)
node src/moviesda-cli.js --limit=3     # small test run
git add -A && git commit -m "add moviesda module (additive)" && git push
```

Add the TMDB key for Stremio ids (repo Settings → Secrets → Actions):
`TMDB_API_KEY` — without it the scraper still works; only the Stremio
catalog/stream files are skipped (they need tmdb/imdb ids). The
`moviesda.json` / `embeds.json` / `moviesda.m3u` outputs are unaffected.

Then enable **Settings → Pages → Deploy from branch → main → / (root)** (or
`/docs` if you prefer) — GitHub Pages serves `stremio/manifest.json` at
`https://<user>.github.io/mv_scrapper/stremio/manifest.json`.

## JaSH ViBeS wiring

1. Admin → ReTro → Add source →
   `https://raw.githubusercontent.com/Jash-k/mv_scrapper/main/data/moviesda.json`
   (JSON source — supported since v10.4.0; magnets auto-rejected at parse)
2. Optionally also the m3u twin — pick ONE of the two, not both.
3. Admin → Stremio → pin `https://<user>.github.io/mv_scrapper/stremio/manifest.json`
4. Watch page: MP4s play in JashPlayer; embeds (from embeds.json) render in the
   sandboxed embed tier with a one-tap "next source" escape.

## Telegram-Stremio loop — untouched

`data/movies.json` (TamilMV magnets) keeps feeding `PREDVD_FEED_URL` exactly as
before. This module never writes it. The leech → Telegram → Stremio pipeline
is unaffected.

## Ops notes

- Cadence: every 4 h (`0 */4 * * *`), ~6–8 min per run, 60 movies/run cap.
  Tune via `MOVIESDA_YEARS_BACK`, `MOVIESDA_MAX_MOVIES`, `MOVIESDA_LATEST`,
  `MOVIESDA_KEEP` (default 120 — how many previous-run movies are carried
  forward, after re-verifying their URLs, so the catalog grows across runs).

  Each run: scrape the newest movies → byte-verify every URL → merge with
  still-alive entries from the previous `data/moviesda.json` + `data/embeds.json`
  (fresh scrape wins on conflicts) → commit. If ZERO MP4s verify, the run exits 2
  and overwrites nothing.
- R2 hotlinks rotate: that's fine — each run re-verifies and rewrites the
  files; the app's own deep check catches anything that dies between runs.
- If moviesda changes their HTML, the CLI fails loudly (exit 2) instead of
  shipping silent junk.
