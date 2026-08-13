/* ==========================================================================
   Zero Cost AI Dating — authentication tests (demo backend)
   Loads the real public/js/auth.js in Node, on top of the real utils, seed
   data and data store, and exercises the demo backend end to end: the
   credential vault, sign-up and sign-in, the session record, onChange and the
   three route guards. Nothing in auth.js is mocked — the harness only supplies
   the browser globals it reaches for (localStorage, location, document and
   window events), so what passes here is what runs in the browser.

   Two things are worth knowing about the harness:
     • auth.js runs its boot as a side effect of loading, so "reloading the
       page" is modelled by dropping ZC.auth plus the require cache entry and
       requiring the file again — see loadAuth().
     • Node 22 ships crypto.subtle, so the real SHA-256 path is the one under
       test; the documented weak fallback is covered separately by hiding
       window.crypto for one test.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

/* ------------------------------------------------------------------------
   Harness: the browser globals auth.js expects
   ------------------------------------------------------------------------ */

// A quota-free localStorage stand-in. `failWrites` lets one test simulate the
// storage-blocked browser auth.js apologises for.
const backing = new Map();
let failWrites = null;
const localStorageShim = {
  getItem: function (key) {
    return backing.has(String(key)) ? backing.get(String(key)) : null;
  },
  setItem: function (key, value) {
    if (failWrites && failWrites.test(String(key))) throw new Error('QuotaExceededError');
    backing.set(String(key), String(value));
  },
  removeItem: function (key) {
    backing.delete(String(key));
  },
  clear: function () {
    backing.clear();
  },
  key: function (index) {
    const keys = Array.from(backing.keys());
    return index >= 0 && index < keys.length ? keys[index] : null;
  },
  get length() {
    return backing.size;
  }
};

// The guards read pathname/search and leave through replace(); recording the
// calls is how a navigation is asserted.
const locationShim = {
  pathname: '/dashboard.html',
  search: '',
  replaced: [],
  replace: function (url) {
    this.replaced.push(String(url));
  }
};

// Section 12 of auth.js only wakes up on a document carrying [data-auth-page];
// a document without one exercises the "every other page pays nothing" branch.
const documentShim = {
  readyState: 'complete',
  querySelector: function () { return null; },
  addEventListener: function () { /* never reached: readyState is not 'loading' */ }
};

// window-level listeners, so the cross-tab 'storage' handler can be fired.
const windowListeners = {};

globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', { value: localStorageShim, configurable: true, writable: true });
Object.defineProperty(globalThis, 'location', { value: locationShim, configurable: true, writable: true });
globalThis.document = documentShim;
globalThis.addEventListener = function (type, cb) {
  windowListeners[type] = (windowListeners[type] || []).concat(cb);
};
globalThis.removeEventListener = function (type, cb) {
  windowListeners[type] = (windowListeners[type] || []).filter(function (fn) { return fn !== cb; });
};

// Load order mirrors the page: utils → seed data → config → store. auth.js
// itself is loaded per test by loadAuth().
require('../public/js/utils.js');
require('../public/js/seed-data.js');
window.ZC.config = {
  mode: 'demo',
  limits: {
    free: { likesPerDay: 25, superLikesPerDay: 1, rewinds: 0, seeLikedYou: false, adaptiveWeights: false },
    premium: { likesPerDay: Infinity, superLikesPerDay: 5, rewinds: Infinity, seeLikedYou: true, adaptiveWeights: true }
  }
};
require('../public/js/data-store.js');

const store = window.ZC.store;
const AUTH_PATH = require.resolve('../public/js/auth.js');
const SESSION_KEY = store.KEYS.session;
const CREDENTIALS_KEY = 'zc.demo.credentials';
const DEMO_UID = 'demo-you';

/* ------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------ */

/**
 * Load a fresh copy of auth.js, the way a page load would run it.
 * Its 8-second ready backstop is unref'd so it cannot hold the process open.
 * @returns {Object} the new ZC.auth
 */
