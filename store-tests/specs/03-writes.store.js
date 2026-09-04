/* ==========================================================================
   What one swipe costs.

   The old bumpUsage went through updateUser, which rewrites the whole user
   document and then mirrors it to discovery/{uid}. So every single swipe was
   two document writes, the second of them re-publishing a public projection
   that deliberately does not — and cannot — contain `usage`. On a free tier
   whose entire thesis is staying inside a quota, that is worth locking down
   with a test rather than a comment.

   These checks watch the database around a bump: what changed, what did not,
   and what happens when there is nothing to bump.
   ========================================================================== */
'use strict';

module.exports = {
  title: 'A bump writes the usage field and nothing else',

  async run(t, k) {
    const today = k.ctx.ZC.util.todayKey();
    const zeros = { date: today, likes: 0, superLikes: 0, rewinds: 0 };

    /* ---- the user document ---------------------------------------------- */

    const uid = 'writes-user';
    await k.admin.set('users', uid, k.h.userDoc(uid, { usage: Object.assign({}, zeros) }));
    const before = await k.admin.get('users', uid);

    await k.store.bumpUsage(uid, 'likes');
    k.ctx.drainWarnings();
    const after = await k.admin.get('users', uid);

    const changed = Object.keys(after).filter(function (key) {
      return !k.same(after[key], before[key]);
    });
    t.check(
      'exactly one field of the user document moved, and it is `usage`',
      k.same(changed, ['usage']),
      'changed: ' + k.show(changed)
    );
    // Deliberate: a counter is not a profile edit, so a swipe no longer looks
    // like one to anything that reads updatedAt.
    t.check(
      'updatedAt is not restamped by a swipe',
      after.updatedAt === before.updatedAt,
      before.updatedAt + ' -> ' + after.updatedAt
    );

    /* ---- the public projection ------------------------------------------ */

    const mirrorUid = 'writes-mirror';
    await k.admin.set('users', mirrorUid, k.h.userDoc(mirrorUid, { usage: Object.assign({}, zeros) }));
    // The projection is seeded deliberately out of step with the user document
    // it mirrors. Comparing a faithful mirror before and after would prove
    // nothing — `usage` is not in the projection, so re-publishing it produces
    // an identical document and the extra write hides. A stale displayName only
    // survives if nothing republished the projection at all.
    await k.admin.set('discovery', mirrorUid, k.h.discoveryDoc(mirrorUid, { displayName: 'A stale projection' }));
    const projectionBefore = await k.admin.get('discovery', mirrorUid);

    await k.store.bumpUsage(mirrorUid, 'likes');
    k.ctx.drainWarnings();
    const projectionAfter = await k.admin.get('discovery', mirrorUid);

    t.check(
      'a swipe does not republish the public projection',
      k.same(projectionAfter, projectionBefore),
      'displayName ' + k.show((projectionAfter || {}).displayName)
    );

    // Sharper than comparing contents: if a bump still mirrored the user doc,
    // a missing projection would be created by it. It must stay missing.
    const quietUid = 'writes-quiet';
    await k.admin.set('users', quietUid, k.h.userDoc(quietUid, { usage: Object.assign({}, zeros) }));
    await k.store.bumpUsage(quietUid, 'superLikes');
    k.ctx.drainWarnings();

    t.check(
      'a swipe does not conjure a discovery document that was not there',
      (await k.admin.get('discovery', quietUid)) === null,
      'discovery/' + quietUid
    );

    /* ---- nothing to bump ------------------------------------------------- */

    // Also deliberate: the old updateUser path would have created a phantom
    // user document here. The transaction updates or it does nothing.
    const ghost = 'writes-ghost';
    const optimistic = await k.store.bumpUsage(ghost, 'likes');
    const warned = k.ctx.drainWarnings();

    t.check(
      'bumping a uid with no user document stores nothing',
      (await k.admin.get('users', ghost)) === null,
      'users/' + ghost
    );
    t.check(
      'the failure is a warning, not a thrown error',
      warned.length === 1,
      k.show(warned)
    );
    t.check(
      'and the caller still gets a usable count back',
      k.same({ date: optimistic.date, likes: optimistic.likes, superLikes: optimistic.superLikes, rewinds: optimistic.rewinds },
        { date: today, likes: 1, superLikes: 0, rewinds: 0 }),
      k.show(optimistic)
    );

    /* ---- nothing to bump, for the other reason --------------------------- */

    // The ghost above is one kind of "no record": the read landed and there
    // was genuinely no document, so 1 is this account's first like and the
    // check just above is right to pin it. Offline is the opposite kind — the
    // read never landed, so the count is not known to be zero, and answering 1
    // would tell someone who had spent twelve likes today that their budget
    // was untouched. Same null, opposite answers; a suite that only covered
    // the first would let the second regress silently.
    const offlineUid = 'writes-offline';
    await k.admin.set('users', offlineUid, k.h.userDoc(offlineUid, {
      usage: { date: today, likes: 12, superLikes: 0, rewinds: 0 }
    }));
    // The deck reads the user before every swipe, which is what leaves the
    // document in the SDK's local cache for the offline path to fall back on.
    await k.store.getUsage(offlineUid);

    // The failure is injected rather than staged. `db.disableNetwork()` looks
    // like the honest way to do this and is not: transactions issue their RPCs
    // through the datastore directly, so a bump still commits with the network
    // "off" (measured — it stored 13). Rejecting the transaction is what being
    // offline actually does to this call, and everything under test after that
    // point is the shipped catch branch.
    const hadOwn = Object.prototype.hasOwnProperty.call(k.ctx.db, 'runTransaction');
    const realRunTransaction = k.ctx.db.runTransaction;
    k.ctx.db.runTransaction = function () {
      return Promise.reject(new Error('Failed to get document because the client is offline.'));
    };
    let offline = null;
    let offlineWarned = [];
    try {
      offline = await k.store.bumpUsage(offlineUid, 'likes');
      offlineWarned = k.ctx.drainWarnings();
    } finally {
      if (hadOwn) k.ctx.db.runTransaction = realRunTransaction;
      else delete k.ctx.db.runTransaction;
    }
    const offlineStored = (await k.admin.get('users', offlineUid) || {}).usage || {};

    t.check(
      'an offline bump counts on from the last known day, not from a fresh one',
      offline.likes === 13 && offline.date === today,
      k.show(offline)
    );
    t.check(
      'and it warned instead of throwing, having stored nothing',
      offlineWarned.length === 1 && offlineStored.likes === 12,
      offlineWarned.length + ' warning(s), stored ' + offlineStored.likes
    );

    /* ---- the presence write, and the throttle docs/ARCHITECTURE.md claims -- */

    // > `touchActive` is throttled to one write per five minutes, because
    // > `lastActiveAt` feeds the activity score but is not worth a write per
    // > navigation.   — docs/ARCHITECTURE.md
    //
    // A sentence, and nothing executing it. `touchActive` is called on every
    // auth resolution and on every page that resolves a user, so without the
    // throttle a browsing session is a Firestore write per navigation, against a
    // free tier's daily write allowance. It is also the only interesting logic
    // that lives in the *facade* rather than in either adapter, which is why
    // neither this suite nor the demo unit tests had ever touched it.
    const touchUid = 'writes-touch';
    await k.admin.set('users', touchUid, k.h.userDoc(touchUid, { lastActiveAt: null }));

    const firstTouch = await k.store.touchActive(touchUid);
    const afterFirst = (await k.admin.get('users', touchUid) || {}).lastActiveAt;
    t.check('the first touch writes, because nothing is known about this account yet',
      firstTouch === true && typeof afterFirst === 'string',
      k.show({ returned: firstTouch, stored: afterFirst }));

    const secondTouch = await k.store.touchActive(touchUid);
    const afterSecond = (await k.admin.get('users', touchUid) || {}).lastActiveAt;
    t.check('a touch straight after it does not write, and says so',
      secondTouch === false && afterSecond === afterFirst,
      k.show({ returned: secondTouch, unchanged: afterSecond === afterFirst }));

    // And the other half of the claim: the throttle is a window, not a latch.
    // Five minutes is too long to wait and too specific to guess at, so the
    // clock is moved instead — `touchActive` reads `Date.now()` when it is
    // called, so this is the shipped comparison running against a later now.
    const realNow = Date.now;
    let advanced;
    try {
      const jump = realNow() + 5 * 60 * 1000 + 1000;
      Date.now = function () { return jump; };
      advanced = await k.store.touchActive(touchUid);
    } finally {
      Date.now = realNow;
    }
    const afterJump = (await k.admin.get('users', touchUid) || {}).lastActiveAt;
    t.check('but once the five minutes are up it writes again',
      advanced === true && afterJump !== afterFirst,
      k.show({ returned: advanced, moved: afterJump !== afterFirst }));

    // And the half that makes the throttle a throttle in THIS app. Every page here
    // is its own HTML document, so every navigation is a fresh JS context. While
    // the last-write times lived in a module-level `{}`, that map was empty again
    // on each page and `app.js` calls `touchActive` on every page that resolves a
    // user: six pages in a minute was six writes, against a documented bound of one
    // per five minutes. The bound held only within a single page — the one case it
    // was not needed for.
    //
    // They live in `localStorage` now, so the proof is that changing what is STORED
    // changes the answer. A fresh page has fresh memory and the same storage, which
    // is exactly this.
    const KEY = k.ctx.ZC.store.KEYS.lastTouch;
    const held = JSON.parse(globalThis.localStorage.getItem(KEY) || '{}');
    t.check('the throttle remembers in storage, not only in memory',
      typeof held[touchUid] === 'number',
      KEY + ' = ' + k.show(held));

    held[touchUid] = Date.now() - (5 * 60 * 1000 + 1000);
    globalThis.localStorage.setItem(KEY, JSON.stringify(held));
    const afterAging = await k.store.touchActive(touchUid);
    t.check('and reads it back, so a new page throttles on what the last one wrote',
      afterAging === true,
      'aged the stored stamp past the window and the next touch ' +
      (afterAging ? 'wrote, as a fresh page would' : 'did NOT write — memory won over storage'));
  }
};
