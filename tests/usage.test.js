/* ==========================================================================
   Zero Cost AI Dating — daily usage counter tests
   Two layers, both against the real public/js/data-store.js. First the pure
   decision `nextUsage(current, field, amount, today)` — no storage, no clock,
   so every roll-over and every piece of corrupt input can be stated exactly.
   Then the demo adapter through the facade, on the same Map-backed
   localStorage shim tests/data-store.test.js uses, to prove the decision is
   actually persisted and that canSpend agrees with it.

   The Firestore half of this (a transaction, N concurrent bumps, the counter
   landing on exactly N) needs a live database and lives in store-tests/ — this
   file stays browser-free and emulator-free so `npm test` does too.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------------
   Harness: the browser globals data-store.js expects
   ------------------------------------------------------------------------ */

const backing = new Map();
const localStorageShim = {
  getItem: function (key) {
    return backing.has(String(key)) ? backing.get(String(key)) : null;
  },
  setItem: function (key, value) {
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

globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageShim,
  configurable: true,
  writable: true
});

// Load order mirrors the page: utils → seed data → config → store.
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
const util = window.ZC.util;
const nextUsage = store._internal.nextUsage;
const KEYS = store.KEYS;

/* ------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------ */

/** Empty the shim and create one account to bump. */
async function freshUser(uid, partial) {
  backing.clear();
  return store.createUser(uid, partial || {});
}

/** Read one storage entry as parsed JSON (null when absent). */
function raw(key) {
  const value = backing.get(key);
  return value === undefined ? null : JSON.parse(value);
}

/** The stored usage record, straight out of storage. */
function storedUsage(uid) {
  const users = raw(KEYS.users) || {};
  return users[uid] ? users[uid].usage : null;
}

/** Yesterday's day key, built the way util.todayKey builds today's. */
function yesterdayKey() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return util.todayKey(d);
}

/** ISO stamps carry milliseconds; a tiny sleep makes a rewrite visible. */
function tick(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 5); });
}

// Two fixed days, so the pure tests never consult a clock.
const DAY = '2026-03-01';
const PRIOR = '2026-02-28';

/* ------------------------------------------------------------------------
   1. nextUsage — the pure decision
   ------------------------------------------------------------------------ */

test('nextUsage moves one counter of the current day and defaults the amount to 1', function () {
  const current = { date: DAY, likes: 4, superLikes: 1, rewinds: 0 };

  assert.deepEqual(nextUsage(current, 'likes', 2, DAY), { date: DAY, likes: 6, superLikes: 1, rewinds: 0 });
  assert.deepEqual(nextUsage(current, 'likes', undefined, DAY), { date: DAY, likes: 5, superLikes: 1, rewinds: 0 });
  assert.deepEqual(nextUsage(current, 'superLikes', undefined, DAY), { date: DAY, likes: 4, superLikes: 2, rewinds: 0 });
  assert.deepEqual(nextUsage(current, 'rewinds', 3, DAY), { date: DAY, likes: 4, superLikes: 1, rewinds: 3 });

  // An amount that is not a number is worth nothing, never NaN.
  assert.deepEqual(nextUsage(current, 'likes', 'lots', DAY), { date: DAY, likes: 4, superLikes: 1, rewinds: 0 });
  assert.deepEqual(nextUsage(current, 'likes', null, DAY), { date: DAY, likes: 4, superLikes: 1, rewinds: 0 });
});

test('nextUsage rolls a stale day over to zeros before the amount lands', function () {
  const spent = { date: PRIOR, likes: 25, superLikes: 1, rewinds: 3 };

  // Yesterday's 25 likes do not survive into today's first like.
  assert.deepEqual(nextUsage(spent, 'likes', 1, DAY), { date: DAY, likes: 1, superLikes: 0, rewinds: 0 });
  assert.deepEqual(nextUsage(spent, 'superLikes', 1, DAY), { date: DAY, likes: 0, superLikes: 1, rewinds: 0 });

  // No field and no amount: the roll-over on its own, which is the shape
  // getUsage persists when it finds a stale date.
  assert.deepEqual(nextUsage(spent, null, 0, DAY), { date: DAY, likes: 0, superLikes: 0, rewinds: 0 });

  // A day that has not turned over yet leaves everything where it is.
  assert.deepEqual(nextUsage(spent, null, 0, PRIOR), spent);
});

