/* ==========================================================================
   Zero Cost AI Dating — data store tests (demo adapter)
   Loads the real public/js/data-store.js in Node and exercises the demo
   adapter against a Map-backed localStorage shim — no mocks of the store
   itself, so what passes here is exactly what runs in the browser. The real
   public/js/utils.js loads first (its DOM access is all inside functions the
   store never calls from Node), then the bundled seed data, then the store
   with ZC.config.mode forced to 'demo'.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------------
   Harness: the browser globals data-store.js expects
   ------------------------------------------------------------------------ */

// A quota-free localStorage stand-in. Values are stored as strings, exactly
// like the real thing, so JSON round-trips behave identically.
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

// data-store.js addresses everything through `window.*`; aliasing window to
// globalThis lets the browser IIFEs run untouched under Node.
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
const M = require('../public/js/matching-engine.js');
const KEYS = store.KEYS;

/* ------------------------------------------------------------------------
   Helpers
   ------------------------------------------------------------------------ */

/** Wipe the shim and seed a pristine demo database. */
async function resetWorld() {
  backing.clear();
  const seeded = await store.seedDemo(false);
  assert.equal(seeded, true, 'a cleared world must reseed');
}

/** Read one storage entry as parsed JSON (null when absent). */
function raw(key) {
  const value = backing.get(key);
  return value === undefined ? null : JSON.parse(value);
}

/** Overwrite one storage entry with a JSON value. */
function writeRaw(key, value) {
  backing.set(key, JSON.stringify(value));
}

/** ISO strings are lexicographically ordered; tiny sleep so stamps differ. */
function tick(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || 5); });
}

const YOU = 'demo-you';
const DEVIN_MATCH = 'demo-you_devin-alvarez';
const SAM_MATCH = 'demo-you_sam-whitfield';

/* ------------------------------------------------------------------------
   1. Seeding
   ------------------------------------------------------------------------ */

test('seedDemo stores all 32 profiles with converted, stripped timestamps', async function () {
  await resetWorld();
  const users = raw(KEYS.users);
  assert.equal(Object.keys(users).length, 32);
  assert.ok(users[YOU], 'demo-you is seeded');
  assert.equal(users[YOU].displayName, 'You');

  // Every stored user carries a real ISO lastActiveAt and no offset field.
  Object.keys(users).forEach(function (uid) {
    const user = users[uid];
    assert.equal(Object.prototype.hasOwnProperty.call(user, 'lastActiveOffsetHours'), false,
      uid + ' must not keep lastActiveOffsetHours');
    assert.ok(isFinite(Date.parse(user.lastActiveAt)), uid + ' has a parseable lastActiveAt');
  });

  // demo-you's bundled offset is 0.5h — the converted stamp must sit near it.
  const ageMs = Date.now() - Date.parse(users[YOU].lastActiveAt);
  assert.ok(ageMs >= 0 && ageMs < 2 * 3600000, 'demo-you was active about half an hour ago');

  const flag = raw(KEYS.seeded);
  assert.equal(flag.version, 1);
  assert.equal(flag.count, 32);
});