function loadAuth() {
  delete require.cache[AUTH_PATH];
  delete window.ZC.auth;
  // Only the listener of the instance under test may see a storage event.
  windowListeners.storage = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function (fn, ms) {
    const timer = realSetTimeout(fn, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  };
  try {
    require('../public/js/auth.js');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return window.ZC.auth;
}

/**
 * Wipe storage, reseed the demo database and boot a fresh signed-out auth.
 * @returns {Promise<Object>} the booted ZC.auth
 */
async function resetWorld() {
  backing.clear();
  failWrites = null;
  locationShim.pathname = '/dashboard.html';
  locationShim.search = '';
  locationShim.replaced.length = 0;
  assert.equal(await store.seedDemo(false), true, 'a cleared world must reseed');
  const auth = loadAuth();
  await auth.ready;
  return auth;
}

/** Let queued microtasks and the odd timer callback run. */
function tick(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 10); });
}

/**
 * Run a guard that is expected to navigate. Those never resolve on purpose,
 * so race the promise against a short wait.
 * @param {Promise} promise the guard's return value
 * @returns {Promise<string>} 'pending' when it correctly never settled
 */
function navigates(promise) {
  return Promise.race([
    promise.then(function () { return 'resolved'; }),
    tick(25).then(function () { return 'pending'; })
  ]);
}

/** Run work with the console muted — for paths that warn on purpose. */
async function quiet(fn) {
  const warn = console.warn;
  const error = console.error;
  console.warn = function () { /* expected */ };
  console.error = function () { /* expected */ };
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
}

/** Read one storage entry as parsed JSON (null when absent). */
function raw(key) {
  const value = backing.get(key);
  return value === undefined ? null : JSON.parse(value);
}

/** The stored credential record for an email, or undefined. */
function credential(email) {
  return (raw(CREDENTIALS_KEY) || {})[email];
}

/** SHA-256 of salt+password, hex — the hash auth.js must have produced. */
function sha256Hex(salt, password) {
  return nodeCrypto.createHash('sha256').update(String(salt) + String(password)).digest('hex');
}

/** Fire the window 'storage' event the way another tab would. */
function fireStorage(key) {
  (windowListeners.storage || []).forEach(function (cb) { cb({ key: key }); });
}

/* ------------------------------------------------------------------------
   1. Backend selection and the first auth state
   ------------------------------------------------------------------------ */

test('a clean world boots into the demo backend, signed out, and settles ready', async function () {
  const auth = await resetWorld();
  assert.equal(auth.mode, 'demo', 'no Firebase config means the demo backend');
  assert.equal(await auth.ready, null, 'ready resolves with the doc, which is nothing yet');
  assert.equal(auth.current, null);
  assert.equal(auth.doc, null);
  assert.equal(backing.has(SESSION_KEY), false, 'no session was invented');
});

/* ------------------------------------------------------------------------
   2. Sign-up
   ------------------------------------------------------------------------ */

test('signUp mints a local account, a credential record, a UserDoc and a session', async function () {
  const auth = await resetWorld();
  const result = await auth.signUp('  Alice@Example.COM ', 'correct horse', '  Alice  ');
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);

  // The uid is namespaced so it can never collide with a bundled seed profile.
  const uid = result.user.uid;
  assert.ok(/^local-/.test(uid), 'demo accounts get a local- uid');

  // The vault key is the trimmed, lowercased address — and so is the doc.
  const record = credential('alice@example.com');
  assert.ok(record, 'the credential record is keyed by the normalised email');
  assert.equal(record.uid, uid);
  assert.equal(result.user.email, 'alice@example.com');
  assert.equal(result.user.displayName, 'Alice', 'the display name is trimmed');
  assert.equal(result.user.profileComplete, false, 'a new account still owes us onboarding');

  // The UserDoc really landed in the store, not just in memory.
  const stored = await store.getUser(uid);
  assert.equal(stored.email, 'alice@example.com');
  assert.equal(stored.displayName, 'Alice');

  // The live surface and the session record agree with each other.
  assert.deepEqual(auth.current, { uid: uid, email: 'alice@example.com', displayName: 'Alice' });
  assert.equal(auth.doc.uid, uid);
  const session = raw(SESSION_KEY);
  assert.equal(session.uid, uid);
  assert.equal(session.email, 'alice@example.com');
  assert.ok(isFinite(Date.parse(session.at)), 'the session is stamped');
});

