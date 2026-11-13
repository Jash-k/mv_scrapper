# Direct MP4 scraper — reliability patch

## Scope

MoviesDa remains a Tamil-movies-only source with 720p/1080p links. The independent TamilMV magnet scraper and `data/movies.json` are unchanged. Use only sources/files you are authorized to access and distribute.

This patch fixes concrete code paths; it **does not promise failure-free scraping or permanent links**. Source downtime, layout changes, access restrictions and token expiry remain external dependencies. No bypass of authentication, CAPTCHA or DRM is included.

## Fixes

- Mandatory byte verification. The old `MOVIESDA_SKIP_VERIFY` bypass is removed/ignored.
- Reject MPEG-TS, HTML, JSON, image-container signatures and malformed/truncated MP4 file-type boxes. Parse MP4 brands rather than simply search for `ftyp`.
- Accept HTTP 200 when a server ignores Range, but cap buffered content at 64 KiB and cancel the response. Validate that HTTP 206 starts at byte zero.
- Verify without a fabricated Referer or cookies, so header-dependent gateways are not advertised as ordinary direct-play links.
- Retry transient verification failures once, with bounded request/body timeout. Isolate individual verification failures.
- Resolve bounded HTTP redirect chains, relative Location headers, HTML meta-refresh and explicit video/MP4 links; detect loops and cancel unused bodies.
- Preserve final verified URL, exact source byte size when supplied, and `verifiedAt` in published qualities. A size is not inferred from a filename.
- Fix empty Stremio catalog/streams when TMDB is not configured: fallback `moviesda:` IDs work without an API key. Metadata entries include `type: movie`.
- Remove torrent merging from MoviesDa's Stremio streams. Never replace an unavailable MP4 with a magnet or embed.
- Dedupe by full URL rather than filename alone, preserving distinct CDN paths/tokens as fallbacks.
- Add configurable mirror origins and regression tests; workflow runs tests before scraping.
- Refresh the dependency lockfile with compatible security updates.

Header verification is a lightweight container check, **not** a full-file decoder/playback test or a resolution probe. Quality labels still come from the source page.

## Run

Node >=20.18.1:

```sh
npm ci
npm test
node src/moviesda-cli.js --limit=5
```

Existing MoviesDa GitHub Action runs every four hours; manual **Actions → MoviesDa Auto-Scraper → Run workflow** is also supported. After replacing the source files in GitHub, trigger a fresh run. Changes in the supplied bundle have not been pushed automatically.

Settings:

| Variable | Default | Purpose |
|---|---|---|
| MOVIESDA_BASES | `https://moviesda34.com,https://movies.downloadpage.xyz` | Comma-separated trusted mirror origins |
| MOVIESDA_YEARS_BACK | 2 | Current year plus preceding years |
| MOVIESDA_MAX_MOVIES | 60 | Movie-page cap |
| MOVIESDA_LATEST | 25 | Latest-list cap |
| MOVIESDA_TIMEOUT_MS | 15000 | Extraction request timeout |
| MOVIESDA_DELAY_MS | 900 | Crawl delay |
| TMDB_API_KEY | empty | Optional richer metadata/external IDs |

Use only trusted origins. This CLI follows source-controlled external links; it is not an SSRF-hardened public URL-fetching API. No arbitrary JavaScript execution or browser challenge automation is included.

## Outputs and failure behavior

- `data/moviesda.json`: verified direct MP4 qualities, `size_bytes`, `verifiedAt`.
- `data/moviesda.m3u`: direct-link playlist.
- `data/embeds.json`: empty array.
- `stremio/`: direct-only static addon (no magnets).
- `data/moviesda-stats.json`: build counts/time.

Zero verified candidates: CLI exits 2 **before the builder runs**, leaving previous outputs untouched. This prevents destructive empty updates, but old output may already be stale. A failed workflow is not evidence that yesterday's links still work. Existing tracked data in this bundle is upstream snapshot data, **not regenerated or revalidated by this patch**.

A static JSON/M3U/addon cannot refresh a signed URL at playback time. An always-on resolver with just-in-time re-extraction would be a separate architecture. Even that cannot guarantee source availability. Hosts requiring special player headers are intentionally rejected rather than emitted as falsely portable URLs.

The builder writes multiple files, not a transactional database; an interrupted local build may leave mixed local outputs. Publish only after a complete successful run (as the workflow does), and do not serve the working directory while a build is in progress.

## Telegram-Stremio boundary

The earlier Telegram-Stremio/WZML automation still consumes **magnet candidates**; pointing it at `moviesda.json` will not make it ingest MP4 URLs. This patch fixes this scraper only. MP4-to-Telegram automation needs a separate direct-download integration and URL/destination validation.

The scraper exposes all verified 720p/1080p sizes, not the earlier Telegram >1-GiB/<1.9-billion-byte policy. Exact `size_bytes` is now available to a future consumer; unknown sizes must not pass strict transfer selection.

## Validation

Tests use a local synthetic HTTP server and temporary output folders: valid/invalid MP4 headers, TS/image rejection, relative redirects/loops, HTML gates, transient HTTP retry, Range behavior, no-TMDB catalog, direct-only streams, distinct CDN paths and preserving the independent magnet file. No real movie download, live playback, upstream scrape or GitHub push is claimed.