test('seedDemo materialises the inbound likes and both conversations', async function () {
  await resetWorld();
  const swipes = raw(KEYS.swipes);
  const matches = raw(KEYS.matches);
  const messages = raw(KEYS.messages);

  // 9 inbound likes + both directions of the two conversations = 13 swipes.
  assert.equal(Object.keys(swipes).length, 13);
  const inbound = swipes['fatima-bennani_demo-you'];
  assert.equal(inbound.id, 'fatima-bennani_demo-you');
  assert.equal(inbound.from, 'fatima-bennani');
  assert.equal(inbound.to, YOU);
  assert.equal(inbound.action, 'super');
  assert.ok(isFinite(Date.parse(inbound.createdAt)));

  // Both conversation matches exist under the sorted pair id.
  assert.deepEqual(Object.keys(matches).sort(), [DEVIN_MATCH, SAM_MATCH]);
  const devin = matches[DEVIN_MATCH];
  assert.deepEqual(devin.users, [YOU, 'devin-alvarez'].sort());

  // The live conversation: 6 ascending messages, the tail unread for demo-you.
  const thread = messages[DEVIN_MATCH];
  assert.equal(thread.length, 6);
  for (let i = 1; i < thread.length; i += 1) {
    assert.ok(Date.parse(thread[i].createdAt) >= Date.parse(thread[i - 1].createdAt), 'messages ascend');
  }
  const last = thread[thread.length - 1];
  assert.equal(last.from, 'devin-alvarez');
  assert.equal(devin.lastMessage, last.text);
  assert.equal(devin.lastMessageAt, last.createdAt);
  assert.equal(devin.unread[YOU], 1, 'demo-you owes devin one read');
  assert.equal(devin.unread['devin-alvarez'], 0);

  // The empty match: no messages, nothing unread, no preview.
  const sam = matches[SAM_MATCH];
  assert.equal(sam.lastMessage, null);
  assert.equal(sam.lastMessageAt, null);
  assert.equal(sam.unread[YOU], 0);
  assert.equal(sam.unread['sam-whitfield'], 0);
  assert.equal(messages[SAM_MATCH], undefined);
});

test('seedDemo is idempotent and never clobbers an existing account', async function () {
  await resetWorld();
  assert.equal(await store.seedDemo(false), false, 'a seeded world does not reseed');

  // Even with the flag gone, a non-force seed leaves live accounts alone.
  await store.updateUser(YOU, { displayName: 'Renamed' });
  backing.delete(KEYS.seeded);
  assert.equal(await store.seedDemo(false), true);
  const you = await store.getUser(YOU);
  assert.equal(you.displayName, 'Renamed');
  assert.equal(Object.keys(raw(KEYS.swipes)).length, 13, 'relationships are not duplicated');
});

test('seedDemo(force) restores deleted seed data wholesale', async function () {
  await resetWorld();
  await store.deleteAccountData('maya-okonkwo');
  assert.equal(await store.getUser('maya-okonkwo'), null);
  assert.equal(raw(KEYS.swipes)['maya-okonkwo_demo-you'], undefined, 'her inbound like went with her');

  await store.seedDemo(true);
  const maya = await store.getUser('maya-okonkwo');
  assert.ok(maya, 'force reseed brings the profile back');
  assert.equal(Object.keys(raw(KEYS.users)).length, 32);
  assert.equal(raw(KEYS.swipes)['maya-okonkwo_demo-you'].action, 'like');
});

/* ------------------------------------------------------------------------
   2. Users: create, read, update
   ------------------------------------------------------------------------ */

test('createUser fills the full DEFAULT_USER shape and getUser round-trips it', async function () {
  await resetWorld();
  assert.equal(await store.getUser('nobody'), null);
  assert.equal(await store.getUser(''), null);

  const created = await store.createUser('alice', { email: 'alice@example.com', displayName: 'Alice' });
  assert.equal(created.uid, 'alice');
  assert.equal(created.plan, 'free');
  assert.deepEqual(created.preferences.interestedIn, ['woman', 'man', 'nonbinary', 'other']);
  assert.deepEqual(created.profile.personality,
    { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, stability: 50 });
  assert.deepEqual(created.learning, { interestAffinity: {}, likeCount: 0, passCount: 0 });
  assert.equal(created.usage.date, util.todayKey());
  assert.ok(isFinite(Date.parse(created.createdAt)));

  const loaded = await store.getUser('alice');
  assert.deepEqual(loaded, created);
});

