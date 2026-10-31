/* DATAHOOD service worker — minimal offline shell cache.
   Registered from src/index.jsx. Network-first for API, cache-first
   for the app shell so the PWA opens fast and works offline-ish. */

/* Bumped v1 -> v2 when favicon.svg was replaced by the real brand PNGs.
   Bumped v2 -> v3 when the landing page landed: index.html gained the SEO
   head and JSON-LD, and `/` changed from a redirect into a real page. The
   bump is not cosmetic — `activate` deletes every cache whose key is not
   CACHE, and the fetch handler is cache-first, so without it a returning
   visitor keeps being served the OLD index.html (still redirecting to the
   login wall, and still referencing a hashed bundle that the new build has
   replaced). Bump it again on any future change to SHELL or index.html. */
/* v4: navigations became network-first and only ok/basic responses are
   cached. This bump is the LAST one that should ever be strictly required
   — with navigations off the cache-first path, a new index.html now
   reaches returning visitors on its own. Bump it anyway when SHELL
   changes, since those entries are still cache-first. */
const CACHE = 'datahood-v4';

/* addAll is atomic — one 404 rejects the whole install and the worker never
   activates. Every path here must exist in public/ (or be a real route).
   robots.txt, sitemap.xml and browserconfig.xml are deliberately absent:
   they are crawler-facing documents, never fetched by the running app, and
   caching them would only add install-time failure surface. */
const SHELL = ['/', '/index.html', '/manifest.json', '/favicon-32.png', '/logo-mark.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  // Never cache API calls — always hit the network.
  if (request.url.includes('/api/')) return;
  if (request.method !== 'GET') return;

  /* NAVIGATIONS ARE NETWORK-FIRST, and that is what makes redeploys work.
     index.html names the hashed JS bundle, so serving a cached index.html
     serves the OLD bundle reference too — a rebuilt frontend then never
     reaches anyone who has visited before, no matter how many times they
     reload. (This is the shape of the mobile-login bug: the fix ships, the
     user's phone keeps running the previous build.) Bumping CACHE fixes it
     only for the one deploy you remember to bump on; network-first fixes
     it permanently. Falling back to the cache keeps offline working. */
  if (request.mode === 'navigate') {
    e.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  e.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((res) => {
      /* Only cache real successes from our own origin. Without this a 404
         or a 500 is stored and then served cache-first FOREVER, so a
         transient server error becomes a permanently broken asset that a
         redeploy cannot clear. `basic` excludes opaque cross-origin
         responses, whose status is always 0 and cannot be judged. */
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
