/* ==========================================================================
   Zero Cost AI Dating — seed data tests
   The bundled cast is content, but it is also load-bearing: the demo mode, the
   interest chips on profile.html and the first-run deck all read from it. These
   tests pin the shape against §4 of the contract, keep the tag table honest,
   prove the ages actually follow from the birthdates, prove `demo-you` still has
   a deck worth swiping, prove the bundled relationships (inbound likes, one
   live conversation and one empty match) really do reach `demo-you`, and prove
   public/js/seed-data.js has not drifted from seed/profiles.json.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const build = require('../scripts/build-seed.js');
const bundle = require('../public/js/seed-data.js');

const seed = build.readSeed();
const TAGS = seed.interests;
const PROFILES = seed.profiles;
const LIKES = seed.inboundLikes;
const CONVERSATIONS = seed.conversations;
const BY_UID = {};
PROFILES.forEach(function (p) { BY_UID[p.uid] = p; });

/* ------------------------------------------------------------------------
   Fixtures and helpers
   ------------------------------------------------------------------------ */

const GENDERS = ['woman', 'man', 'nonbinary', 'other'];
const THEMES = ['system', 'light', 'dark'];
const AXES = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'stability'];
const CATEGORIES = ['outdoors', 'arts', 'food', 'music', 'fitness', 'tech', 'travel', 'homebody', 'social', 'mindful'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ANYWHERE_KM = 500;

/**
 * Whole years between a birthdate and a reference day, both treated as UTC
 * calendar dates so the result never depends on the runner's timezone.
 * @param {string} birthdate 'YYYY-MM-DD'
 * @param {Date} at reference date
 * @returns {number} age in whole years
 */
function ageAt(birthdate, at) {
  const born = new Date(birthdate + 'T00:00:00Z');
  let years = at.getUTCFullYear() - born.getUTCFullYear();
  const months = at.getUTCMonth() - born.getUTCMonth();
  if (months < 0 || (months === 0 && at.getUTCDate() < born.getUTCDate())) years -= 1;
  return years;
}

/**
 * Great-circle distance in kilometres between two {lat,lng} points.
 * Mirrors ZC.util.haversineKm so the test stays independent of other agents.
 * @param {{lat:number,lng:number}} a first point
 * @param {{lat:number,lng:number}} b second point
 * @returns {number} distance in km
 */
function haversineKm(a, b) {
  const R = 6371;
  const rad = function (deg) { return (deg * Math.PI) / 180; };
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The hard filters from §5.2, in order, applied to two seed profiles.
 * Reimplemented here on purpose: this file must be able to fail on the *data*
 * without depending on the matching engine's implementation.
 * @param {Object} me viewer profile
 * @param {Object} candidate candidate profile
 * @returns {string|null} the failing filter, or null when the candidate passes
 */
function hardFail(me, candidate) {
  if (me.uid === candidate.uid) return 'self';
  if (me.blocked.indexOf(candidate.uid) !== -1 || candidate.blocked.indexOf(me.uid) !== -1) return 'blocked';
  if (candidate.preferences.discoverable === false) return 'not-discoverable';
  if (!candidate.profileComplete || !candidate.profile.age) return 'incomplete';

  const mine = me.preferences.interestedIn;
  const theirs = candidate.preferences.interestedIn;
  const openToThem = !mine.length || mine.indexOf(candidate.profile.gender) !== -1;
  const openToMe = !theirs.length || theirs.indexOf(me.profile.gender) !== -1;
  if (!openToThem || !openToMe) return 'gender';

  if (candidate.profile.age < me.preferences.ageMin || candidate.profile.age > me.preferences.ageMax) return 'age';
  if (me.profile.age < candidate.preferences.ageMin || me.profile.age > candidate.preferences.ageMax) return 'age';

  if (me.profile.location && candidate.profile.location) {
    const cap = Math.min(me.preferences.maxDistanceKm, candidate.preferences.maxDistanceKm);
    if (cap < ANYWHERE_KM && haversineKm(me.profile.location, candidate.profile.location) > cap) return 'distance';
  }
  return null;
}

/** Group the candidate outcomes for `demo-you` once, and reuse them. */
function demoOutcomes() {
  const me = PROFILES[0];
  const outcomes = { pass: [] };
  PROFILES.slice(1).forEach(function (candidate) {
    const fail = hardFail(me, candidate);
    if (!fail) {
      outcomes.pass.push(candidate.uid);
      return;
    }
    outcomes[fail] = outcomes[fail] || [];
    outcomes[fail].push(candidate.uid);
  });
  return outcomes;
}

/* ------------------------------------------------------------------------
   1. The document envelope
   ------------------------------------------------------------------------ */

test('seed document has the expected envelope', function () {
  assert.equal(seed.version, 1);
  assert.match(seed.ageAsOf, DATE_ONLY, 'ageAsOf pins the day the ages were computed');
  assert.ok(Array.isArray(TAGS));
  assert.ok(Array.isArray(PROFILES));
});

/* ------------------------------------------------------------------------
   2. The interest tag table
   ------------------------------------------------------------------------ */

test('there are exactly 48 interest tags', function () {
  assert.equal(TAGS.length, 48);
});

test('every tag has a kebab-case slug, a label, an emoji and a known category', function () {
  TAGS.forEach(function (tag) {
    assert.deepEqual(Object.keys(tag), ['slug', 'label', 'emoji', 'category'], 'tag key order is stable');
    assert.match(tag.slug, KEBAB, tag.slug + ' should be kebab-case');
    assert.equal(typeof tag.label, 'string');
    assert.ok(tag.label.length > 0 && tag.label.length <= 24, tag.slug + ' needs a short label');
    assert.equal(typeof tag.emoji, 'string');
    assert.ok(tag.emoji.length > 0, tag.slug + ' needs an emoji');
    assert.ok(CATEGORIES.indexOf(tag.category) !== -1, tag.category + ' is not a known category');
  });
});

test('tag slugs and labels are unique', function () {
  const slugs = new Set(TAGS.map(function (t) { return t.slug; }));
  const labels = new Set(TAGS.map(function (t) { return t.label.toLowerCase(); }));
  assert.equal(slugs.size, TAGS.length, 'duplicate slug');
  assert.equal(labels.size, TAGS.length, 'duplicate label');
});

test('all ten categories are present with 4-6 tags each', function () {
  const counts = {};
  TAGS.forEach(function (tag) { counts[tag.category] = (counts[tag.category] || 0) + 1; });
  assert.deepEqual(Object.keys(counts).sort(), CATEGORIES.slice().sort());
  CATEGORIES.forEach(function (category) {
    assert.ok(counts[category] >= 4 && counts[category] <= 6,
      category + ' has ' + counts[category] + ' tags, expected 4-6');
  });
});

/* ------------------------------------------------------------------------
   3. The cast
   ------------------------------------------------------------------------ */

test('there are exactly 32 profiles and demo-you comes first', function () {
  assert.equal(PROFILES.length, 32);
  const you = PROFILES[0];
  assert.equal(you.uid, 'demo-you');
  assert.equal(you.email, 'you@example.com');
  assert.equal(you.displayName, 'You');
  assert.equal(you.plan, 'free', 'the demo account starts on the free plan so limits are visible');
});

test('uids, emails, display names and bios are all unique', function () {
  const uids = new Set(PROFILES.map(function (p) { return p.uid; }));
  const emails = new Set(PROFILES.map(function (p) { return p.email.toLowerCase(); }));
  const names = new Set(PROFILES.map(function (p) { return p.displayName; }));
  const bios = new Set(PROFILES.map(function (p) { return p.profile.bio; }));
  assert.equal(uids.size, PROFILES.length, 'duplicate uid');
  assert.equal(emails.size, PROFILES.length, 'duplicate email');
  assert.equal(names.size, PROFILES.length, 'duplicate display name');
  assert.equal(bios.size, PROFILES.length, 'two profiles share a bio');
});

test('every profile matches the UserDoc top level', function () {
  PROFILES.forEach(function (p) {
    assert.match(p.uid, KEBAB, p.uid + ': uid should be a kebab-case id');
    assert.match(p.email, /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/, p.uid + ': implausible email');
    assert.ok(typeof p.displayName === 'string' && p.displayName.length >= 2 && p.displayName.length <= 40,
      p.uid + ': displayName must be 2-40 chars');
    assert.equal(p.profileComplete, true, p.uid + ': seed profiles are complete by definition');
    assert.ok(p.plan === 'free' || p.plan === 'premium', p.uid + ': unknown plan');
    assert.match(p.createdAt, ISO_STAMP, p.uid + ': createdAt must be an ISO stamp');
    assert.match(p.updatedAt, ISO_STAMP, p.uid + ': updatedAt must be an ISO stamp');
    assert.ok(Date.parse(p.updatedAt) >= Date.parse(p.createdAt), p.uid + ': updated before created');
    assert.ok(Array.isArray(p.blocked), p.uid + ': blocked must be an array');
  });
});

test('plan and planSince agree, and exactly four profiles are premium', function () {
  const premium = PROFILES.filter(function (p) { return p.plan === 'premium'; });
  assert.equal(premium.length, 4, 'the seed should exercise both plans');
  premium.forEach(function (p) {
    assert.match(p.planSince, ISO_STAMP, p.uid + ': premium needs a planSince');
  });
  PROFILES.filter(function (p) { return p.plan === 'free'; }).forEach(function (p) {
    assert.equal(p.planSince, null, p.uid + ': free plans have no planSince');
  });
});

test('lastActiveAt is stored as a durable offset, not a timestamp', function () {
  PROFILES.forEach(function (p) {
    assert.ok(!Object.prototype.hasOwnProperty.call(p, 'lastActiveAt'),
      p.uid + ': use lastActiveOffsetHours so the demo never looks abandoned');
    assert.equal(typeof p.lastActiveOffsetHours, 'number', p.uid + ': lastActiveOffsetHours must be a number');
    assert.ok(p.lastActiveOffsetHours >= 0 && p.lastActiveOffsetHours <= 336,
      p.uid + ': last active should fall inside the past 14 days');
  });
  const offsets = PROFILES.map(function (p) { return p.lastActiveOffsetHours; });
  assert.ok(Math.max.apply(null, offsets) > 168, 'some profiles should be over a week stale');
  assert.ok(Math.min.apply(null, offsets) < 6, 'some profiles should read as active today');
});

/* ------------------------------------------------------------------------
   4. profile.*
   ------------------------------------------------------------------------ */

test('every profile.profile matches §4', function () {
  const slugs = new Set(TAGS.map(function (t) { return t.slug; }));
  PROFILES.forEach(function (p) {
    const pr = p.profile;
    assert.match(pr.birthdate, DATE_ONLY, p.uid + ': birthdate must be YYYY-MM-DD');
    assert.equal(typeof pr.age, 'number', p.uid + ': age must be denormalised');
    assert.ok(GENDERS.indexOf(pr.gender) !== -1, p.uid + ': unknown gender ' + pr.gender);
    assert.ok(typeof pr.pronouns === 'string' && pr.pronouns.length > 0, p.uid + ': pronouns missing');
    assert.ok(typeof pr.bio === 'string' && pr.bio.length > 0 && pr.bio.length <= 500,
      p.uid + ': bio must be 1-500 chars');
    assert.deepEqual(pr.photos, [], p.uid + ': seed profiles use generated avatars, never hosted photos');
    assert.ok(Array.isArray(pr.interests), p.uid + ': interests must be an array');
    assert.ok(pr.interests.length >= 4 && pr.interests.length <= 9,
      p.uid + ' has ' + pr.interests.length + ' interests, expected 4-9');
    assert.equal(new Set(pr.interests).size, pr.interests.length, p.uid + ': duplicate interest');
    pr.interests.forEach(function (slug) {
      assert.ok(slugs.has(slug), p.uid + ' references unknown interest ' + slug);
    });
    AXES.forEach(function (axis) {
      const value = pr.personality[axis];
      assert.ok(Number.isInteger(value) && value >= 0 && value <= 100,
        p.uid + ': personality.' + axis + ' must be an integer 0-100');
    });
    assert.deepEqual(Object.keys(pr.personality).sort(), AXES.slice().sort(), p.uid + ': personality axes');
    assert.ok(pr.location && typeof pr.location.label === 'string' && pr.location.label.length > 0,
      p.uid + ': location needs a label');
    assert.ok(pr.location.lat >= -90 && pr.location.lat <= 90, p.uid + ': latitude out of range');
    assert.ok(pr.location.lng >= -180 && pr.location.lng <= 180, p.uid + ': longitude out of range');
    assert.equal(typeof pr.showAge, 'boolean', p.uid + ': showAge must be a boolean');
    assert.equal(typeof pr.showDistance, 'boolean', p.uid + ': showDistance must be a boolean');
  });
});

test('bios are short, human and free of placeholder text', function () {
  PROFILES.forEach(function (p) {
    const bio = p.profile.bio;
    const sentences = (bio.match(/[.!?]+(?=\s|$)/g) || []).length;
    assert.ok(sentences >= 1 && sentences <= 3, p.uid + ': bio should be 1-3 sentences, found ' + sentences);
    assert.doesNotMatch(bio, /lorem ipsum|TODO|placeholder|\{\w+\}/i, p.uid + ': bio contains filler');
    assert.equal(bio.trim(), bio, p.uid + ': bio has stray whitespace');
  });
});

test('every interest tag is worn by at least one profile', function () {
  const used = new Set();
  PROFILES.forEach(function (p) {
    p.profile.interests.forEach(function (slug) { used.add(slug); });
  });
  const orphans = TAGS.map(function (t) { return t.slug; }).filter(function (slug) { return !used.has(slug); });
  assert.deepEqual(orphans, [], 'unused interest tags make the chip grid look dead');
});

test('ages follow from the birthdates and stay inside 21-58', function () {
  const asOf = new Date(seed.ageAsOf + 'T00:00:00Z');
  PROFILES.forEach(function (p) {
    assert.equal(p.profile.age, ageAt(p.profile.birthdate, asOf),
      p.uid + ': age disagrees with birthdate as of ' + seed.ageAsOf);
    assert.ok(p.profile.age >= 21 && p.profile.age <= 58, p.uid + ': age ' + p.profile.age + ' is out of range');
    assert.ok(ageAt(p.profile.birthdate, new Date()) >= 18, p.uid + ': everyone must still be 18+ today');
  });
});

test('the cast is demographically varied', function () {
  const genders = new Set(PROFILES.map(function (p) { return p.profile.gender; }));
  const cities = new Set(PROFILES.map(function (p) { return p.profile.location.label; }));
  const ages = PROFILES.map(function (p) { return p.profile.age; });
  assert.equal(genders.size, GENDERS.length, 'all four gender values should appear');
  assert.ok(cities.size >= 10, 'profiles should span about ten cities, found ' + cities.size);
  assert.ok(Math.max.apply(null, ages) - Math.min.apply(null, ages) >= 30, 'ages should span a wide range');
});

/* ------------------------------------------------------------------------
   5. preferences, learning, usage
   ------------------------------------------------------------------------ */

test('every preferences block matches §4', function () {
  PROFILES.forEach(function (p) {
    const prefs = p.preferences;
    assert.ok(Array.isArray(prefs.interestedIn) && prefs.interestedIn.length > 0,
      p.uid + ': interestedIn must list at least one gender');
    prefs.interestedIn.forEach(function (gender) {
      assert.ok(GENDERS.indexOf(gender) !== -1, p.uid + ': unknown interestedIn value ' + gender);
    });
    assert.equal(new Set(prefs.interestedIn).size, prefs.interestedIn.length, p.uid + ': duplicate interestedIn');
    assert.ok(Number.isInteger(prefs.ageMin) && prefs.ageMin >= 18, p.uid + ': ageMin must be an integer >= 18');
    assert.ok(Number.isInteger(prefs.ageMax) && prefs.ageMax <= 100, p.uid + ': ageMax must be an integer <= 100');
    assert.ok(prefs.ageMin <= prefs.ageMax, p.uid + ': ageMin must not exceed ageMax');
    assert.ok(Number.isInteger(prefs.maxDistanceKm) && prefs.maxDistanceKm >= 1 && prefs.maxDistanceKm <= 500,
      p.uid + ': maxDistanceKm must be an integer 1-500');
    assert.equal(typeof prefs.notifications, 'boolean', p.uid + ': notifications must be a boolean');
    assert.ok(THEMES.indexOf(prefs.theme) !== -1, p.uid + ': unknown theme ' + prefs.theme);
    assert.equal(typeof prefs.discoverable, 'boolean', p.uid + ': discoverable must be a boolean');
  });
});

test('learning, usage and blocked start in a sane state', function () {
  const uids = new Set(PROFILES.map(function (p) { return p.uid; }));
  let blockedPairs = 0;
  PROFILES.forEach(function (p) {
    const learning = p.learning;
    assert.ok(learning && typeof learning.interestAffinity === 'object', p.uid + ': learning.interestAffinity missing');
    Object.keys(learning.interestAffinity).forEach(function (slug) {
      const value = learning.interestAffinity[slug];
      assert.ok(TAGS.some(function (t) { return t.slug === slug; }), p.uid + ': affinity for unknown tag ' + slug);
      assert.ok(typeof value === 'number' && value >= -1 && value <= 1,
        p.uid + ': affinity for ' + slug + ' must sit in -1..1');
    });
    assert.ok(Number.isInteger(learning.likeCount) && learning.likeCount >= 0, p.uid + ': bad likeCount');
    assert.ok(Number.isInteger(learning.passCount) && learning.passCount >= 0, p.uid + ': bad passCount');

    assert.deepEqual(Object.keys(p.usage).sort(), ['date', 'likes', 'rewinds', 'superLikes'], p.uid + ': usage keys');
    assert.equal(p.usage.date, null, p.uid + ': usage.date is stamped at seed time, not in the file');
    assert.equal(p.usage.likes, 0, p.uid + ': usage starts empty');
    assert.equal(p.usage.superLikes, 0, p.uid + ': usage starts empty');
    assert.equal(p.usage.rewinds, 0, p.uid + ': usage starts empty');

    p.blocked.forEach(function (uid) {
      assert.ok(uids.has(uid), p.uid + ' blocks unknown uid ' + uid);
      assert.notEqual(uid, 'demo-you', 'nobody may block the demo account');
      blockedPairs += 1;
    });
  });
  assert.ok(blockedPairs >= 1, 'at least one block keeps the blocked hard filter exercised');
});

test('only premium profiles carry learned affinities', function () {
  PROFILES.forEach(function (p) {
    if (p.plan === 'premium') return;
    assert.deepEqual(p.learning.interestAffinity, {}, p.uid + ': adaptive weights are a premium feature');
    assert.equal(p.learning.likeCount, 0, p.uid + ': free profiles start with no swipe history');
    assert.equal(p.learning.passCount, 0, p.uid + ': free profiles start with no swipe history');
  });
});

/* ------------------------------------------------------------------------
   6. The data has to make the filters do work
   ------------------------------------------------------------------------ */

test('demo-you sees a full first-run deck', function () {
  const outcomes = demoOutcomes();
  assert.ok(outcomes.pass.length >= 15,
    'demo-you should have at least 15 candidates, found ' + outcomes.pass.length);
});

test('every mutual hard filter is exercised against demo-you', function () {
  const outcomes = demoOutcomes();
  ['gender', 'age', 'distance', 'not-discoverable'].forEach(function (reason) {
    assert.ok(outcomes[reason] && outcomes[reason].length >= 1,
      'no seed profile is rejected for "' + reason + '" — that filter would never be tested');
  });
});

test('the gender and age filters really are mutual', function () {
  const you = PROFILES[0];

  // Rejected because *they* are not interested in demo-you, not the reverse.
  const oneWayGender = PROFILES.slice(1).filter(function (p) {
    return you.preferences.interestedIn.indexOf(p.profile.gender) !== -1 &&
      p.preferences.interestedIn.indexOf(you.profile.gender) === -1;
  });
  assert.ok(oneWayGender.length >= 1, 'no candidate rejects demo-you on gender');

  // Rejected because demo-you is outside *their* age range.
  const oneWayAge = PROFILES.slice(1).filter(function (p) {
    const theyFitMe = p.profile.age >= you.preferences.ageMin && p.profile.age <= you.preferences.ageMax;
    const iFitThem = you.profile.age >= p.preferences.ageMin && you.profile.age <= p.preferences.ageMax;
    return theyFitMe && !iFitThem;
  });
  assert.ok(oneWayAge.length >= 1, 'no candidate rejects demo-you on age');

  // And a symmetric sanity check: the filter is reflexive on itself.
  assert.equal(hardFail(you, BY_UID['demo-you']), 'self');
});

test('some pairs are blocked by distance and some are not', function () {
  const you = PROFILES[0];
  const local = PROFILES.slice(1).filter(function (p) {
    return haversineKm(you.profile.location, p.profile.location) <= 25;
  });
  const remote = PROFILES.slice(1).filter(function (p) {
    return haversineKm(you.profile.location, p.profile.location) > 1000;
  });
  assert.ok(local.length >= 4, 'demo-you needs nearby candidates so distance reasons appear');
  assert.ok(remote.length >= 4, 'demo-you needs far-away candidates so the distance filter bites');
});

/* ------------------------------------------------------------------------
   7. The bundled relationships
   ------------------------------------------------------------------------ */

test('there are exactly nine inbound likes, two of them super', function () {
  assert.ok(Array.isArray(LIKES), 'inboundLikes must be an array');
  assert.equal(LIKES.length, 9, 'demo-you needs a "Who liked you" list worth gating');
  const supers = LIKES.filter(function (like) { return like.action === 'super'; });
  assert.equal(supers.length, 2, 'exactly two of the inbound likes should be super likes');
  LIKES.forEach(function (like) {
    assert.deepEqual(Object.keys(like), ['from', 'action', 'offsetHours'], 'inbound like key order is stable');
    assert.ok(like.action === 'like' || like.action === 'super', like.from + ': bad action ' + like.action);
  });
});

test('every inbound like comes from a real seeded person, once', function () {
  const seen = new Set();
  LIKES.forEach(function (like) {
    assert.ok(BY_UID[like.from], 'inbound like from unknown uid ' + like.from);
    assert.notEqual(like.from, 'demo-you', 'demo-you cannot like themselves');
    assert.ok(!seen.has(like.from), like.from + ' likes demo-you twice');
    seen.add(like.from);
  });
});

test('inbound like offsets are finite hours in the past', function () {
  LIKES.forEach(function (like) {
    assert.equal(typeof like.offsetHours, 'number', like.from + ': offsetHours must be a number');
    assert.ok(Number.isFinite(like.offsetHours) && like.offsetHours >= 0,
      like.from + ': offsetHours must be finite and >= 0');
    assert.ok(!Object.prototype.hasOwnProperty.call(like, 'createdAt'),
      like.from + ': use offsetHours so the seeded likes never rot');
  });
});

test('there are exactly two conversations: one with history, one still empty', function () {
  assert.ok(Array.isArray(CONVERSATIONS), 'conversations must be an array');
  assert.equal(CONVERSATIONS.length, 2);
  const withHistory = CONVERSATIONS[0];
  const empty = CONVERSATIONS[1];
  assert.ok(withHistory.messages.length === 5 || withHistory.messages.length === 6,
    'the first conversation should be a 5-6 message exchange, found ' + withHistory.messages.length);
  assert.deepEqual(empty.messages, [],
    'the second match must have no messages so the icebreaker empty state is reachable');
});

test('every conversation partner is a real seeded person, once', function () {
  const seen = new Set();
  CONVERSATIONS.forEach(function (conversation) {
    assert.deepEqual(Object.keys(conversation), ['with', 'matchedOffsetHours', 'messages'],
      'conversation key order is stable');
    assert.ok(BY_UID[conversation.with], 'conversation with unknown uid ' + conversation.with);
    assert.notEqual(conversation.with, 'demo-you', 'demo-you cannot match themselves');
    assert.ok(!seen.has(conversation.with), conversation.with + ' appears in two conversations');
    seen.add(conversation.with);
    assert.ok(Number.isFinite(conversation.matchedOffsetHours) && conversation.matchedOffsetHours >= 0,
      conversation.with + ': matchedOffsetHours must be finite and >= 0');
  });
});

test('nobody is both a liker and a match', function () {
  const likers = new Set(LIKES.map(function (like) { return like.from; }));
  CONVERSATIONS.forEach(function (conversation) {
    assert.ok(!likers.has(conversation.with),
      conversation.with + ' cannot be an unanswered like and an existing match at once');
  });
});

test('messages run oldest first, never predate the match, and only have two authors', function () {
  CONVERSATIONS.forEach(function (conversation) {
    let previous = Infinity;
    conversation.messages.forEach(function (message, i) {
      const at = conversation.with + '.messages[' + i + ']';
      assert.deepEqual(Object.keys(message), ['from', 'text', 'offsetHours'], at + ': message key order');
      assert.ok(message.from === 'demo-you' || message.from === conversation.with,
        at + ': ' + message.from + ' is not in this conversation');
      assert.equal(typeof message.text, 'string', at + ': text must be a string');
      assert.ok(message.text.length >= 1 && message.text.length <= 1000, at + ': text must be 1-1000 chars');
      assert.ok(Number.isFinite(message.offsetHours) && message.offsetHours >= 0,
        at + ': offsetHours must be finite and >= 0');
      assert.ok(message.offsetHours <= conversation.matchedOffsetHours,
        at + ': a message cannot be older than the match itself');
      assert.ok(message.offsetHours < previous, at + ': offsets must strictly decrease down the array');
      previous = message.offsetHours;
    });
  });
});

test('both sides actually speak, and the exchange is grounded in their profile', function () {
  const conversation = CONVERSATIONS[0];
  const partner = BY_UID[conversation.with];
  const authors = new Set(conversation.messages.map(function (m) { return m.from; }));
  assert.deepEqual(Array.from(authors).sort(), ['demo-you', conversation.with].sort(),
    'a real exchange needs both people in it');

  // Nothing generic: every line is a sentence, and at least one of them picks up
  // a distinctive word from the partner's own bio.
  const bioWords = new Set(partner.profile.bio.toLowerCase().match(/[a-z']{6,}/g) || []);
  let grounded = false;
  conversation.messages.forEach(function (message) {
    assert.ok(message.text.length >= 40, 'message is too short to say anything: ' + message.text);
    assert.doesNotMatch(message.text, /hey+\b|how are you|what'?s up|\{\w+\}|lorem ipsum/i,
      'dating-app filler: ' + message.text);
    (message.text.toLowerCase().match(/[a-z']{6,}/g) || []).forEach(function (word) {
      if (bioWords.has(word)) grounded = true;
    });
  });
  assert.ok(grounded, 'the exchange should start from something specific in ' + partner.uid + "'s bio");
});

test('every inbound liker passes the mutual filters both ways', function () {
  const you = PROFILES[0];
  LIKES.forEach(function (like) {
    const them = BY_UID[like.from];
    assert.ok(you.preferences.interestedIn.indexOf(them.profile.gender) !== -1,
      like.from + ': demo-you is not interested in ' + them.profile.gender);
    assert.ok(them.preferences.interestedIn.indexOf(you.profile.gender) !== -1,
      like.from + ' is not interested in ' + you.profile.gender + ', so the like could never happen');
    assert.ok(them.profile.age >= you.preferences.ageMin && them.profile.age <= you.preferences.ageMax,
      like.from + ': age ' + them.profile.age + ' is outside demo-you\'s range');
    assert.ok(you.profile.age >= them.preferences.ageMin && you.profile.age <= them.preferences.ageMax,
      like.from + ': demo-you is outside their age range');
    assert.equal(hardFail(you, them), null,
      like.from + ' liked demo-you but would never appear in the deck');
  });
});

test('both conversation partners would also have passed the filters', function () {
  const you = PROFILES[0];
  CONVERSATIONS.forEach(function (conversation) {
    assert.equal(hardFail(you, BY_UID[conversation.with]), null,
      conversation.with + ' is matched with demo-you but fails demo-you\'s own filters');
  });
});

test('the deck is still deep once the existing matches are swiped away', function () {
  const matched = CONVERSATIONS.map(function (conversation) { return conversation.with; });
  const remaining = demoOutcomes().pass.filter(function (uid) { return matched.indexOf(uid) === -1; });
  assert.ok(remaining.length >= 15,
    'after the seeded matches demo-you should still have 15+ candidates, found ' + remaining.length);
});

/* ------------------------------------------------------------------------
   8. The generator rejects broken relationships
   ------------------------------------------------------------------------ */

/**
 * Mutate a deep copy of the seed, write it to a scratch file and return the
 * message `readSeed` rejects it with. Fails the test if it is accepted.
 * @param {function(Object):void} mutate applied to the copy before writing
 * @returns {string} the thrown error's message
 */
function rejectionFor(mutate) {
  const copy = JSON.parse(JSON.stringify(seed));
  mutate(copy);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-seed-'));
  const file = path.join(dir, 'profiles.json');
  let message = null;
  try {
    fs.writeFileSync(file, JSON.stringify(copy), 'utf8');
    build.readSeed(file);
  } catch (err) {
    message = err.message;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(message, 'the mutated seed should have been rejected');
  return message;
}

test('the generator rejects relationships pointing at nobody', function () {
  assert.match(rejectionFor(function (s) { s.inboundLikes[0].from = 'nobody-at-all'; }), /unknown uid/);
  assert.match(rejectionFor(function (s) { s.conversations[0].with = 'nobody-at-all'; }), /unknown uid/);
});

test('the generator rejects demo-you relating to itself', function () {
  assert.match(rejectionFor(function (s) { s.inboundLikes[0].from = 'demo-you'; }), /other than demo-you/);
  assert.match(rejectionFor(function (s) { s.conversations[0].with = 'demo-you'; }), /other than demo-you/);
});

test('the generator rejects bad offsets and unknown actions', function () {
  assert.match(rejectionFor(function (s) { s.inboundLikes[0].offsetHours = -1; }), /finite number of hours/);
  assert.match(rejectionFor(function (s) { s.inboundLikes[0].offsetHours = 'soon'; }), /finite number of hours/);
  assert.match(rejectionFor(function (s) { s.conversations[0].matchedOffsetHours = null; }), /finite number of hours/);
  assert.match(rejectionFor(function (s) { s.inboundLikes[0].action = 'pass'; }), /must be "like" or "super"/);
});

test('the generator rejects a message from outside the conversation', function () {
  assert.match(rejectionFor(function (s) { s.conversations[0].messages[0].from = 'maya-okonkwo'; }),
    /must be "demo-you" or "devin-alvarez"/);
});

test('the generator rejects messages that are out of order or predate the match', function () {
  assert.match(rejectionFor(function (s) {
    s.conversations[0].messages[1].offsetHours = s.conversations[0].messages[0].offsetHours;
  }), /smaller than the message before it/);
  assert.match(rejectionFor(function (s) {
    s.conversations[0].messages[0].offsetHours = s.conversations[0].matchedOffsetHours + 1;
  }), /predates the match/);
});

test('the generator rejects an unusable message body', function () {
  assert.match(rejectionFor(function (s) { s.conversations[0].messages[0].text = ''; }), /1-1000 characters/);
  assert.match(rejectionFor(function (s) {
    s.conversations[0].messages[0].text = 'x'.repeat(1001);
  }), /1-1000 characters/);
  assert.match(rejectionFor(function (s) { s.conversations[0].messages = {}; }), /messages must be an array/);
});

test('a seed file without the relationship arrays still builds', function () {
  const bare = JSON.parse(JSON.stringify(seed));
  delete bare.inboundLikes;
  delete bare.conversations;
  const source = build.render(bare);
  assert.match(source, /const SEED_INBOUND_LIKES = \[\];/, 'an absent array must default to []');
  assert.match(source, /const SEED_CONVERSATIONS = \[\];/, 'an absent array must default to []');
  assert.match(source, /0 inbound likes, 0 conversations/, 'the banner should report the empty counts');
});

/* ------------------------------------------------------------------------
   9. public/js/seed-data.js stays in sync
   ------------------------------------------------------------------------ */

test('the generated bundle is byte-identical to a fresh render', function () {
  const onDisk = fs.readFileSync(build.OUT_PATH, 'utf8');
  assert.equal(onDisk, build.render(seed),
    'public/js/seed-data.js is stale — run `npm run build:seed`');
});

test('rendering is deterministic', function () {
  assert.equal(build.render(seed), build.render(build.readSeed()));
});

test('the generated bundle is a strict classic script with the expected banner', function () {
  const source = fs.readFileSync(build.OUT_PATH, 'utf8');
  assert.match(source, /GENERATED FILE — DO NOT EDIT BY HAND/);
  assert.ok(source.indexOf("'use strict';") !== -1, 'the IIFE must be strict');
  assert.doesNotMatch(source, /\bTODO\b/);
  assert.doesNotMatch(source, /\bexport\s|\brequire\(/, 'seed-data.js must stay a plain classic script');
  assert.ok(source.endsWith('\n'), 'file should end with a newline');
});

test('the bundle exports the same data as the JSON', function () {
  assert.equal(bundle.SEED_VERSION, seed.version);
  assert.deepEqual(bundle.INTEREST_TAGS, TAGS);
  assert.deepEqual(bundle.SEED_PROFILES, PROFILES);
  assert.deepEqual(bundle.SEED_INBOUND_LIKES, LIKES);
  assert.deepEqual(bundle.SEED_CONVERSATIONS, CONVERSATIONS);
});

test('INTEREST_BY_SLUG indexes every tag', function () {
  assert.equal(Object.keys(bundle.INTEREST_BY_SLUG).length, TAGS.length);
  TAGS.forEach(function (tag) {
    assert.deepEqual(bundle.INTEREST_BY_SLUG[tag.slug], tag);
  });
  assert.equal(bundle.INTEREST_BY_SLUG['not-a-real-tag'], undefined);
});

test('loading the bundle publishes the ZC surface and nothing else', function () {
  assert.ok(globalThis.ZC, 'seed-data.js should attach to the ZC namespace');
  assert.equal(globalThis.ZC.SEED_PROFILES, bundle.SEED_PROFILES);
  assert.equal(globalThis.ZC.INTEREST_TAGS, bundle.INTEREST_TAGS);
  assert.equal(globalThis.ZC.INTEREST_BY_SLUG, bundle.INTEREST_BY_SLUG);
  assert.equal(globalThis.ZC.SEED_VERSION, bundle.SEED_VERSION);
  assert.equal(globalThis.ZC.SEED_INBOUND_LIKES, bundle.SEED_INBOUND_LIKES);
  assert.equal(globalThis.ZC.SEED_CONVERSATIONS, bundle.SEED_CONVERSATIONS);
  assert.equal(globalThis.INTEREST_TAGS, undefined, 'no stray globals');
  assert.equal(globalThis.SEED_PROFILES, undefined, 'no stray globals');
  assert.equal(globalThis.SEED_CONVERSATIONS, undefined, 'no stray globals');
});

test('--check passes for a fresh bundle and fails for a stale one', function (t) {
  const logged = [];
  t.mock.method(console, 'log', function () { logged.push('log'); });
  t.mock.method(console, 'error', function () { logged.push('error'); });

  assert.equal(build.main(['--check']), 0, '--check should pass right after a build');

  // Corrupt the generated file, confirm the guard trips, then restore it byte for byte.
  const original = fs.readFileSync(build.OUT_PATH, 'utf8');
  try {
    fs.writeFileSync(build.OUT_PATH, original + '\n/* drift */\n', 'utf8');
    assert.equal(build.main(['--check']), 1, '--check should fail on a stale bundle');
  } finally {
    fs.writeFileSync(build.OUT_PATH, original, 'utf8');
  }
  assert.equal(build.main(['--check']), 0, 'the bundle must be restored');
  assert.ok(logged.length >= 3, 'the CLI reports what it did');
});

test('the seed paths point where the contract says they do', function () {
  assert.equal(path.basename(build.SEED_PATH), 'profiles.json');
  assert.equal(path.relative(path.dirname(build.SEED_PATH), build.OUT_PATH).replace(/\\/g, '/'),
    '../public/js/seed-data.js');
});