test('updateUser deep-merges, bumps updatedAt and pins uid/createdAt', async function () {
  await resetWorld();
  const created = await store.createUser('alice', { displayName: 'Alice', profile: { bio: 'original', gender: 'woman' } });
  await tick();

  // A nested patch merges: siblings survive, the patched leaf changes,
  // uid cannot be smuggled and createdAt cannot move.
  const updated = await store.updateUser('alice', {
    uid: 'evil',
    profile: { bio: 'rewritten', personality: { openness: 80 } }
  });
  assert.equal(updated.uid, 'alice');
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt > created.updatedAt, 'updatedAt moved forward');
  assert.equal(updated.profile.bio, 'rewritten');
  assert.equal(updated.profile.gender, 'woman', 'unpatched siblings survive');
  assert.equal(updated.profile.personality.openness, 80);
  assert.equal(updated.profile.personality.stability, 50, 'nested maps merge key by key');

  // Arrays replace whole, never merge.
  const replaced = await store.updateUser('alice', { profile: { interests: ['hiking'] } });
  assert.deepEqual(replaced.profile.interests, ['hiking']);
});

/* ------------------------------------------------------------------------
   3. learning.interestAffinity is atomic (the pruning regression)
   ------------------------------------------------------------------------ */

test('updateUser replaces learning.interestAffinity wholesale, so pruned keys stay gone', async function () {
  await resetWorld();
  await store.createUser('alice', {
    learning: { interestAffinity: { hiking: 0.5, vinyl: 0.02 }, likeCount: 3, passCount: 1 }
  });

  // The engine prunes decayed tags; a merge would resurrect `vinyl` here.
  const updated = await store.updateUser('alice', { learning: { interestAffinity: { hiking: 0.6 } } });
  assert.deepEqual(updated.learning.interestAffinity, { hiking: 0.6 });
  assert.equal(Object.prototype.hasOwnProperty.call(updated.learning.interestAffinity, 'vinyl'), false,
    'the pruned key must not come back');
  assert.equal(updated.learning.likeCount, 3, 'the rest of learning still merges');
});

/* ------------------------------------------------------------------------
   4. Swipes and matches
   ------------------------------------------------------------------------ */

test('recordSwipe: no reciprocal means no match, pass never matches, mutual like matches', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.createUser('cara', {});

  // A one-sided like is just a swipe.
  const oneWay = await store.recordSwipe('alice', 'bob', 'like');
  assert.deepEqual(oneWay, { matched: false, matchId: null, created: false });

  // A pass over an incoming like still never matches.
  await store.recordSwipe('cara', 'alice', 'like');
  const passed = await store.recordSwipe('alice', 'cara', 'pass');
  assert.equal(passed.matched, false);

  // The reciprocal like creates the match under the sorted pair id,
  // with both unread counters at zero.
  const matched = await store.recordSwipe('bob', 'alice', 'like');
  assert.equal(matched.matched, true);
  assert.equal(matched.matchId, 'alice_bob');
  assert.equal(matched.created, true);
  const doc = raw(KEYS.matches).alice_bob;
  assert.deepEqual(doc.users, ['alice', 'bob']);
  assert.deepEqual(doc.unread, { bob: 0, alice: 0 });
  assert.equal(doc.lastMessage, null);

  // The facade refuses malformed swipes outright.
  await assert.rejects(store.recordSwipe('alice', 'alice', 'like'), /yourself/);
  await assert.rejects(store.recordSwipe('', 'bob', 'like'), /both people/);
});

test('recordSwipe is idempotent and super counts as positive', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});

  // A recorded decision stands: re-recording never overwrites the action.
  await store.recordSwipe('alice', 'bob', 'pass');
  const rerecorded = await store.recordSwipe('alice', 'bob', 'like');
  assert.equal(rerecorded.matched, false, 'the stored pass still wins');
  const mine = await store.getSwipes('alice');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].action, 'pass');

  // A super like is positive on both sides of the reciprocity check.
  await store.recordSwipe('alice', 'cara', 'super');
  await store.createUser('cara', {});
  const matched = await store.recordSwipe('cara', 'alice', 'like');
  assert.equal(matched.matched, true);
  assert.equal(matched.created, true);

  // Re-recording a matched swipe re-reports the match without duplicating it.
  const again = await store.recordSwipe('cara', 'alice', 'super');
  assert.equal(again.matched, true);
  assert.equal(again.created, false, 'no second match document');
  assert.equal((await store.getSwipes('cara'))[0].action, 'like', 'the original action is preserved');
});

