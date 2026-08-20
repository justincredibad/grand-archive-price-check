// Builds data/pokemon-insights.json: which Pokemon species and which card
// illustrators tend to show rising prices or command a premium, based on
// our own price history (data/pokemon-history.json) cross-referenced with
// artist/species metadata from the Pokemon TCG API's bulk data repo
// (https://github.com/PokemonTCG/pokemon-tcg-data — free, actively
// maintained, MIT-licensed set/card database; not the same thing as
// tcgcsv/TCGplayer, which has no artist field at all).
//
// This is exploratory/statistical, not a forecast: it reports what already
// happened in our recorded price history, grouped by species/artist, with
// sample sizes so small groups don't masquerade as strong patterns. It does
// not predict future prices or recommend purchases.
//
// Matching TCGCSV sets to Pokemon TCG API sets: TCGCSV's group `abbreviation`
// usually equals the Pokemon TCG API's `ptcgoCode` (e.g. "MEW" for 151) — that
// covers ~60% of sets. The rest fall back to normalized-name matching. Around
// 80% of sets end up matched; the rest are mostly promo/peripheral products
// (McDonald's promos, Battle Academy, etc.) that don't carry TCGplayer's
// "Number" field consistently anyway and matter little for this analysis.

import fs from "node:fs/promises";

const PTCG_RAW = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";
const UA = "trading-card-price-checker/1.0 (+https://github.com/)";
const CONCURRENCY = 8;
const MIN_GROUP_SIZE = 5; // ignore species/artists with too few tracked cards to mean anything
const MIN_TREND_SPAN_DAYS = 14; // need at least this much space between first/last data point
const MIN_TREND_START_PRICE = 3; // below this, percentage moves are mostly noise on bulk commons (and TCGplayer's "market price" is often a stale/placeholder value at this range), not something meaningful for a buying decision
const MAX_PLAUSIBLE_TREND_PCT = 400; // beyond this a card is more likely a data glitch (see Entei Star case) than a genuine move
const SET_SIZE_TOLERANCE = 0.4; // reject a set match if card counts differ by more than this fraction (catches abbreviation collisions like BW Trainer Kits reusing "BLW")

