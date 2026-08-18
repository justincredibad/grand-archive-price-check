// Fetches TCG card prices from TCGCSV.com (a free, public, ToS-compliant
// mirror of TCGplayer's catalog + pricing API — see https://tcgcsv.com/docs).
// No API key required.
//
// Output:
//   data/games.json             — manifest of supported games (for the game
//                                  selector UI; doesn't include card data)
//   data/<game.id>.json         — per game: sets list + flat card list, each
//                                  card carrying every printing/variant TCGplayer
//                                  lists (Normal, Foil, Holofoil, Reverse
//                                  Holofoil, 1st Edition, ...) with low/mid/high/
//                                  market price. Sealed product (booster boxes,
//                                  packs, etc.) is excluded.
//   data/<game.id>-history.json — daily price history for the trend charts.
//                                  Columnar: a shared `dates` array plus one
//                                  array per "productId:variantName" series,
//                                  aligned by index to `dates`. This script
//                                  appends one column per day it runs (or
//                                  overwrites today's column if re-run same
//                                  day) and prunes anything older than
//                                  HISTORY_DAYS, so the file grows to a
//                                  bounded size instead of forever.
//
// A USD->SGD conversion rate is baked into every game file so the site works
// fully offline after first load.

const GAMES = [
  { id: "grand-archive", label: "Grand Archive TCG", categoryId: 74 },
  { id: "pokemon", label: "Pokémon TCG", categoryId: 3 },
];

const BASE = "https://tcgcsv.com/tcgplayer";
const CONCURRENCY = 6;
// How many daily columns to keep in each history file. Bigger = longer trend
// lines but a bigger file to download; 60 days is ~2 months of context at a
// modest size (only the "display" price is tracked per variant, not low/mid/high).
const HISTORY_DAYS = 60;

// Printings TCGplayer marks with "Foil" in the name get a shiny accent in
// the UI; this also controls display order (plain printings first).
const VARIANT_ORDER = [
  "Normal",
  "1st Edition",
  "Unlimited",
  "Foil",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition Holofoil",
  "Unlimited Holofoil",
];