test('signUp validates the email, the password length and the display name', async function () {
  const auth = await resetWorld();

  assert.equal((await auth.signUp('not-an-email', 'longenough', 'Alice')).error,
    'That email address does not look right.');
  assert.equal((await auth.signUp('alice@example', 'longenough', 'Alice')).error,
    'That email address does not look right.', 'a missing TLD is not an address');
  assert.equal((await auth.signUp('alice@example.com', 'sevench', 'Alice')).error,
    'Please pick a password with at least 8 characters.');
  assert.equal((await auth.signUp('alice@example.com', '', 'Alice')).error,
    'Please pick a password with at least 8 characters.');
  assert.equal((await auth.signUp('alice@example.com', 'longenough', 'A')).error,
    'Please use a display name between 2 and 40 characters.');
  assert.equal((await auth.signUp('alice@example.com', 'longenough', 'x'.repeat(41))).error,
    'Please use a display name between 2 and 40 characters.');

  // An 8-character password is exactly on the allowed side of the boundary.
  assert.equal((await auth.signUp('alice@example.com', 'eightchr', 'Al')).ok, true);

  // Nothing that failed validation left a trace.
  assert.deepEqual(Object.keys(raw(CREDENTIALS_KEY)), ['alice@example.com']);
  assert.equal(auth.current.email, 'alice@example.com');
});

test('signUp rejects a duplicate email case-insensitively and keeps the first account', async function () {
  const auth = await resetWorld();
  const first = await auth.signUp('alice@example.com', 'correct horse', 'Alice');
  await auth.signOut();

  const again = await auth.signUp('  ALICE@Example.com  ', 'a different password', 'Impostor');
  assert.equal(again.ok, false);
  assert.equal(again.error, 'That email already has an account. Try signing in instead.');
  assert.equal(again.user, undefined);

  // The vault still holds exactly one record, still pointing at Alice.
  const map = raw(CREDENTIALS_KEY);
  assert.equal(Object.keys(map).length, 1);
  assert.equal(map['alice@example.com'].uid, first.user.uid);
  assert.equal(auth.current, null, 'a rejected sign-up signs nobody in');

  // And the original password still works.
  assert.equal((await auth.signIn('alice@example.com', 'correct horse')).ok, true);
});

test('signUp reports a browser that refuses to store the account, and creates nothing', async function () {
  const auth = await resetWorld();
  failWrites = /credentials/;
  const result = await quiet(function () { return auth.signUp('bob@example.com', 'longenough1', 'Bob'); });
  failWrites = null;

  assert.equal(result.ok, false);
  assert.equal(result.error,
    'This browser refused to save the account. Check that storage is not full or blocked.');
  assert.equal(backing.has(CREDENTIALS_KEY), false, 'nothing was written');
  assert.equal(backing.has(SESSION_KEY), false, 'and nobody was signed in');
  assert.equal(auth.current, null);
});

/* ------------------------------------------------------------------------
   3. The demo credential vault
   ------------------------------------------------------------------------ */

test('passwords are stored as salted SHA-256 and never in plain text', async function () {
  const auth = await resetWorld();
  await auth.signUp('alice@example.com', 'correct horse battery', 'Alice');
  const record = credential('alice@example.com');

  // Real crypto.subtle output: 16 salt bytes and a 32-byte digest, both hex.
  assert.match(record.salt, /^[0-9a-f]{32}$/);
  assert.match(record.hash, /^[0-9a-f]{64}$/);
  assert.equal(record.hash, sha256Hex(record.salt, 'correct horse battery'),
    'the stored hash is SHA-256(salt + password) — the subtle path really ran');

  // The record carries nothing else, and the plaintext appears nowhere in
  // the whole demo database.
  assert.deepEqual(Object.keys(record).sort(), ['hash', 'salt', 'uid']);
  const everything = Array.from(backing.values()).join('\n');
  assert.equal(everything.indexOf('correct horse battery'), -1, 'no plaintext password anywhere');
});

test('two accounts sharing a password get different salts and different hashes', async function () {
  const auth = await resetWorld();
  await auth.signUp('alice@example.com', 'the same password', 'Alice');
  await auth.signOut();
  await auth.signUp('bob@example.com', 'the same password', 'Bob');

  const alice = credential('alice@example.com');
  const bob = credential('bob@example.com');
  assert.notEqual(alice.salt, bob.salt, 'each account gets a fresh salt');
  assert.notEqual(alice.hash, bob.hash, 'so identical passwords do not collide');
  assert.notEqual(alice.uid, bob.uid);
  assert.equal(bob.hash, sha256Hex(bob.salt, 'the same password'));
});

