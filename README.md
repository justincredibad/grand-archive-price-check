# TCG Price Check

A small, fast, offline-friendly card price checker built for vending at events.
Pick a game, type a card name, get **TCGplayer market prices for every
printing** (Normal, Foil, Holofoil, Reverse Holofoil, 1st Edition, ...
whatever actually exists for that card), shown in **USD and SGD**, with the
low–high price range for each.

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
  TCGplayer actually lists a price for (low/mid/high/market), plus the
  current USD→SGD rate. It writes one file per game — `data/grand-archive.json`,
  `data/pokemon.json` — plus `data/games.json`, a small manifest the frontend
  reads first to build the game picker without downloading any card data.
- `.github/workflows/update-prices.yml` runs that script once a day
  (04:00 UTC) on GitHub Actions and commits the refreshed data files
  automatically. You can also trigger it manually from the Actions tab.
- `index.html` / `app.js` / `styles.css` are a static frontend. It loads
  `data/games.json` first (tiny), renders the game tabs, then lazily fetches
  only the selected game's file and searches it entirely client-side —
  instant results, no server round-trip per keystroke. Your last-picked game
  is remembered (`localStorage`) so it reopens where you left off.
- `sw.js` is a small service worker that caches the app shell + `games.json`
  on install, and caches each game's data file the first time you actually
  open that game (not all of them up front — Pokémon's file alone is over
  10MB). Once a game's been opened once online, it keeps working offline at
  a venue with no wifi; prices just won't refresh until you're back online.

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
