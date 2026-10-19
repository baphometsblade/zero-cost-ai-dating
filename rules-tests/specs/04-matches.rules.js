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
    const BLOCKER = 'blocker';    // has liked me, and has blocked me
    const OPENER = 'opener';      // has liked me, has a user document, blocks nobody
    const ANSWERED = 'answered';  // has liked me, and the match is dated by that like

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

      // Two more who have liked ME, so the reciprocal-like precondition holds for both
      // and the block list is the only thing that can separate them. Both have a user
      // document, which LIKER above deliberately does not: a rule that denied whenever
      // it could read one would pass the blocked check for the wrong reason.
      await db.doc('swipes/' + BLOCKER + '_' + ME).set(h.swipeDoc(BLOCKER, ME, 'like'));
      await db.doc('users/' + BLOCKER).set(h.userDoc(BLOCKER, { blocked: [ME] }));
      await db.doc('swipes/' + OPENER + '_' + ME).set(h.swipeDoc(OPENER, ME, 'like'));
      await db.doc('users/' + OPENER).set(h.userDoc(OPENER, { blocked: [] }));
      await db.doc('swipes/' + ANSWERED + '_' + ME).set(h.swipeDoc(ANSWERED, ME, 'like'));
    });

    /* ---- the attack the rule exists to stop ---- */
    t.check('you CANNOT mint a match with someone who never liked you',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, STRANGER)).set(h.matchDoc(ME, STRANGER)))));

    t.check('a pass does not count as a like either',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, 'nobody')).set(h.matchDoc(ME, 'nobody')))));

    // A match with no messages sorts by when it was made, so a stamp from the future
    // pins it above every real conversation in the other person's list.
    t.check('but not with a createdAt from the future, even once they have',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, LIKER)).set(
        h.matchDoc(ME, LIKER, { createdAt: '9999-12-31T23:59:59.999Z' })
      ))));

    // Nor with one a little over a day ahead, which is what a device whose clock runs
    // that fast stamps as now. The store answers that refusal by dating the match by the
    // like it answers (see matchDocumentFor), so the next check writes exactly that.
    t.check('nor with one a little over a day ahead, which a fast device clock writes as now',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, LIKER)).set(
        h.matchDoc(ME, LIKER, { createdAt: new Date(Date.now() + 25 * 3600000).toISOString() })
      ))));

    t.check('you CAN create the match once they have liked you, dated by that like',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, ANSWERED)).set(
        h.matchDoc(ME, ANSWERED, { createdAt: h.swipeDoc(ANSWERED, ME, 'like').createdAt })
      ))));

    t.check('you CAN create the match once they have liked you',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, LIKER)).set(h.matchDoc(ME, LIKER)))));

    /* ---- a block, enforced here because there is nowhere else ---- */

    // Unmatching deletes the match document and not the like underneath it, so
    // `likedByOther` still holds afterwards and the other side could simply write the
    // document again and carry on messaging. A block list lives in a private user
    // document no client but its owner can read — and a rule can read it, which makes
    // this the one place a block survives a determined client.
    t.check('you cannot create a match with somebody who has blocked you',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, BLOCKER)).set(h.matchDoc(ME, BLOCKER)))));

    // The control. OPENER has a user document too, so this fails if the rule is denying
    // because it found a document rather than because it found the caller inside it.
    t.check('but you can with somebody who has one and has not blocked you',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, OPENER)).set(h.matchDoc(ME, OPENER)))));

    /* ---- shape ---- */
    // One unexpected key is the whole test. `hasAll` admitted any number of them at
    // any size, so a document the rules called well-formed could still be padded to
    // Firestore's 1 MiB ceiling; a spec that actually wrote a megabyte would prove the
    // same thing and take a hundred times as long.
    t.check('a match carrying a field the shape does not name is refused',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, OPENER)).set(
        h.matchDoc(ME, OPENER, { padding: 'x'.repeat(64) })
      ))));

    // `unread` was checked as "a map with at most two keys", which bounded the number
    // of keys and neither their names nor their values.
    const outsiderUnread = {};
    outsiderUnread[ME] = 0;
    outsiderUnread[THIRD] = 0;
    t.check('an unread map keyed by somebody outside the match is refused',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, OPENER)).set(
        h.matchDoc(ME, OPENER, { unread: outsiderUnread })
      ))));

    const paddedUnread = {};
    paddedUnread[ME] = 'x'.repeat(200);
    paddedUnread[OPENER] = 0;
    t.check('an unread count that is not a number is refused',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, OPENER)).set(
        h.matchDoc(ME, OPENER, { unread: paddedUnread })
      ))));

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

    // The absent case is load-bearing, not a curiosity. undoSwipe reads the
    // pair's match document inside a transaction *before* deleting the swipe,
    // and for almost every rewind that document is not there. Tightening this
    // rule to `request.auth.uid in resource.data.users` alone reads perfectly
    // sensibly and would break every rewind in the app, because a null
    // resource cannot be dereferenced and the whole transaction fails.
    t.check('a signed-in user can probe a match document that does not exist, which rewind depends on',
      await ok(assertSucceeds(as(ME).doc('matches/' + h.pairId(ME, THIRD)).get())));

    // And only their own. Allowing every miss would mean the difference between
    // an empty snapshot and a denial answers "have those two matched?" for any
    // pair somebody cares to name, which in a dating app is the fact worth
    // hiding. The id is the sorted pair, so a probe is confined to matches the
    // caller would be in.
    t.check('but not a missing match between two other people, which would tell them it is missing',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(THIRD, 'unmatched-stranger')).get())));

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

    // Both people's conversation lists order by these two stamps, and nothing else
    // about a match update stops a participant rewriting either.
    t.check('a preview stamped in the future is refused',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, LIKER)).update({
        lastMessage: 'pinned', lastMessageAt: '9999-12-31T23:59:59.999Z'
      }))));

    t.check('and so is moving when the match was made into the future',
      await ok(assertFails(as(ME).doc('matches/' + h.pairId(ME, LIKER)).update({
        createdAt: '9999-12-31T23:59:59.999Z'
      }))));

    // `is number && >= 0` let Infinity through, and the other side's badge printed
    // "Infinity unread". A count is a whole number, and one no conversation reaches.
    const countOf = function (value) {
      const patch = {};
      patch['unread.' + LIKER] = value;
      return as(ME).doc('matches/' + h.pairId(ME, LIKER)).update(patch);
    };
    t.check('an unread count of Infinity is refused', await ok(assertFails(countOf(Infinity))));
    t.check('as is a fractional one', await ok(assertFails(countOf(1.5))));
    t.check('and one past a million', await ok(assertFails(countOf(1000001))));
    t.check('while an ordinary count still saves', await ok(assertSucceeds(countOf(3))));

    // A count is also the other person's to raise, one message at a time, with
    // `FieldValue.increment(1)`. Bounding the value it lands on made that a tripwire:
    // a participant who parked their own count at the ceiling turned every message the
    // other person sent into a refused preview update, from then on.
    const fsdk = h.loadOutside('firebase/firestore');
    const mine = function (value) {
      const patch = {};
      patch['unread.' + ME] = value;
      return as(ME).doc('matches/' + h.pairId(ME, LIKER)).update(patch);
    };
    const theirMessage = function () {
      const patch = { lastMessage: 'still there?', lastMessageAt: new Date().toISOString() };
      patch['unread.' + ME] = fsdk.increment(1);
      return fsdk.updateDoc(fsdk.doc(as(LIKER), 'matches', h.pairId(ME, LIKER)), patch);
    };
    t.check('a participant may park their own count at the ceiling', await ok(assertSucceeds(mine(1000000))));
    t.check('and the other side\'s next message still raises it, preview and all',
      await ok(assertSucceeds(theirMessage())));
    t.check('and the one after that', await ok(assertSucceeds(theirMessage())));
    t.check('while a count written past the ceiling directly is still refused, even from there',
      await ok(assertFails(mine(1000010))));
    t.check('as is Infinity', await ok(assertFails(mine(Infinity))));
    t.check('and reading the thread still clears it', await ok(assertSucceeds(mine(0))));

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
