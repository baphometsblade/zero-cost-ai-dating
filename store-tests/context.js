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

   public/js/seed-data.js is deliberately *not* loaded: it only feeds the demo
   adapter's seeding, which firebase mode never runs.

   The IIFE returns early if ZC.store already exists and `require` caches, so
   the store is loaded once per process and every spec shares it. Specs
   therefore use their own uids rather than assuming an empty database.
   ========================================================================== */
'use strict';

const path = require('path');
const harness = require('./harness');

const PUBLIC_JS = path.join(harness.ROOT, 'public', 'js');

/**
 * Load the compat SDK from outside the repository and register its Firestore
 * component. Both halves resolve through the same NODE_PATH roots, so they
 * are guaranteed to be the same copy of @firebase/app-compat.
 * @returns {Object|null} the `firebase` compat namespace, or null when the
 *   package is not installed
 */
function loadCompat() {
  const app = harness.loadOutside('firebase/compat/app');
  if (!app) return null;
  // The compat bundles are transpiled ESM, so the namespace is under .default
  // in CommonJS.
  const firebase = app.default || app;
  // Required for the side effect: it is what puts .firestore() on the app.
  if (!harness.loadOutside('firebase/compat/firestore')) return null;
  return typeof firebase.initializeApp === 'function' ? firebase : null;
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
  // globalThis lets the browser IIFEs run untouched under Node. No
  // localStorage shim is needed — every access to it in the store is inside a
  // try/catch, and firebase mode never reaches one.
  globalThis.window = globalThis;

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

module.exports = { createContext: createContext };
