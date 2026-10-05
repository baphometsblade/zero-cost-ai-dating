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
 *   every cache write reject; `existing` cache names already on the origin
 * @returns {Object} the caches it left, the names it deleted, and `fire(type, event)`
 */
function runWorker(opts) {
  const o = opts || {};
  const listeners = {};
  const stores = new Map();
  (o.existing || []).forEach(function (name) { stores.set(name, new Map()); });
  const deleted = [];
  const origin = 'https://example.test';
  function keyOf(req) {
    return new URL(typeof req === 'string' ? req : req.url, origin + '/').href;
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
    location: new URL(origin + '/sw.js'),
    addEventListener: function (type, fn) { listeners[type] = fn; },
    skipWaiting: function () { return Promise.resolve(); },
    clients: { claim: function () { return Promise.resolve(); } }
  };
  const context = vm.createContext({
    self: self, caches: caches, Response: Response, URL: URL, Blob: Blob, Headers: Headers,
    fetch: function (req) { return Promise.resolve(o.fetch(typeof req === 'string' ? req : req.url)); }
  });
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), context, { filename: SW_PATH });
  return {
    stores: stores,
    deleted: deleted,
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
