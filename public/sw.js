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
// `rebuilt` below), so none of it may be served again.
// v5: v4 shells were precached through the browser's HTTP cache, which held
// scripts for an hour against pages it did not, so one may mix two deploys.
//
// The name carries BASE, because Cache Storage belongs to the ORIGIN, and on
// GitHub Pages every project site a user publishes shares one: two copies of
// this app there — a fork beside the original — would otherwise share a prefix,
// and each one's `activate` would delete the other's shell.
const CACHE_PREFIX = 'zc-static:' + BASE + ':';
const CACHE = CACHE_PREFIX + 'v5';

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
  'js/theme-boot.js',
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
 * The response read in full and built again from its bytes: never redirected,
 * and holding no connection open. Everything this worker stores goes through
 * here, what the install stores and what a visit writes over it alike, so the
 * copy an offline request is served is the same shape whichever wrote it last.
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
 * Rebuilding the response from its body gives the same status and bytes with
 * a URL list of one, and the same headers less the two dropped below.
 * @param {Response} response a fetched response
 * @returns {Promise<Response>} one that is safe to store and to hand to a navigation
 */
function rebuilt(response) {
  return response.blob().then(function (body) {
    // `blob()` hands back the DECODED bytes, so the headers that described the
    // bytes on the wire no longer describe this body. Copied as they were, the
    // stored page said `content-encoding: gzip` and `content-length: 2892` over
    // 9,119 bytes of plain HTML — measured against a server gzipping the way
    // Hosting does. Chromium serves that anyway; nothing here should depend
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

/**
 * The name a page is cached under, from the URL a navigation asked for.
 *
 * The address bar need not say `matches.html`: on Firebase Hosting cleanUrls
 * answers each page at its clean URL (`/matches`) and the landing page at '/',
 * and on GitHub Pages the app lives under the project subpath, which is its
 * landing page.
 * Strip BASE, then map what is left back to its file ('' -> index.html,
 * 'matches' -> matches.html); a query string is no part of the name.
 * Both halves of the fetch handler go through this — the write a visit makes
 * and the lookup an offline navigation makes — so the two cannot disagree.
 * @param {URL} url the navigation's URL
 * @returns {string} a path relative to BASE, as CORE names it
 */
function pageKey(url) {
  const rel = url.pathname.indexOf(BASE) === 0
    ? url.pathname.slice(BASE.length)
    : url.pathname.replace(/^\/+/, '');
  return rel === '' ? 'index.html' : rel.replace(/\.html$/, '') + '.html';
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
  //
  // Every asset is in hand before any is stored. This worker writes into the
  // cache its predecessor is still serving offline from whenever sw.js changes
  // without a version bump, and storing each as it arrived meant one failure
  // rejected the install — the old worker stays — after the others had
  // overwritten its copies: an offline shell half from each deploy.
  event.waitUntil(
    Promise.all(CORE.map(function (path) {
      // `no-cache`: asked of the server, not of the browser's HTTP cache.
      // A new worker installs because a deploy changed it, and a script or
      // page the browser cached before that deploy is exactly what must not
      // be stored as this deploy's offline copy. GitHub Pages caches every
      // file for ten minutes and cannot be told otherwise.
      //
      // Read in full as it arrives, redirected or not. Holding two dozen
      // responses unread until the last one landed kept each one's connection
      // busy, and a browser opens six to a host: the seventh fetch waited for a
      // connection that never came, and the install never finished.
      return fetch(path, { cache: 'no-cache' }).then(function (response) {
        if (!response.ok) throw new Error('precache: ' + path + ' answered ' + response.status);
        return rebuilt(response).then(function (clean) { return { path: path, response: clean }; });
      });
    }))
      .then(function (shell) {
        return caches.open(CACHE).then(function (cache) {
          return Promise.all(shell.map(function (entry) { return cache.put(entry.path, entry.response); }));
        });
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
        // A page is stored under its file name, the one an offline navigation
        // looks it up by, not under the URL the visit asked for. On Firebase
        // Hosting those are never the same: cleanUrls answers each page at its
        // clean URL, `/matches`, and the copy a visit wrote under that was one
        // nothing read. Offline, the page stayed the one the worker installed
        // with, while every visit refreshed the scripts it runs: after any
        // deploy that left sw.js alone, the install's page ran the newer
        // scripts. GitHub Pages names the file, but its landing page and any
        // query string parted the two names there too.
        const key = request.mode === 'navigate' ? pageKey(url) : request;
        // Stored rebuilt, as the install stores it, whether it was redirected
        // or not. On Hosting anything fetched by its `.html` name arrives
        // redirected, and under that name it is the copy an offline navigation
        // is served. A navigation never arrives redirected: its redirect mode
        // is manual, so the worker is handed the 301 itself — not ok, so not
        // stored — and the browser follows it with a second navigation, to
        // `/matches`. Rebuilding only what was redirected, then, stored that
        // page as it came off the wire, with the headers of its compressed
        // bytes: measured in Chromium against a server gzipping the way
        // Hosting does, one online visit replaced the install's clean matches
        // page with one saying "gzip, 3238 bytes" over 10,014 bytes of HTML,
        // and matches.js and style.css went the same way.
        //
        // `return cache.put(...)`: the write's promise used to be dropped inside
        // the callback, so the `.catch` below caught only `caches.open` and a
        // failed write — quota, mostly — escaped as an unhandled rejection.
        const copy = response.clone();
        caches.open(CACHE)
          .then(function (cache) {
            return rebuilt(copy).then(function (clean) { return cache.put(key, clean); });
          })
          .catch(function () {});
      }
      return response;
    }).catch(function () {
      // A navigation is answered with its page, or with the 404 page when that
      // page is not cached — never with a network error for a page that is.
      if (request.mode === 'navigate') {
        return caches.match(pageKey(url)).then(function (hit) {
          return hit || caches.match('404.html');
        });
      }
      return caches.match(request);
    })
  );
});
