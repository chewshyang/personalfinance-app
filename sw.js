// Service worker — network-first so edits and fresh balances always win,
// with a cache fallback so the installed app still opens offline showing
// the last loaded numbers.
const CACHE = "net-v20";
// Relative to this file, so the app works at a sub-path (GitHub Pages:
// chewshyang.github.io/personalfinance-app/) as well as at the root locally.
const SHELL = [
  "./", "index.html", "styles.css", "chat.css", "design-system/tokens.css",
  "config.js", "net.js",
  "app.js",
  "manifest.json", "icons/brand.png", "icons/favicon.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                       // writes always go to the network
  const url = new URL(req.url);
  if (url.pathname.includes("/api/")) return;                   // local server: live-only
  if (url.hostname.endsWith(".supabase.co")) return;            // data + auth: never cache signed-in
                                                                // responses here; net.js keeps its own copy

  const cacheKey = url.origin === location.origin ? url.origin + url.pathname : req.url;  // drop ?v= busters

  e.respondWith((async () => {
    try {
      // Navigation requests can't be re-created with options, so same-origin
      // GETs are refetched by URL; cross-origin (CDN) requests pass through.
      const res = url.origin === location.origin
        ? await fetch(url.href, { cache: "no-store", credentials: "same-origin" })
        : await fetch(req);
      if (res.ok) {
        const copy = res.clone();
        const headers = new Headers(copy.headers);
        headers.set("x-cached-at", new Date().toISOString());
        const body = await copy.blob();
        caches.open(CACHE).then(c => c.put(cacheKey, new Response(body, { status: res.status, headers })));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(cacheKey);
      if (hit) return hit;
      throw err;
    }
  })());
});
