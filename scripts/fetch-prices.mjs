// Fetches Grand Archive TCG card prices from TCGCSV.com (a free, public,
// ToS-compliant mirror of TCGplayer's catalog + pricing API — see
// https://tcgcsv.com/docs). No API key required.
//
// Output: data/cards.json — a flat list of single cards (sealed product like
// booster boxes is excluded) with low/mid/high/market price for both the
// Normal and Foil printing, plus a USD->SGD conversion rate baked in so the
// site works fully offline after first load.

const CATEGORY_ID = 74; // Grand Archive TCG on TCGplayer/TCGCSV
const BASE = "https://tcgcsv.com/tcgplayer";
const CONCURRENCY = 6;

async function getJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "grand-archive-price-checker/1.0 (+https://github.com/)",
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

function priceBlock(entry) {
  if (!entry) return null;
  return {
    low: entry.lowPrice,
    mid: entry.midPrice,
    high: entry.highPrice,
    market: entry.marketPrice,
  };
}

async function fetchGroupCards(group) {
  const [productsRes, pricesRes] = await Promise.all([
    getJson(`${BASE}/${CATEGORY_ID}/${group.groupId}/products`),
    getJson(`${BASE}/${CATEGORY_ID}/${group.groupId}/prices`).catch(() => ({ results: [] })),
  ]);

  const pricesByProduct = new Map();
  for (const p of pricesRes.results || []) {
    if (!pricesByProduct.has(p.productId)) pricesByProduct.set(p.productId, {});
    pricesByProduct.get(p.productId)[p.subTypeName] = p;
  }

  const cards = [];
  for (const product of productsRes.results || []) {
    // Singles carry a "Number" field in extendedData; sealed product
    // (booster packs/boxes, cases, starter decks) does not.
    const ext = product.extendedData || [];
    const numberField = ext.find((f) => f.name === "Number");
    if (!numberField) continue;
    const rarityField = ext.find((f) => f.name === "Rarity");

    const prices = pricesByProduct.get(product.productId) || {};

    cards.push({
      id: product.productId,
      name: product.cleanName || product.name,
      set: group.name,
      setAbbrev: group.abbreviation,
      number: numberField.value,
      rarity: rarityField ? rarityField.value : null,
      url: product.url,
      image: product.imageUrl,
      normal: priceBlock(prices.Normal),
      foil: priceBlock(prices.Foil),
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

async function main() {
  console.log("Fetching Grand Archive TCG groups (sets)...");
  const groupsRes = await getJson(`${BASE}/${CATEGORY_ID}/groups`);
  const groups = groupsRes.results;
  console.log(`Found ${groups.length} sets. Fetching products + prices...`);

  const perGroup = await mapWithConcurrency(groups, CONCURRENCY, async (group) => {
    try {
      const cards = await fetchGroupCards(group);
      console.log(`  ${group.name}: ${cards.length} cards`);
      return cards;
    } catch (err) {
      console.error(`  ${group.name}: FAILED (${err.message})`);
      return [];
    }
  });

  const cards = perGroup.flat().sort((a, b) => a.name.localeCompare(b.name));

  console.log("Fetching USD -> SGD exchange rate...");
  const { rate, date, fallback } = await fetchExchangeRate();

  const sets = groups
    .map((g) => ({ name: g.name, abbrev: g.abbreviation }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const output = {
    generatedAt: new Date().toISOString(),
    usdToSgd: rate,
    rateDate: date,
    rateFallback: !!fallback,
    source: "tcgcsv.com (TCGplayer catalog/pricing mirror)",
    totalCards: cards.length,
    sets,
    cards,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/cards.json", JSON.stringify(output));
  console.log(`\nWrote data/cards.json: ${cards.length} cards, rate 1 USD = ${rate} SGD`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
