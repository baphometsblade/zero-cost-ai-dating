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

// The directory this worker was served from: '/' on Firebase Hosting, or a
// project subpath like '/zero-cost-ai-dating/' on GitHub Pages. Every path
// computed below is relative to it, so the same worker serves both hosts.
const BASE = new URL('./', self.location).pathname;

// Bump the version to retire every previously cached asset on next activate.
// v4: every earlier shell stored REDIRECTED responses on Firebase Hosting (see
// `unredirected` below), so none of it may be served again.
//
// The name carries BASE, because Cache Storage belongs to the ORIGIN, and on
// GitHub Pages every project site a user publishes shares one: two copies of
// this app there — a fork beside the original — would otherwise share a prefix,
// and each one's `activate` would delete the other's shell.
const CACHE_PREFIX = 'zc-static:' + BASE + ':';
const CACHE = CACHE_PREFIX + 'v4';

// Names this worker used before they were scoped. All of them predate the fix
// above — and on Hosting all of them hold redirected responses — so they are
// retired on activation, whichever deployment wrote them: a sibling still
// running an old worker loses an offline copy it could not have served.
const LEGACY_CACHE = /^zc-static-v\d+$/;

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

/**
 * The same response, minus the fact that it was redirected.
 *
 * Firebase Hosting runs with `cleanUrls: true`, which answers every request for
 * `something.html` with a 301 to `something`. So every page in CORE reaches this
 * worker as a REDIRECTED response, and a browser will not let a worker answer a
 * navigation with one: a navigation's redirect mode is "manual", and a response
 * whose URL list says it was redirected is turned into a network error. Offline,
 * that was every page — the shell was precached, and every attempt to serve it
 * failed. It went unseen because the e2e server answered `.html` with a plain
 * 200, which Hosting never does; `e2e/harness.js` now redirects the way Hosting
 * does, and `e2e/specs/07-offline.e2e.js` fails against the old worker.
 *
 * Rebuilding the response from its body gives the same status, headers and
 * bytes with a URL list of one. A response that was not redirected is returned
 * as it is — GitHub Pages serves `.html` directly, so there nothing changes.
 * @param {Response} response a fetched response
 * @returns {Promise<Response>} one that is safe to hand to a navigation
 */
function unredirected(response) {
  if (!response.redirected) return Promise.resolve(response);
  return response.blob().then(function (body) {
    // `blob()` hands back the DECODED bytes, so the headers that described the
    // bytes on the wire no longer describe this body. Copied as they were, the
    // stored page said `content-encoding: gzip` and `content-length: 2892` over
    // 9,119 bytes of plain HTML — measured, with the e2e server gzipping the
    // way Hosting does. Chromium serves that anyway; nothing here should depend
    // on every engine being as forgiving, so the two are dropped and the
    // browser takes the length from the body itself.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers
    });
  });
}

self.addEventListener('install', function (event) {
  // No catch here on purpose: if any CORE asset fails to fetch, installation
  // must fail so the previous worker — and its working cache — stay active.
  // Swallowing the failure would activate an empty shell and then delete the
  // old cache below. A failed install simply retries on the next visit.
  //
  // Not `cache.addAll(CORE)`, which stores what it fetched as it fetched it —
  // redirects and all. Each asset is fetched, refused if it is not a success
  // (the same rule addAll applies), and stored without its redirect.
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return Promise.all(CORE.map(function (path) {
          return fetch(path).then(function (response) {
            if (!response.ok) throw new Error('precache: ' + path + ' answered ' + response.status);
            return unredirected(response).then(function (clean) { return cache.put(path, clean); });
          });
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  // Drop caches from THIS deployment's older versions so a deploy fully
  // replaces the shell — and only those, plus the unscoped names above. Cache
  // Storage belongs to the origin, and on GitHub Pages every project site a
  // user publishes shares one (`user.github.io`). Deleting every name that was
  // not the current one wiped the caches of every other project on it; scoping
  // by app alone still let two copies of THIS app delete each other's.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        const older = name.indexOf(CACHE_PREFIX) === 0 && name !== CACHE;
        return older || LEGACY_CACHE.test(name) ? caches.delete(name) : null;
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
        // Stored without its redirect for the same reason as the precache: a
        // live visit to `/matches.html` arrives redirected, and this copy is the
        // one an offline visit to `/matches` would be served.
        //
        // `return cache.put(...)`: the write's promise used to be dropped inside
        // the callback, so the `.catch` below caught only `caches.open` and a
        // failed write — quota, mostly — escaped as an unhandled rejection.
        const copy = response.clone();
        caches.open(CACHE)
          .then(function (cache) {
            return unredirected(copy).then(function (clean) { return cache.put(request, clean); });
          })
          .catch(function () {});
      }
      return response;
    }).catch(function () {
      // Navigations are cached under their file names, but the address bar
      // says BASE, BASE + 'matches', … — on Firebase Hosting because cleanUrls
      // drops the .html, on GitHub Pages because the app lives under the
      // project subpath. Strip BASE first, then map what is left back to its
      // page ('' -> index.html, 'matches' -> matches.html) so offline
      // navigation serves the right shell on either host, never the 404 page
      // for a page that is actually cached.
      if (request.mode === 'navigate') {
        const rel = url.pathname.indexOf(BASE) === 0
          ? url.pathname.slice(BASE.length)
          : url.pathname.replace(/^\/+/, '');
        const page = rel === ''
          ? 'index.html'
          : rel.replace(/\.html$/, '') + '.html';
        return caches.match(page).then(function (hit) {
          return hit || caches.match('404.html');
        });
      }
      return caches.match(request);
    })
  );
});