test('a block outranks a mutual like, and says so as a plain no-match', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.recordSwipe('bob', 'alice', 'like');
  await store.updateUser('bob', { blocked: ['alice'] });

  // Everything except the block says this is a match. The answer is "no match"
  // rather than an error, because the person who was blocked must not be told
  // that they were — an error nobody else gets would tell them.
  const out = await store.recordSwipe('alice', 'bob', 'like');
  assert.deepEqual(out, { matched: false, matchId: null, created: false });
  assert.equal(await store.getMatch(['alice', 'bob'].sort().join('_'), 'alice'), null);

  // The swipe itself is stored: the deck must not put the card back.
  assert.equal((await store.getSwipes('alice')).length, 1);

  // The Firestore adapter cannot make this decision — the block list is private
  // and its client never sees it — so `firestore.rules` refuses the match write
  // and the adapter turns that refusal into the same answer. The two agree by
  // arriving from opposite ends, which is the only agreement available here.
  await store.updateUser('bob', { blocked: [] });
  const now = await store.recordSwipe('alice', 'bob', 'like');
  assert.equal(now.matched, true, 'unblocking lets the same pair match');
});

test('undoSwipe removes a swipe nobody has answered yet', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.recordSwipe('alice', 'bob', 'like');

  const undone = await store.undoSwipe('alice', 'bob');
  assert.deepEqual(undone, { ok: true });
  assert.equal((await store.getSwipes('alice')).length, 0);

  // Undoing again is a clean no-op rather than an error: the deck can ask
  // twice, and there is nothing left to protect.
  assert.deepEqual(await store.undoSwipe('alice', 'bob'), { ok: true });
});

test('undoSwipe refuses once the pair have matched, and deletes nothing', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.recordSwipe('alice', 'bob', 'like');
  const matched = await store.recordSwipe('bob', 'alice', 'like');
  await store.sendMessage(matched.matchId, 'bob', 'hello there');

  // This assertion used to run the other way — the rewind removed the match
  // and the conversation went with it — which was the defect written down as
  // a requirement. A match is two people's, and only one of them is holding
  // the rewind button; the other is not asked and is not told.
  assert.deepEqual(await store.undoSwipe('bob', 'alice'), { ok: false, reason: 'matched' });
  assert.equal((await store.getSwipes('bob')).length, 1, 'the swipe stands');
  assert.notEqual(await store.getMatch(matched.matchId, 'alice'), null, 'the match stands');
  assert.equal(raw(KEYS.messages)[matched.matchId].length, 1, 'and so does what was said in it');
  assert.equal((await store.getSwipes('alice')).length, 1, 'the other side\'s swipe stands');
});

/* ------------------------------------------------------------------------
   5. Discovery
   ------------------------------------------------------------------------ */

test('listCandidates excludes self, swiped and blocks either way, honours limit, sorts by activity', async function () {
  await resetWorld();
  const out = await store.listCandidates(YOU, {});

  // 32 seeded users minus demo-you and the two conversation partners it
  // already swiped right on.
  assert.equal(out.length, 29);
  const uids = out.map(function (u) { return u.uid; });
  assert.equal(uids.indexOf(YOU), -1, 'never yourself');
  assert.equal(uids.indexOf('devin-alvarez'), -1, 'already swiped');
  assert.equal(uids.indexOf('sam-whitfield'), -1, 'already swiped');
  assert.notEqual(uids.indexOf('maya-okonkwo'), -1, 'her inbound like does not hide her');

  // Most recently active first.
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(Date.parse(out[i].lastActiveAt) <= Date.parse(out[i - 1].lastActiveAt), 'activity sort holds');
  }

  // Blocks cut both ways.
  await store.updateUser(YOU, { blocked: ['maya-okonkwo'] });
  await store.updateUser('priya-raghunathan', { blocked: [YOU] });
  const filtered = await store.listCandidates(YOU, {});
  assert.equal(filtered.length, 27);
  assert.equal(filtered.map(function (u) { return u.uid; }).indexOf('maya-okonkwo'), -1);
  assert.equal(filtered.map(function (u) { return u.uid; }).indexOf('priya-raghunathan'), -1);

  // The limit caps the page.
  assert.equal((await store.listCandidates(YOU, { limit: 5 })).length, 5);
});

