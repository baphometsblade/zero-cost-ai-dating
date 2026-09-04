/* ==========================================================================
   The who-liked-you count is live, correct, and costs what changed.

   Its query is `swipes where to == me`, which has a blind spot the poll it
   replaced did not: it never fires when *I* answer somebody, because my swipe
   is aimed the other way. The first version of this listener therefore kept
   counting a person after I had passed on them — until something unrelated
   moved or the page reloaded. That is a correctness regression paid for a cost
   win, which is not a trade worth making, and it is the check below that found
   it:

     PASS  the three waiting likes are counted        [[3]]
     FAIL  answering one takes it off the count       [[3]]

   The fix costs nothing: `recordSwipe` already knows it answered somebody, so
   it says so directly rather than the listener spending a read to find out.

   The cost claim is the other half. Whether each sender has been answered is
   remembered rather than recomputed, so a new inbound like costs one read for
   the change, one for the sender's own record, and one for the block list —
   three, whether eight people have liked this account or eight hundred.
   ========================================================================== */
'use strict';

/** People who have liked this account before the measurement starts. */
const WAITING = 8;

/** Long enough for a snapshot and the lookups it triggers. */
const SETTLE_MS = 1200;

/** @returns {Promise<void>} */
function settle(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || SETTLE_MS); });
}

module.exports = {
  title: 'A live like count is corrected by this client, and costs what changed',

  async run(t, k) {
    const me = 'likes-me';
    await k.admin.set('users', me, k.h.userDoc(me));

    const likers = [];
    for (let i = 0; i < WAITING; i += 1) {
      const them = 'likes-them-' + String(i).padStart(2, '0');
      likers.push(them);
      await k.admin.set('users', them, k.h.userDoc(them));
      await k.admin.set('swipes', them + '_' + me, {
        id: them + '_' + me, from: them, to: me, action: i % 3 ? 'like' : 'super',
        createdAt: '2026-01-02T00:00:00.000Z'
      });
    }

    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);

    const seen = [];
    let stop = function () { /* replaced below */ };
    try {
      stop = k.store.listenLikesReceived(me, function (count) { seen.push(count); });
      await settle();
      k.ctx.drainWarnings();

      t.check('everyone still waiting is counted',
        seen[seen.length - 1] === WAITING, k.show(seen));

      // The query itself, one lookup per sender, and one for the block list.
      t.check('subscribing costs the senders plus one lookup each, and the blocks once',
        tally.reads === WAITING * 2 + 1,
        tally.reads + ' reads for ' + WAITING + ' waiting');

      /* ---- this client answering somebody ------------------------------- */

      const before = tally.reads;
      const deliveries = seen.length;
      await k.store.recordSwipe(me, likers[0], 'pass');
      await settle();
      k.ctx.drainWarnings();

      t.check('answering one takes it off the count',
        seen.length > deliveries && seen[seen.length - 1] === WAITING - 1, k.show(seen));

      // recordSwipe does its own reads; what matters is that the *listener*
      // spends none, because the swipe it needs to know about is the one this
      // client just wrote.
      t.check('and the count itself costs no read to correct',
        tally.reads - before <= 2,
        (tally.reads - before) + ' read(s), all of them recordSwipe\'s own');

      /* ---- and a rewind putting it back --------------------------------- */

      await k.store.undoSwipe(me, likers[0]);
      await settle();
      k.ctx.drainWarnings();

      t.check('a rewind puts them back on the count',
        seen[seen.length - 1] === WAITING, k.show(seen.slice(-3)));

      /* ---- somebody new liking this account ----------------------------- */

      const beforeNew = tally.reads;
      const newcomer = 'likes-newcomer';
      await k.admin.set('users', newcomer, k.h.userDoc(newcomer));
      await k.admin.set('swipes', newcomer + '_' + me, {
        id: newcomer + '_' + me, from: newcomer, to: me, action: 'like',
        createdAt: '2026-01-03T00:00:00.000Z'
      });
      await settle();
      k.ctx.drainWarnings();

      t.check('a new like is counted', seen[seen.length - 1] === WAITING + 1, k.show(seen.slice(-2)));

      // The check that would fail if the answered set were recomputed from
      // scratch on every delivery: this would be WAITING + 2 reads instead.
      t.check('and costs three reads however many were already waiting',
        tally.reads - beforeNew === 3,
        (tally.reads - beforeNew) + ' read(s) with ' + WAITING + ' already there');
    } finally {
      stop();
      k.ctx.ZC.firebase.db = real;
    }
  }
};
