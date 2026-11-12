// A different name from the Preact shell's cache, so switching frontends on one origin installs and precaches fresh.
const CACHE = "harness-shell-solid-v1";
const LIVE = ["/api/", "/ws", "/mcp"];

// The cache keys (path plus query) to drop once a new shell is complete: everything except "/" and
// the assets the new page references.
function staleKeys(cached, assets) {
  const keep = new Set(["/", ...assets]);
  return cached.filter((key) => !keep.has(key));
}

// Bundled asset URLs carry content hashes, so they are discovered from the served page. The page is
// stored last: if a required asset fails, the previous "/" and its assets stay in the cache.
async function storeShell(cache, res) {
  const html = await res.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => new URL(m[1], location.origin))
    .filter((url) => url.origin === location.origin)
    .map((url) => url.pathname + url.search);
  // Scripts and styles are required: without them the cached "/" cannot start offline. Icons and the
  // manifest are optional.
  await Promise.all(
    assets.map((url) =>
      /\.(?:js|css)(?:\?|$)/.test(url) ? cache.add(url) : cache.add(url).catch(() => undefined),
    ),
  );
  // A redirected response cannot answer a navigation, so the page is stored as a fresh Response.
  await cache.put("/", new Response(await res.blob(), { headers: res.headers }));
  try {
    const cached = (await cache.keys()).map((r) => {
      const url = new URL(r.url);
      return url.pathname + url.search;
    });
    await Promise.all(staleKeys(cached, assets).map((key) => cache.delete(key)));
  } catch (err) {
    console.warn("old shell assets not removed", err);
  }
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch("/", { cache: "reload" });
  // A failed shell fetch must fail the install, or the empty new cache replaces the working one.
  if (!res.ok) throw new Error(`shell fetch answered ${res.status}`);
  await storeShell(cache, res);
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
  const remember = async (res) => {
    if (res.ok && res.type === "basic") {
      try {
        const cache = await caches.open(CACHE);
        if (request.mode === "navigate") await storeShell(cache, res.clone());
        else await cache.put(request, res.clone());
      } catch (err) {
        console.warn("shell cache not updated", err);
      }
    }
    return res;
  };
  // Online visits refresh the cached shell and assets, so a later offline start serves the newest release.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(remember)
        .catch(() => caches.match("/")),
    );
    return;
  }
  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request).then(remember)));
});

// The payload is JSON from our own server; a broken one still shows something rather than nothing.
function readPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

self.addEventListener("push", (event) => {
  const { title, body, tag, url } = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(title || "harness", { body, tag, data: { url } }),
  );
});

// Only same-origin targets are followed, whatever the payload says.
function target(url) {
  try {
    const parsed = new URL(url || "/", location.origin);
    return parsed.origin === location.origin ? parsed.href : `${location.origin}/`;
  } catch {
    return `${location.origin}/`;
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = target(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      const client = open.find((c) => new URL(c.url).origin === location.origin);
      if (!client) return self.clients.openWindow(url);
      return client.focus().then(() => client.navigate(url));
    }),
  );
});
