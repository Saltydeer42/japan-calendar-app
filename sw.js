/* ==========================================================================
   sw.js — keeps the shell available on a Tokyo subway platform.

   Only the shell is cached. The itinerary itself is fetched from the GitHub
   API and deliberately never cached here, because a stale itinerary is worse
   than no itinerary -- store.js keeps its own copy in localStorage for that.
   ========================================================================== */

const VERSION = "4";
const CACHE = `jc-shell-${VERSION}`;
const TIMEOUT = 3500;

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./chat.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/store.js",
  "./js/render.js",
  "./js/drag.js",
  "./js/editor.js",
  "./js/config.js",
  "./js/chat.js",
  "./js/agent.js",
  "./js/haptics.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Anything cross-origin is the GitHub API. Leave it alone entirely.
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  event.respondWith(networkFirst(event.request));
});

/* Network first so a shell change lands on the next launch rather than the one
   after, with the cache there for when there is no network at all. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("slow")), TIMEOUT)),
    ]);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === "navigate") {
      const index = await cache.match("./index.html");
      if (index) return index;
    }
    throw e;
  }
}