test('without crypto.subtle the documented weak fallback still round-trips', async function () {
  const auth = await resetWorld();
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  // A non-secure origin (file://, plain http) has no crypto at all.
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try {
    await quiet(function () { return auth.signUp('weak@example.com', 'longenough1', 'Weak'); });
    const record = credential('weak@example.com');
    assert.match(record.hash, /^weak-[0-9a-f]+$/, 'the fallback hash is marked as such');
    assert.match(record.salt, /^[0-9a-f]{32}$/, 'Math.random still produces a full-width salt');
    assert.equal(record.hash.indexOf('longenough1'), -1, 'still no plaintext');

    await auth.signOut();
    assert.equal((await auth.signIn('weak@example.com', 'longenough1')).ok, true, 'the fallback verifies');
    assert.equal((await auth.signIn('weak@example.com', 'longenough2')).ok, false, 'and still rejects');
  } finally {
    Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  }
  assert.equal(typeof globalThis.crypto.subtle, 'object', 'the real crypto is back for later tests');
});

/* ------------------------------------------------------------------------
   4. Sign-in
   ------------------------------------------------------------------------ */

test('signIn accepts the right password, normalising the address on the way in', async function () {
  const auth = await resetWorld();
  const created = await auth.signUp('alice@example.com', 'correct horse', 'Alice');
  await auth.signOut();

  const result = await auth.signIn('  ALICE@Example.COM  ', 'correct horse');
  assert.equal(result.ok, true);
  assert.equal(result.user.uid, created.user.uid);
  assert.equal(result.user.displayName, 'Alice', 'the existing doc keeps its name');
  assert.equal(auth.current.uid, created.user.uid);
  assert.equal(auth.doc.uid, created.user.uid);
  assert.equal(raw(SESSION_KEY).uid, created.user.uid, 'the session was rewritten');
  assert.equal(raw(SESSION_KEY).displayName, 'Alice');
});

test('signIn fails identically for a wrong password and an unknown email, leaking no codes', async function () {
  const auth = await resetWorld();
  await auth.signUp('alice@example.com', 'correct horse', 'Alice');
  await auth.signOut();

  const wrong = await auth.signIn('alice@example.com', 'correct hoarse');
  const unknown = await auth.signIn('ghost@example.com', 'correct horse');
  assert.equal(wrong.ok, false);
  assert.equal(unknown.ok, false);
  assert.equal(wrong.error, 'That email and password do not match an account.');
  assert.equal(unknown.error, wrong.error, 'the two are indistinguishable, so nothing is enumerable');
  assert.equal(wrong.error.indexOf('auth/'), -1, 'no raw Firebase code reaches the screen');
  assert.equal(wrong.error.indexOf('Firebase'), -1);
  assert.equal(wrong.user, undefined);
  assert.equal(auth.current, null, 'a failed sign-in signs nobody in');
  assert.equal(backing.has(SESSION_KEY), false, 'and writes no session');

  // The password is case-sensitive, as the page copy promises.
  assert.equal((await auth.signIn('alice@example.com', 'Correct Horse')).ok, false);
});

test('signIn checks its inputs before touching the vault', async function () {
  const auth = await resetWorld();
  assert.equal((await auth.signIn('nonsense', 'correct horse')).error,
    'That email address does not look right.');
  assert.equal((await auth.signIn('alice@example.com', '')).error, 'Please enter your password.');
  assert.equal((await auth.signIn('alice@example.com', null)).error, 'Please enter your password.');
  assert.equal(auth.current, null);
});

/* ------------------------------------------------------------------------
   5. Sign-out
   ------------------------------------------------------------------------ */

test('signOut clears the session, the cached doc and the identity', async function () {
  const auth = await resetWorld();
  await auth.signUp('alice@example.com', 'correct horse', 'Alice');
  assert.ok(backing.has(SESSION_KEY));

  const result = await auth.signOut();
  assert.deepEqual(result, { ok: true });
  assert.equal(auth.current, null);
  assert.equal(auth.doc, null);
  assert.equal(backing.has(SESSION_KEY), false, 'the session record is gone');
  assert.ok(backing.has(CREDENTIALS_KEY), 'but the account itself survives a sign-out');

  // Signing out twice is a clean no-op, not an error.
  assert.deepEqual(await auth.signOut(), { ok: true });
  assert.equal(auth.current, null);
});

