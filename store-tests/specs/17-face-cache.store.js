/* ==========================================================================
   A face read once is not read again on the next page — and what that saves.

   Every page in this app is its own HTML document. Opening the conversation
   list, tapping into a conversation and coming back is three documents and
   three fresh JavaScript contexts, so `resolveProfiles`' per-page memo starts
   empty each time and `getMatches` re-read a `discovery/{uid}` for every
   conversation, every time. Ten conversations and twenty visits a day is 200
   reads a person a day spent re-reading ten names that had not changed.

   Nothing in the Firestore client covers that here. Offline persistence is not
   enabled, so each page load gets a new SDK with an empty memory cache: the
   `get()` this file is about is a `get()` that reaches the server and is
   billed. That is the difference between this cache and the shared-stream hub
   in `specs/15-live-list.store.js`, which turned out to save no reads at all
   because the SDK was already sharing the target — the correction that file's
   header records. So the number here is counted, and counted with the same
   `harness.countingDb` whose blind spot is documented there: that blind spot is
   about two listeners on one query, and there are no listeners in this file. A
   `get()` that does not happen is a read that is not billed under any model.

   Twelve claims, in the order somebody would doubt them:

     1. A cold page pays for the rows and one face per conversation.
     2. The next page pays for the rows and NOTHING for the faces.
     3. It still shows real names, not placeholders.
     4. The names come from the stored copy — proved by editing it.
     5. A copy older than the TTL is re-read.
     6. So is one stamped in the future, which is the clock-skew case.
     7. A copy filed under the wrong uid is re-read, never shown.
     8. So is one written by a different version of the cache shape.
     9. So is a cache that is not JSON at all, without throwing.
    10. The cache is bounded, and it is the newest faces that survive.
    11. Storage that refuses writes costs reads, never correctness.
    12. A profile that is missing is not remembered as missing.

   And one that is not about cost: what gets stored is the public projection,
   so a cache dump cannot hold an email or a block list.
   ========================================================================== */
'use strict';

/** Conversations to seed. Enough that "one read per face" is not one read. */
const MATCHES = 5;

/** The cache's own bound, from data-store.js. Kept in step by a check below. */
const CACHE_MAX = 40;

/** The cache's TTL, from data-store.js: one `touchActive` throttle window. */
const TTL_MS = 5 * 60 * 1000;