test('listCandidates leaves eligibility filtering to the engine, which hard-fails those profiles', async function () {
  await resetWorld();
  // The demo adapter deliberately returns non-discoverable, incomplete and
  // mutually ineligible profiles — "ranking is the engine's job" — so the
  // pair store→engine is what actually keeps them off the deck. Prove both
  // halves of that contract.
  await store.createUser('nd-user', {
    profileComplete: true,
    profile: { age: 30, gender: 'woman' },
    preferences: { discoverable: false }
  });
  await store.createUser('inc-user', {});
  await store.createUser('gender-user', {
    profileComplete: true,
    profile: { age: 30, gender: 'man' },
    preferences: { interestedIn: ['man'] } // demo-you is a woman → mutual fail
  });
  await store.createUser('age-user', {
    profileComplete: true,
    profile: { age: 21, gender: 'man' } // below demo-you's ageMin of 25
  });

  const uids = (await store.listCandidates(YOU, {})).map(function (u) { return u.uid; });
  ['nd-user', 'inc-user', 'gender-user', 'age-user'].forEach(function (uid) {
    assert.notEqual(uids.indexOf(uid), -1, uid + ' passes through the adapter untouched');
  });

  const me = await store.getUser(YOU);
  const four = await Promise.all(['nd-user', 'inc-user', 'gender-user', 'age-user'].map(function (uid) {
    return store.getUser(uid);
  }));
  const fails = {};
  M.rankCandidates(me, four, { includeHardFails: true }).forEach(function (result) {
    fails[result.uid] = result.hardFail;
  });
  assert.equal(fails['nd-user'], 'not-discoverable');
  assert.equal(fails['inc-user'], 'incomplete');
  assert.equal(fails['gender-user'], 'gender');
  assert.equal(fails['age-user'], 'age');
});

test('getLikesReceived lists unanswered inbound likes and drops answered or blocked ones', async function () {
  await resetWorld();
  const likers = await store.getLikesReceived(YOU);

  // 9 seeded inbound likes; devin and sam were already answered at seed time.
  assert.equal(likers.length, 9);
  const uids = likers.map(function (u) { return u.uid; });
  assert.notEqual(uids.indexOf('fatima-bennani'), -1);
  assert.notEqual(uids.indexOf('maya-okonkwo'), -1);
  assert.equal(uids.indexOf('devin-alvarez'), -1, 'a matched liker is answered');

  // Answering a like removes it — and, being reciprocal, creates the match.
  const answered = await store.recordSwipe(YOU, 'maya-okonkwo', 'like');
  assert.equal(answered.matched, true);
  const after = await store.getLikesReceived(YOU);
  assert.equal(after.length, 8);
  assert.equal(after.map(function (u) { return u.uid; }).indexOf('maya-okonkwo'), -1);

  // Blocking a liker hides them too.
  await store.updateUser(YOU, { blocked: ['fatima-bennani'] });
  assert.equal((await store.getLikesReceived(YOU)).length, 7);
});

/* ------------------------------------------------------------------------
   6. Messaging
   ------------------------------------------------------------------------ */