/* ------------------------------------------------------------------------
   6. Session persistence, reloads and other tabs
   ------------------------------------------------------------------------ */

test('a reload adopts the stored session and re-resolves ready with the doc', async function () {
  const auth = await resetWorld();
  const created = await auth.signUp('alice@example.com', 'correct horse', 'Alice');

  // "Reload the page": a brand-new module instance reading the same storage.
  const reloaded = loadAuth();
  const doc = await reloaded.ready;
  assert.notEqual(reloaded, auth, 'this really is a second instance');
  assert.equal(doc.uid, created.user.uid, 'ready resolves with the restored doc');
  assert.equal(reloaded.current.uid, created.user.uid);
  assert.equal(reloaded.current.email, 'alice@example.com');
  assert.equal(reloaded.doc.displayName, 'Alice');

  // A bare-string session (the older shape) is still understood.
  backing.set(SESSION_KEY, JSON.stringify(DEMO_UID));
  const legacy = loadAuth();
  await legacy.ready;
  assert.equal(legacy.current.uid, DEMO_UID, 'a string session names the uid');
  assert.equal(legacy.doc.displayName, 'You');
});

test('a session pointing at a deleted account is dropped, not adopted', async function () {
  const auth = await resetWorld();
  await auth.signInAsDemoUser();
  assert.equal(raw(SESSION_KEY).uid, DEMO_UID);

  // Another page (or another tab) deleted the account under us.
  await store.deleteAccountData(DEMO_UID);
  const reloaded = loadAuth();
  assert.equal(await reloaded.ready, null, 'ready settles signed out');
  assert.equal(reloaded.current, null);
  assert.equal(backing.has(SESSION_KEY), false, 'the stale session was cleared');

  // A corrupt session value is ignored the same way.
  backing.set(SESSION_KEY, 'not json{');
  const afterCorrupt = await quiet(async function () {
    const instance = loadAuth();
    await instance.ready;
    return instance;
  });
  assert.equal(afterCorrupt.current, null);
});

test('a storage event from another tab signs out, switches account, or is ignored', async function () {
  const auth = await resetWorld();
  await auth.signInAsDemoUser();

  // Another tab signed out: the session key is gone.
  backing.delete(SESSION_KEY);
  fireStorage(SESSION_KEY);
  assert.equal(auth.current, null, 'sign-out in one tab is sign-out in all of them');

  // Another tab signed in as somebody else.
  await store.createUser('other-tab', { email: 'other@example.com', displayName: 'Other' });
  backing.set(SESSION_KEY, JSON.stringify({ uid: 'other-tab' }));
  fireStorage(SESSION_KEY);
  await tick();
  assert.equal(auth.current.uid, 'other-tab');
  assert.equal(auth.doc.displayName, 'Other');

  // An unrelated key changing is none of auth.js's business.
  backing.set('zc.demo.users', backing.get('zc.demo.users'));
  fireStorage('zc.demo.users');
  assert.equal(auth.current.uid, 'other-tab', 'still signed in');
});

test('refresh re-reads the document for the signed-in account only', async function () {
  const auth = await resetWorld();
  await auth.signInAsDemoUser();
  assert.equal(auth.doc.plan, 'free');

  // Another page upgraded the plan behind our back.
  await store.updateUser(DEMO_UID, { plan: 'premium' });
  assert.equal(auth.doc.plan, 'free', 'the cached doc is stale until asked');
  const refreshed = await auth.refresh();
  assert.equal(refreshed.plan, 'premium');
  assert.equal(auth.doc.plan, 'premium', 'the cache was replaced');

  await auth.signOut();
  assert.equal(await auth.refresh(), null, 'nothing to refresh when signed out');
});

/* ------------------------------------------------------------------------
   7. onChange subscribers
   ------------------------------------------------------------------------ */

