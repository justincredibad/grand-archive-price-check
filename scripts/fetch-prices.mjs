// Fetches TCG card prices from TCGCSV.com (a free, public, ToS-compliant
// mirror of TCGplayer's catalog + pricing API — see https://tcgcsv.com/docs).
// No API key required.
//
// Output:
//   data/games.json           — manifest of supported games (for the game
//                                selector UI; doesn't include card data)
//   data/<game.id>.json       — per game: sets list + flat card list, each
//                                card carrying every printing/variant TCGplayer
//                                lists (Normal, Foil, Holofoil, Reverse
//                                Holofoil, 1st Edition, ...) with low/mid/high/
//                                market price. Sealed product (booster boxes,
//                                packs, etc.) is excluded.
//
// A USD->SGD conversion rate is baked into every game file so the site works
// fully offline after first load.

const GAMES = [
  { id: "grand-archive", label: "Grand Archive TCG", categoryId: 74 },
  { id: "pokemon", label: "Pokémon TCG", categoryId: 3 },
];

const BASE = "https://tcgcsv.com/tcgplayer";
const CONCURRENCY = 6;

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

    const variants = (pricesByProduct.get(product.productId) || [])
      .filter((v) => v.market !== null && v.market !== undefined)
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
    manifest.push({
      id: game.id,
      label: game.label,
      file: `${game.id}.json`,
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
