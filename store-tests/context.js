/* ==========================================================================
   Zero Cost AI Dating — load the shipped store into Node

   The whole point of this suite is that it drives public/js/data-store.js
   itself. A test that re-implemented the transaction would pass while the
   file the browser loads was broken — the same false-green this project has
   had to fix twice already.

   data-store.js is a classic browser script: an IIFE that hangs ZC.store off
   `window`, and whose Firestore adapter reaches the database through
   `ZC.firebase.db` using the **compat** API shape (`db.collection(...)`,
   `db.runTransaction(...)`). So all this file does is arrange the four things
   the file expects to find and then `require` it, exactly the way
   tests/data-store.test.js does for demo mode:

     1. `window`, aliased to globalThis so the IIFE runs untouched;
     2. the real public/js/utils.js (its DOM access all lives inside functions
        the store never calls from Node);
     3. `ZC.config.mode = 'firebase'` and the plan limits canSpend reads;
     4. `ZC.firebase.db` — a compat Firestore pointed at the emulator.

   public/js/seed-data.js is loaded too, before the store, as every page loads
   it. It used to be left out on the grounds that it only feeds the demo
   adapter's seeding, which firebase mode never runs; that stopped being true
   when the projection began publishing only the interests in its vocabulary
   (`ZC.INTEREST_BY_SLUG`), which is what firestore.rules accepts there. Left
   out, the store would publish whatever the private profile held, and every
   spec would be evidence about a branch no page takes.

   The IIFE returns early if ZC.store already exists and `require` caches, so
   the store is loaded once per process and every spec shares it. Specs
   therefore use their own uids rather than assuming an empty database.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const harness = require('./harness');

const PUBLIC_JS = path.join(harness.ROOT, 'public', 'js');

/**
 * The compat SDK version the pages load from gstatic, read out of the deck's
 * own script tag so there is no second copy of the number to drift.
 * tests/static.test.js holds every page to the same three tags.
 * @returns {string|null} e.g. '10.12.2', or null when the tag is not found
 */
function shippedSdkVersion() {
  const html = fs.readFileSync(path.join(harness.ROOT, 'public', 'dashboard.html'), 'utf8');
  const tag = /https:\/\/www\.gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)\/firebase-firestore-compat\.js/.exec(html);
  return tag ? tag[1] : null;
}

/**
 * Load a module from one node_modules directory and nowhere else.
 * @param {string} root a node_modules directory, absolute or relative to the
 *   working directory
 * @param {string} name the module to load
 * @returns {Object|null} the module, or null when `root` does not hold it
 */
function loadFrom(root, name) {
  // createRequire throws on a relative path, and the catch below would report
  // that as the package not being there, so a relative root is taken against
  // the working directory first: the way Node takes a relative NODE_PATH.
  root = path.resolve(root);
  let resolved;
  try {
    resolved = Module.createRequire(path.join(root, 'noop.js')).resolve(name);
  } catch (err) {
    return null;
  }
  // Resolution also walks up from `root` and into NODE_PATH, so a directory
  // without the package would quietly hand back another install's copy —
  // measured: an empty ZC_STORE_SDK loaded NODE_PATH's 12.19.0. `resolve`
  // answers with the real path, so `root` is compared as one too.
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    return null;
  }
  if (path.relative(real, resolved).split(path.sep)[0] === '..') return null;
  return require(resolved);
}

/**
 * Load the compat SDK from outside the repository and register its Firestore
 * component. Both halves resolve through the same roots, so they are
 * guaranteed to be the same copy of @firebase/app-compat.
 *
 * Those roots are NODE_PATH's, unless ZC_STORE_SDK names a node_modules
 * directory of its own. It exists because one install cannot hold both SDKs
 * this suite needs: @firebase/rules-unit-testing peers with firebase ^12 for
 * the modular `firebase/firestore` run.js reads stored documents back through,
 * while the compat build the store is driven through has to be the one the
 * pages load (shippedSdkVersion). The two are not interchangeable: measured,
 * 12.18 and 12.19 keep a document in their memory cache after a read and the
 * pages' 10.12.2 does not, which let an offline-bump check pass here that
 * failed on the pages' version. So CI installs the pages' version apart and
 * points ZC_STORE_SDK at it, and run.js refuses a pinned SDK of any other
 * version (see sdkProblem).
 * @returns {Object|null} the `firebase` compat namespace, or null when the
 *   package is not installed
 */
function loadCompat() {
  const pinned = process.env.ZC_STORE_SDK;
  const load = pinned ? function (name) { return loadFrom(pinned, name); } : harness.loadOutside;
  const app = load('firebase/compat/app');
  if (!app) return null;
  // The compat bundles are transpiled ESM, so the namespace is under .default
  // in CommonJS.
  const firebase = app.default || app;
  // Required for the side effect: it is what puts .firestore() on the app.
  if (!load('firebase/compat/firestore')) return null;
  return typeof firebase.initializeApp === 'function' ? firebase : null;
}

/**
 * Why this run must not drive the store through the SDK it would load, or
 * null. Only a pinned SDK is held to the pages' version: ZC_STORE_SDK is a
 * statement that this run certifies what ships, and a pin that delivers some
 * other version would turn a green run back into the false one it replaced.
 * An unpinned run uses whatever NODE_PATH holds, and run.js says which.
 * @returns {string|null} a message for stderr, or null to go ahead
 */