function normSetName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/^[a-z]{1,6}[0-9.]*\s*(:|-)\s*/i, "") // strip a "CODE: " or "CODE - " prefix
    .replace(/\bbase set\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normCardNumber(raw) {
  const first = String(raw || "").split("/")[0].trim();
  return first.replace(/^0+(?=\d)/, "").toUpperCase();
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
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

// Card counts differing wildly between the two sides means the "match" is
// almost certainly wrong even if a code/name lined up — e.g. TCGCSV gives a
// small "BW Trainer Kit" spinoff the same "BLW" code the real 115-card
// Black & White base set uses, which would otherwise look like a solid match.
function sizesAgree(countA, countB) {
  if (!countA || !countB) return false;
  const diff = Math.abs(countA - countB) / Math.max(countA, countB);
  return diff <= SET_SIZE_TOLERANCE;
}

async function matchSets(tcgcsvSets, ptcgSets, countBySetName) {
  const byCode = new Map(ptcgSets.filter((s) => s.ptcgoCode).map((s) => [s.ptcgoCode.toUpperCase(), s]));
  const byName = new Map(ptcgSets.map((s) => [normSetName(s.name), s]));

  const matches = new Map(); // tcgcsv set name -> ptcg set id
  let matchedCode = 0, matchedName = 0, matchedSub = 0, rejectedSize = 0;
  for (const s of tcgcsvSets) {
    const ourCount = countBySetName.get(s.name) || 0;
    let m = byCode.get((s.abbrev || "").toUpperCase());
    let tier = "code";
    if (!m) {
      const gn = normSetName(s.name);
      m = byName.get(gn);
      tier = "name";
      if (!m && gn.length >= 4) {
        m = ptcgSets.find((p) => {
          const pn = normSetName(p.name);
          return pn.length >= 4 && (gn.includes(pn) || pn.includes(gn));
        });
        tier = "substring";
      }
    }
    if (!m) continue;

    if (!sizesAgree(ourCount, m.total)) {
      rejectedSize++;
      continue;
    }
    matches.set(s.name, m.id);
    if (tier === "code") matchedCode++;
    else if (tier === "name") matchedName++;
    else matchedSub++;
  }
  console.log(
    `Set matching: ${matchedCode} by code, ${matchedName} by name, ${matchedSub} by substring, ${rejectedSize} rejected on card-count mismatch — ${matches.size}/${tcgcsvSets.length} sets matched`
  );
  return matches;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Per-card trend: % change between the median of the first few and the
// median of the last few non-null "display" price points, using whichever
// variant has the most data points. Median-of-a-few (rather than the raw
// endpoints) and the price/plausibility guards below exist because TCGplayer
// sometimes reports a near-zero placeholder "market price" for a low-volume
// printing for a long stretch before real trade data comes in — a card
// sitting at $0.99 for two months then correcting to its real ~$1000 value
// isn't a 1000% "rise", it's a stale data point resolving.
function cardTrend(card, history) {
  let best = null;
  for (const variant of card.variants) {
    const series = history.series[`${card.id}:${variant.name}`];
    if (!series) continue;
    const points = [];
    series.forEach((v, i) => {
      if (v !== null && v !== undefined) points.push({ i, v });
    });
    if (points.length < 2) continue;
    const spanDays = points[points.length - 1].i - points[0].i;
    if (spanDays < MIN_TREND_SPAN_DAYS) continue;

    const chunkSize = Math.min(3, points.length);
    const first = median(points.slice(0, chunkSize).map((p) => p.v));
    const last = median(points.slice(-chunkSize).map((p) => p.v));
    if (first < MIN_TREND_START_PRICE) continue;

    const pctChange = ((last - first) / first) * 100;
    if (Math.abs(pctChange) > MAX_PLAUSIBLE_TREND_PCT) continue;

    if (!best || points.length > best.points) {
      best = { pctChange, latestPrice: points[points.length - 1].v, points: points.length };
    }
  }
  return best;
}

function summarizeGroups(entries, keyFn) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyFn(entry);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const summaries = [];
  for (const [key, items] of groups) {
    if (items.length < MIN_GROUP_SIZE) continue;
    const avgTrend = items.reduce((sum, i) => sum + i.trend.pctChange, 0) / items.length;
    const medianTrend = [...items.map((i) => i.trend.pctChange)].sort((a, b) => a - b)[Math.floor(items.length / 2)];
    const avgPrice = items.reduce((sum, i) => sum + i.trend.latestPrice, 0) / items.length;
    summaries.push({
      key,
      cardCount: items.length,
      avgTrendPct: Math.round(avgTrend * 10) / 10,
      medianTrendPct: Math.round(medianTrend * 10) / 10,
      avgPrice: Math.round(avgPrice * 100) / 100,
      example: items.sort((a, b) => b.trend.pctChange - a.trend.pctChange)[0].card.name,
    });
  }
  return summaries;
}

async function main() {
  console.log("Loading local card + history data...");
  const cardData = JSON.parse(await fs.readFile("data/pokemon.json", "utf8"));
  const history = JSON.parse(await fs.readFile("data/pokemon-history.json", "utf8"));

  const countBySetName = new Map();
  for (const card of cardData.cards) {
    countBySetName.set(card.set, (countBySetName.get(card.set) || 0) + 1);
  }

  console.log("Fetching Pokemon TCG API bulk sets list...");
  const ptcgSets = await getJson(`${PTCG_RAW}/sets/en.json`);
  const setMatch = await matchSets(cardData.sets, ptcgSets, countBySetName);

  console.log(`Fetching card data for ${setMatch.size} matched sets...`);
  const cardsBySet = new Map();
  await mapWithConcurrency([...setMatch.entries()], CONCURRENCY, async ([tcgcsvName, ptcgId]) => {
    try {
      const cards = await getJson(`${PTCG_RAW}/cards/en/${ptcgId}.json`);
      const byNumber = new Map(cards.map((c) => [normCardNumber(c.number), c]));
      cardsBySet.set(tcgcsvName, byNumber);
    } catch (err) {
      console.error(`  ${tcgcsvName} (${ptcgId}): FAILED (${err.message})`);
    }
  });

  console.log("Joining TCGCSV cards to Pokemon TCG API metadata + computing trends...");
  const enriched = [];
  let cardsMatched = 0;
  let trendsComputed = 0;
  for (const card of cardData.cards) {
    const byNumber = cardsBySet.get(card.set);
    if (!byNumber) continue;
    const ptcgCard = byNumber.get(normCardNumber(card.number));
    if (!ptcgCard) continue;
    cardsMatched++;

    const trend = cardTrend(card, history);
    if (!trend) continue;
    trendsComputed++;

    enriched.push({
      card,
      artist: ptcgCard.artist || null,
      speciesKey: Array.isArray(ptcgCard.nationalPokedexNumbers) && ptcgCard.nationalPokedexNumbers.length
        ? ptcgCard.nationalPokedexNumbers[0]
        : null,
      speciesName: ptcgCard.name,
      trend,
    });
  }
  console.log(`Matched ${cardsMatched}/${cardData.cards.length} cards to species/artist metadata; ${trendsComputed} had a usable price trend.`);

  const bySpecies = summarizeGroups(enriched, (e) => e.speciesKey);
  const speciesNames = new Map();
  for (const e of enriched) if (e.speciesKey) speciesNames.set(e.speciesKey, e.speciesName.replace(/\s+(ex|EX|GX|V|VMAX|VSTAR|BREAK)$/i, ""));
  for (const s of bySpecies) s.name = speciesNames.get(s.key) || String(s.key);

  const byArtist = summarizeGroups(enriched, (e) => e.artist);
  for (const a of byArtist) a.name = a.key;

  const output = {
    generatedAt: new Date().toISOString(),
    coverage: {
      totalCards: cardData.cards.length,
      cardsMatched,
      trendsComputed,
      setsMatched: setMatch.size,
      setsTotal: cardData.sets.length,
    },
    historyWindowDays: history.dates.length,
    // Sorted views the UI can render directly, already filtered to groups
    // with at least MIN_GROUP_SIZE cards.
    speciesByTrend: [...bySpecies].sort((a, b) => b.avgTrendPct - a.avgTrendPct).slice(0, 25),
    speciesByPrice: [...bySpecies].sort((a, b) => b.avgPrice - a.avgPrice).slice(0, 25),
    artistsByTrend: [...byArtist].sort((a, b) => b.avgTrendPct - a.avgTrendPct).slice(0, 25),
    artistsByPrice: [...byArtist].sort((a, b) => b.avgPrice - a.avgPrice).slice(0, 25),
  };

  await fs.writeFile("data/pokemon-insights.json", JSON.stringify(output));
  console.log(`Wrote data/pokemon-insights.json (${bySpecies.length} species groups, ${byArtist.length} artist groups).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
