/* ==========================================================================
   Zero Cost AI Dating — what is public about an account, agreed in one place

   An account is split in two. `users/{uid}` is readable only by its owner;
   `discovery/{uid}` is readable by every signed-in user, because that is the
   surface the deck ranks. Deciding which fields cross that line is the single
   most consequential judgement in this codebase, and it was written down three
   times independently:

     - `projectDiscovery()` in public/js/data-store.js decides what is copied;
     - three `keys().hasOnly([...])` lists in firestore.rules decide what is
       accepted;
     - a hand-written expected-key array in store-tests/06-projection-order.

   Three copies of one decision, and nothing comparing them. The failure that
   shape produces is well known and has already happened once here in a milder
   form: the projection emitted `lastActiveAt: null`, the rules accepted that
   key only as a string, and account creation broke in Firebase mode while
   every demo-mode test stayed green.

   That direction is the loud one — the write is rejected and somebody notices.
   The quiet direction is worse. Add a private field to the projection and the
   write starts failing; the obvious way to make a failing write pass is to
   widen the rule. Two small edits, each locally reasonable, and `email` or
   `birthdate` is now world-readable. Nothing in the suite would have said a
   word, because both copies would agree with each other.

   So this file checks both directions:

     (a) the projection's key set and the rules' allowlist are *equal*, at all
         three levels — catching drift in either copy, in `npm test`, with no
         emulator;
     (b) nothing private appears in the projection at all — by name and, more
         importantly, by value. A fully populated private account is projected
         and the output searched for sentinels that only exist in the private
         half. Widening the rules does not help you here: this check never
         reads the rules.

   (b) is the one that matters. (a) would pass a change that leaked an email
       through both copies at once; (b) would not.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* --------------------------------------------------------------------------
   The shipped store, loaded the way the page loads it
   -------------------------------------------------------------------------- */

const backing = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: function (k) { return backing.has(String(k)) ? backing.get(String(k)) : null; },
    setItem: function (k, v) { backing.set(String(k), String(v)); },
    removeItem: function (k) { backing.delete(String(k)); },
    clear: function () { backing.clear(); },
    key: function (i) { const keys = Array.from(backing.keys()); return i >= 0 && i < keys.length ? keys[i] : null; },
    get length() { return backing.size; }
  },
  configurable: true,
  writable: true
});

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

const projectDiscovery = window.ZC.store._internal.projectDiscovery;
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

/* --------------------------------------------------------------------------
   A private account, every field filled with something recognisable
   -------------------------------------------------------------------------- */

/**
 * Values that exist only in the private half. Each is a string a reader would
 * never mistake for anything else, so finding one anywhere in the projected
 * output — at any depth, under any key, however renamed — is proof of a leak.
 *
 * `birthdate` is the interesting one. The projection is *supposed* to carry a
 * derived `age`; what it must never carry is the date somebody was born, which
 * is a different and much more identifying fact. The rules say so in a comment
 * — "no birthdate here, only the derived age" — and this is that comment made
 * executable.
 */
const PRIVATE_VALUES = {
  email: 'zc-private-email@example.invalid',
  createdAt: 'zc-private-created-at',
  updatedAt: 'zc-private-updated-at',
  planSince: 'zc-private-plan-since',
  birthdate: '1987-03-14',
  blockedUid: 'zc-private-blocked-uid',
  affinityKey: 'zc-private-affinity-key',
  theme: 'zc-private-theme'
};

/** Field names that must never appear as a key in the projection, at any depth. */
const PRIVATE_KEYS = ['email', 'createdAt', 'updatedAt', 'plan', 'planSince',
  'learning', 'usage', 'blocked', 'birthdate', 'notifications', 'theme'];

/**
 * A user document with every private field set to a sentinel and every public
 * field set to something plainly public, so a leak cannot hide behind a value
 * that was going to be there anyway.
 * @returns {Object} a private user document
 */
function fullPrivateUser() {
  return {
    uid: 'projection-uid',
    email: PRIVATE_VALUES.email,
    displayName: 'Public Name',
    createdAt: PRIVATE_VALUES.createdAt,
    updatedAt: PRIVATE_VALUES.updatedAt,
    lastActiveAt: '2026-01-02T03:04:05.000Z',
    profileComplete: true,
    plan: 'premium',
    planSince: PRIVATE_VALUES.planSince,
    profile: {
      birthdate: PRIVATE_VALUES.birthdate,
      age: 39,
      gender: 'woman',
      pronouns: 'she/her',
      bio: 'A public bio.',
      photos: ['https://example.com/a.jpg'],
      interests: ['hiking'],
      personality: { openness: 60, conscientiousness: 55, extraversion: 45, agreeableness: 70, stability: 50 },
      location: { label: 'Portland', lat: 45.52, lng: -122.68 },
      showAge: true,
      showDistance: true
    },
    preferences: {
      interestedIn: ['man'],
      ageMin: 25,
      ageMax: 45,
      maxDistanceKm: 50,
      notifications: false,
      theme: PRIVATE_VALUES.theme,
      discoverable: true
    },
    learning: { interestAffinity: {}, likeCount: 7, passCount: 3 },
    usage: { date: '2026-01-02', likes: 11, superLikes: 1, rewinds: 0 },
    blocked: [PRIVATE_VALUES.blockedUid]
  };
}

/* --------------------------------------------------------------------------
   Reading the rules' closed key lists
   -------------------------------------------------------------------------- */