test('onChange fires on the settled state, on sign-in and on sign-out, and unsubscribes', async function () {
  const auth = await resetWorld();
  const seen = [];
  const off = auth.onChange(function (doc) { seen.push(doc ? doc.uid : null); });

  // The first call reports the already-settled state, asynchronously.
  await tick();
  assert.deepEqual(seen, [null], 'a subscriber hears the current state once');

  await auth.signInAsDemoUser();
  assert.deepEqual(seen, [null, DEMO_UID], 'sign-in notifies');

  await auth.signOut();
  assert.deepEqual(seen, [null, DEMO_UID, null], 'sign-out notifies');

  off();
  await auth.signInAsDemoUser();
  assert.deepEqual(seen, [null, DEMO_UID, null], 'an unsubscribed listener hears nothing more');

  // Unsubscribing twice, or subscribing a non-function, must not throw.
  off();
  assert.equal(typeof auth.onChange(null), 'function', 'a non-function still gets a no-op unsubscribe');
  auth.onChange(null)();
});

test('one listener that throws never robs the others of their notification', async function () {
  const auth = await resetWorld();
  const order = [];
  const offA = auth.onChange(function () { order.push('a'); throw new Error('listener boom'); });
  const offB = auth.onChange(function () { order.push('b'); });
  await quiet(function () { return tick(); });

  order.length = 0;
  await quiet(function () { return auth.signInAsDemoUser(); });
  assert.deepEqual(order, ['a', 'b'], 'the second listener still ran');
  assert.equal(auth.current.uid, DEMO_UID, 'and the sign-in itself succeeded');
  offA();
  offB();
});

/* ------------------------------------------------------------------------
   8. The bundled demo account
   ------------------------------------------------------------------------ */

test('signInAsDemoUser seeds the database and lands on the bundled profile', async function () {
  backing.clear();
  failWrites = null;
  locationShim.replaced.length = 0;
  const auth = loadAuth();
  await auth.ready;
  assert.equal(backing.size, 0, 'nothing is stored before the demo button is pressed');

  const result = await auth.signInAsDemoUser();
  assert.equal(result.ok, true);
  assert.equal(result.user.uid, DEMO_UID);
  assert.equal(result.user.displayName, 'You');
  assert.equal(result.user.profileComplete, true, 'the bundled profile is ready to swipe');
  assert.equal(Object.keys(raw('zc.demo.users')).length, 32, 'the whole cast was seeded');
  assert.equal(auth.current.uid, DEMO_UID);
  assert.equal(raw(SESSION_KEY).uid, DEMO_UID);
  assert.equal(raw(SESSION_KEY).email, 'you@example.com');
  assert.equal(credential('you@example.com'), undefined, 'the demo account has no password to store');
});

test('signInAsDemoUser recreates a blank account when demo-you has been deleted', async function () {
  const auth = await resetWorld();
  await store.deleteAccountData(DEMO_UID);
  assert.equal(await store.getUser(DEMO_UID), null);

  // The seed flag is still set, so seedDemo(false) does nothing here — the
  // account has to be rebuilt from scratch.
  const result = await auth.signInAsDemoUser();
  assert.equal(result.ok, true);
  assert.equal(result.user.uid, DEMO_UID);
  assert.equal(result.user.email, 'you@example.com');
  assert.equal(result.user.displayName, 'You');
  assert.equal(result.user.profileComplete, false, 'a rebuilt demo account starts empty');
  assert.equal(auth.current.uid, DEMO_UID);
  assert.equal(raw(SESSION_KEY).uid, DEMO_UID);
});

/* ------------------------------------------------------------------------
   9. Route guards
   ------------------------------------------------------------------------ */

test('requireAuth passes a signed-in visitor through untouched', async function () {
  const auth = await resetWorld();
  await auth.signInAsDemoUser();
  const doc = await auth.requireAuth();
  assert.equal(doc.uid, DEMO_UID);
  assert.deepEqual(locationShim.replaced, [], 'no redirect for someone who belongs here');
});

