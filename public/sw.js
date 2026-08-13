/* ==========================================================================
   Zero Cost AI Dating — service worker
   Network-first with a cache fallback, for same-origin GET requests only.
   The point is resilience, not aggressive caching: a fresh response always
   wins and refreshes the cache, and the cached copy only answers when the
   network is unavailable — which makes demo mode fully usable offline.
   Never intercepts cross-origin requests (the Firebase SDK and APIs go
   straight to the network), and never serves stale HTML when online.
   ========================================================================== */
'use strict';

// Bump the version to retire every previously cached asset on next activate.
const CACHE = 'zc-static-v2';

// The app shell, cached up front so a first visit can go offline immediately.
const CORE = [
  'index.html',
  'auth.html',
  'dashboard.html',
  'profile.html',
  'matches.html',
  'settings.html',
  'subscription.html',
  '404.html',
  'favicon.svg',
  'manifest.webmanifest',
  'css/style.css',
  'css/components.css',
  'js/firebase-config.js',
  'js/utils.js',
  'js/seed-data.js',
  'js/data-store.js',
  'js/matching-engine.js',
  'js/auth.js',
  'js/app.js',
  'js/dashboard.js',
  'js/profile.js',
  'js/matches.js',
  'js/settings.js',
  'js/subscription.js'
];

self.addEventListener('install', function (event) {
  // No catch here on purpose: if any CORE asset fails to fetch, installation
  // must fail so the previous worker — and its working cache — stay active.
  // Swallowing the failure would activate an empty shell and then delete the
  // old cache below. A failed install simply retries on the next visit.
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  // Drop caches from older versions so a deploy fully replaces the shell.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        return name === CACHE ? null : caches.delete(name);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network first: a live response is always preferred and refreshes the
  // cache; the cache only answers when the network fails.
  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); }).catch(function () {});
      }
      return response;
    }).catch(function () {
      // Navigations are cached under their file names, but with Hosting's
      // cleanUrls the address bar says '/', '/matches', … — map the pathname
      // back to its page ('/' -> index.html, '/matches' -> matches.html) so
      // offline navigation serves the right shell, never the 404 page for a
      // page that is actually cached.
      if (request.mode === 'navigate') {
        const page = url.pathname === '/'
          ? 'index.html'
          : url.pathname.replace(/^\//, '').replace(/\.html$/, '') + '.html';
        return caches.match(page).then(function (hit) {
          return hit || caches.match('404.html');
        });
      }
      return caches.match(request);
    })
  );
});
