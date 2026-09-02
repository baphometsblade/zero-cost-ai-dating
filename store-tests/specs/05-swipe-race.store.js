/* ==========================================================================
   A whole-document write in flight across a counter bump.

   01-concurrency proves that bumps racing bumps all land. This is the other
   shape: `updateUser(uid, patch)` — a read-modify-write of the entire user
   document — overlapping `bumpUsage(uid, field)`. Whichever write reads first
   and commits last wins the fields the other one moved: the counter is lost if
   the profile write lands second, the patch is lost if it lands first. Both
   must survive, and only making *both* writes atomic gets that. None of the
   suite's other specs write to the user document while bumping, so 21 green
   checks said nothing about it.

   This used to be the deck's own ordering, swipe for swipe: persistSwipe left
   persistLearning's `updateUser(uid, {learning})` unawaited across the bump.
   The data always survived — that is what this spec proves — but the price was
   a commit rejected as stale on every like, because two transactions on one
   document cannot both commit against the version they read. Learning is saved
   through `saveLearning` now, a field write with nothing to read. What is left
   here is the overlap nobody sequences: a profile or settings save landing
   while a swipe bumps a counter. The patch below is still shaped like a
   learning map so the payload assertions stay exact.

   Like every spec here this reads the stored document. bumpUsage answers
   optimistically when its write fails and callers routinely swallow an
   updateUser rejection, so neither return value is evidence of anything.
   ========================================================================== */
'use strict';

/**
 * How many overlaps. Twenty is the suite's usual "leaves no doubt" number;
 * this one uses thirty because the review that found the bug measured it at
 * thirty and the number is quoted in the report.
 */
const N = 30;

module.exports = {
  title: 'A document save in flight cannot eat the counter (or be eaten)',

  async run(t, k) {
    const today = k.ctx.ZC.util.todayKey();
    const uid = 'swipe-race';
    await k.admin.set('users', uid, k.h.userDoc(uid, {
      usage: { date: today, likes: 0, superLikes: 0, rewinds: 0 },
      learning: { interestAffinity: {}, likeCount: 0, passCount: 0 }
    }));

    // One document save started and left unawaited, the bump awaited, then the
    // next round. The previous save is settled before the next one starts,
    // which is what makes the *final* stored payload predictable — the race
    // under test is one whole-document write against one bump.
    const rejected = [];
    let docWrite = Promise.resolve();
    for (let i = 1; i <= N; i++) {
      await docWrite;
      const learning = { interestAffinity: { hiking: i }, likeCount: i, passCount: 0 };
      docWrite = k.store.updateUser(uid, { learning: learning }).catch(function (err) {
        rejected.push(err && err.message ? err.message : String(err));
      });
      await k.store.bumpUsage(uid, 'likes');
    }
    await docWrite;

    const warned = k.ctx.drainWarnings();
    const stored = (await k.admin.get('users', uid)) || {};
    const usage = stored.usage || {};
    const learning = stored.learning || {};

    t.check(
      N + ' bumps with a document save in flight store exactly ' + N + ' likes',
      usage.likes === N,
      'stored ' + usage.likes + ' of ' + N
    );
    t.check(
      'the day and the counters nobody spent are untouched',
      usage.date === today && usage.superLikes === 0 && usage.rewinds === 0,
      k.show(usage)
    );
    t.check(
      'and the last save\'s payload is what the document holds',
      learning.likeCount === N && k.same(learning.interestAffinity, { hiking: N }),
      k.show(learning)
    );
    t.check(
      'nothing gave up: no warning, no rejected document write',
      warned.length === 0 && rejected.length === 0,
      warned.length + ' warning(s), ' + rejected.length + ' rejection(s)' +
        (warned.length ? ': ' + warned[0] : '') + (rejected.length ? ': ' + rejected[0] : '')
    );
  }
};
