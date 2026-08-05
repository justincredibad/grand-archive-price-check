# Grand Archive Price Check

A small, fast, offline-friendly card price checker built for vending at events.
Type a card name, get **TCGplayer market prices for both Non-Foil and Foil**,
shown in **USD and SGD**, with the low–high price range for each.

Live data source: [Grand Archive TCG](https://www.gatcg.com/) on TCGplayer,
category 74, mirrored for free (no scraping, no API key) by
[tcgcsv.com](https://tcgcsv.com/) — a public JSON/CSV mirror of TCGplayer's
catalog and pricing API. Currency conversion uses the European Central Bank
rate via [frankfurter.dev](https://frankfurter.dev/) (free, no key).

> TCGplayer's own developer API has been closed to new applicants since late
> 2024, and their Terms of Service discourage direct scraping of the site —
> tcgcsv.com sources the same TCGplayer pricing data legitimately, so this
> project never touches tcgplayer.com directly.

## How it works

- `scripts/fetch-prices.mjs` pulls every Grand Archive set, every single card
  (sealed product like booster boxes is excluded), and both the Normal and
  Foil price (low/mid/high/market) for each, plus the current USD→SGD rate.
  It writes everything to `data/cards.json` — one file, no backend, no
  database.
- `.github/workflows/update-prices.yml` runs that script once a day
  (04:00 UTC) on GitHub Actions and commits the refreshed `data/cards.json`
  automatically. You can also trigger it manually from the Actions tab.
- `index.html` / `app.js` / `styles.css` are a static frontend that fetches
  `data/cards.json` once and searches it entirely client-side — instant
  results, no server round-trip per keystroke.
- `sw.js` is a small service worker that caches the app and the price data,
  so once you've loaded it at home, it keeps working at a venue with no wifi
  (prices just won't refresh until you're back online).

## Local development

```bash
npm run fetch-prices   # regenerate data/cards.json from live TCGCSV data
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
   workflow is allowed to commit `data/cards.json` back to the repo.

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

## Extending to other TCGs

The category ID is the only game-specific bit. Change `CATEGORY_ID` at the
top of `scripts/fetch-prices.mjs` to another TCGplayer category (e.g. Magic:
The Gathering, Pokémon, One Piece — see `https://tcgcsv.com/tcgplayer/categories`
for the full list) and everything else — the search UI, foil/non-foil
split, USD/SGD conversion — works unchanged. Multi-game support (a game
switcher in the UI) would be a natural next step if you want to price-check
more than one TCG from the same site.

## Disclaimer

Prices are TCGplayer *market* estimates mirrored daily, not live quotes —
treat them as a pricing guide for vending, not a guarantee of what a card
will sell for. Actual value depends on condition, seller reputation, and
buyer demand on the day.
