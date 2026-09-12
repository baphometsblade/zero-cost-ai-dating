/* ==========================================================================
   What it costs to ask "have I got any likes left?"

   `specs/09-read-cost.store.js` counts what opening a page costs and
   `specs/18-deck-cost.store.js` what filling the deck costs. Both measure a
   list. This one measures the smallest question in the app — one number out of
   one document — and it was, per swipe, the most expensive thing the deck did.

   The deck consults the daily counters twice around every card:

     - once BEFORE the spend, `checkBudget(field)` in dashboard.js, so a swipe
       past the limit is refused before anything is written;
     - once AFTER it, `refreshBudgets()`, which repaints the hint, the limit
       banner and the buttons and therefore needs all three fields.

   Every one of those answers comes out of `users/{uid}`, and every one of them
   used to fetch it afresh. `canSpend` read the document twice on its own — once
   for the plan, once more inside `getUsage` for the counters — and
   `refreshBudgets` called it three times in a `Promise.all`. A like was eight
   reads of one document that had not changed between the first and the eighth.

   Eight is not a number anybody chose; it is two functions each doing the
   obvious thing. That is what makes it worth a spec rather than a comment: the
   cost is invisible at both call sites, and `getUsage` re-reading a document
   its caller is already holding looks like nothing at all in a diff.

   The properties pinned here are the ones that survive a refactor:

     - one budget question is ONE read, whatever it asks about;
     - all three budgets together are also one read, so the cost does not grow
       with the number of counters the app decides to keep;
     - the batch and the single answer AGREE, field for field — the whole
       saving is worthless if it comes with a second opinion;
     - the day roll-over still persists, and now happens once rather than once
       per field asked about.

   Writing this spec cost the instrument a correction. `harness.countingDb` did
   not count a transaction's own `tx.get`, and its header defended the omission
   on two grounds: that nothing measured with the helper used one, and that
   counting them would move numbers in five specs. The first was never true —
   the roll-over is a transaction, and so is every counted swipe — and the
   second had never been executed: counting them moves no number this suite
   asserts. So they are counted now, and the roll-over checks below can say what
   the day's first question really costs instead of rounding it down.
   ========================================================================== */
'use strict';

/** The counters the app keeps, and the order `refreshBudgets` wants them in. */
const FIELDS = ['likes', 'superLikes', 'rewinds'];