test('sendMessage appends, denormalises the preview and bumps only the other side\'s unread', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.recordSwipe('alice', 'bob', 'like');
  const matchId = (await store.recordSwipe('bob', 'alice', 'like')).matchId;

  const sent = await store.sendMessage(matchId, 'alice', '  hello bob  ');
  assert.equal(sent.text, 'hello bob', 'text is trimmed');
  assert.equal(sent.from, 'alice');
  await store.sendMessage(matchId, 'alice', 'still there?');

  const bobsView = await store.getMatch(matchId, 'bob');
  assert.equal(bobsView.unread, 2, 'the recipient owes two reads');
  assert.equal(bobsView.lastMessage, 'still there?');
  assert.ok(isFinite(Date.parse(bobsView.lastMessageAt)));
  assert.equal((await store.getMatch(matchId, 'alice')).unread, 0, 'the sender owes none');

  // markRead zeroes the reader's counter and only theirs.
  assert.equal(await store.markRead(matchId, 'bob'), true);
  assert.equal((await store.getMatch(matchId, 'bob')).unread, 0);
  assert.equal(await store.markRead('no-such-match', 'bob'), false);
});

test('getMessages orders ascending and keeps the newest under a limit; input rules hold', async function () {
  await resetWorld();

  // The seeded conversation is the ordering fixture.
  const thread = await store.getMessages(DEVIN_MATCH, {});
  assert.equal(thread.length, 6);
  for (let i = 1; i < thread.length; i += 1) {
    assert.ok(Date.parse(thread[i].createdAt) >= Date.parse(thread[i - 1].createdAt));
  }

  // A limit keeps the newest messages, still ascending.
  const tail = await store.getMessages(DEVIN_MATCH, { limit: 2 });
  assert.equal(tail.length, 2);
  assert.deepEqual(tail.map(function (m) { return m.text; }),
    thread.slice(4).map(function (m) { return m.text; }));

  // Whitespace-only is rejected; oversized text is capped at 1000 chars.
  await assert.rejects(store.sendMessage(DEVIN_MATCH, YOU, '   \n  '), /empty/);
  await assert.rejects(store.sendMessage('no-such-match', YOU, 'hi'), /no longer exists/);
  const long = await store.sendMessage(DEVIN_MATCH, YOU, 'x'.repeat(1200));
  assert.equal(long.text.length, 1000);
});

/* ------------------------------------------------------------------------
   7. Usage and limits
   ------------------------------------------------------------------------ */

test('getUsage resets a stale date and persists the reset', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.updateUser('alice', { usage: { date: '2020-01-01', likes: 9, superLikes: 1, rewinds: 2 } });

  const usage = await store.getUsage('alice');
  assert.deepEqual(usage, { date: util.todayKey(), likes: 0, superLikes: 0, rewinds: 0 });
  const stored = (await store.getUser('alice')).usage;
  assert.equal(stored.date, util.todayKey(), 'the reset was written back');
  assert.equal(stored.likes, 0);
});

test('bumpUsage and canSpend enforce the free plan; premium lifts the limits', async function () {
  await resetWorld();
  await store.createUser('alice', {});

  assert.equal((await store.bumpUsage('alice', 'likes')).likes, 1);
  assert.equal((await store.bumpUsage('alice', 'likes', 3)).likes, 4);
  const likes = await store.canSpend('alice', 'likes');
  assert.deepEqual(likes, { allowed: true, remaining: 21, limit: 25, plan: 'free' });

  // An unknown field is ignored, never a crash.
  assert.equal((await store.bumpUsage('alice', 'bogus')).likes, 4);

  // One super like per day on free; zero rewinds, ever.
  await store.bumpUsage('alice', 'superLikes');
  const supers = await store.canSpend('alice', 'superLikes');
  assert.equal(supers.allowed, false);
  assert.equal(supers.remaining, 0);
  const rewinds = await store.canSpend('alice', 'rewinds');
  assert.equal(rewinds.allowed, false);
  assert.equal(rewinds.limit, 0);

  // Exhaust the daily likes, then upgrade: premium is unlimited.
  await store.updateUser('alice', { usage: { date: util.todayKey(), likes: 25, superLikes: 1, rewinds: 0 } });
  assert.equal((await store.canSpend('alice', 'likes')).allowed, false);
  await store.updateUser('alice', { plan: 'premium' });
  const upgraded = await store.canSpend('alice', 'likes');
  assert.equal(upgraded.allowed, true);
  assert.equal(upgraded.limit, Infinity);
  assert.equal(upgraded.plan, 'premium');
  assert.equal((await store.canSpend('alice', 'rewinds')).allowed, true);
});