module.exports = {
  title: 'A face read once is not read again until it could have changed',

  async run(t, k) {
    const me = 'face-me';
    const KEY = k.store.KEYS.profiles;

    /** Everything currently filed, by uid. */
    function stored() {
      const raw = globalThis.localStorage.getItem(KEY);
      if (!raw) return {};
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch (err) { return {}; }
      return (parsed && parsed.faces) || {};
    }

    /** Rewrite the whole envelope. */
    function put(faces, version) {
      globalThis.localStorage.setItem(KEY, JSON.stringify({
        v: version === undefined ? 1 : version,
        faces: faces
      }));
    }

    /** Run one call with the store's Firestore swapped for a counting stand-in. */
    async function measure(fn) {
      const real = k.ctx.ZC.firebase.db;
      const tally = { reads: 0, calls: 0 };
      k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
      try {
        const value = await fn();
        return { value: value, reads: tally.reads, calls: tally.calls };
      } finally {
        k.ctx.ZC.firebase.db = real;
      }
    }

    /** The name this list shows for one person. */
    function nameOf(views, uid) {
      const hit = (views || []).filter(function (v) { return v.otherUid === uid; })[0];
      return hit && hit.other ? hit.other.displayName : '';
    }

    // The store is loaded once per process and every spec shares its storage,
    // so this file starts from a cache it emptied itself rather than from one
    // an earlier spec happened to leave behind.
    globalThis.localStorage.removeItem(KEY);

    await k.admin.set('users', me, k.h.userDoc(me));

    const others = [];
    const rows = [];
    for (let i = 0; i < MATCHES; i += 1) {
      const them = 'face-them-' + String(i).padStart(2, '0');
      others.push(them);
      rows.push({
        id: [me, them].sort().join('_'),
        data: {
          id: [me, them].sort().join('_'),
          users: [me, them].sort(),
          createdAt: '2026-01-0' + (i + 1) + 'T00:00:00.000Z',
          lastMessage: null,
          lastMessageAt: null,
          unread: {}
        }
      });
    }
    await k.admin.setMany('matches', rows);
    await k.admin.setMany('discovery', others.map(function (them) {
      return { id: them, data: k.h.discoveryDoc(them, { displayName: 'Real ' + them.slice(-2) }) };
    }));
    // A private document each, and each holding two things the cache must never
    // acquire: an email address, and a block list naming the viewer. The second
    // is the sharper of the two — a client that could read who had blocked it
    // would be telling its user exactly what a block exists not to announce —
    // and `discovery/{uid}` carries neither. See the last check in this file.
    await k.admin.setMany('users', others.map(function (them) {
      return { id: them, data: k.h.userDoc(them, { blocked: [me] }) };
    }));

    /* ---- 1. a cold page pays for everything --------------------------- */

    const cold = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a cold page load costs the match query plus one face per conversation',
      cold.reads === MATCHES + MATCHES && cold.value.length === MATCHES,
      cold.reads + ' read(s) for ' + MATCHES + ' conversations — the query bills ' + MATCHES +
      ' rows and each face is one more');

    /* ---- 2. the next one pays for the faces not at all ----------------- */

    const warm = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('the next page load costs the rows and not one face',
      warm.reads === MATCHES,
      warm.reads + ' read(s), against ' + cold.reads + ' cold — ' + MATCHES +
      ' of them were saved, which is what a person navigating back to this page stops paying');

    t.check('and it is still a list of real people, not placeholders',
      warm.value.length === MATCHES &&
        others.every(function (them) { return nameOf(warm.value, them) === 'Real ' + them.slice(-2); }),
      others.map(function (them) { return nameOf(warm.value, them); }).join(', '));

    /* ---- 3. proof the answer came from storage ------------------------- */

    // The read count above is consistent with a cache that works and with a
    // counter that has stopped counting. Editing the stored copy tells the two
    // apart: only a page actually reading storage can show a name that exists
    // nowhere else.
    const edited = stored();
    // Guarded rather than assumed: a store that had stopped writing the cache
    // altogether should fail the check below with a name, not crash the file
    // three lines earlier and take the remaining fourteen checks with it.
    if (edited[others[0]]) edited[others[0]].doc.displayName = 'From The Cache';
    put(edited);

    const fromCache = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('and the name it shows is the stored one, so the read really was skipped',
      nameOf(fromCache.value, others[0]) === 'From The Cache' && fromCache.reads === MATCHES,
      nameOf(fromCache.value, others[0]) + ', in ' + fromCache.reads + ' read(s)');

    /* ---- 4. and it does not last ---------------------------------------- */

    const aged = stored();
    Object.keys(aged).forEach(function (uid) { aged[uid].at = Date.now() - TTL_MS - 1000; });
    put(aged);

    const expired = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a face older than the ' + (TTL_MS / 60000) + '-minute window is read again',
      expired.reads === MATCHES * 2 && nameOf(expired.value, others[0]) === 'Real 00',
      expired.reads + ' read(s) and the name is back to ' + k.show(nameOf(expired.value, others[0])) +
      ' — a cache that never expired would still be showing the edit');

    /* ---- 5. a clock that went backwards is not a permanent cache -------- */

    const future = stored();
    Object.keys(future).forEach(function (uid) { future[uid].at = Date.now() + TTL_MS * 100; });
    if (future[others[0]]) future[others[0]].doc.displayName = 'Stamped In The Future';
    put(future);

    const skewed = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a face stamped in the future is stale, not fresh forever',
      skewed.reads === MATCHES * 2 && nameOf(skewed.value, others[0]) === 'Real 00',
      skewed.reads + ' read(s), showing ' + k.show(nameOf(skewed.value, others[0])) +
      ' — treating a negative age as fresh would pin that entry until storage was cleared');

    /* ---- 6. and it must be the right person ----------------------------- */

    const swapped = stored();
    // Person 01's document, filed under person 00's uid. Nothing shipped can
    // write this pair; serving it would put one person's face and name on
    // another person's conversation.
    if (swapped[others[1]]) {
      swapped[others[0]] = { at: Date.now(), doc: JSON.parse(JSON.stringify(swapped[others[1]].doc)) };
    }
    put(swapped);

    const mismatched = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a face filed under somebody else\'s uid is re-read, never shown',
      nameOf(mismatched.value, others[0]) === 'Real 00' && mismatched.reads === MATCHES + 1,
      'conversation with ' + others[0] + ' shows ' + k.show(nameOf(mismatched.value, others[0])) +
      ' in ' + mismatched.reads + ' read(s) — one face re-read, the other four served');

    /* ---- 7. shapes this version did not write --------------------------- */

    put(stored(), 99);

    const versioned = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a cache written by a different version of the shape is ignored whole',
      versioned.reads === MATCHES * 2,
      versioned.reads + ' read(s) — without the stamp, a change to the projection would be read back ' +
      'as the old shape for a whole window');

    globalThis.localStorage.setItem(KEY, 'this is not json {{{');

    // Caught here rather than left to the file's own guard rail, because "not an
    // exception" is half of what this check claims: a `JSON.parse` straight onto
    // the stored string throws out of `getMatches`, and a claim whose failure
    // mode is the spec crashing four checks earlier cannot report itself.
    let corrupt = { reads: -1, value: [], error: null };
    try {
      corrupt = await measure(function () { return k.store.getMatches(me); });
      corrupt.error = null;
    } catch (err) {
      corrupt = { reads: -1, value: [], error: err };
    }
    k.ctx.drainWarnings();

    t.check('and a cache that is not JSON at all costs reads, not an exception',
      !corrupt.error && corrupt.reads === MATCHES * 2 && corrupt.value.length === MATCHES,
      corrupt.error
        ? 'it threw: ' + (corrupt.error.message || String(corrupt.error))
        : corrupt.reads + ' read(s), ' + corrupt.value.length + ' conversation(s)');

    /* ---- 8. bounded, newest kept ---------------------------------------- */

    const held = stored();
    const heldCount = Object.keys(held).length;
    t.check('what a real page load left behind is one entry per conversation',
      heldCount === MATCHES, heldCount + ' entry(s) for ' + MATCHES + ' conversations');

    // Fill it past the bound with faces of people who are not in the list, then
    // make one more real fetch and see what survived.
    //
    // The five real entries are aged on the way in, and that is not decoration:
    // eviction happens when something is filed, and nothing is filed on a load
    // that fetched nothing. Leaving them fresh would mean no fetch, no write, no
    // eviction — and a check that passed against a cache which had quietly grown
    // to fifty-five entries.
    const filler = stored();
    Object.keys(filler).forEach(function (uid) { filler[uid].at = Date.now() - TTL_MS - 1000; });
    for (let i = 0; i < CACHE_MAX + 10; i += 1) {
      const uid = 'face-filler-' + String(i).padStart(3, '0');
      filler[uid] = {
        // Ascending, so "oldest" is well defined and the newest are the last ones.
        at: Date.now() - (CACHE_MAX + 10 - i) * 1000,
        doc: { uid: uid, displayName: 'Filler ' + i }
      };
    }
    const handed = Object.keys(filler).length;
    put(filler);
    await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    const after = stored();
    const names = Object.keys(after);
    t.check('the cache is bounded at ' + CACHE_MAX + ' faces however many it is given',
      names.length === CACHE_MAX,
      names.length + ' entry(s) after being handed ' + handed);

    t.check('and it is the oldest that go, so the conversations just read survive',
      others.every(function (them) { return names.indexOf(them) !== -1; }) &&
        names.indexOf('face-filler-000') === -1,
      'all ' + MATCHES + ' conversations kept: ' +
        others.every(function (them) { return names.indexOf(them) !== -1; }) +
        '; oldest filler evicted: ' + (names.indexOf('face-filler-000') === -1));

    /* ---- 9. storage that will not take it -------------------------------- */

    globalThis.localStorage.removeItem(KEY);
    const realSetItem = globalThis.localStorage.setItem;
    let refused = 0;
    globalThis.localStorage.setItem = function (key) {
      if (key === KEY) { refused += 1; throw new Error('quota exceeded'); }
      return realSetItem.apply(globalThis.localStorage, arguments);
    };
    // Same reason as the corrupt-cache check above: an unguarded `setItem` throws
    // out of `getMatches`, and "still gets its conversations" is precisely the
    // claim that must be able to report its own failure rather than abort the file.
    let full = { reads: -1, value: [], error: null };
    let fullAgain = { reads: -1, value: [], error: null };
    try {
      full = await measure(function () { return k.store.getMatches(me); });
      fullAgain = await measure(function () { return k.store.getMatches(me); });
    } catch (err) {
      full.error = err;
    } finally {
      globalThis.localStorage.setItem = realSetItem;
    }
    k.ctx.drainWarnings();

    t.check('an origin whose storage is full still gets its conversations',
      !full.error && refused > 0 && full.value.length === MATCHES &&
        others.every(function (them) { return nameOf(full.value, them) === 'Real ' + them.slice(-2); }),
      full.error
        ? 'it threw after ' + refused + ' refused write(s): ' + (full.error.message || String(full.error))
        : refused + ' refused write(s), ' + full.value.length + ' conversation(s), all named');

    t.check('it just pays what it paid before the cache existed, every time',
      full.reads === MATCHES * 2 && fullAgain.reads === MATCHES * 2,
      full.reads + ' then ' + fullAgain.reads + ' read(s) — a failed write must cost reads, never names');

    /* ---- 10. a profile that is not there --------------------------------- */

    globalThis.localStorage.removeItem(KEY);
    const ghost = 'face-ghost';
    await k.admin.set('matches', [me, ghost].sort().join('_'), {
      id: [me, ghost].sort().join('_'),
      users: [me, ghost].sort(),
      createdAt: '2026-02-01T00:00:00.000Z',
      lastMessage: null, lastMessageAt: null, unread: {}
    });

    const withGhost = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();
    const ghostAgain = await measure(function () { return k.store.getMatches(me); });
    k.ctx.drainWarnings();

    t.check('a conversation with a deleted account is still listed, once for each load',
      withGhost.value.length === MATCHES + 1 && ghostAgain.value.length === MATCHES + 1,
      withGhost.value.length + ' then ' + ghostAgain.value.length + ' conversation(s)');

    t.check('and its missing profile is not remembered as missing',
      ghostAgain.reads === (MATCHES + 1) + 1 && !(ghost in stored()),
      ghostAgain.reads + ' read(s) on the warm load: ' + (MATCHES + 1) +
      ' rows and one retry for the account with no profile. Caching the miss would ' +
      'make a briefly unreadable profile a permanent "Someone"');

    /* ---- 11. and only the public half is ever written --------------------- */

    const kept = stored()[others[1]];
    const doc = (kept && kept.doc) || {};
    // Values, not keys, and deliberately: `normalizeUser` fills the whole
    // UserDoc shape in, so `email` and `blocked` are PRESENT on the stored copy
    // as '' and []. A check reading "no private keys" would have been false
    // while passing. What is actually true, and what matters, is that no private
    // VALUE crosses — the copy is built from `discovery/{uid}`, which never held
    // one.
    t.check('nothing private reaches the disk: no address, and no block list',
      !!kept && doc.email === '' && Array.isArray(doc.blocked) && doc.blocked.length === 0 &&
        doc.displayName === 'Real 01',
      'stored email ' + k.show(doc.email) + ', stored blocked ' + k.show(doc.blocked) +
      ' — users/' + others[1] + ' holds ' + k.show(others[1] + '@example.com') + ' and ' +
      k.show([me]) + ', so a copy taken from the private half would show them here');
  }
};
