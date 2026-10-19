/* ==========================================================================
   Zero Cost AI Dating — PWA subpath checks
   The same public/ directory is served from two very different places: the
   root of a Firebase Hosting site ('/') and a GitHub Pages *project* site
   ('/zero-cost-ai-dating/'). Nothing in the manifest or the service worker
   may assume root hosting, or the Pages demo installs under the wrong
   identity and offline navigation computes page names that were never
   cached. These checks pin the manifest to relative URLs and keep
   root-anchored path literals out of sw.js, so the assumption cannot creep
   back in a later edit. The CORE precache list is deliberately NOT checked
   here — check (f) in static.test.js already owns that both ways.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'manifest.webmanifest');
const SW_PATH = path.join(PUBLIC_DIR, 'sw.js');

// URLs that must not be treated as local files (same test as static.test.js).
const EXTERNAL_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/* ------------------------------------------------------------------------
   Tiny helpers — string and regex work only, no dependencies
   ------------------------------------------------------------------------ */

/**
 * Blank out block and whole-line comments in JS source while preserving every
 * character offset and newline, so line numbers reported from the blanked
 * text still match the real file. Comments are free to *talk about* absolute
 * paths — only code must not contain them.
 * @param {string} js source text
 * @returns {string} source with comment contents replaced by spaces
 */
function blankJsComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, function (block) {
      return block.replace(/[^\n]/g, ' ');
    })
    .replace(/^\s*\/\/[^\n]*/gm, function (line) {
      return line.replace(/[^\n]/g, ' ');
    });
}

/**
 * 1-based line number of a character offset in a string.
 * @param {string} text the text the offset points into
 * @param {number} index character offset
 * @returns {number} line number, counting from 1
 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Format a list of problems into a message a human can act on directly.
 * @param {string} headline what went wrong, in one line
 * @param {string[]} problems one entry per offending location
 * @returns {string} the assertion message
 */
function report(headline, problems) {
  return headline + '\n  - ' + problems.join('\n  - ') + '\n';
}

/* ------------------------------------------------------------------------
   The manifest: every URL relative, no origin-absolute identity
   ------------------------------------------------------------------------ */

test('the manifest keeps its identity and URLs subpath-relative', function () {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'public/manifest.webmanifest is missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // No "id": any value resolves against the *origin*, so even a relative id
  // would collide between projects sharing github.io. Absent, it defaults to
  // the resolved start_url — manifest-relative, correct on both hosts.
  assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'id'),
    'the manifest must not declare "id" — it resolves against the origin, ' +
    'so it cannot be made subpath-safe; omit it and start_url takes over');

  // "./" resolves against the manifest URL to whichever directory serves it.
  assert.equal(manifest.scope, './',
    'manifest "scope" must be "./" so the app scope follows the hosting path');

  // start_url must stay relative for the same reason: a leading slash (or a
  // full URL) would pin the installed app to root hosting.
  assert.equal(typeof manifest.start_url, 'string', 'manifest "start_url" must be a string');
  assert.notEqual(manifest.start_url.charAt(0), '/',
    'manifest "start_url" must not start with "/" — that assumes root hosting');
  assert.ok(!EXTERNAL_RE.test(manifest.start_url),
    'manifest "start_url" must be a relative path, not an absolute URL');
});

test('every manifest icon resolves to a file in public/', function () {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0,
    'the manifest must declare at least one icon');

  const problems = [];
  manifest.icons.forEach(function (icon, i) {
    const src = (icon && icon.src) || '';
    if (!src || src.charAt(0) === '/' || EXTERNAL_RE.test(src)) {
      problems.push('icons[' + i + '].src "' + src + '" is not a relative path');
    } else if (!fs.existsSync(path.join(PUBLIC_DIR, src))) {
      problems.push('icons[' + i + '].src "' + src + '" does not exist in public/');
    }
  });

  assert.equal(problems.length, 0, report('Manifest icon problems:', problems));
});

/* ------------------------------------------------------------------------
   The service worker: all paths flow through BASE, never a hard-coded root
   ------------------------------------------------------------------------ */