test('nextUsage leaves the counters alone for a field it does not know', function () {
  const current = { date: DAY, likes: 4, superLikes: 1, rewinds: 0 };

  ['bogus', 'plan', '', null, undefined, 0].forEach(function (field) {
    assert.deepEqual(nextUsage(current, field, 5, DAY), current, String(field) + ' is not a counter');
  });

  // Inherited names are not fields either — membership is an own-property test.
  assert.deepEqual(nextUsage(current, 'constructor', 5, DAY), current);
  assert.deepEqual(nextUsage(current, 'hasOwnProperty', 5, DAY), current);

  // Unknown field, stale day: the roll-over still happens.
  assert.deepEqual(nextUsage({ date: PRIOR, likes: 9, superLikes: 0, rewinds: 0 }, 'bogus', 5, DAY),
    { date: DAY, likes: 0, superLikes: 0, rewinds: 0 });
});

test('nextUsage tolerates a missing or corrupt record', function () {
  const first = { date: DAY, likes: 1, superLikes: 0, rewinds: 0 };

  [null, undefined, {}, [], 'nonsense', 42, true].forEach(function (junk) {
    assert.deepEqual(nextUsage(junk, 'likes', 1, DAY), first, 'recovers from ' + JSON.stringify(junk));
  });

  // Unusable counters read as zero rather than poisoning the record with NaN.
  assert.deepEqual(nextUsage({ date: DAY, likes: 'many', superLikes: null, rewinds: undefined }, 'likes', 1, DAY), first);

  // A record already dated today with negative counters is repaired on the way through.
  assert.deepEqual(nextUsage({ date: DAY, likes: -5, superLikes: -1, rewinds: -2 }, 'likes', 1, DAY), first);
});

test('nextUsage takes the day it is handed, even for a record with no usable date', function () {
  // Every junk fixture above normalises to zeros, so it answers the same
  // whichever day a dateless record is filed under — which is exactly why they
  // could not see this. A dateless record *carrying counters* can tell the
  // difference: filing it under the clock's today rather than the day the
  // caller named made the same arguments answer differently tomorrow, and let
  // a retried transaction disagree with its own first attempt.
  const dateless = { likes: 5, superLikes: 2, rewinds: 1 };

  assert.deepEqual(nextUsage(dateless, 'likes', 1, DAY), { date: DAY, likes: 6, superLikes: 2, rewinds: 1 });
  assert.deepEqual(nextUsage(dateless, 'likes', 1, PRIOR), { date: PRIOR, likes: 6, superLikes: 2, rewinds: 1 });

  // A date that is present but unusable is the same case.
  assert.deepEqual(nextUsage({ date: 42, likes: 5, superLikes: 2, rewinds: 1 }, 'likes', 1, DAY),
    { date: DAY, likes: 6, superLikes: 2, rewinds: 1 });
  assert.deepEqual(nextUsage({ date: '', likes: 5, superLikes: 2, rewinds: 1 }, 'likes', 1, DAY),
    { date: DAY, likes: 6, superLikes: 2, rewinds: 1 });

  // The real clock is not a special case: today is just another argument.
  const today = util.todayKey();
  assert.deepEqual(nextUsage(dateless, 'likes', 1, today), { date: today, likes: 6, superLikes: 2, rewinds: 1 });
});

