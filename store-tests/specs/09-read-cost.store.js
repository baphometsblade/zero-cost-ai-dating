/* ==========================================================================
   What a background refresh costs, counted rather than reasoned about.

   The whole premise of this project is a Firebase Spark project that never
   leaves the free tier, and the free tier's binding limit is 50,000 document
   reads a day. Everything else in the README is a design choice; this one is
   an arithmetic fact about whether the app keeps working.

   `app.js` polls every 20 seconds while the tab is visible, and for an account
   on the premium plan each poll calls `getLikesReceived`. That function used to
   read the caller's **entire swipe history** — every card they have ever passed
   or liked — to work out which of the inbound likes they had already answered.
   The history only grows. At 25 likes a day it is 750 documents inside a month,
   and 180 polls an hour turns that into 135,000 reads an hour: the day's whole
   quota inside half an hour, from one tab left open, doing nothing.

   Reading the code does not make that visible. `getSwipes(uid)` is one line and
   looks like one read. So this spec counts, by wrapping the Firestore the store
   talks to and tallying what every `get()` actually returns.

   The check that matters is a *scaling* property rather than a number: the same
   call, against a history twice as long, must cost the same. A budget written
   as "at most N reads" ages into a lie the first time somebody adds a field; a
   budget written as "does not depend on how long you have used the app" cannot.
   ========================================================================== */
'use strict';

/** Swipes already in the history before the first measurement. */
const HISTORY = 400;

/** How many more are added before the second, identical, measurement. */
const MORE_HISTORY = 400;

/** People who have liked this account and are still waiting for an answer. */
const PENDING = 12;

/** People who liked this account and have already been answered. */
const ANSWERED = 6;

module.exports = {
  title: 'A background refresh does not cost more the longer you have used the app',

  async run(t, k) {
    const me = 'cost-me';

    await k.admin.set('users', me, k.h.userDoc(me));

    /* ---- a history, and an inbox ---------------------------------------- */

    const history = [];
    for (let i = 0; i < HISTORY; i += 1) {
      const them = 'cost-swiped-' + String(i).padStart(4, '0');
      history.push({
        id: me + '_' + them,
        data: { from: me, to: them, action: i % 3 ? 'pass' : 'like', createdAt: '2026-01-01T00:00:00.000Z' }
      });
    }
    await k.admin.setMany('swipes', history);

    // Inbound likes nobody has answered. These are what the badge counts.
    const pending = [];
    for (let i = 0; i < PENDING; i += 1) {
      const them = 'cost-liker-' + String(i).padStart(2, '0');
      pending.push(them);
      await k.admin.set('swipes', them + '_' + me, {
        from: them, to: me, action: i % 4 ? 'like' : 'super', createdAt: '2026-01-02T00:00:00.000Z'
      });
      await k.admin.set('users', them, k.h.userDoc(them));
      await k.admin.set('discovery', them, k.h.discoveryDoc(them));
    }

    // Inbound likes already answered. They must not be counted, and the only
    // way to know is to look at what this account swiped — which is exactly
    // the lookup whose cost this spec is about.
    const answered = [];
    for (let i = 0; i < ANSWERED; i += 1) {
      const them = 'cost-answered-' + String(i).padStart(2, '0');
      answered.push(them);
      await k.admin.set('swipes', them + '_' + me, {
        from: them, to: me, action: 'like', createdAt: '2026-01-02T00:00:00.000Z'
      });
      await k.admin.set('swipes', me + '_' + them, {
        from: me, to: them, action: 'pass', createdAt: '2026-01-03T00:00:00.000Z'
      });
      await k.admin.set('users', them, k.h.userDoc(them));
      await k.admin.set('discovery', them, k.h.discoveryDoc(them));
    }

    /* ---- correctness first ---------------------------------------------- */

    const first = await measure(k, function () { return k.store.getLikesReceived(me); });
    k.ctx.drainWarnings();

    const names = (first.value || []).map(function (user) { return user.uid; }).sort();
    t.check('every unanswered liker is reported',
      k.same(names, pending.slice().sort()), names.length + ' of ' + PENDING + ': ' + k.show(names.slice(0, 3)));

    t.check('and nobody already answered is',
      answered.every(function (uid) { return names.indexOf(uid) === -1; }),
      'answered: ' + k.show(answered));

    /* ---- then the bill --------------------------------------------------- */

    // A history this long is an ordinary month of use, not an extreme.
    //
    // The lower bound is not padding. "Fewer reads than the history is long" is
    // satisfied by a function that reads nothing and returns nothing, so on its
    // own this check passes against a `getLikesReceived` that has been broken
    // rather than fixed — it would be leaning entirely on the two correctness
    // checks above to notice, and a cost check that cannot fail by itself is
    // not evidence about cost. It has to read at least the profiles it returns.
    t.check('the first refresh is cheaper than the history is long',
      first.reads < HISTORY && first.reads >= PENDING,
      first.reads + ' reads in ' + first.calls + ' round-trip(s), against ' + HISTORY +
      ' stored swipes and ' + PENDING + ' profiles to return');

    const more = [];
    for (let i = 0; i < MORE_HISTORY; i += 1) {
      const them = 'cost-later-' + String(i).padStart(4, '0');
      more.push({
        id: me + '_' + them,
        data: { from: me, to: them, action: 'pass', createdAt: '2026-01-04T00:00:00.000Z' }
      });
    }
    await k.admin.setMany('swipes', more);

    const second = await measure(k, function () { return k.store.getLikesReceived(me); });
    k.ctx.drainWarnings();

    t.check('the same refresh still answers the same thing after another ' + MORE_HISTORY + ' swipes',
      (second.value || []).length === PENDING, (second.value || []).length + ' of ' + PENDING);

    // The check this file exists for. Not "under N reads" — a number ages into
    // a lie. Twice the history, the same bill, or the app's cost grows with the
    // one thing guaranteed to grow.
    //
    // Carrying the same floor as the check above, for the same reason: equality
    // between two measurements is satisfied by two measurements of nothing, and
    // a mutation run confirmed it — against a `getLikesReceived` stubbed to
    // return early this read `0 reads at 400 swipes, 0 at 800` and passed.
    t.check('and costs exactly what it cost before, with twice the history behind it',
      second.reads === first.reads && second.reads >= PENDING,
      first.reads + ' reads at ' + HISTORY + ' swipes, ' + second.reads + ' at ' + (HISTORY + MORE_HISTORY));
  }
};

/**
 * Run one call with the store's Firestore swapped for a counting stand-in.
 * @param {Object} k the spec kit
 * @param {Function} fn the call to measure
 * @returns {Promise<{value:*, reads:number, calls:number}>}
 */
async function measure(k, fn) {
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
