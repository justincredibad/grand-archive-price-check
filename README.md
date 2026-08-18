# TCG Price Check

A small, fast, offline-friendly card price checker built for vending at events.
Pick a game, type a card name, get **TCGplayer market prices for every
printing** (Normal, Foil, Holofoil, Reverse Holofoil, 1st Edition, ...
whatever actually exists for that card), shown in **USD and SGD**, with the
low–high price range for each and an optional **90-day price trend** per
printing, backed by real historical data back to 2024-02-08.

Currently covers:
- [Grand Archive TCG](https://www.gatcg.com/) (TCGplayer category 74)
- [Pokémon TCG](https://www.pokemon.com/us/pokemon-tcg) (TCGplayer category 3)

Live data source for both: mirrored for free (no scraping, no API key) by
[tcgcsv.com](https://tcgcsv.com/) — a public JSON/CSV mirror of TCGplayer's
catalog and pricing API. Currency conversion uses the European Central Bank
rate via [frankfurter.dev](https://frankfurter.dev/) (free, no key).

> TCGplayer's own developer API has been closed to new applicants since late
> 2024, and their Terms of Service discourage direct scraping of the site —
> tcgcsv.com sources the same TCGplayer pricing data legitimately, so this
> project never touches tcgplayer.com directly.

## How it works

- `scripts/fetch-prices.mjs` loops over a small `GAMES` list (id, label,
  TCGplayer category id), and for each game pulls every set, every single
  card (sealed product like booster boxes is excluded), and every printing
  TCGplayer lists a price for (low/mid/high/market — if `market` itself is
  missing, which happens for low-volume printings, it falls back to
  mid/high/low so the printing still shows up), plus the current USD→SGD
  rate. It writes one file per game — `data/grand-archive.json`,
  `data/pokemon.json` — plus `data/games.json`, a small manifest the frontend
  reads first to build the game picker without downloading any card data.
- The same script also maintains `data/<game>-history.json`: a compact
  columnar file (`{dates: [...], series: {"productId:variantName": [prices,
  aligned to dates]}}`) that it appends one column to every day it runs
  (overwriting today's column if re-run same day), pruned to the last
  `REPO_HISTORY_DAYS` (90) days — this is the copy committed to the repo and
  served by the site, kept deliberately small since it's a full-file rewrite
  every day. This is what powers the "Price history" trend line per printing.
- `scripts/backfill-history.mjs` is a one-off script (not part of the daily
  job) that seeds real historical prices instead of only starting from
  whenever `fetch-prices.mjs` first ran, by walking tcgcsv.com's daily
  archive (`https://tcgcsv.com/archive/tcgplayer/prices-YYYY-MM-DD.ppmd.7z`,
  available from 2024-02-08 onward). Run it with `npm run backfill-history
  [-- --days=365]`.
- Both scripts also maintain a **full, unpruned** copy of history at a
  local-only folder (`EXTERNAL_HISTORY_DIR` in `fetch-prices.mjs`, currently
  `E:\Card price db`) — this is *not* committed to git. A full year of
  Pokémon history alone is around 90MB, and since it's one big rewritten
  JSON blob, committing that daily would add ~90MB to the repo's history
  *every day*. Keeping the full archive local and shipping only a 90-day
  slice keeps the live site's history file (and the repo itself) a
  reasonable size, while you still have the complete archive on disk. If
  that folder isn't reachable (e.g. on GitHub's CI runners), both scripts
  just skip that step and carry on — nothing breaks.
- `.github/workflows/update-prices.yml` runs `fetch-prices.mjs` once a day
  (04:00 UTC) on GitHub Actions and commits the refreshed data + history
  files automatically. You can also trigger it manually from the Actions tab.
- `index.html` / `app.js` / `styles.css` are a static frontend. It loads
  `data/games.json` first (tiny), renders the game tabs, then lazily fetches
  only the selected game's file and searches it entirely client-side —
  instant results, no server round-trip per keystroke. Your last-picked game
  is remembered (`localStorage`) so it reopens where you left off. Each
  card's "📈 Price history" button lazily fetches that game's history file
  (only once per session) and draws a small sparkline + % change per
  printing from it.
- `sw.js` is a small service worker that caches the app shell + `games.json`
  on install, and caches each game's data/history files the first time you
  actually request them (not all of them up front — Pokémon's data file
  alone is over 10MB). Once a game's been opened once online, it keeps
  working offline at a venue with no wifi; prices just won't refresh until
  you're back online.

## Local development

```bash
npm run fetch-prices   # regenerate data/*.json from live TCGCSV data
npm run serve          # serve the site at http://localhost:8080
```

## Hosting it on GitHub Pages

1. Create a new GitHub repo and push this project to it (see below).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to `Deploy from a branch`,
   branch `main`, folder `/ (root)`. Save.
4. GitHub will publish the site at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two.
5. **Settings → Actions → General → Workflow permissions**: make sure
   "Read and write permissions" is selected, so the daily price-update
   workflow is allowed to commit the refreshed data files back to the repo.

That's it — no build step, no server to pay for or maintain.

## Pushing this project to GitHub

From this folder:

```bash
gh auth login          # if you haven't already
gh repo create grand-archive-price-check --public --source=. --remote=origin --push
```

Or manually: create an empty repo on github.com, then:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

## Adding another game

Add one entry to the `GAMES` array at the top of `scripts/fetch-prices.mjs`:

```js
{ id: "one-piece", label: "One Piece Card Game", categoryId: 68 },
```

(Find category IDs at `https://tcgcsv.com/tcgplayer/categories`.) Run
`npm run fetch-prices` and the new game's file + tab show up automatically —
nothing else in the pipeline or UI is game-specific. Printing/variant names
(Foil, Holofoil, 1st Edition, ...) are read directly from whatever TCGplayer
calls them for that game, so no per-game UI work is needed either.

## Disclaimer

Prices are TCGplayer *market* estimates mirrored daily, not live quotes —
treat them as a pricing guide for vending, not a guarantee of what a card
will sell for. Actual value depends on condition, seller reputation, and
buyer demand on the day. A card with no listed printings currently has no
active TCGplayer sellers for it (common for ultra-rare/promo cards) — that's
what the data says, not a bug in the fetch.
