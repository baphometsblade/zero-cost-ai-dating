/* ==========================================================================
   The lost update — the reason this suite exists.

   README used to say the daily counter "can undercount across devices",
   because bumpUsage read the doc, added one, and wrote it back: two swipes
   racing from two tabs both read N and both wrote N+1. These checks fire many
   bumps at one document at once and look at what the *database* holds
   afterwards.

   They must read the stored document, never bumpUsage's return value: a bump
   whose write fails still hands the caller the optimistically computed figure
   (deliberately — a counter must never take the deck down), so asserting on
   the return value would go green against a store that persisted nothing.
   ========================================================================== */
'use strict';

/** How many racers. The README's claim is about two; twenty leaves no doubt. */
const N = 20;

/** [0, 1, … n-1] */
function range(n) {
  return Array.from({ length: n }, function (_, i) { return i; });
}

module.exports = {
  title: 'Concurrent bumps land exactly once each',

  async run(t, k) {
    const today = k.ctx.ZC.util.todayKey();
    const zeros = { date: today, likes: 0, superLikes: 0, rewinds: 0 };

    /* ---- N racers on one counter ---------------------------------------- */

    const uid = 'race-likes';
    await k.admin.set('users', uid, k.h.userDoc(uid, { usage: Object.assign({}, zeros) }));

    const returned = await Promise.all(range(N).map(function () {
      return k.store.bumpUsage(uid, 'likes');
    }));
    const warned = k.ctx.drainWarnings();
    const stored = (await k.admin.get('users', uid) || {}).usage || {};

    t.check(
      N + ' concurrent likes store exactly ' + N,
      stored.likes === N,
      'stored ' + stored.likes + ' of ' + N
    );
    // A transaction that exhausts the SDK's retry budget is caught, warned
    // about and answered optimistically. That is the designed offline path,
    // but under contention it would be a silent undercount, so name it.
    t.check(
      'no bump gave up and fell back to the optimistic figure',
      warned.length === 0,
      warned.length + ' warning(s)' + (warned.length ? ': ' + warned[0] : '')
    );
    // Each committed transaction sees the previous one's number, so the values
    // handed back to the callers are 1..N with nothing repeated — which is
    // what a UI showing "x of 25 likes left" depends on.
    const seen = returned.map(function (u) { return u.likes; }).sort(function (a, b) { return a - b; });
    t.check(
      'the ' + N + ' callers each got a different number, 1..' + N,
      k.same(seen, range(N).map(function (i) { return i + 1; })),
      k.show(seen)
    );

    /* ---- racers on two different counters -------------------------------- */

    // bumpUsage writes the whole `usage` map, not a single field, so a likes
    // bump and a superLikes bump racing each other is the case where a
    // non-transactional write would quietly drop one of the two.
    const mixedUid = 'race-mixed';
    await k.admin.set('users', mixedUid, k.h.userDoc(mixedUid, { usage: Object.assign({}, zeros) }));

    const half = N / 2;
    const mixed = [];
    range(half).forEach(function () {
      mixed.push(k.store.bumpUsage(mixedUid, 'likes'));
      mixed.push(k.store.bumpUsage(mixedUid, 'superLikes'));
    });
    await Promise.all(mixed);
    k.ctx.drainWarnings();
    const both = (await k.admin.get('users', mixedUid) || {}).usage || {};

    t.check(
      'interleaved likes and superLikes both reach ' + half,
      both.likes === half && both.superLikes === half,
      'likes ' + both.likes + ', superLikes ' + both.superLikes
    );
    t.check(
      'the counter nobody touched is still 0 and the day is still today',
      both.rewinds === 0 && both.date === today,
      k.show(both)
    );
  }
};
