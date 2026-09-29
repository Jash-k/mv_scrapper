# MoviesDa Module — direct MP4 only (for `mv_scrapper`)

Adds a **second scraper** to this repo: MoviesDa **Tamil movies only** →
**direct 720p/1080p MP4** links (byte-verified), committed as static files every
4 hours by its own workflow.

**Nothing existing is touched** — `scrape.yml`, `src/scraper/*`,
`src/scrape-cli.js` and `data/movies.json` stay exactly as they are.

## Mode (locked)

| Setting | Value |
|---|---|
| Content | **Movies only** (web series / seasons / episodes skipped) |
| Qualities | **720p + 1080p only** (360p/480p dropped) |
| Stream type | **Direct MP4 only** (onestream / embeds disabled) |
| Catalog | **Fresh rebuild every run** (no carry-over of expired token URLs) |
| Verify | Ranged GET must return real `ftyp` MP4 bytes or the URL is dropped |

## Outputs

| File | Contents |
|---|---|
| `data/moviesda.json` | Direct MP4 tier (verified 720p/1080p) |
| `data/embeds.json` | Always `[]` (embeds removed) |
| `data/moviesda.m3u` | M3U twin of the MP4 tier |
| `stremio/**` | Static Stremio addon (MP4 + TamilMV magnets merged by title+year) |
| `data/moviesda-stats.json` | Run metadata |

Guarantees:
- **No magnet ever enters moviesda.json / moviesda.m3u.** Magnets are read from
  `data/movies.json` and only appear in the `stremio/` output.
- **Zero unverified streams**: an MP4 ships only if a ranged GET just now
  returned real `ftyp` bytes (HTML gate pages are rejected).
- If a run verifies **zero** MP4s, the CLI exits non-zero and commits nothing.

## Run locally

```bash
npm install
node src/moviesda-cli.js --limit=5     # small test
node src/moviesda-cli.js               # full run
# or:
npm run scrape:moviesda
```

Env knobs:

| Env | Default | Meaning |
|---|---|---|
| `MOVIESDA_YEARS_BACK` | `2` | Crawl `/tamil-YYYY-movies/` for last N years |
| `MOVIESDA_MAX_MOVIES` | `60` | Cap movie pages per run |
| `MOVIESDA_LATEST` | `25` | Cap items from `/tamil-latest-updates/` |
| `TMDB_API_KEY` | — | Enables TMDB id/poster for Stremio catalog |
| `MOVIESDA_SKIP_VERIFY` | — | Emergency only — never in CI |

## GitHub Actions

`.github/workflows/moviesda.yml` runs every 4 hours (`0 */4 * * *`) and on
manual `workflow_dispatch`. It installs via `npm ci` and runs
`node src/moviesda-cli.js`.

## Why links used to "not work"

1. **Token hosts expire** (`htag`/`etag` on kollybytes, skyvault, fileraja, …)
   and start serving HTML gate pages — the old verifier only checked status
   codes loosely and carry-over re-kept half-dead URLs.
2. **Embeds** (`play.onestream.today`) were mixed into the pipeline even though
   you only wanted direct links.
3. **Web series** flooded the latest listing and wasted scrape budget.

This rewrite fixes all three: durable hosts preferred (biggshare/hotshare),
HTML gates rejected, embeds removed, movies-only, fresh rebuild each run.