test('nextUsage clamps at zero so a negative bump cannot go under', function () {
  assert.deepEqual(nextUsage({ date: DAY, likes: 1, superLikes: 0, rewinds: 0 }, 'likes', -3, DAY),
    { date: DAY, likes: 0, superLikes: 0, rewinds: 0 });
  assert.deepEqual(nextUsage({ date: DAY, likes: 5, superLikes: 0, rewinds: 0 }, 'likes', -2, DAY),
    { date: DAY, likes: 3, superLikes: 0, rewinds: 0 });
  assert.deepEqual(nextUsage({ date: DAY, likes: 0, superLikes: 0, rewinds: 0 }, 'rewinds', -1, DAY),
    { date: DAY, likes: 0, superLikes: 0, rewinds: 0 });
});

test('nextUsage returns a new record and never edits the one it was handed', function () {
  const current = Object.freeze({ date: PRIOR, likes: 7, superLikes: 1, rewinds: 2 });
  const result = nextUsage(current, 'likes', 1, DAY);

  assert.notEqual(result, current);
  assert.deepEqual(current, { date: PRIOR, likes: 7, superLikes: 1, rewinds: 2 }, 'the input is untouched');
  // Two calls with the same arguments agree — nothing is carried between them.
  assert.deepEqual(nextUsage(current, 'likes', 1, DAY), result);
});

/* ------------------------------------------------------------------------
   2. The demo adapter, through the facade
   ------------------------------------------------------------------------ */

test('a demo bump persists the counter and touches nothing else on the doc', async function () {
  const created = await freshUser('alice', { displayName: 'Alice' });
  await tick();

  const usage = await store.bumpUsage('alice', 'superLikes');
  assert.deepEqual(usage, { date: util.todayKey(), likes: 0, superLikes: 1, rewinds: 0 });
  assert.deepEqual(storedUsage('alice'), usage, 'the returned record is the stored one');

  // A counter is not a profile edit: the rest of the document stays as it was.
  const after = await store.getUser('alice');
  assert.equal(after.updatedAt, created.updatedAt, 'a bump does not restamp updatedAt');
  assert.equal(after.displayName, 'Alice');
});

test('demo bumps fired together all count, and canSpend agrees', async function () {
  await freshUser('alice', {});

  await Promise.all([
    store.bumpUsage('alice', 'likes'),
    store.bumpUsage('alice', 'likes'),
    store.bumpUsage('alice', 'likes'),
    store.bumpUsage('alice', 'likes'),
    store.bumpUsage('alice', 'likes')
  ]);

  assert.equal((await store.getUsage('alice')).likes, 5, 'five bumps, five likes');
  assert.equal(storedUsage('alice').likes, 5);
  assert.equal((await store.canSpend('alice', 'likes')).remaining, 20);
});

test('a bump rolls yesterday over to today inside the same write', async function () {
  await freshUser('alice', {});
  const yesterday = yesterdayKey();
  await store.updateUser('alice', { usage: { date: yesterday, likes: 25, superLikes: 1, rewinds: 2 } });
  assert.equal(storedUsage('alice').date, yesterday, 'the stale day really is stored');

  const usage = await store.bumpUsage('alice', 'likes');
  assert.deepEqual(usage, { date: util.todayKey(), likes: 1, superLikes: 0, rewinds: 0 });
  assert.deepEqual(storedUsage('alice'), usage, 'the roll-over was persisted, not just reported');

  // Yesterday's exhausted budget does not follow the user into today.
  const likes = await store.canSpend('alice', 'likes');
  assert.equal(likes.allowed, true);
  assert.equal(likes.remaining, 24);
});

test('a negative bump clamps at zero on the way to storage', async function () {
  await freshUser('alice', {});
  await store.bumpUsage('alice', 'likes', 2);

  assert.equal((await store.bumpUsage('alice', 'likes', -5)).likes, 0);
  assert.equal(storedUsage('alice').likes, 0, 'storage never holds a negative counter');
});

test('bumping an account that does not exist writes nothing', async function () {
  await freshUser('alice', {});

  // The caller still gets an honest answer for the swipe it just made; there
  // is simply no document to record it against, so none is invented.
  assert.equal((await store.bumpUsage('ghost', 'likes')).likes, 1);
  assert.equal(await store.getUser('ghost'), null);
  assert.deepEqual(Object.keys(raw(KEYS.users)), ['alice']);
});
