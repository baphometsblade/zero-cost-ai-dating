/* ==========================================================================
   What opening ANY page costs, before the page does anything of its own.

   Every cost spec before this one measures a page's own work: 09 the
   who-liked-you list, 15 the conversation list, 17 its faces, 18 the deck, 20
   the daily budgets. None of them measured the part every page pays first,
   and it is the part paid most often.

   This app is a set of separate HTML documents, so every navigation is a new
   JavaScript context with a new Firestore SDK — no cache, no resume token,
   because offline persistence is off. On every one of them, before any
   page-specific code runs:

     - `auth.js` resolves the account: `getUser(uid)`, one read;
     - `app.js` subscribes the nav badge, `listenMatches`, whose first snapshot
       is billed for every document in it — one read per conversation, and one
       for an empty result, because a query that matches nothing costs one;
     - on the premium plan, `listenLikesReceived` as well;
     - and `touchActive`, throttled to once per five minutes ACROSS page loads.

   So the floor is `1 + max(1, N)` reads per navigation for N conversations, and
   it is paid again on the next page. That is pinned here as what it is — a cost
   that grows with the number of conversations — rather than as a virtue. The
   checks fail if it gets worse (the badge hydrating profiles would make it
   2N + 1) and they will fail if it gets better, which is the point: a change to
   the most frequently paid number in the app should have to be made on purpose.

   What a fix would take, so nobody has to rediscover it: the badge needs only
   the conversations with something unread, and a match document cannot be
   queried for that today — `unread` is a map keyed by uid, and `users
   array-contains` plus a range on a per-user map key is not an index anybody
   can declare. An `unreadFor` array maintained by `sendMessage` and `markRead`
   (both already write the match document, so it costs no extra writes) would
   let the badge ask `unreadFor array-contains uid` and pay for what is unread
   rather than for everything. That is a schema and rules change, and it is not
   in this round.

   The premium half WAS fixed here. The likes listener asked, per sender, whether
   that like had been answered — one `get` each — and a `get` of a missing
   document is still a read, while a pending like is by definition one whose
   answer is missing. It paid a read per waiting person to learn they were
   waiting: 1 + 2M on every page for M people. It now asks through
   `alreadySwiped`, ten at a time, and a key query bills what it finds.

   And the touch, whose write count `docs/ARCHITECTURE.md` used to hand to
   `specs/19-write-cost.store.js` — which has never called `touchActive`. "A touch
   is TWO writes" had never been executed. It is here.
   ========================================================================== */
'use strict';

/** Wait until `test()` is true, or give up. Deliveries cross a network. */
function until(test, ms) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const timer = setInterval(function () {
      let ok = false;
      try { ok = !!test(); } catch (err) { ok = false; }
      if (ok || Date.now() - started > ms) {
        clearInterval(timer);
        resolve(ok);
      }
    }, 20);
  });
}

