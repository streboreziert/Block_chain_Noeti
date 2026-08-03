/* Noeti PWA service worker — cache the app shell, never cache API calls. */
const CACHE = "noetis-shell-v28";
const SHELL = [
  "./",
  "static/app.css?v=38",
  "static/app.js?v=38",
  "static/browser_compute.js?v=38",
  "static/wallet.js",
  "static/auth.js",
  "static/logo.svg",
  "static/icon-192.png",
  "static/icon-512.png",
  "static/apple-touch-icon.png",
  "manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes("/api/") || event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});