test('sw.js derives BASE and hard-codes no root-anchored path literals', function () {
  assert.ok(fs.existsSync(SW_PATH), 'public/sw.js is missing');
  const sw = fs.readFileSync(SW_PATH, 'utf8');

  // The one sanctioned way to learn where the worker lives. Everything else
  // must be expressed relative to it.
  assert.ok(sw.indexOf("const BASE = new URL('./', self.location).pathname;") !== -1,
    "sw.js must derive its base once via new URL('./', self.location).pathname");

  // Cheap guard: a string literal opening with '/' is a same-origin path that
  // only works at root hosting — exactly the assumption this round removed.
  // Comments are blanked first, so prose may still say '/zero-cost-ai-dating/'.
  const code = blankJsComments(sw);
  const problems = [];
  const re = /['"]\//g;
  let m;
  while ((m = re.exec(code)) !== null) {
    problems.push('public/sw.js:' + lineAt(code, m.index) +
      ' has a string literal starting with "/" — route it through BASE instead');
  }

  assert.equal(problems.length, 0, report('Root-hosting assumptions in sw.js:', problems));
});

/* ------------------------------------------------------------------------
   The worker itself, run rather than read

   Everything above inspects sw.js as text. These run it: the shipped file is
   evaluated in a `vm` context with a stand-in `caches` and `fetch`, and its own
   install, activate and fetch handlers are fired. Three defects lived in this
   file at once and none of them was visible to a string check:

     - on Firebase Hosting every precached page arrived REDIRECTED (cleanUrls
       answers `x.html` with a 301), and a browser turns a redirected response
       handed to a navigation into a network error — so offline navigation
       failed on every page of the production host;
     - `activate` deleted every cache on the origin, and GitHub Pages puts every
       project site a user publishes on one origin;
     - the runtime write's promise was dropped, so a failed `cache.put` escaped
       its `.catch` as an unhandled rejection.
   ------------------------------------------------------------------------ */

const vm = require('node:vm');

/** A fetched response as the worker sees it, redirected or not. */
function fakeResponse(body, opts) {
  const o = opts || {};
  const res = {
    ok: o.ok === undefined ? true : o.ok,
    status: o.status || 200,
    statusText: o.statusText || 'OK',
    redirected: !!o.redirected,
    headers: new Headers(Object.assign({ 'content-type': 'text/html; charset=utf-8' }, o.headers || {})),
    blob: function () { return Promise.resolve(new Blob([body])); },
    text: function () { return Promise.resolve(body); }
  };
  res.clone = function () { return fakeResponse(body, o); };
  return res;
}

/**
 * Evaluate the shipped sw.js against stand-ins, and hand back what it did.
 * @param {Object} opts `fetch(path)` to answer requests; `putFails` to make
 *   every cache write reject; `existing` cache names already on the origin;
 *   `scope` the directory the worker is served from, '/' unless given
 * @returns {Object} the caches it left, the names it deleted, and `fire(type, event)`
 */
function runWorker(opts) {
  const o = opts || {};
  const listeners = {};
  const stores = new Map();
  (o.existing || []).forEach(function (name) { stores.set(name, new Map()); });
  const deleted = [];
  const fetched = [];
  const origin = 'https://example.test';
  const location = new URL(origin + (o.scope || '/') + 'sw.js');
  // A relative cache key resolves against the worker's own URL, as it does in
  // a browser: under a project subpath 'matches.html' is that subpath's page.
  function keyOf(req) {
    return new URL(typeof req === 'string' ? req : req.url, location).href;
  }
  const caches = {
    open: function (name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return Promise.resolve({
        put: function (req, res) {
          if (o.putFails) return Promise.reject(new Error('QuotaExceededError'));
          store.set(keyOf(req), res);
          return Promise.resolve();
        },
        match: function (req) { return Promise.resolve(store.get(keyOf(req))); }
      });
    },
    keys: function () { return Promise.resolve(Array.from(stores.keys())); },
    delete: function (name) { deleted.push(name); return Promise.resolve(stores.delete(name)); },
    match: function (req) {
      const key = keyOf(req);
      for (const store of stores.values()) if (store.has(key)) return Promise.resolve(store.get(key));
      return Promise.resolve(undefined);
    }
  };
  const self = {
    location: location,
    addEventListener: function (type, fn) { listeners[type] = fn; },
    skipWaiting: function () { return Promise.resolve(); },
    clients: { claim: function () { return Promise.resolve(); } }
  };
  const context = vm.createContext({
    self: self, caches: caches, Response: Response, URL: URL, Blob: Blob, Headers: Headers,
    fetch: function (req, init) {
      const url = typeof req === 'string' ? req : req.url;
      fetched.push({ url: url, init: init || null });
      return Promise.resolve(o.fetch(url));
    }
  });
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), context, { filename: SW_PATH });
  return {
    stores: stores,
    deleted: deleted,
    fetched: fetched,
    cacheName: vm.runInContext('CACHE', context),
    core: vm.runInContext('CORE', context),
    fire: function (type, extra) {
      let pending = null;
      const event = Object.assign({
        waitUntil: function (p) { pending = p; },
        respondWith: function (p) { pending = p; }
      }, extra || {});
      listeners[type](event);
      return pending;
    }
  };
}

