/* ==========================================================================
   Zero Cost AI Dating — Firestore rules test harness

   firestore.rules is the only server-side security this app has. Five rounds
   of review read it; nothing had ever executed it. These tests run the real
   rules file against the Firestore emulator and assert what it actually does,
   not what the comments claim.

   Like e2e/, this lives outside tests/ so `node --test` cannot discover it,
   and its dependencies are resolved from outside the repository so
   package.json keeps its empty dependency lists.
   ========================================================================== */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.join(ROOT, 'firestore.rules');

const INSTALL_HINT =
  'Firestore rules tests need @firebase/rules-unit-testing and firebase-tools, which are\n' +
  'deliberately NOT dependencies of this repo. Install them somewhere else and point\n' +
  'NODE_PATH at it, e.g.\n' +
  '  mkdir -p /tmp/zc-rules && cd /tmp/zc-rules \\\n' +
  '    && npm install @firebase/rules-unit-testing firebase-tools\n' +
  '  cd ' + ROOT + ' && NODE_PATH=/tmp/zc-rules/node_modules npm run test:rules';

/**
 * Resolve a module that is intentionally not in this repo's dependency tree:
 * an explicit env var, then NODE_PATH, then any ancestor node_modules.
 * @param {string} name the package to load
 * @returns {Object|null} the module, or null when it cannot be found
 */
function loadOutside(name) {
  const roots = [];
  if (process.env.ZC_RULES_MODULES) roots.push(process.env.ZC_RULES_MODULES);
  (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean).forEach(function (p) {
    roots.push(p);
  });
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    roots.push(path.join(dir, 'node_modules'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const root of roots) {
    try {
      return require(Module.createRequire(path.join(root, 'noop.js')).resolve(name));
    } catch (err) { /* try the next root */ }
  }
  return null;
}

/* --------------------------------------------------------------------------
   Fixtures — the shapes firestore.rules validates against
   -------------------------------------------------------------------------- */

/**
 * A complete, valid UserDoc. Tests override one field at a time so a denial
 * can only be attributed to the field under test.
 * @param {string} uid the account id
 * @param {Object} [over] fields to replace
 * @returns {Object} a UserDoc
 */
function userDoc(uid, over) {
  const base = {
    uid: uid,
    email: uid + '@example.com',
    displayName: 'Test ' + uid,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    profileComplete: true,
    plan: 'free',
    planSince: null,
    profile: {
      birthdate: '1995-02-19',
      age: 31,
      gender: 'woman',
      pronouns: 'she/her',
      bio: 'A short, valid bio.',
      photos: [],
      interests: ['hiking', 'coffee'],
      personality: { openness: 70, conscientiousness: 60, extraversion: 50, agreeableness: 65, stability: 55 },
      location: { label: 'Portland, OR', lat: 45.52, lng: -122.68 },
      showAge: true,
      showDistance: true
    },
    preferences: {
      interestedIn: ['woman', 'man'],
      ageMin: 25,
      ageMax: 44,
      maxDistanceKm: 100,
      notifications: true,
      theme: 'system',
      discoverable: true
    },
    learning: { interestAffinity: {}, likeCount: 0, passCount: 0 },
    usage: { date: '2026-01-01', likes: 0, superLikes: 0, rewinds: 0 },
    blocked: []
  };
  return Object.assign(base, over || {});
}

/**
 * The public projection of a user — the only shape other people may read.
 * @param {string} uid the account id
 * @param {Object} [over] fields to replace
 * @returns {Object} a discovery document
 */
function discoveryDoc(uid, over) {
  const base = {
    uid: uid,
    displayName: 'Test ' + uid,
    profileComplete: true,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    profile: {
      age: 31,
      gender: 'woman',
      pronouns: 'she/her',
      bio: 'A short, valid bio.',
      photos: [],
      interests: ['hiking', 'coffee'],
      personality: { openness: 70, conscientiousness: 60, extraversion: 50, agreeableness: 65, stability: 55 },
      location: { label: 'Portland, OR', lat: 45.52, lng: -122.68 },
      showAge: true,
      showDistance: true
    },
    preferences: { interestedIn: ['woman', 'man'], ageMin: 25, ageMax: 44, maxDistanceKm: 100, discoverable: true }
  };
  return Object.assign(base, over || {});
}

/** A swipe document; the rules require the id to be `from_to`. */
function swipeDoc(from, to, action) {
  return { id: from + '_' + to, from: from, to: to, action: action || 'like', createdAt: '2026-01-02T00:00:00.000Z' };
}

/** The deterministic pair id used by both swipes and matches. */
function pairId(a, b) {
  return [a, b].sort().join('_');
}

/** A match document, users sorted as the rules demand. */
function matchDoc(a, b, over) {
  const users = [a, b].sort();
  const unread = {};
  unread[users[0]] = 0;
  unread[users[1]] = 0;
  return Object.assign({
    id: users.join('_'),
    users: users,
    createdAt: '2026-01-03T00:00:00.000Z',
    lastMessage: null,
    lastMessageAt: null,
    unread: unread
  }, over || {});
}

/** A chat message. */
function messageDoc(from, text) {
  return { from: from, text: text === undefined ? 'hello there' : text, createdAt: '2026-01-04T00:00:00.000Z' };
}

/** A report; the rules require the id to be `from_about`. */
function reportDoc(from, about, over) {
  return Object.assign({
    id: from + '_' + about,
    from: from,
    about: about,
    reason: 'harassment',
    details: 'Some detail.',
    createdAt: '2026-01-05T00:00:00.000Z'
  }, over || {});
}

module.exports = {
  ROOT: ROOT,
  RULES_PATH: RULES_PATH,
  INSTALL_HINT: INSTALL_HINT,
  loadOutside: loadOutside,
  readRules: function () { return fs.readFileSync(RULES_PATH, 'utf8'); },
  userDoc: userDoc,
  discoveryDoc: discoveryDoc,
  swipeDoc: swipeDoc,
  matchDoc: matchDoc,
  messageDoc: messageDoc,
  reportDoc: reportDoc,
  pairId: pairId
};
