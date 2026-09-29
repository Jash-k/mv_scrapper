# 🎬 1TamilMV Custom Scraper (720p & 1080p Only) + GitHub Actions Cron

A standalone, self-hosted **1TamilMV Movie Scraper & Metadata Enricher** designed for total independence and sustainability.

Filters out unwanted low-res 400MB / 480p rips and bloated 4K releases, keeping **STRICTLY 720p & 1080p magnet links** (`720p AVC`, `720p HEVC`, `1080p AVC`, `1080p HEVC`).

---

## 🎯 Repo scope — 1TamilMV only

This repository does **one** job: scrape 1TamilMV. It used to also carry a
MoviesDa scraper (`src/moviesda/`, `moviesda.yml`, `README-moviesda.md`); that was
**removed on 29 Sep 2026** because MoviesDa embeds are now handled properly by the
`mv_vault` repo (paginated series, daily refresh, posters).

What remains here:

| path | what it is |
|---|---|
| `src/scrape-cli.js` | entry point — scrape → enrich → write |
| `src/scraper/tamilmv.js` | the scraper (mirror failover, quality filter, magnets) |
| `src/services/{filter,imdb}.js` | quality filtering + Cinemeta enrichment |
| `src/config.js` | mirrors, limits, headers, trackers (reads `.env`) |
| `src/check.js` | `npm run check` — verifies every import is a declared dependency |
| `data/movies.json`, `data/stats.json` | this scraper's output, committed by the workflow |
| `.github/workflows/scrape.yml` | the 30-minute scheduled run |

**Frozen legacy files** (kept on purpose, no longer updated by anything here):

- `data/moviesda.json`, `data/embeds.json` — still read by the JaSH ViBeS app
  (`lib/moviesdaSource.js`). Deleting them breaks that screen, so they stay until
  the app is pointed at `mv_vault` instead.
- `data/moviesda.m3u`, `data/moviesda-stats.json`, `stremio/` — the old MoviesDa
  outputs / static Stremio addon.

Once the app reads the vault, those can go in one line:

```bash
git rm data/moviesda.json data/embeds.json data/moviesda.m3u data/moviesda-stats.json
git rm -r stremio/
git commit -m "drop frozen MoviesDa outputs (mv_vault is the source now)"
```

⚠️ **Do not rename `.github/workflows/scrape.yml`** — the external (Koyeb)
dispatcher triggers this workflow by name. Renaming it would silently stop the
30-minute cadence.

---

## ⚡ Key Highlights

- 🎯 **Strict Quality Filter**: Captures **720p and 1080p** magnet links exclusively. Drops 4K, 2160p, 480p, and SD mobile rips.
- 🔄 **Automated GitHub Actions Cron Job**: Automatically runs every **30 minutes** (`cron: '*/30 * * * *'`) or on-demand via GitHub UI.
- 📦 **Enriched Output**: Generates `data/movies.json` with IMDb IDs, TMDB/Cinemeta poster artwork, genres, ratings, multi-audio flags, and active public tracker lists.
- 🌐 **Multi-Mirror Resiliency**: Automatically cycles between working mirrors (`1tamilmv.report`, `1tamilmv.fi`, `1tamilmv.observer`, `1tamilmv.meme`, etc.) if one is blocked.

---

## 📁 Output Data Structure (`data/movies.json`)

```json
[
  {
    "id": "a1b2c3d4e5f6...",
    "imdbId": "tt32758159",
    "name": "Once More",
    "year": 2026,
    "poster": "https://images.metahub.space/poster/medium/tt32758159/img.jpg",
    "languages": ["Tamil", "Telugu", "Multi-Lang"],
    "rawText": "Once More (2026) Tamil HQ PreDVD - [1080p & 720p - x264 - 2.7GB + Rips]",
    "qualities": [
      {
        "quality": "1080p AVC",
        "size": "2.7GB",
        "type": "magnet",
        "url": "magnet:?xt=urn:btih:...",
        "languages": ["Tamil"],
        "seeders": 439,
        "leechers": 25
      },
      {
        "quality": "720p AVC",
        "size": "1.4GB",
        "type": "magnet",
        "url": "magnet:?xt=urn:btih:...",
        "languages": ["Tamil"],
        "seeders": 386,
        "leechers": 18
      }
    ]
  }
]
```

---

## 🚀 How to Set Up on Your GitHub (3 Steps)

### Step 1: Create a New GitHub Repository
1. Extract `tmv-custom-scraper.zip`.
2. Push the files to your own GitHub account:
   ```bash
   git init
   git add .
   git commit -m "Initial commit of 1TamilMV 720p/1080p Custom Scraper"
   git branch -M main
   git remote add origin https://github.com/your-username/tmv-custom-scraper.git
   git push -u origin main
   ```

### Step 2: Enable Workflow Permissions in GitHub
1. Go to your repository on GitHub.
2. Click **Settings** ➔ **Actions** ➔ **General**.
3. Under **Workflow permissions**, select **"Read and write permissions"** and check **"Allow GitHub Actions to create and approve pull requests"**.
4. Click **Save**.

### Step 3: Trigger Your First Scrape
1. Go to the **Actions** tab in your GitHub repository.
2. Click on **"1TamilMV Auto-Scraper (720p & 1080p Only)"** on the left.
3. Click **"Run workflow"** ➔ **"Run workflow"**.
4. It will scrape 1TamilMV, filter 720p/1080p magnets, and automatically push `data/movies.json` to your repository!
5. After this, GitHub Actions will automatically repeat this every **30 minutes**.

---

## 💻 Local Execution

```bash
# 1. Install dependencies
npm ci            # or: npm install

# 2. Optional: verify every import has a declared dependency (~2s)
npm run check

# 3. Run the scraper
npm run scrape

# …or a quick smoke test without overwriting the real dataset
MAX_SCRAPE_LIMIT=3 node src/scrape-cli.js
```

### Dependencies (why `npm run check` exists)

The scraper needs **axios**, **cheerio** and **dotenv**. All three are declared in
`package.json` and locked in `package-lock.json`, and the workflow installs them
with `npm ci` before running `npm run check`.

That guard is not decoration. On 29 Sep 2026 the Actions run died with:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'axios'
  imported from src/scraper/tamilmv.js
```

`axios` (and `dotenv`) were imported in code but missing from `package.json`, so
`npm ci` installed a dependency set that could not run. If you ever see that error
again, `npm run check` now names the missing package and the exact `npm install`
line — and remember to commit **both** `package.json` and `package-lock.json`.

---

## 🔗 Using Your JSON Feed in Telegram-Stremio

Once your repository updates `data/movies.json`, you can use your direct raw GitHub URL:
```
https://raw.githubusercontent.com/your-username/tmv-custom-scraper/main/data/movies.json
```
in your `FEED_URL` or `Telegram-Stremio` settings for 100% self-hosted sustainability!