test('install stores every page WITHOUT its redirect, so a navigation may be served it', async function () {
  // What Firebase Hosting hands back for `dashboard.html`: the page, but as the
  // answer to a 301 — and compressed, with the length of the compressed bytes.
  const worker = runWorker({
    fetch: function (url) {
      return fakeResponse('<!doctype html>' + url, {
        redirected: true,
        headers: { 'content-encoding': 'gzip', 'content-length': '7' }
      });
    }
  });
  await worker.fire('install');

  const shell = worker.stores.get(worker.cacheName);
  assert.ok(shell, 'install opened no cache named ' + worker.cacheName);
  const pages = worker.core.filter(function (file) { return /\.html$/.test(file); });
  assert.ok(pages.length >= 7, 'expected the precache list to name the pages, found ' + pages.length);
  for (const file of pages) {
    const stored = shell.get('https://example.test/' + file);
    assert.ok(stored, file + ' was not precached');
    assert.equal(stored.redirected, false, file + ' was stored as a redirected response');
    assert.equal(stored.status, 200, file + ' lost its status');
    assert.equal(await stored.text(), '<!doctype html>' + file, file + ' lost its body');
    // The body is decoded bytes now; headers describing the wire must not travel
    // with it (found in review, and measured: gzip and 2892 over 9,119 bytes).
    assert.equal(stored.headers.get('content-encoding'), null, file + ' still claims to be gzipped');
    assert.equal(stored.headers.get('content-length'), null, file + ' still claims the compressed length');
    assert.equal(stored.headers.get('content-type'), 'text/html; charset=utf-8', file + ' lost its content type');
  }
});

test('install asks the server for the shell, not the browser\'s HTTP cache', async function () {
  // A new worker installs because a deploy changed it, so what it stores as the
  // offline copy has to be that deploy. A plain fetch is answered from the HTTP
  // cache when it can be, and GitHub Pages caches every file for ten minutes:
  // a page or script the browser kept from before the deploy would be stored as
  // this deploy's shell, beside files that are not.
  const worker = runWorker({ fetch: function (url) { return fakeResponse('ok ' + url); } });
  await worker.fire('install');
  assert.equal(worker.fetched.length, worker.core.length, 'install fetched ' + worker.fetched.length +
    ' times for ' + worker.core.length + ' shell assets');
  const cached = worker.fetched.filter(function (call) { return !call.init || call.init.cache !== 'no-cache'; });
  assert.deepEqual(cached.map(function (call) { return call.url; }), [],
    'fetched without `cache: \'no-cache\'`, so the browser may answer from its HTTP cache');
});

test('an install that fails leaves the cache it found exactly as it was', async function () {
  // A worker installs into the cache its predecessor is still serving offline
  // from whenever sw.js changes without a version bump. Writing each asset as
  // it arrived meant that one asset failing rejected the install — the old
  // worker stays — after the others had already overwritten its copies, and
  // the shell it went on serving offline was half this deploy, half the last.
  const worker = runWorker({
    fetch: function (url) {
      return /matches\.html$/.test(url) ? fakeResponse('gone', { ok: false, status: 404 }) : fakeResponse('new ' + url);
    }
  });
  const before = new Map([['https://example.test/index.html', fakeResponse('old index.html')]]);
  worker.stores.set(worker.cacheName, new Map(before));
  await assert.rejects(worker.fire('install'), /matches\.html answered 404/);
  // The assets that did arrive settle after the rejection; let them.
  for (let i = 0; i < 10; i += 1) await new Promise(function (resolve) { setImmediate(resolve); });
  const after = worker.stores.get(worker.cacheName);
  assert.deepEqual(Array.from(after.keys()), Array.from(before.keys()), 'a failed install wrote into the cache it found');
  assert.equal(await after.get('https://example.test/index.html').text(), 'old index.html',
    'a failed install overwrote the copy the old worker serves offline');
});

