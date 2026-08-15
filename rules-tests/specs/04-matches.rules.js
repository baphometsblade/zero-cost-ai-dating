/* matches/{a_b} — and the reciprocal-like proof.

   The interesting rule here came out of PR #2's review: creating a match
   requires that the other person has ALREADY liked you. Without it, any
   signed-in account could mint a match against a uid found through the
   deliberately-open discovery collection and then message a stranger, since
   message writes are gated purely on membership of the match. That attack is
   the first thing this spec tries. */
'use strict';

module.exports = {
  title: 'matches/{a_b} — participants only, and only with a reciprocal like',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const LIKER = 'liker';        // has liked me
    const STRANGER = 'stranger';  // has not
    const THIRD = 'third';
    const FOURTH = 'fourth';

    await seed(async function (admin) {
      const db = admin.firestore();
      // Only LIKER has aimed a like at ME.
      await db.doc('swipes/' + LIKER + '_' + ME).set(h.swipeDoc(LIKER, ME, 'like'));
      await db.doc('swipes/' + STRANGER + '_' + ME).set(h.swipeDoc(STRANGER, ME, 'pass'));
      // THIRD has liked ME. That satisfies the reciprocal-like precondition for
      // a THIRD/FOURTH match, so the participant check below is the ONLY thing
      // left to deny it — otherwise the test would pass for the wrong reason.
      await db.doc('swipes/' + THIRD + '_' + ME).set(h.swipeDoc(THIRD, ME, 'like'));
      // A match between two other people, for the outsider checks.
      await db.doc('matches/' + h.pairId(THIRD, FOURTH)).set(h.matchDoc(THIRD, FOURTH));
    });

    /* ---- the attack the rule exists to stop ---- */
    t.check('you CANNOT mint a match with someone who never liked you',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, STRANGER)).set(h.matchDoc(ME, STRANGER)))));

    t.check('a pass does not count as a like either',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, 'nobody')).set(h.matchDoc(ME, 'nobody')))));

    t.check('you CAN create the match once they have liked you',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, LIKER)).set(h.matchDoc(ME, LIKER)))));

    /* ---- shape ---- */
    t.check('the document id must be the sorted pair',
      await ok(assertFails(as(ME).doc('matches/not-the-pair-id').set(h.matchDoc(ME, LIKER)))));

    // A valid pair id AND a satisfied reciprocal-like, so that being an
    // outsider is the only condition left for the rules to reject. Written to
    // a doc that does not exist yet, so it is evaluated as a create.
    t.check('you must be one of the two participants',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(THIRD, 'unseeded')).set(h.matchDoc(THIRD, 'unseeded')))));

    // Unsorted users force the id to differ from the sorted pair, so this has
    // to target a fresh document: writing the sorted id would be an update and
    // would be refused by the frozen-participants rule instead.
    const unsorted = [ME, LIKER].sort().reverse();
    t.check('the users array must be sorted',
      await ok(assertFails(as(ME).doc('matches/' + unsorted.join('_')).set(
        h.matchDoc(ME, LIKER, { id: unsorted.join('_'), users: unsorted })
      ))));

    /* ---- reads ---- */
    t.check('a participant can read their match',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, LIKER)).get())));

    t.check('an outsider cannot read a match they are not in',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(THIRD, FOURTH)).get())));

    t.check('a query constrained to your own matches is allowed',
      await ok(assertSucceeds(as(ME).collection('matches').where('users', 'array-contains', ME).get())));

    t.check('an unconstrained scan of all matches is refused',
      await ok(assertFails(as(ME).collection('matches').get())));

    t.check('a signed-out visitor cannot read a match',
      await ok(assertFails(anon().doc('matches/' + h.pairId(ME, LIKER)).get())));

    /* ---- updates: the conversation preview and unread counters ---- */
    t.check('a participant can update lastMessage and unread',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, LIKER)).update({
        lastMessage: 'hello', lastMessageAt: '2026-01-05T00:00:00.000Z'
      }))));

    t.check('the participant list itself is frozen',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, LIKER)).update({ users: [ME, 'someone-else'].sort() }))));

    t.check('an outsider cannot update a match',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(THIRD, FOURTH)).update({ lastMessage: 'x' }))));

    /* ---- delete: unmatching ---- */
    t.check('an outsider cannot unmatch two other people',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(THIRD, FOURTH)).delete())));

    t.check('a participant can unmatch',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, LIKER)).delete())));
  }
};
