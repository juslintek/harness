const CACHE = "harness-shell-v1";
const LIVE = ["/api/", "/ws", "/mcp"];

// Bundled asset URLs carry content hashes, so they are discovered from the served page.
async function cacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "reload" });
  if (!res.ok) return;
  const html = await res.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => new URL(m[1], location.origin))
    .filter((url) => url.origin === location.origin)
    .map((url) => url.pathname + url.search);
  // A redirected response cannot answer a navigation, so the page is stored as a fresh Response.
  await cache.put("/", new Response(await res.blob(), { headers: res.headers }));
  await Promise.all(assets.map((url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;
  if (LIVE.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