module.exports = {
  title: 'What every page pays before it does anything',

  async run(t, k) {
    /**
     * Run one call with the store's Firestore swapped for a counting stand-in.
     * @param {Function} fn what to measure
     * @returns {Promise<{value:*, reads:number, writes:number, wrote:string[]}>}
     */
    async function measure(fn) {
      const real = k.ctx.ZC.firebase.db;
      const tally = { reads: 0, calls: 0, writes: 0, wrote: [] };
      k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
      try {
        const value = await fn();
        return { value: value, reads: tally.reads, writes: tally.writes, wrote: tally.wrote };
      } finally {
        k.ctx.ZC.firebase.db = real;
      }
    }

    /** Seed an account with `n` conversations, and return its uid. */
    async function withConversations(uid, n, over) {
      await k.admin.set('users', uid, Object.assign(k.h.userDoc(uid), over || {}));
      await k.admin.set('discovery', uid, k.h.discoveryDoc(uid));
      const docs = [];
      for (let i = 0; i < n; i += 1) {
        const them = uid + '-c' + String(i).padStart(2, '0');
        docs.push({ id: k.h.pairId(uid, them), data: k.h.matchDoc(uid, them) });
      }
      if (docs.length) await k.admin.setMany('matches', docs);
      return uid;
    }

    /** Seed `n` people who liked `uid`; the first `answered` of them it has liked back. */
    async function withLikers(uid, n, answered) {
      const inbound = [];
      const replies = [];
      for (let i = 0; i < n; i += 1) {
        const them = uid + '-l' + String(i).padStart(2, '0');
        inbound.push({ id: them + '_' + uid, data: { from: them, to: uid, action: i % 4 ? 'like' : 'super', createdAt: '2026-01-02T00:00:00.000Z' } });
        if (i < (answered || 0)) {
          replies.push({ id: uid + '_' + them, data: { from: uid, to: them, action: i % 2 ? 'pass' : 'like', createdAt: '2026-01-03T00:00:00.000Z' } });
        }
      }
      if (inbound.length) await k.admin.setMany('swipes', inbound);
      if (replies.length) await k.admin.setMany('swipes', replies);
    }

    /** One navigation's store work, in the order auth.js and app.js do it. */
    function navigate(uid, premium) {
      return measure(async function () {
        await k.store.getUser(uid);
        let rows = null;
        let likes = premium ? null : 0;
        const stopMatches = k.store.listenMatches(uid, function (r) { rows = r; });
        const stopLikes = premium ? k.store.listenLikesReceived(uid, function (c) { likes = c; }) : null;
        await until(function () { return rows !== null && likes !== null; }, 5000);
        stopMatches();
        if (stopLikes) stopLikes();
        return { rows: rows ? rows.length : -1, likes: likes };
      });
    }

    /* ---- 1. the free floor ---------------------------------------------- */

    const none = await navigate(await withConversations('nav-none', 0), false);
    const four = await navigate(await withConversations('nav-four', 4), false);
    const sixteen = await navigate(await withConversations('nav-sixteen', 16), false);
    k.ctx.drainWarnings();

    t.check('a navigation with no conversations is two reads: the account, and an empty badge query',
      none.reads === 2 && none.value.rows === 0,
      none.reads + ' read(s), ' + none.value.rows + ' row(s)');
    t.check('and it is the account plus one read per conversation — 5 at four, 17 at sixteen',
      four.reads === 1 + 4 && sixteen.reads === 1 + 16 &&
      four.value.rows === 4 && sixteen.value.rows === 16,
      'four: ' + four.reads + ', sixteen: ' + sixteen.reads);
    t.check('it grows by exactly one read per conversation, no more — the badge carries no profiles',
      sixteen.reads - four.reads === 16 - 4,
      (sixteen.reads - four.reads) + ' read(s) for 12 more conversations');

    /* ---- 2. the touch ---------------------------------------------------- */

    // `03-writes` executes the throttle's timing; this executes its count, which
    // the documentation asserted and nothing ran.
    const toucher = await withConversations('nav-touch', 0);
    try {
      if (globalThis.localStorage) globalThis.localStorage.removeItem(k.store.KEYS.lastTouch || 'zc.lastTouch');
    } catch (err) { /* storage is the throttle's business, not this check's */ }
    const firstTouch = await measure(function () { return k.store.touchActive(toucher); });
    const secondTouch = await measure(function () { return k.store.touchActive(toucher); });
    k.ctx.drainWarnings();

    t.check('the first touch of a session is two writes: the account and its public projection',
      firstTouch.value === true && firstTouch.writes === 2 &&
      k.same(firstTouch.wrote.slice().sort(), ['discovery/' + toucher + ':update', 'users/' + toucher + ':update']),
      firstTouch.writes + ' write(s): ' + k.show(firstTouch.wrote));
    t.check('and the next page inside five minutes writes nothing, and reads nothing',
      secondTouch.value === false && secondTouch.writes === 0 && secondTouch.reads === 0,
      secondTouch.writes + ' write(s), ' + secondTouch.reads + ' read(s)');

    /* ---- 3. the premium half: who liked you ------------------------------ */

    // M + 1 + ceil(M / 10) for M people waiting and nobody answered: the inbound
    // likes themselves, the account once for its block list, and one key query
    // per ten senders that finds nothing. It was 1 + 2M.
    const premium = { plan: 'premium' };

    const quiet = await withConversations('nav-p0', 0, premium);
    const quietNav = await navigate(quiet, true);

    const three = await withConversations('nav-p3', 0, premium);
    await withLikers(three, 3, 0);
    const threeNav = await navigate(three, true);

    const twelve = await withConversations('nav-p12', 0, premium);
    await withLikers(twelve, 12, 0);
    const twelveNav = await navigate(twelve, true);
    k.ctx.drainWarnings();

    // Each navigate() also reads the account and an empty badge query: 2 reads
    // that are the free floor, not the likes.
    const likesOf = function (nav) { return nav.reads - 2; };

    t.check('nobody waiting: the likes listener is one read',
      likesOf(quietNav) === 1 && quietNav.value.likes === 0,
      likesOf(quietNav) + ' read(s), count ' + quietNav.value.likes);
    t.check('three waiting: the three likes, the account, and ONE lookup — five, not seven',
      likesOf(threeNav) === 3 + 1 + 1 && threeNav.value.likes === 3,
      likesOf(threeNav) + ' read(s), count ' + threeNav.value.likes);
    t.check('twelve waiting: twelve likes, the account, and TWO lookups — fifteen, not twenty-five',
      likesOf(twelveNav) === 12 + 1 + 2 && twelveNav.value.likes === 12,
      likesOf(twelveNav) + ' read(s), count ' + twelveNav.value.likes);

    // The saving is worthless if it miscounts. Half of these were answered —
    // liked back or passed on — and an answered like is not waiting. The batch
    // FINDS those, and a found document is a billed read, so this costs more
    // than the all-pending case, and the count must still be the six.
    const mixed = await withConversations('nav-pmix', 0, premium);
    await withLikers(mixed, 12, 6);
    const mixedNav = await navigate(mixed, true);
    k.ctx.drainWarnings();

    t.check('answered likes are found and excluded: twelve liked, six answered, six waiting',
      mixedNav.value.likes === 6,
      'count ' + mixedNav.value.likes);
    // Twelve senders are two batches, ten and two. The six answered are the
    // first six, so the first batch finds six (six reads) and the second finds
    // nothing and still pays its floor (one). An earlier draft of this check
    // expected 12 + 1 + 6 and forgot that floor; the emulator did not.
    t.check('and the found answers are what the extra reads paid for — 12 + 1 + 6 found + 1 empty batch',
      likesOf(mixedNav) === 12 + 1 + 6 + 1,
      likesOf(mixedNav) + ' read(s)');
  }
};