test('install reads each asset as it arrives, so six connections are enough', async function () {
  // A browser opens six HTTP/1.1 connections to a host, and a response holds
  // its connection until its body is read. Gathering the shell by holding every
  // response unread until the last one arrived left the seventh fetch waiting
  // for a connection that never freed: in Chromium the new worker sat in
  // `installing` for good. Modelled here: six responses at a time may be
  // unread, and the next fetch waits for one of them to be.
  const CONNECTIONS = 6;
  let unread = 0;
  const queued = [];
  const worker = runWorker({
    fetch: function (url) {
      function answer() {
        unread += 1;
        const res = fakeResponse('ok ' + url);
        const read = res.blob;
        let freed = false;
        res.blob = function () {
          if (!freed) {
            freed = true;
            unread -= 1;
            const next = queued.shift();
            if (next) next();
          }
          return read();
        };
        return res;
      }
      if (unread < CONNECTIONS) return answer();
      return new Promise(function (resolve) { queued.push(function () { resolve(answer()); }); });
    }
  });
  const outcome = await Promise.race([
    worker.fire('install').then(function () { return 'installed'; }),
    new Promise(function (resolve) { setTimeout(function () { resolve('stalled'); }, 1000); })
  ]);
  assert.equal(outcome, 'installed', 'install stalled with ' + queued.length + ' of ' + worker.core.length +
    ' fetches waiting on a connection held by an unread response');
});

test('install still fails as a whole when any shell asset is not a success', async function () {
  // The rule cache.addAll applied, kept on purpose: a half-precached shell must
  // not activate and then delete the old, working one.
  const worker = runWorker({
    fetch: function (url) {
      return /matches\.html$/.test(url) ? fakeResponse('gone', { ok: false, status: 404 }) : fakeResponse('ok');
    }
  });
  await assert.rejects(worker.fire('install'), /matches\.html answered 404/);
});

test('activate retires only this deployment\'s older shells, never another project\'s or another copy\'s', async function () {
  // This worker is served from the origin's root, so its BASE is '/'. A second
  // copy of this same app on the same origin — a fork published beside the
  // original on one github.io — has its own BASE and must keep its shell.
  const worker = runWorker({
    fetch: function () { return fakeResponse('ok'); },
    existing: [
      'zc-static-v1', 'zc-static-v3',          // unscoped names from before: retired
      'zc-static:/:v3',                         // this deployment, older: retired
      'zc-static:/a-fork/:v3',                  // the same app, another deployment: kept
      'another-project-offline', 'workbox-precache-v2'
    ]
  });
  await worker.fire('install');
  await worker.fire('activate');

  assert.ok(/^zc-static:\/:v\d+$/.test(worker.cacheName), 'the cache name is not scoped to BASE: ' + worker.cacheName);
  assert.deepEqual(worker.deleted.slice().sort(), ['zc-static-v1', 'zc-static-v3', 'zc-static:/:v3'],
    'activate deleted ' + JSON.stringify(worker.deleted));
  assert.ok(worker.stores.has('zc-static:/a-fork/:v3'), 'another deployment of this app lost its shell');
  assert.ok(worker.stores.has('another-project-offline'), 'a sibling project\'s cache was deleted');
  assert.ok(worker.stores.has('workbox-precache-v2'), 'a sibling project\'s cache was deleted');
  assert.ok(worker.stores.has(worker.cacheName), 'the current shell was deleted');
});

test('a failed runtime cache write is caught, not left as an unhandled rejection', async function () {
  const unhandled = [];
  function onUnhandled(reason) { unhandled.push(reason); }
  process.on('unhandledRejection', onUnhandled);
  try {
    const worker = runWorker({ fetch: function () { return fakeResponse('live'); }, putFails: true });
    const answered = await worker.fire('fetch', {
      request: { method: 'GET', url: 'https://example.test/matches', mode: 'navigate' }
    });
    assert.equal(await answered.text(), 'live', 'the live response must still be served');
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled.map(String), [], 'a cache write failure escaped');
});