/**
 * Pull one `keys().hasOnly([...])` list out of the rules by the function that
 * contains it. Anchored on the function name rather than on order, so moving
 * the blocks around does not silently change what is compared.
 * @param {string} fnName the rules function holding the list
 * @returns {string[]} the allowed keys, in source order
 */
function hasOnlyList(fnName) {
  const fn = new RegExp('function\\s+' + fnName + '\\s*\\([\\s\\S]*?\\n      \\}');
  const block = fn.exec(RULES);
  assert.ok(block, 'no ' + fnName + '() found in firestore.rules — this test is comparing nothing');
  const list = /keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/.exec(block[0]);
  assert.ok(list, 'no keys().hasOnly([...]) inside ' + fnName + '()');
  return list[1]
    .split(',')
    .map(function (raw) { return raw.trim().replace(/^['"]|['"]$/g, ''); })
    .filter(Boolean);
}

/** Every key of an object, at every depth, as a flat set. */
function deepKeys(value, into) {
  const out = into || new Set();
  if (Array.isArray(value)) {
    value.forEach(function (item) { deepKeys(item, out); });
  } else if (value && typeof value === 'object') {
    Object.keys(value).forEach(function (key) {
      out.add(key);
      deepKeys(value[key], out);
    });
  }
  return out;
}

/* --------------------------------------------------------------------------
   (a) the two copies agree
   -------------------------------------------------------------------------- */

test('the projection emits exactly the keys firestore.rules allows', function () {
  const projected = projectDiscovery(fullPrivateUser());

  const pairs = [
    { what: 'the projection itself', got: Object.keys(projected), allowed: hasOnlyList('discoveryOk') },
    { what: 'profile', got: Object.keys(projected.profile), allowed: hasOnlyList('discoveryProfileOk') },
    { what: 'preferences', got: Object.keys(projected.preferences), allowed: hasOnlyList('discoveryPrefsOk') }
  ];

  const problems = [];
  pairs.forEach(function (pair) {
    const got = pair.got.slice().sort();
    const allowed = pair.allowed.slice().sort();
    const extra = got.filter(function (k) { return allowed.indexOf(k) === -1; });
    const unused = allowed.filter(function (k) { return got.indexOf(k) === -1; });
    // Extra is the loud failure: the write would be rejected by the rules.
    if (extra.length) problems.push(pair.what + ': projected but not allowed — ' + extra.join(', '));
    // Unused is the quiet one: a key the rules would accept that nothing sends.
    // Harmless today, but it is a door left open in the only file that decides
    // what may be public, so it has to be deliberate rather than forgotten.
    if (unused.length) problems.push(pair.what + ': allowed but never projected — ' + unused.join(', '));
  });

  assert.deepEqual(problems, [],
    'public/js/data-store.js and firestore.rules disagree about what is public:\n  ' +
    problems.join('\n  '));
});

/* --------------------------------------------------------------------------
   (b) nothing private gets out, whatever the rules happen to permit
   -------------------------------------------------------------------------- */

test('no private field name survives into the projection', function () {
  const projected = projectDiscovery(fullPrivateUser());
  const keys = deepKeys(projected);
  const leaked = PRIVATE_KEYS.filter(function (name) { return keys.has(name); });
  assert.deepEqual(leaked, [],
    'the world-readable projection carries private field name(s): ' + leaked.join(', '));
});

test('no private value survives into the projection, however it is nested', function () {
  const projected = projectDiscovery(fullPrivateUser());
  const serialised = JSON.stringify(projected);
  const leaked = Object.keys(PRIVATE_VALUES).filter(function (name) {
    return serialised.indexOf(PRIVATE_VALUES[name]) !== -1;
  });
  // This is the check that a change widening firestore.rules cannot satisfy,
  // because it never reads them. It asks the only question that matters: given
  // an account with something private in every field, does any of it come out?
  assert.deepEqual(leaked, [],
    'the world-readable projection carries private value(s): ' + leaked.join(', ') +
    '\n  projected: ' + serialised.slice(0, 300));
});

test('the derived age is published but the birthdate it came from is not', function () {
  const projected = projectDiscovery(fullPrivateUser());
  // Both halves matter. Dropping `age` too would pass the leak check above
  // while quietly breaking every age filter in the deck.
  assert.equal(typeof projected.profile.age, 'number', 'the deck filters on age, so it has to be published');
  assert.equal(JSON.stringify(projected).indexOf(PRIVATE_VALUES.birthdate), -1,
    'the birthdate itself must never be published — firestore.rules says "no birthdate here, only the derived age"');
});

test('an empty account projects the same shape as a full one', function () {
  // A brand-new account is the case that broke Firebase mode once before: the
  // projection emitted a key whose *type* the rules did not accept. Shape
  // stability across a sparse input is what stops that recurring.
  const sparse = projectDiscovery({ uid: 'sparse-uid' });
  const full = projectDiscovery(fullPrivateUser());
  assert.deepEqual(Object.keys(sparse).sort(), Object.keys(full).sort(),
    'a sparse account projects a different top-level shape than a complete one');
  assert.deepEqual(Object.keys(sparse.profile).sort(), Object.keys(full.profile).sort(),
    'a sparse account projects a different profile shape than a complete one');
  assert.deepEqual(Object.keys(sparse.preferences).sort(), Object.keys(full.preferences).sort(),
    'a sparse account projects a different preferences shape than a complete one');
});