test('requireAuth sends a signed-out visitor to auth.html with a ?next= back here', async function () {
  const auth = await resetWorld();
  locationShim.pathname = '/matches.html';
  locationShim.search = '?tab=1&next=%2Falready-here';

  assert.equal(await navigates(auth.requireAuth()), 'pending', 'the guard never resolves once it navigates');
  assert.deepEqual(locationShim.replaced, ['auth.html?next=%2Fmatches.html%3Ftab%3D1'],
    'the current URL comes along, and an inherited next= is dropped so redirects cannot nest');

  // A custom destination keeps the same treatment, merging into its query.
  locationShim.replaced.length = 0;
  locationShim.pathname = '/settings.html';
  locationShim.search = '';
  await navigates(auth.requireAuth({ redirect: 'welcome.html?a=1' }));
  assert.deepEqual(locationShim.replaced, ['welcome.html?a=1&next=%2Fsettings.html']);
});

test('requireGuest lets signed-out visitors stay and sends signed-in ones on', async function () {
  const auth = await resetWorld();
  locationShim.pathname = '/auth.html';

  assert.equal(await auth.requireGuest(), null, 'a signed-out visitor may stay');
  assert.deepEqual(locationShim.replaced, []);

  await auth.signInAsDemoUser();
  assert.equal(await navigates(auth.requireGuest()), 'pending');
  assert.deepEqual(locationShim.replaced, ['dashboard.html'], 'the default destination is the deck');

  // An honest ?next= is obeyed, in either spelling.
  locationShim.replaced.length = 0;
  locationShim.search = '?next=matches.html';
  await navigates(auth.requireGuest());
  assert.deepEqual(locationShim.replaced, ['matches.html']);

  locationShim.replaced.length = 0;
  locationShim.search = '?next=%2Fsettings';
  await navigates(auth.requireGuest());
  assert.deepEqual(locationShim.replaced, ['/settings']);
});

test('requireGuest refuses an off-site ?next= and will not loop back to this page', async function () {
  const auth = await resetWorld();
  await auth.signInAsDemoUser();
  locationShim.pathname = '/auth.html';

  const hostile = [
    '//evil.example/x',            // protocol-relative
    'https://evil.example/x',      // absolute, other origin
    'javascript:alert(1)',         // a scheme, not a path
    '\\\\evil.example',            // backslashes some parsers read as slashes
    '/\\evil.example',             // mixed slash trick
    ''                             // empty
  ];
  for (let i = 0; i < hostile.length; i += 1) {
    locationShim.replaced.length = 0;
    locationShim.search = '?next=' + encodeURIComponent(hostile[i]);
    await navigates(auth.requireGuest());
    assert.deepEqual(locationShim.replaced, ['dashboard.html'],
      JSON.stringify(hostile[i]) + ' must fall back to the default destination');
  }

  // A ?next= naming the page we are already on would be a redirect loop; both
  // spellings of it are ignored in favour of the fallback.
  locationShim.replaced.length = 0;
  locationShim.search = '?next=auth.html';
  await navigates(auth.requireGuest());
  assert.deepEqual(locationShim.replaced, ['dashboard.html']);

  locationShim.replaced.length = 0;
  locationShim.search = '?next=%2Fauth%3Fmode%3Dsignup';
  await navigates(auth.requireGuest());
  assert.deepEqual(locationShim.replaced, ['dashboard.html'], 'the suffix-less spelling loops too');
});

test('requireProfile insists on onboarding, and defers to requireAuth when signed out', async function () {
  const auth = await resetWorld();
  locationShim.pathname = '/dashboard.html';

  // Signed out: only the sign-in redirect happens — the profile page is never
  // offered to someone who has no account.
  assert.equal(await navigates(auth.requireProfile()), 'pending');
  assert.deepEqual(locationShim.replaced, ['auth.html?next=%2Fdashboard.html']);

  // Signed in with a finished profile: straight through.
  locationShim.replaced.length = 0;
  await auth.signInAsDemoUser();
  const doc = await auth.requireProfile();
  assert.equal(doc.uid, DEMO_UID);
  assert.deepEqual(locationShim.replaced, []);

  // Signed in without one: off to onboarding.
  await store.updateUser(DEMO_UID, { profileComplete: false });
  await auth.refresh();
  assert.equal(await navigates(auth.requireProfile()), 'pending');
  assert.deepEqual(locationShim.replaced, ['profile.html?onboarding=1']);
});

/* ------------------------------------------------------------------------
   10. Error humanising

   Every failure the API reports goes through humanError(). Making the store
   throw during signInAsDemoUser is the honest way to drive each code through
   the real mapping, exactly as a Firebase rejection would.
   ------------------------------------------------------------------------ */

