/* ==========================================================================
   The other half of the swipe.

   01-concurrency proves that bumps racing bumps all land. But a swipe is not
   only a bump: dashboard.js persistSwipe calls persistLearning(), which fires
   `updateUser(uid, {learning})` and deliberately does **not** await it — the
   deck must never wait on personalisation — and then awaits
   `bumpUsage(uid, field)`. So every single like has a whole-document write in
   flight across the transaction that increments the counter.

   That is the case the rest of this suite missed: none of its specs write to
   the user document while bumping, so 21 green checks said nothing about the
   ordering the shipped app actually performs. Whichever write reads first and
   commits last wins the fields the other one moved — the counter is lost if
   the profile write lands second, the learning is lost if it lands first.
   Both must survive, and only making *both* writes atomic gets that.

   Like every spec here this reads the stored document. bumpUsage answers
   optimistically when its write fails and updateUser's rejection is swallowed
   by dashboard.js, so neither return value is evidence of anything.
   ========================================================================== */
'use strict';

/**
 * How many swipes. Twenty is the suite's usual "leaves no doubt" number; this
 * one uses thirty because the review that found the bug measured it at thirty
 * and the number is quoted in the report.
 */
const N = 30;

module.exports = {
  title: 'A learning save in flight cannot eat the counter (or be eaten)',

  async run(t, k) {
    const today = k.ctx.ZC.util.todayKey();
    const uid = 'swipe-race';
    await k.admin.set('users', uid, k.h.userDoc(uid, {
      usage: { date: today, likes: 0, superLikes: 0, rewinds: 0 },
      learning: { interestAffinity: {}, likeCount: 0, passCount: 0 }
    }));

    // dashboard.js persistSwipe, in its exact order: the learning write is
    // started and left unawaited, the bump is awaited, then the next swipe.
    // The previous swipe's learning write is settled before the next one
    // starts, which is what makes the *final* stored payload predictable —
    // the race under test is one learning write against one bump, which is
    // the one the deck actually performs.
    const rejected = [];
    let learningWrite = Promise.resolve();
    for (let i = 1; i <= N; i++) {
      await learningWrite;
      const learning = { interestAffinity: { hiking: i }, likeCount: i, passCount: 0 };
      learningWrite = k.store.updateUser(uid, { learning: learning }).catch(function (err) {
        rejected.push(err && err.message ? err.message : String(err));
      });
      await k.store.bumpUsage(uid, 'likes');
    }
    await learningWrite;

    const warned = k.ctx.drainWarnings();
    const stored = (await k.admin.get('users', uid)) || {};
    const usage = stored.usage || {};
    const learning = stored.learning || {};

    t.check(
      N + ' swipes with a learning save in flight store exactly ' + N + ' likes',
      usage.likes === N,
      'stored ' + usage.likes + ' of ' + N
    );
    t.check(
      'the day and the counters nobody spent are untouched',
      usage.date === today && usage.superLikes === 0 && usage.rewinds === 0,
      k.show(usage)
    );
    t.check(
      "and the last swipe's learning payload is what the document holds",
      learning.likeCount === N && k.same(learning.interestAffinity, { hiking: N }),
      k.show(learning)
    );
    t.check(
      'nothing gave up: no warning, no rejected learning write',
      warned.length === 0 && rejected.length === 0,
      warned.length + ' warning(s), ' + rejected.length + ' rejection(s)' +
        (warned.length ? ': ' + warned[0] : '') + (rejected.length ? ': ' + rejected[0] : '')
    );
  }
};
