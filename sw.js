// Lets the price checker keep working with no signal at a vending table —
// caches the app shell and the price data on first load, then serves from
// cache instantly while refreshing in the background when online.
const CACHE_NAME = "tcg-price-check-v2";
// Only the shell + the small game manifest are precached on install. Each
// game's card data (Pokemon alone is >10MB) is cached lazily the first time
// it's actually requested, via the fetch handler's stale-while-revalidate
// below — so picking one game doesn't force-download every game's data.
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.json", "data/games.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      // Stale-while-revalidate: serve cache immediately if we have it,
      // otherwise wait for the network.
      return cached || (await network) || new Response("Offline", { status: 503 });
    })
  );
});