test('offline, a page is the copy its last visit stored, whatever URL it was visited at', async function () {
  // Firebase Hosting answers every page at its clean URL, so a visit to the
  // matches page is a navigation to `/matches`, and the landing page is '/'.
  // Offline the worker looks a page up by its file name. Stored under the URL
  // it was answered at, the visit was a copy nothing read: offline served the
  // page the worker installed with, while the same visit had refreshed the
  // page's scripts — so after any deploy that left sw.js alone, the offline
  // page was one deploy and its scripts the next. A query string did the same
  // on either host. GitHub Pages serves the file name itself, and must still.
  //
  // Each page is asked for offline twice: before the visit it must be the
  // install's copy, not the 404 page — which pins the name a visit is stored
  // under to the name the install stored it under, since one function now
  // makes both the write and the lookup, and a wrong name in it would agree
  // with itself.
  const visits = [
    { scope: '/', path: 'matches', page: 'matches.html' },
    { scope: '/', path: '', page: 'index.html' },
    { scope: '/', path: 'auth?mode=signup', page: 'auth.html' },
    { scope: '/zero-cost-ai-dating/', path: 'matches.html', page: 'matches.html' },
    { scope: '/zero-cost-ai-dating/', path: '', page: 'index.html' },
    { scope: '/zero-cost-ai-dating/', path: 'auth.html?mode=signup', page: 'auth.html' }
  ];
  const problems = [];
  for (const visit of visits) {
    let deploy = 1;
    let online = true;
    const request = { method: 'GET', url: 'https://example.test' + visit.scope + visit.path, mode: 'navigate' };
    const worker = runWorker({
      scope: visit.scope,
      // The install asks for each file by its CORE name; the visit by its URL.
      fetch: function (url) {
        if (!online) return Promise.reject(new TypeError('Failed to fetch'));
        return fakeResponse('deploy ' + deploy + ' ' + (url === request.url ? visit.page : url));
      }
    });
    const offline = async function () {
      online = false;
      const answered = await worker.fire('fetch', { request: request });
      online = true;
      // A clone, because the stand-in cache hands back the response it holds,
      // where a browser's hands back a new one each time: read in place, the
      // installed copy could not be read a second time.
      return answered ? answered.clone().text() : 'nothing';
    };
    await worker.fire('install');
    const installed = await offline();
    if (installed !== 'deploy 1 ' + visit.page) {
      problems.push(request.url + ' served "' + installed + '" offline before any visit, not the installed ' +
        visit.page);
    }
    deploy = 2;
    await worker.fire('fetch', { request: request });
    // The worker answers before it writes; every step of the write is a
    // settled promise here, so it has landed once the microtasks drain.
    await new Promise(function (resolve) { setImmediate(resolve); });
    const visited = await offline();
    if (visited !== 'deploy 2 ' + visit.page) {
      problems.push(request.url + ' served "' + visited + '" offline after a visit to deploy 2');
    }
  }
  assert.equal(problems.length, 0, report('Offline, a page is not the copy its last visit stored:', problems));
});

test('a visit stores what it fetched the way the install does: no redirect, no headers that describe the wire', async function () {
  // The install stores every asset rebuilt from its decoded bytes, so nothing
  // it serves offline says `content-encoding: gzip` over plain text. A visit
  // writes over those copies, and on Firebase Hosting nothing it fetches is
  // redirected but a `.html` name: so the visit wrote the page and every
  // script and stylesheet back exactly as they came off the wire. Measured
  // in Chromium against a server that compresses the way Hosting does: after
  // one online visit the matches page an offline navigation is served said
  // "gzip, 3238 bytes" over 10,014, and matches.js "gzip, 24842" over 83,947.
  const HTML = 'text/html; charset=utf-8';
  const visits = [
    { why: 'a page at its clean URL, as Hosting answers it', url: 'matches', mode: 'navigate', key: 'matches.html', type: HTML },
    { why: 'a script', url: 'js/matches.js', mode: 'no-cors', key: 'js/matches.js', type: 'text/javascript; charset=utf-8' },
    { why: 'a page asked for by its file name, which Hosting redirects', url: 'settings.html', mode: 'cors',
      key: 'settings.html', type: HTML, redirected: true }
  ];
  const problems = [];
  for (const visit of visits) {
    const url = 'https://example.test/' + visit.url;
    const worker = runWorker({
      fetch: function (asked) {
        return fakeResponse('decoded ' + asked, {
          redirected: !!visit.redirected,
          headers: { 'content-type': visit.type, 'content-encoding': 'gzip', 'content-length': '7' }
        });
      }
    });
    await worker.fire('fetch', { request: { method: 'GET', url: url, mode: visit.mode } });
    // The write lands after the answer; every step of it is a settled promise
    // here, so it has landed once the microtasks drain.
    await new Promise(function (resolve) { setImmediate(resolve); });
    const shell = worker.stores.get(worker.cacheName);
    const stored = shell && shell.get('https://example.test/' + visit.key);
    if (!stored) {
      problems.push(visit.why + ': nothing stored under ' + visit.key);
      continue;
    }
    const said = [];
    if (stored.redirected) said.push('redirected');
    if (stored.headers.get('content-encoding') !== null) said.push('content-encoding: ' + stored.headers.get('content-encoding'));
    if (stored.headers.get('content-length') !== null) said.push('content-length: ' + stored.headers.get('content-length'));
    if (stored.headers.get('content-type') !== visit.type) said.push('lost its content type');
    if (await stored.clone().text() !== 'decoded ' + url) said.push('lost its body');
    if (said.length) problems.push(visit.why + ' (' + visit.key + ') was stored ' + said.join(', '));
  }
  assert.equal(problems.length, 0, report('A visit stored a copy the install would not have:', problems));
});