test('every mapped Firebase code becomes a sentence, and nothing else leaks', async function () {
  const auth = await resetWorld();
  const expected = {
    'auth/email-already-in-use': 'That email already has an account. Try signing in instead.',
    'auth/invalid-email': 'That email address does not look right.',
    'auth/invalid-credential': 'That email and password do not match an account.',
    'auth/wrong-password': 'That email and password do not match an account.',
    'auth/user-not-found': 'That email and password do not match an account.',
    'auth/weak-password': 'Please pick a password with at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts from this device. Wait a minute, then try again.',
    'auth/network-request-failed': 'The network did not answer. Check your connection and try again.',
    'auth/user-disabled': 'That account has been disabled.',
    'auth/operation-not-allowed': 'This project has not switched that sign-in method on yet.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
    'auth/popup-closed-by-user': 'The Google window closed before sign-in finished.',
    'auth/cancelled-popup-request': 'Only one Google window at a time. Try again.',
    'auth/unauthorized-domain': 'This address is not on the Firebase project list of authorised domains.',
    'auth/requires-recent-login': 'Please sign in again to finish that.',
    'auth/internal-error': 'Sign-in failed unexpectedly. Please try again.'
  };

  const realGetUser = store.getUser;
  try {
    const codes = Object.keys(expected);
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      store.getUser = async function () {
        const err = new Error('Firebase: Error (' + code + ').');
        err.code = code;
        throw err;
      };
      const result = await auth.signInAsDemoUser();
      assert.equal(result.ok, false, code + ' fails');
      assert.equal(result.error, expected[code], code + ' has its own sentence');
      assert.equal(result.error.indexOf('auth/'), -1, code + ' never shows the raw code');
    }
  } finally {
    store.getUser = realGetUser;
  }
});

test('unmapped failures fall back safely without exposing internals', async function () {
  const auth = await resetWorld();
  const realGetUser = store.getUser;

  /** Make the next demo sign-in fail with `thrown`, then report the message. */
  async function failWith(thrown) {
    store.getUser = async function () { throw thrown; };
    const result = await quiet(function () { return auth.signInAsDemoUser(); });
    assert.equal(result.ok, false);
    return result.error;
  }

  try {
    const unmapped = new Error('Firebase: Error (auth/quota-exceeded).');
    unmapped.code = 'auth/quota-exceeded';
    assert.equal(await failWith(unmapped), 'Something went wrong. Please try again.',
      'an unknown code becomes the generic apology');

    assert.equal(await failWith(new Error('Could not reach the database.')), 'Could not reach the database.',
      'a plain message is already human enough to show');
    assert.equal(await failWith(new Error('Firebase: Error (auth/nope).')),
      'Something went wrong. Please try again.', 'a code hiding in the message text is not shown');
    assert.equal(await failWith('The disk is on fire.'), 'The disk is on fire.', 'a thrown string is passed through');
    assert.equal(await failWith(null), 'Something went wrong. Please try again.');
    assert.equal(await failWith(undefined), 'Something went wrong. Please try again.');
  } finally {
    store.getUser = realGetUser;
  }

  // The surface recovered: a normal demo sign-in still works afterwards.
  assert.equal((await auth.signInAsDemoUser()).ok, true);
});

/* ------------------------------------------------------------------------
   11. Backend-specific refusals
   ------------------------------------------------------------------------ */

test('the demo backend declines Google sign-in and password resets, helpfully', async function () {
  const auth = await resetWorld();
  const google = await auth.signInWithGoogle();
  assert.equal(google.ok, false);
  assert.equal(google.error,
    'Google sign-in needs a Firebase project. In demo mode, create a local account or use the demo account.');
  assert.equal(auth.current, null, 'and nobody was signed in by the refusal');

  const reset = await auth.resetPassword('alice@example.com');
  assert.equal(reset.ok, false);
  assert.equal(reset.error,
    'Demo mode cannot send email: accounts live only in this browser. Create a new account, or use the demo account.');

  // The address is still validated first, whichever backend is live.
  assert.equal((await auth.resetPassword('not-an-email')).error, 'That email address does not look right.');
});