function sdkProblem() {
  const pinned = process.env.ZC_STORE_SDK;
  if (!pinned) return null;
  // A relative pin is taken against this process's working directory, which
  // under rules-tests/emulate.js is the repository root rather than wherever
  // the shell was, so the message says which directory that came to.
  const named = 'ZC_STORE_SDK=' + pinned + (path.isAbsolute(pinned) ? '' : ' (' + path.resolve(pinned) + ')');
  const firebase = loadCompat();
  if (!firebase) {
    return named + ' holds no firebase compat SDK. Install the version the pages load:\n' +
      '  npm install --prefix <dir> firebase@' + shippedSdkVersion() + '   and set ZC_STORE_SDK=<dir>/node_modules';
  }
  if (firebase.SDK_VERSION !== shippedSdkVersion()) {
    return named + ' holds firebase ' + firebase.SDK_VERSION + ', but the pages load ' +
      shippedSdkVersion() + ' (public/dashboard.html). A pinned run has to drive the store through the\n' +
      'SDK that ships; install firebase@' + shippedSdkVersion() + ' there, or move the pages and CI together.';
  }
  return null;
}

/**
 * Build the browser-ish globals, install the emulator-backed Firestore and
 * evaluate the shipped store against it.
 * @returns {Object|null} the context specs run against, or null when either
 *   the compat SDK or FIRESTORE_EMULATOR_HOST is missing
 */
function createContext() {
  const address = harness.emulatorAddress();
  if (!address) return null;
  const firebase = loadCompat();
  if (!firebase) return null;

  // data-store.js addresses everything through `window.*`; aliasing window to
  // globalThis lets the browser IIFEs run untouched under Node.
  globalThis.window = globalThis;

  // ...and a localStorage shim, because "firebase mode never reaches one" stopped
  // being true. `touchActive`'s throttle keeps its last-write times in storage —
  // it has to, since every page in this app is its own document and an in-memory
  // map is empty again on every navigation. Without the shim the store falls back
  // to that in-memory copy and the suite exercises the browser-with-storage-
  // disabled path instead of the ordinary one. Same lesson as `globalThis.firebase`
  // one round ago: a harness that withholds a global chooses which branch runs.
  const cells = new Map();
  globalThis.localStorage = {
    getItem: function (k) { return cells.has(String(k)) ? cells.get(String(k)) : null; },
    setItem: function (k, v) { cells.set(String(k), String(v)); },
    removeItem: function (k) { cells.delete(String(k)); },
    clear: function () { cells.clear(); },
    key: function (i) { return Array.from(cells.keys())[i] || null; },
    get length() { return cells.size; }
  };

  // ...and `firebase` itself, which a page gets from its <script> tags. This is
  // not decoration: `fieldValue()` in the shipped store is guarded by
  // `typeof firebase === 'undefined'`, and without the global it returns null,
  // so `sendMessage` takes its read-modify-write fallback instead of the
  // `FieldValue.increment` the browser runs. A suite that loads the shipped file
  // and then starves it of a global is testing a branch the browser never takes
  // — the same false green this suite exists to avoid, arrived at from the other
  // side. `specs/13-messaging.store.js` asserts the increment path is the live
  // one rather than trusting this line.
  globalThis.firebase = firebase;

  // A named app, so nothing here can collide with an app the testing library
  // creates for its own contexts.
  const app = firebase.initializeApp({
    projectId: harness.PROJECT_ID,
    // The emulator never validates this, but the SDK insists on its presence.
    apiKey: 'fake-api-key-for-the-emulator'
  }, 'zc-store-suite');
  const db = firebase.firestore(app);
  db.useEmulator(address.host, address.port);

  require(path.join(PUBLIC_JS, 'utils.js'));
  require(path.join(PUBLIC_JS, 'seed-data.js'));

  const ZC = globalThis.window.ZC;
  // Mirrors what public/js/firebase-config.js publishes in firebase mode.
  ZC.config = {
    mode: 'firebase',
    limits: {
      free: { likesPerDay: 25, superLikesPerDay: 1, rewinds: 0, seeLikedYou: false, adaptiveWeights: false },
      premium: { likesPerDay: Infinity, superLikesPerDay: 5, rewinds: Infinity, seeLikedYou: true, adaptiveWeights: true }
    }
  };
  ZC.firebase = { db: db };

  require(path.join(PUBLIC_JS, 'data-store.js'));

  // A failed usage write is a console.warn and an optimistic return value by
  // design — which means a check that only looked at what bumpUsage *returned*
  // could pass while nothing had been stored. Every spec asserts against the
  // stored document instead, and captures the warnings so it can also say
  // whether the shipped code silently gave up.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = function () {
    warnings.push(Array.prototype.map.call(arguments, function (a) {
      return a && a.message ? a.message : String(a);
    }).join(' '));
  };

  return {
    firebase: firebase,
    db: db,
    ZC: ZC,
    store: ZC.store,
    /** Warnings captured since the last drain, newest last. */
    drainWarnings: function () { return warnings.splice(0, warnings.length); },
    /** Put console.warn back, so the runner's own output is not swallowed. */
    restoreConsole: function () { console.warn = realWarn; }
  };
}

module.exports = {
  createContext: createContext,
  sdkProblem: sdkProblem,
  shippedSdkVersion: shippedSdkVersion
};