function variantSortKey(name) {
  const i = VARIANT_ORDER.indexOf(name);
  return i === -1 ? VARIANT_ORDER.length : i;
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "trading-card-price-checker/1.0 (+https://github.com/)",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchGroupCards(categoryId, group) {
  const [productsRes, pricesRes] = await Promise.all([
    getJson(`${BASE}/${categoryId}/${group.groupId}/products`),
    getJson(`${BASE}/${categoryId}/${group.groupId}/prices`).catch(() => ({ results: [] })),
  ]);

  const pricesByProduct = new Map();
  for (const p of pricesRes.results || []) {
    if (!pricesByProduct.has(p.productId)) pricesByProduct.set(p.productId, []);
    pricesByProduct.get(p.productId).push({
      name: p.subTypeName,
      low: p.lowPrice,
      mid: p.midPrice,
      high: p.highPrice,
      market: p.marketPrice,
    });
  }

  const cards = [];
  for (const product of productsRes.results || []) {
    // Singles carry a "Number" field in extendedData; sealed product
    // (booster packs/boxes, cases, starter decks, ETBs) does not.
    const ext = product.extendedData || [];
    const numberField = ext.find((f) => f.name === "Number");
    if (!numberField) continue;
    const rarityField = ext.find((f) => f.name === "Rarity");

    // TCGplayer often has no "market" figure for a low-volume printing (e.g.
    // a foil) while still reporting low/mid/high — `display` falls back
    // through those so the printing still shows up instead of silently
    // disappearing from the results.
    const variants = (pricesByProduct.get(product.productId) || [])
      .map((v) => ({ ...v, display: v.market ?? v.mid ?? v.high ?? v.low ?? null }))
      .filter((v) => v.display !== null)
      .sort((a, b) => variantSortKey(a.name) - variantSortKey(b.name));

    cards.push({
      id: product.productId,
      name: product.cleanName || product.name,
      set: group.name,
      setAbbrev: group.abbreviation,
      number: numberField.value,
      rarity: rarityField ? rarityField.value : null,
      url: product.url,
      image: product.imageUrl,
      variants,
    });
  }
  return cards;
}

// Merges today's prices into a columnar history: `dates` is a shared array
// of "YYYY-MM-DD" strings, and `series["<productId>:<variantName>"]` is an
// array of the same length (prices aligned by index to `dates`, null where
// that printing had no price that day). Re-running the same day overwrites
// today's column instead of adding a duplicate.
function updateHistory(existing, cards, todayStr) {
  const dates = existing?.dates ? [...existing.dates] : [];
  const series = existing?.series ? structuredClone(existing.series) : {};

  const sameDay = dates.length > 0 && dates[dates.length - 1] === todayStr;
  if (!sameDay) dates.push(todayStr);
  const todayIndex = dates.length - 1;

  for (const card of cards) {
    for (const variant of card.variants) {
      if (variant.display === null || variant.display === undefined) continue;
      const key = `${card.id}:${variant.name}`;
      if (!series[key]) series[key] = [];
      while (series[key].length <= todayIndex) series[key].push(null);
      series[key][todayIndex] = variant.display;
    }
  }

  // Keep every series aligned to `dates` even if it wasn't touched today.
  for (const key of Object.keys(series)) {
    while (series[key].length <= todayIndex) series[key].push(null);
  }

  if (dates.length > HISTORY_DAYS) {
    const drop = dates.length - HISTORY_DAYS;
    dates.splice(0, drop);
    for (const key of Object.keys(series)) {
      series[key].splice(0, drop);
      // Drop series that are now entirely empty (delisted long enough ago
      // that no point in the retained window has a price) to keep the file lean.
      if (series[key].every((v) => v === null || v === undefined)) delete series[key];
    }
  }

  return { dates, series };
}

async function fetchExchangeRate() {
  try {
    const data = await getJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=SGD");
    return { rate: data.rates.SGD, date: data.date };
  } catch (err) {
    console.error("Exchange rate fetch failed, falling back to last-known rate:", err.message);
    return { rate: 1.3, date: null, fallback: true };
  }
}

async function fetchGame(game, exchangeRate) {
  console.log(`\n=== ${game.label} (category ${game.categoryId}) ===`);
  const groupsRes = await getJson(`${BASE}/${game.categoryId}/groups`);
  const groups = groupsRes.results;
  console.log(`${groups.length} sets. Fetching products + prices...`);

  const perGroup = await mapWithConcurrency(groups, CONCURRENCY, async (group) => {
    try {
      const cards = await fetchGroupCards(game.categoryId, group);
      return cards;
    } catch (err) {
      console.error(`  ${group.name}: FAILED (${err.message})`);
      return [];
    }
  });

  const cards = perGroup.flat().sort((a, b) => a.name.localeCompare(b.name));
  const sets = groups
    .map((g) => ({ name: g.name, abbrev: g.abbreviation }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    game: game.id,
    label: game.label,
    generatedAt: new Date().toISOString(),
    usdToSgd: exchangeRate.rate,
    rateDate: exchangeRate.date,
    rateFallback: !!exchangeRate.fallback,
    source: "tcgcsv.com (TCGplayer catalog/pricing mirror)",
    totalCards: cards.length,
    sets,
    cards,
  };

  console.log(`${game.label}: ${cards.length} cards across ${sets.length} sets`);
  return output;
}

async function main() {
  console.log("Fetching USD -> SGD exchange rate...");
  const exchangeRate = await fetchExchangeRate();

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });

  const manifest = [];
  for (const game of GAMES) {
    const output = await fetchGame(game, exchangeRate);
    const file = `data/${game.id}.json`;
    await fs.writeFile(file, JSON.stringify(output));

    const historyFile = `data/${game.id}-history.json`;
    let existingHistory = null;
    try {
      existingHistory = JSON.parse(await fs.readFile(historyFile, "utf8"));
    } catch {
      // No history yet (first run for this game) — start fresh.
    }
    const todayStr = output.generatedAt.slice(0, 10);
    const history = updateHistory(existingHistory, output.cards, todayStr);
    await fs.writeFile(historyFile, JSON.stringify(history));
    console.log(`${game.label}: history now spans ${history.dates.length} day(s)`);

    manifest.push({
      id: game.id,
      label: game.label,
      file: `${game.id}.json`,
      historyFile: `${game.id}-history.json`,
      totalCards: output.totalCards,
      generatedAt: output.generatedAt,
    });
  }

  await fs.writeFile(
    "data/games.json",
    JSON.stringify({ generatedAt: new Date().toISOString(), usdToSgd: exchangeRate.rate, games: manifest })
  );

  console.log(`\nWrote data/games.json + ${GAMES.length} game file(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
