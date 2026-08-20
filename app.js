const MAX_RESULTS = 40;
const MIN_CHARS_FOR_FULL_LIST = 2;
const LAST_GAME_KEY = "tcg-price-check:last-game";

const els = {
  gameTabs: document.getElementById("gameTabs"),
  viewToggle: document.getElementById("viewToggle"),
  search: document.getElementById("search"),
  setFilter: document.getElementById("setFilter"),
  searchWrap: document.querySelector(".search-wrap"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  insightsView: document.getElementById("insightsView"),
  insightsSections: document.getElementById("insightsSections"),
  metaInfo: document.getElementById("meta-info"),
  cardTemplate: document.getElementById("card-template"),
  variantTemplate: document.getElementById("variant-template"),
  insightsSectionTemplate: document.getElementById("insights-section-template"),
  insightsRowTemplate: document.getElementById("insights-row-template"),
};

// Games with an insights file available (currently just Pokemon — TCGCSV
// itself carries no illustrator data for any game, this is built separately
// per-game by cross-referencing a game-specific card database).
const INSIGHTS_GAMES = { pokemon: "data/pokemon-insights.json" };

let state = {
  games: [],          // manifest entries: {id, label, file, historyFile, totalCards, generatedAt}
  activeGameId: null,
  activeView: "search", // "search" | "insights"
  gameData: {},        // cache of loaded per-game payloads, keyed by game id
  gameHistory: {},      // cache of loaded per-game price-history payloads, keyed by game id
  insightsData: {},     // cache of loaded insights payloads, keyed by game id
};

function usd(n) {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function sgd(n) {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-SG", { style: "currency", currency: "SGD" });
}

function activeData() {
  return state.gameData[state.activeGameId];
}

function toSgd(usdAmount) {
  const data = activeData();
  if (usdAmount === null || usdAmount === undefined || !data || !data.usdToSgd) return null;
  return usdAmount * data.usdToSgd;
}

function isFoilLike(variantName) {
  return /foil/i.test(variantName);
}

function renderVariant(variant) {
  const node = els.variantTemplate.content.cloneNode(true);
  const block = node.querySelector(".price-block");
  block.classList.toggle("foil", isFoilLike(variant.name));

  node.querySelector(".variant-name").textContent = variant.name;
  node.querySelector(".market.usd").textContent = usd(variant.display);
  node.querySelector(".market.sgd").textContent = `≈ ${sgd(toSgd(variant.display))}`;

  const rangeEl = node.querySelector(".price-range");
  rangeEl.innerHTML = `Range: ${usd(variant.low)}–${usd(variant.high)}<br>≈ ${sgd(toSgd(variant.low))}–${sgd(toSgd(variant.high))}`;

  return node;
}

function renderCard(card) {
  const node = els.cardTemplate.content.cloneNode(true);

  const img = node.querySelector(".card-img");
  img.src = card.image || "";
  img.alt = card.name;

  node.querySelector(".card-name").textContent = card.name;
  const subParts = [card.set];
  if (card.number) subParts.push(`#${card.number}`);
  if (card.rarity) subParts.push(card.rarity);
  node.querySelector(".card-sub").textContent = subParts.join(" · ");

  const grid = node.querySelector(".price-grid");
  const hasVariants = card.variants && card.variants.length > 0;
  node.querySelector(".no-listings-msg").style.display = hasVariants ? "none" : "block";
  if (hasVariants) {
    const frag = document.createDocumentFragment();
    card.variants.forEach((v) => frag.appendChild(renderVariant(v)));
    grid.appendChild(frag);
  }

  const historyToggle = node.querySelector(".history-toggle");
  const historyPanel = node.querySelector(".history-panel");
  if (hasVariants) {
    historyToggle.addEventListener("click", () => toggleHistory(card, historyToggle, historyPanel));
  } else {
    historyToggle.remove();
    historyPanel.remove();
  }

  const link = node.querySelector(".tcgp-link");
  if (card.url) {
    link.href = card.url;
  } else {
    link.remove();
  }

  return node;
}

async function loadGameHistory(gameId) {
  if (state.gameHistory[gameId]) return state.gameHistory[gameId];

  const game = state.games.find((g) => g.id === gameId);
  if (!game || !game.historyFile) return null;
  const res = await fetch(`data/${game.historyFile}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.gameHistory[gameId] = data;
  return data;
}

async function toggleHistory(card, btn, panel) {
  if (!panel.hidden) {
    panel.hidden = true;
    btn.textContent = "📈 Price history";
    return;
  }

  btn.textContent = "Loading…";
  btn.disabled = true;
  try {
    const history = await loadGameHistory(state.activeGameId);
    renderHistoryPanel(card, history, panel);
    panel.hidden = false;
    btn.textContent = "📉 Hide price history";
  } catch (err) {
    console.error(err);
    panel.innerHTML = "";
    panel.textContent = "Couldn't load price history.";
    panel.hidden = false;
    btn.textContent = "📈 Price history";
  } finally {
    btn.disabled = false;
  }
}

function renderHistoryPanel(card, history, panel) {
  panel.innerHTML = "";
  if (!history) {
    panel.textContent = "Price history isn't available for this game yet.";
    return;
  }

  const frag = document.createDocumentFragment();
  let any = false;
  for (const variant of card.variants) {
    const series = history.series[`${card.id}:${variant.name}`];
    if (!series) continue;
    const points = [];
    series.forEach((v, i) => {
      if (v !== null && v !== undefined) points.push({ i, v });
    });
    if (points.length < 2) continue;
    any = true;
    frag.appendChild(renderTrendRow(variant.name, points, history.dates.length));
  }

  if (!any) {
    panel.textContent = "Not enough price history yet for this card — check back after a few daily updates.";
    return;
  }
  panel.appendChild(frag);
}

function renderTrendRow(variantName, points, totalDays) {
  const first = points[0].v;
  const last = points[points.length - 1].v;
  const changePct = first !== 0 ? ((last - first) / first) * 100 : 0;
  const dir = last > first ? "up" : last < first ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "▬";

  const row = document.createElement("div");
  row.className = "trend-row";

  const label = document.createElement("div");
  label.className = "trend-label";

  const name = document.createElement("span");
  name.className = "trend-name";
  name.textContent = variantName;

  const change = document.createElement("span");
  change.className = `trend-change ${dir}`;
  change.textContent = `${arrow} ${changePct >= 0 ? "+" : ""}${changePct.toFixed(1)}% / ${totalDays}d`;

  label.appendChild(name);
  label.appendChild(change);
  row.appendChild(label);
  row.appendChild(buildSparkline(points, totalDays, dir));
  return row;
}

function buildSparkline(points, totalDays, dir) {
  const width = 110;
  const height = 32;
  const pad = 3;
  const ys = points.map((p) => p.v);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanY = maxY - minY || 1;
  const spanX = Math.max(totalDays - 1, 1);
  const scaleX = (i) => pad + (i / spanX) * (width - pad * 2);
  const scaleY = (v) => height - pad - ((v - minY) / spanY) * (height - pad * 2);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `sparkline ${dir}`);

  const line = document.createElementNS(svgNS, "polyline");
  line.setAttribute("points", points.map((p) => `${scaleX(p.i)},${scaleY(p.v)}`).join(" "));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.appendChild(line);

  return svg;
}

function render(cards) {
  els.results.innerHTML = "";
  if (cards.length === 0) {
    els.results.innerHTML = `<p class="hint">No matching cards found.</p>`;
    return;
  }
  const frag = document.createDocumentFragment();
  cards.slice(0, MAX_RESULTS).forEach((c) => frag.appendChild(renderCard(c)));
  els.results.appendChild(frag);

  if (cards.length > MAX_RESULTS) {
    const more = document.createElement("p");
    more.className = "hint";
    more.textContent = `Showing ${MAX_RESULTS} of ${cards.length} matches — refine your search for more.`;
    els.results.appendChild(more);
  }
}

function search() {
  const data = activeData();
  if (!data) return;

  const q = els.search.value.trim().toLowerCase();
  const setName = els.setFilter.value;

  let pool = data.cards;
  if (setName) pool = pool.filter((c) => c.set === setName);

  if (!q) {
    if (setName) {
      render(pool);
    } else {
      els.results.innerHTML = `<p class="hint">Start typing a card name above…</p>`;
    }
    return;
  }

  if (q.length < MIN_CHARS_FOR_FULL_LIST) {
    els.results.innerHTML = `<p class="hint">Keep typing…</p>`;
    return;
  }

  const starts = [];
  const contains = [];
  for (const c of pool) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q)) contains.push(c);
  }
  render([...starts, ...contains]);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function populateSetFilter(sets) {
  els.setFilter.innerHTML = `<option value="">All sets</option>`;
  const frag = document.createDocumentFragment();
  for (const s of sets) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = s.name;
    frag.appendChild(opt);
  }
  els.setFilter.appendChild(frag);
}

function renderMeta() {
  const data = activeData();
  if (!data) {
    els.metaInfo.textContent = "";
    return;
  }
  const parts = [];
  if (data.generatedAt) {
    const d = new Date(data.generatedAt);
    parts.push(`Prices updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (data.usdToSgd) {
    parts.push(`1 USD ≈ ${data.usdToSgd.toFixed(4)} SGD`);
  }
  els.metaInfo.textContent = parts.join(" · ");
}

function renderGameTabs() {
  els.gameTabs.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const game of state.games) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "game-tab";
    btn.textContent = game.label;
    btn.dataset.gameId = game.id;
    btn.setAttribute("aria-pressed", String(game.id === state.activeGameId));
    btn.addEventListener("click", () => selectGame(game.id));
    frag.appendChild(btn);
  }
  els.gameTabs.appendChild(frag);
}

function updateActiveTabStyles() {
  els.gameTabs.querySelectorAll(".game-tab").forEach((btn) => {
    const isActive = btn.dataset.gameId === state.activeGameId;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

async function loadGameData(gameId) {
  if (state.gameData[gameId]) return state.gameData[gameId];

  const game = state.games.find((g) => g.id === gameId);
  const res = await fetch(`data/${game.file}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.gameData[gameId] = data;
  return data;
}

async function selectGame(gameId) {
  state.activeGameId = gameId;
  updateActiveTabStyles();
  localStorage.setItem(LAST_GAME_KEY, gameId);

  els.viewToggle.hidden = !INSIGHTS_GAMES[gameId];
  setView("search");

  els.search.value = "";
  els.results.innerHTML = "";
  els.status.classList.remove("error");
  els.status.textContent = "Loading card prices…";

  try {
    const data = await loadGameData(gameId);
    populateSetFilter(data.sets);
    renderMeta();
    els.status.textContent = `${data.cards.length.toLocaleString()} cards loaded.`;
    els.results.innerHTML = `<p class="hint">Start typing a card name above…</p>`;
    els.search.focus();
  } catch (err) {
    console.error(err);
    els.status.textContent = "Couldn't load price data. Check your connection and reload.";
    els.status.classList.add("error");
  }
}

function setView(view) {
  state.activeView = view;
  els.viewToggle.querySelectorAll(".view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });

  const showSearch = view === "search";
  els.searchWrap.hidden = !showSearch;
  els.status.hidden = !showSearch;
  els.results.hidden = !showSearch;
  els.insightsView.hidden = showSearch;

  if (view === "insights") loadAndRenderInsights(state.activeGameId);
}

async function loadInsights(gameId) {
  if (state.insightsData[gameId]) return state.insightsData[gameId];
  const file = INSIGHTS_GAMES[gameId];
  if (!file) return null;
  const res = await fetch(file, { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  state.insightsData[gameId] = data;
  return data;
}

function insightsSection(heading, rows, formatMetric, formatSub) {
  const node = els.insightsSectionTemplate.content.cloneNode(true);
  node.querySelector(".insights-heading").textContent = heading;
  const container = node.querySelector(".insights-rows");
  if (rows.length === 0) {
    container.innerHTML = `<p class="hint">Not enough data yet.</p>`;
  } else {
    const frag = document.createDocumentFragment();
    rows.forEach((row, i) => {
      const rowNode = els.insightsRowTemplate.content.cloneNode(true);
      rowNode.querySelector(".insights-rank").textContent = `#${i + 1}`;
      rowNode.querySelector(".insights-name").textContent = row.name;
      rowNode.querySelector(".insights-metric").textContent = formatMetric(row);
      rowNode.querySelector(".insights-sub").textContent = formatSub(row);
      frag.appendChild(rowNode);
    });
    container.appendChild(frag);
  }
  return node;
}

async function loadAndRenderInsights(gameId) {
  els.insightsSections.innerHTML = `<p class="hint">Loading insights…</p>`;
  try {
    const data = await loadInsights(gameId);
    if (!data) {
      els.insightsSections.innerHTML = `<p class="hint">Insights aren't available for this game.</p>`;
      return;
    }

    els.insightsSections.innerHTML = "";
    const frag = document.createDocumentFragment();
    const trendMetric = (r) => `${r.avgTrendPct >= 0 ? "+" : ""}${r.avgTrendPct}%`;
    const priceMetric = (r) => usd(r.avgPrice);
    const sub = (r) => `avg ${usd(r.avgPrice)} · n=${r.cardCount}`;

    frag.appendChild(insightsSection("📈 Rising Species (90d)", data.speciesByTrend.slice(0, 15), trendMetric, sub));
    frag.appendChild(insightsSection("💎 Premium Species (highest avg price)", data.speciesByPrice.slice(0, 15), priceMetric, (r) => `n=${r.cardCount}`));
    frag.appendChild(insightsSection("🎨 Rising Illustrators (90d)", data.artistsByTrend.slice(0, 15), trendMetric, sub));
    frag.appendChild(insightsSection("🎨 Premium Illustrators (highest avg price)", data.artistsByPrice.slice(0, 15), priceMetric, (r) => `n=${r.cardCount}`));
    els.insightsSections.appendChild(frag);

    const coverageNote = document.createElement("p");
    coverageNote.className = "insights-coverage";
    coverageNote.textContent = `Based on ${data.coverage.cardsMatched.toLocaleString()} of ${data.coverage.totalCards.toLocaleString()} cards matched to artist/species data, across a ${data.historyWindowDays}-day price history window. Updated ${new Date(data.generatedAt).toLocaleDateString()}.`;
    els.insightsSections.appendChild(coverageNote);
  } catch (err) {
    console.error(err);
    els.insightsSections.innerHTML = `<p class="hint">Couldn't load insights. Check your connection and reload.</p>`;
  }
}

async function init() {
  els.status.textContent = "Loading…";
  try {
    const res = await fetch("data/games.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    state.games = manifest.games || [];

    if (state.games.length === 0) throw new Error("No games in manifest");

    renderGameTabs();

    const lastGame = localStorage.getItem(LAST_GAME_KEY);
    const initialGame = state.games.find((g) => g.id === lastGame) ? lastGame : state.games[0].id;
    await selectGame(initialGame);
  } catch (err) {
    console.error(err);
    els.status.textContent = "Couldn't load game list. Check your connection and reload.";
    els.status.classList.add("error");
  }
}

els.search.addEventListener("input", debounce(search, 80));
els.setFilter.addEventListener("change", search);
els.viewToggle.querySelectorAll(".view-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
  });
}
