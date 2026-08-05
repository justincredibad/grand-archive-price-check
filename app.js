const MAX_RESULTS = 40;
const MIN_CHARS_FOR_FULL_LIST = 2;
const LAST_GAME_KEY = "tcg-price-check:last-game";

const els = {
  gameTabs: document.getElementById("gameTabs"),
  search: document.getElementById("search"),
  setFilter: document.getElementById("setFilter"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  metaInfo: document.getElementById("meta-info"),
  cardTemplate: document.getElementById("card-template"),
  variantTemplate: document.getElementById("variant-template"),
};

let state = {
  games: [],          // manifest entries: {id, label, file, totalCards, generatedAt}
  activeGameId: null,
  gameData: {},        // cache of loaded per-game payloads, keyed by game id
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
  node.querySelector(".market.usd").textContent = usd(variant.market);
  node.querySelector(".market.sgd").textContent = `≈ ${sgd(toSgd(variant.market))}`;

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

  const link = node.querySelector(".tcgp-link");
  if (card.url) {
    link.href = card.url;
  } else {
    link.remove();
  }

  return node;
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

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
  });
}