/* ------------------------------------------------------------------------
   8. Reports
   ------------------------------------------------------------------------ */

test('reportUser writes a deterministic doc, keeps the first filing, rejects bad input', async function () {
  await resetWorld();
  const filed = await store.reportUser(YOU, 'maya-okonkwo', 'harassment', '  first filing  ');
  assert.deepEqual(filed, { ok: true, id: 'demo-you_maya-okonkwo', duplicate: false });

  const doc = raw(KEYS.reports)['demo-you_maya-okonkwo'];
  assert.equal(doc.from, YOU);
  assert.equal(doc.about, 'maya-okonkwo');
  assert.equal(doc.reason, 'harassment');
  assert.equal(doc.details, 'first filing', 'details are trimmed');
  assert.ok(isFinite(Date.parse(doc.createdAt)));

  // Re-reporting the same person flags the duplicate and changes nothing.
  const dup = await store.reportUser(YOU, 'maya-okonkwo', 'other', 'second attempt');
  assert.equal(dup.duplicate, true);
  const kept = raw(KEYS.reports)['demo-you_maya-okonkwo'];
  assert.equal(kept.reason, 'harassment');
  assert.equal(kept.details, 'first filing');

  // Details cap at 500 chars; bad reason and self-reports never land.
  await store.reportUser(YOU, 'theo-lindqvist', 'other', 'd'.repeat(600));
  assert.equal(raw(KEYS.reports)['demo-you_theo-lindqvist'].details.length, 500);
  await assert.rejects(store.reportUser(YOU, 'rin-matsuda', 'not-a-reason', ''), /reason/);
  await assert.rejects(store.reportUser(YOU, YOU, 'harassment', ''), /yourself/);
  assert.equal(Object.keys(raw(KEYS.reports)).length, 2);
});

test('getMyReports sorts newest first and returns copies; retractReport removes exactly once', async function () {
  await resetWorld();
  await store.reportUser(YOU, 'maya-okonkwo', 'harassment', 'older');
  await store.reportUser(YOU, 'theo-lindqvist', 'other', 'newer');
  await store.reportUser('maya-okonkwo', 'theo-lindqvist', 'other', 'not mine');

  // Pin the stamps so the sort is deterministic rather than same-millisecond.
  const reports = raw(KEYS.reports);
  reports['demo-you_maya-okonkwo'].createdAt = '2026-01-01T00:00:00.000Z';
  reports['demo-you_theo-lindqvist'].createdAt = '2026-02-01T00:00:00.000Z';
  writeRaw(KEYS.reports, reports);

  const mine = await store.getMyReports(YOU);
  assert.equal(mine.length, 2, 'only my own filings');
  assert.deepEqual(mine.map(function (r) { return r.about; }), ['theo-lindqvist', 'maya-okonkwo']);
  assert.deepEqual(await store.getMyReports(''), [], 'no uid, no reports');

  // The returned docs are clones — mutating one never reaches storage.
  mine[0].details = 'vandalised';
  assert.equal((await store.getMyReports(YOU))[0].details, 'newer');

  // Retract once: removed. Retract again: a clean miss, not an error.
  assert.deepEqual(await store.retractReport(YOU, 'maya-okonkwo'), { ok: true, removed: true });
  assert.deepEqual(await store.retractReport(YOU, 'maya-okonkwo'), { ok: true, removed: false });
  assert.equal((await store.getMyReports(YOU)).length, 1);
  await assert.rejects(store.retractReport(YOU, ''), /both accounts/);
});

/* ------------------------------------------------------------------------
   9. Account deletion
   ------------------------------------------------------------------------ */