module.exports = {
  title: 'A budget question costs one read, and so do all three',

  async run(t, k) {
    const util = k.ctx.ZC.util;
    const today = util.todayKey();
    const yesterday = util.todayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

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

    /** A user whose counters already belong to today, so nothing rolls over. */
    function settled(uid, usage) {
      return k.h.userDoc(uid, {
        usage: Object.assign({ date: today, likes: 0, superLikes: 0, rewinds: 0 }, usage || {})
      });
    }

    /* ---- 1. one question, one read -------------------------------------- */

    const me = 'spend-me';
    await k.admin.set('users', me, settled(me, { likes: 4 }));

    const one = await measure(function () { return k.store.canSpend(me, 'likes'); });
    k.ctx.drainWarnings();

    t.check('one budget question is one read of users/{uid}',
      one.reads === 1,
      one.reads + ' read(s)');
    t.check('and it still answers from the stored counter',
      one.value.allowed === true && one.value.remaining === 21 && one.value.limit === 25,
      k.show(one.value));

    /* ---- 2. three questions, still one read ------------------------------ */

    const all = await measure(function () { return k.store.canSpendAll(me); });
    k.ctx.drainWarnings();

    t.check('every budget at once is also one read, not one per field',
      all.reads === 1,
      all.reads + ' read(s) for ' + FIELDS.length + ' fields');
    t.check('and it answers about every counter the app keeps',
      k.same(Object.keys(all.value).sort(), FIELDS.slice().sort()),
      k.show(Object.keys(all.value)));

    /* ---- 3. the batch and the single answer agree ------------------------ */

    // Asked separately, which is what the deck used to do. The saving is only
    // worth having if the cheap answer is the same answer.
    const separately = {};
    for (const field of FIELDS) {
      separately[field] = await k.store.canSpend(me, field);
    }
    k.ctx.drainWarnings();

    t.check('canSpendAll agrees with canSpend, field for field',
      FIELDS.every(function (field) { return k.same(all.value[field], separately[field]); }),
      k.show({ batch: all.value, one: separately }));

    /* ---- 4. what a swipe now costs in budget reads ----------------------- */

    // The deck's real sequence around one card: the check before the spend,
    // then the repaint after it. This used to be 2 + 6.
    const swipe = await measure(function () {
      return k.store.canSpend(me, 'likes')
        .then(function () { return k.store.canSpendAll(me); });
    });
    k.ctx.drainWarnings();

    t.check('a swipe asks about budgets twice and pays for two reads, not eight',
      swipe.reads === 2,
      swipe.reads + ' read(s)');

    /* ---- 5. the premium plan still lifts the limit through the batch ----- */

    const rich = 'spend-premium';
    await k.admin.set('users', rich, Object.assign(settled(rich), { plan: 'premium' }));
    const premium = await measure(function () { return k.store.canSpendAll(rich); });
    k.ctx.drainWarnings();

    t.check('the batch reads the plan off the same document it counts from',
      premium.reads === 1 &&
      premium.value.likes.plan === 'premium' &&
      premium.value.rewinds.allowed === true &&
      separately.rewinds.allowed === false,
      k.show({ premium: premium.value.likes, freeRewinds: separately.rewinds }));

    /* ---- 6. the roll-over still happens, and still persists -------------- */

    // Yesterday finished at the ceiling, so anything that leaks across midnight
    // is loud rather than subtle.
    const spent = { date: yesterday, likes: 25, superLikes: 1, rewinds: 3 };

    const stale = 'spend-stale';
    await k.admin.set('users', stale, k.h.userDoc(stale, { usage: Object.assign({}, spent) }));
    const rolled = await measure(function () { return k.store.canSpend(stale, 'likes'); });
    k.ctx.drainWarnings();
    const afterOne = (await k.admin.get('users', stale) || {}).usage || {};

    t.check('canSpend on a new day still sees the new day, not yesterday at the limit',
      rolled.value.allowed === true && rolled.value.remaining === 25,
      k.show(rolled.value));
    t.check('and still persists the reset, through the transaction a bump takes',
      rolled.writes === 1 && k.same(rolled.wrote, ['tx:users/' + stale + ':update']) &&
      afterOne.date === today && afterOne.likes === 0,
      k.show({ wrote: rolled.wrote, stored: afterOne }));
    // Two, not one: the document itself, and then the transaction's own read of
    // it. That second read is what the counter used to report as free.
    t.check("the day's first question costs the read AND the transaction's read",
      rolled.reads === 2,
      rolled.reads + ' read(s)');

    /* ---- 7. the batch rolls the day over ONCE ---------------------------- */

    // Midnight is where this change stops being only about reads. Three fields
    // answered from one snapshot means ONE roll-over; the three parallel
    // `canSpend` calls it replaces each found the same stale record — they are
    // in flight together, so none of them can see another's reset — and each
    // fired its own transaction. Three contended writes for one midnight, on
    // the first repaint of every day.
    //
    // Both halves are measured here rather than one asserted and the other
    // remembered: a check that names a comparison and only performs half of it
    // is the kind that goes on passing after the thing it compares against has
    // changed underneath it.
    const staleAll = 'spend-stale-all';
    await k.admin.set('users', staleAll, k.h.userDoc(staleAll, { usage: Object.assign({}, spent) }));
    const rolledAll = await measure(function () { return k.store.canSpendAll(staleAll); });
    k.ctx.drainWarnings();
    const afterAll = (await k.admin.get('users', staleAll) || {}).usage || {};

    const staleEach = 'spend-stale-each';
    await k.admin.set('users', staleEach, k.h.userDoc(staleEach, { usage: Object.assign({}, spent) }));
    const rolledEach = await measure(function () {
      return Promise.all(FIELDS.map(function (field) { return k.store.canSpend(staleEach, field); }));
    });
    k.ctx.drainWarnings();

    // The write counts are exact: one transaction each, all of which commit.
    // The read counts are not, on the field-by-field side, and deliberately are
    // not asserted as if they were — three transactions contending for one
    // document retry, and a retried attempt really did pay for the read it
    // made. Six is the floor (a fetch and a transaction read apiece); eight is
    // what this emulator does. A floor is the honest shape for a number whose
    // excess depends on how a race went.
    t.check('a new day costs the batch one roll-over write; asking field by field cost one each',
      rolledAll.writes === 1 && k.same(rolledAll.wrote, ['tx:users/' + staleAll + ':update']) &&
      rolledEach.writes === FIELDS.length,
      'batch ' + rolledAll.writes + ' write(s), field by field ' + rolledEach.writes);
    t.check('and the batch reads twice where field by field read at least six times',
      rolledAll.reads === 2 && rolledEach.reads >= 2 * FIELDS.length,
      'batch ' + rolledAll.reads + ' read(s), field by field ' + rolledEach.reads);
    // Nothing spent today means every counter is back at its own ceiling —
    // which for `rewinds` on the free plan is zero, so "allowed" is the wrong
    // property to check and `remaining === limit` is the right one.
    t.check('and every field in the batch reports the reset day',
      FIELDS.every(function (field) {
        return rolledAll.value[field].remaining === rolledAll.value[field].limit;
      }) &&
      rolledAll.value.likes.remaining === 25 && rolledAll.value.superLikes.remaining === 1 &&
      afterAll.date === today && afterAll.likes === 0,
      k.show({ answers: rolledAll.value, stored: afterAll }));

    /* ---- 8. spending moves the batch's answer --------------------------- */

    // A counter nothing reads back is not a counter. This is the check that
    // fails if `canSpendAll` ever answers from anything but the stored record.
    await k.store.bumpUsage(me, 'likes', 3);
    const after = await measure(function () { return k.store.canSpendAll(me); });
    k.ctx.drainWarnings();

    t.check('a bump shows up in the batch answer, at the same one-read price',
      after.reads === 1 && after.value.likes.remaining === 18,
      k.show(after.value.likes) + ' in ' + after.reads + ' read(s)');

    /* ---- 9. no account, no invented budget ------------------------------- */

    // `canSpend` has always answered for a uid with no document — the deck asks
    // before auth has necessarily written one — and the batch must not differ.
    const ghost = 'spend-ghost';
    const missing = await measure(function () { return k.store.canSpendAll(ghost); });
    const noisy = k.ctx.drainWarnings();
    const ghostOne = await k.store.canSpend(ghost, 'likes');
    k.ctx.drainWarnings();

    // Silence is part of the contract, not decoration. The roll-over is skipped
    // for a document that is not there — `bumpUsage` would be an `update` on a
    // missing reference, which Firestore refuses — and the refusal is reported
    // through `console.warn`. So "no warning" is how a check can tell "we knew
    // there was nothing to reset" apart from "we tried anyway and it failed
    // quietly", which are indistinguishable from the answer alone.
    t.check('an account that does not exist gets the free plan from both, writes nothing, warns about nothing',
      k.same(missing.value.likes, ghostOne) && missing.value.likes.plan === 'free' &&
      missing.writes === 0 && noisy.length === 0,
      k.show({ batch: missing.value.likes, one: ghostOne, writes: missing.writes, warned: noisy.length }));
  }
};
