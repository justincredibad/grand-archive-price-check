const DATA_URL = "data/cards.json";
const MAX_RESULTS = 40;
const MIN_CHARS_FOR_FULL_LIST = 2;

const els = {
  search: document.getElementById("search"),
  setFilter: document.getElementById("setFilter"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  metaInfo: document.getElementById("meta-info"),
  template: document.getElementById("card-template"),
};

let state = {
  cards: [],
  sets: [],
  usdToSgd: null,
  generatedAt: null,
};

function usd(n) {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function sgd(n) {
  if (n === null || n === undefined) return "";
  return n.toLocaleString("en-SG", { style: "currency", currency: "SGD" });
}

function toSgd(usdAmount) {
  if (usdAmount === null || usdAmount === undefined || !state.usdToSgd) return null;
  return usdAmount * state.usdToSgd;
}

function fillPriceBlock(blockEl, priceData) {
  const hasData = !!(priceData && priceData.market !== null && priceData.market !== undefined);
  blockEl.classList.toggle("no-data", !hasData);
  if (!hasData) return;

  blockEl.querySelector(".market.usd").textContent = usd(priceData.market);
  blockEl.querySelector(".market.sgd").textContent = `≈ ${sgd(toSgd(priceData.market))}`;

  const rangeEl = blockEl.querySelector(".price-range");
  const lowUsd = usd(priceData.low);
  const highUsd = usd(priceData.high);
  const lowSgd = sgd(toSgd(priceData.low));
  const highSgd = sgd(toSgd(priceData.high));
  rangeEl.innerHTML = `Range: ${lowUsd}–${highUsd}<br>≈ ${lowSgd}–${highSgd}`;
}

function renderCard(card) {
  const node = els.template.content.cloneNode(true);

  const img = node.querySelector(".card-img");
  img.src = card.image || "";
  img.alt = card.name;

  node.querySelector(".card-name").textContent = card.name;
  const subParts = [card.set];
  if (card.number) subParts.push(`#${card.number}`);
  if (card.rarity) subParts.push(card.rarity);
  node.querySelector(".card-sub").textContent = subParts.join(" · ");

  fillPriceBlock(node.querySelector(".price-block.normal"), card.normal);
  fillPriceBlock(node.querySelector(".price-block.foil"), card.foil);

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
  const q = els.search.value.trim().toLowerCase();
  const setName = els.setFilter.value;

  let pool = state.cards;
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
  const parts = [];
  if (state.generatedAt) {
    const d = new Date(state.generatedAt);
    parts.push(`Prices updated ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
  }
  if (state.usdToSgd) {
    parts.push(`1 USD ≈ ${state.usdToSgd.toFixed(4)} SGD`);
  }
  els.metaInfo.textContent = parts.join(" · ");
}

async function init() {
  els.status.textContent = "Loading card prices…";
  try {
    const res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    state.cards = data.cards || [];
    state.sets = data.sets || [];
    state.usdToSgd = data.usdToSgd;
    state.generatedAt = data.generatedAt;

    populateSetFilter(state.sets);
    renderMeta();

    els.status.textContent = `${state.cards.length.toLocaleString()} cards loaded.`;
    els.results.innerHTML = `<p class="hint">Start typing a card name above…</p>`;
  } catch (err) {
    console.error(err);
    els.status.textContent = "Couldn't load price data. Check your connection and reload.";
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