test('deleteAccountData purges the account\'s footprint but keeps reports about it', async function () {
  await resetWorld();
  await store.createUser('alice', {});
  await store.createUser('bob', {});
  await store.createUser('cara', {});
  await store.recordSwipe('alice', 'bob', 'like');
  const matchId = (await store.recordSwipe('bob', 'alice', 'like')).matchId;
  await store.sendMessage(matchId, 'alice', 'soon to vanish');
  await store.recordSwipe('cara', 'alice', 'like');
  await store.reportUser('alice', 'bob', 'other', 'filed by alice');
  await store.reportUser('bob', 'alice', 'harassment', 'about alice');

  await store.deleteAccountData('alice');

  // Swipes in both directions are gone — including cara's inbound like.
  const swipeDocs = raw(KEYS.swipes);
  Object.keys(swipeDocs).forEach(function (id) {
    assert.notEqual(swipeDocs[id].from, 'alice');
    assert.notEqual(swipeDocs[id].to, 'alice');
  });
  assert.equal((await store.getSwipes('cara')).length, 0);

  // The match and its conversation went with the account.
  assert.equal(await store.getMatch(matchId, 'bob'), null);
  assert.equal(raw(KEYS.messages)[matchId], undefined);

  // Filed reports are purged; the report about the account stays queued.
  const reports = raw(KEYS.reports);
  assert.equal(reports.alice_bob, undefined);
  assert.equal(reports.bob_alice.details, 'about alice');

  // The account doc is gone; bystanders and the seed cast are untouched.
  assert.equal(await store.getUser('alice'), null);
  assert.ok(await store.getUser('bob'));
  assert.ok(await store.getUser('cara'));
  assert.ok(await store.getUser(YOU));
});

/* ------------------------------------------------------------------------
   10. Export, import, reset
   ------------------------------------------------------------------------ */

test('exportDemo/importDemo round-trip the whole database, reports included', async function () {
  await resetWorld();
  await store.reportUser(YOU, 'maya-okonkwo', 'other', 'travels with the export');
  const snapshot = await store.exportDemo();
  assert.equal(snapshot.mode, 'demo');
  assert.ok(snapshot.users[YOU]);
  assert.ok(snapshot.reports['demo-you_maya-okonkwo']);

  // Wreck the world, then restore it from the snapshot (object form).
  await store.deleteAccountData(YOU);
  assert.equal(await store.getUser(YOU), null);
  assert.equal(await store.importDemo(snapshot), true);
  assert.ok(await store.getUser(YOU), 'the account came back');
  assert.ok(await store.getMatch(DEVIN_MATCH, YOU), 'the match came back');
  assert.equal((await store.getMyReports(YOU))[0].details, 'travels with the export');

  // The JSON-string form restores too; garbage is rejected loudly.
  await store.deleteAccountData(YOU);
  assert.equal(await store.importDemo(JSON.stringify(snapshot)), true);
  assert.ok(await store.getUser(YOU));
  await assert.rejects(store.importDemo('{not json'), /valid JSON/);
  await assert.rejects(store.importDemo({ nothing: true }), /users/);
});

test('resetDemo wipes every demo key and restores the pristine seed', async function () {
  await resetWorld();
  await store.createUser('squatter', { displayName: 'Squatter' });
  await store.reportUser(YOU, 'maya-okonkwo', 'other', 'gone after reset');
  await store.recordSwipe(YOU, 'maya-okonkwo', 'like');

  assert.equal(await store.resetDemo(), true);
  const users = raw(KEYS.users);
  assert.equal(Object.keys(users).length, 32, 'exactly the seed cast');
  assert.equal(users.squatter, undefined);
  assert.equal((await store.getMyReports(YOU)).length, 0);
  assert.equal(Object.keys(raw(KEYS.swipes)).length, 13, 'only the seeded relationships');
  assert.deepEqual(Object.keys(raw(KEYS.matches)).sort(), [DEVIN_MATCH, SAM_MATCH]);
  assert.equal(raw(KEYS.seeded).version, 1);
});
