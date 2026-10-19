/* swipes/{from_to} — one immutable record per decision.

   The deterministic id is load-bearing: it is what makes recording a swipe
   idempotent and what stops a client inventing two conflicting swipes for the
   same pair. Deletes are allowed in both directions because a rewind removes
   your own, and account deletion (PR #2) must be able to purge inbound likes —
   and in the inbound direction only likes: a pass aimed at you, and a miss, are
   its author's alone, as they are to read. */
'use strict';

module.exports = {
  title: 'swipes/{from_to} — authored by you, immutable, id-pinned',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const OTHER = 'other';
    const THIRD = 'third';
    const FOURTH = 'fourth';   // never seeded, so writes to it are creates
    const PASSER = 'passer';   // passed on ME
    const STARRER = 'starrer'; // super-liked ME

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('swipes/' + OTHER + '_' + ME).set(h.swipeDoc(OTHER, ME, 'like'));
      await db.doc('swipes/' + OTHER + '_' + THIRD).set(h.swipeDoc(OTHER, THIRD, 'like'));
      await db.doc('swipes/' + PASSER + '_' + ME).set(h.swipeDoc(PASSER, ME, 'pass'));
      await db.doc('swipes/' + STARRER + '_' + ME).set(h.swipeDoc(STARRER, ME, 'super'));
    });

    /* ---- create ---- */
    t.check('you can record your own swipe under the right id',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_' + THIRD).set(h.swipeDoc(ME, THIRD, 'like')))));

    t.check('the document id must be exactly from_to',
      await ok(assertFails(as(ME).doc('swipes/wrong-id').set(h.swipeDoc(ME, 'someone', 'like')))));

    // Deliberately an UNSEEDED id: writing over a document that already exists
    // is an update, which `allow update: if false` refuses on its own, so the
    // check would stay green even if the create-time authorship rule vanished.
    t.check('you cannot record a swipe authored by someone else',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + FOURTH).set(h.swipeDoc(OTHER, FOURTH, 'like')))));

    // One unexpected key is the whole test. `hasAll` admitted any number of them at
    // any size, so a document the rules called well-formed could still be padded to
    // Firestore's 1 MiB ceiling; a spec that actually wrote a megabyte would prove the
    // same thing and take a hundred times as long.
    // Each of the three shape refusals below writes to its **own** document id, and
    // that is load-bearing rather than tidy. They used to share one, and a combined
    // mutation run showed why: with the rule weakened, the first write succeeded, so
    // the next was an update rather than a create — refused by `allow update: if false`
    // — and the check went green against the very code it exists to catch. A check that
    // passes for the wrong reason is the failure mode this suite has had before.
    t.check('a swipe carrying a field the shape does not name is refused',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_pad-target').set(
        Object.assign(h.swipeDoc(ME, 'pad-target', 'like'), { padding: 'x'.repeat(64) })
      ))));

    t.check('you cannot swipe on yourself',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_' + ME).set(h.swipeDoc(ME, ME, 'like')))));

    // `createdAt is string` bounded nothing, and every document in this project
    // carries one — so the closed key list above stopped a document growing an
    // extra field while this one could still hold a megabyte.
    t.check('a timestamp longer than a timestamp is refused',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_stamp-target').set(
        Object.assign(h.swipeDoc(ME, 'stamp-target', 'like'), { createdAt: 'x'.repeat(200) })
      ))));

    // `id` was on the key list and validated by nothing at all.
    t.check('an id field that is not the document id is refused',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_id-target').set(
        Object.assign(h.swipeDoc(ME, 'id-target', 'like'), { id: 'x'.repeat(200) })
      ))));

    t.check('an action outside like/pass/super is rejected',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_x').set(h.swipeDoc(ME, 'x', 'adore')))));

    t.check('a signed-out visitor cannot record anything',
      await ok(assertFails(anon().doc('swipes/anon_x').set(h.swipeDoc('anon', 'x', 'like')))));

    t.check('a signed-out visitor cannot read a swipe',
      await ok(assertFails(anon().doc('swipes/' + OTHER + '_' + ME).get())));

    t.check('a signed-out visitor cannot scrape the collection',
      await ok(assertFails(anon().collection('swipes').get())));

    t.check('nor scrape it with the same constraint a signed-in user may use',
      await ok(assertFails(anon().collection('swipes').where('to', '==', ME)
        .where('action', 'in', ['like', 'super']).get())));

    /* ---- read: your own, in either direction ---- */
    t.check('you can read a swipe you made',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_' + THIRD).get())));

    t.check('you can read a like aimed at you (match detection needs this)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + OTHER + '_' + ME).get())));

    // Neither reason for reading inbound swipes needs a pass: match detection
    // asks whether the other person LIKED you, and the who-liked-you list is
    // likes. A pass is the one decision somebody makes about you that the app
    // never shows you, and one query used to list every person who had passed
    // on you, with the time they did it.
    t.check('but not a pass aimed at you',
      await ok(assertFails(as(ME).doc('swipes/' + PASSER + '_' + ME).get())));

    t.check('you cannot read a swipe between two other people',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + THIRD).get())));

    // The absent case, which shipped paths depend on and cannot work around.
    // Every first swipe reads its own not-yet-written document; and
    // `getLikesReceived` asks, once per person who liked you, whether
    // `swipes/{me}_{them}` exists — as does the live `listenLikesReceived` behind
    // the badge, on every sender it has not seen before. (This comment said "on a
    // timer, every twenty seconds" until the timer was replaced by a snapshot
    // listener and the sentence was not.) Dropping `resource == null` from the
    // read rule looks like tightening it and would deny a read of a document that
    // holds nothing, breaking the deck and the who-liked-you badge together.
    t.check('a signed-in user can probe their own swipe document before it exists',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_unswiped-so-far').get())));

    // The reciprocal read is the one miss that is refused, and it has to be. With a
    // pass refused and a miss answered, the two answers would differ and the
    // refusal would BE the pass. So a swipe aimed at you that is a pass and one
    // that does not exist are refused alike, and the store reads either refusal
    // as what both mean to it: they have not liked you.
    t.check('nor a missing swipe aimed at you, so a refusal does not single out a pass',
      await ok(assertFails(as(ME).doc('swipes/' + FOURTH + '_' + ME).get())));

    // The other half of that, and the reason the miss is allowed by the id
    // rather than unconditionally. `resource == null` on its own answers every
    // caller for every id, and the two answers differ: an empty snapshot means
    // the document is not there, a denial means it is there and is not yours.
    // Probing `other_fourth` and `other_third` in turn therefore reports which
    // of them `other` has swiped on — without reading a byte of either — and
    // uids are enumerable, because any signed-in user can list every discoverable
    // projection in discovery/{uid}, and its document id is the uid.
    t.check('but not a missing swipe between two other people, which would tell them it is missing',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + FOURTH).get())));

    t.check('a query constrained to your own swipes is allowed',
      await ok(assertSucceeds(as(ME).collection('swipes').where('from', '==', ME).get())));

    // The query `likeSenders` and the live badge make. It names the actions, so
    // every document it can return is one the read rule allows.
    t.check('a query for likes aimed at you is allowed ("who liked you")',
      await ok(assertSucceeds(as(ME).collection('swipes').where('to', '==', ME)
        .where('action', 'in', ['like', 'super']).get())));

    t.check('a query for the passes aimed at you is refused',
      await ok(assertFails(as(ME).collection('swipes').where('to', '==', ME)
        .where('action', '==', 'pass').get())));

    // Without the action it could return a pass, and the rules are not a filter.
    t.check('and so is one for everything aimed at you',
      await ok(assertFails(as(ME).collection('swipes').where('to', '==', ME).get())));

    t.check('an unconstrained scan of everyone\'s swipes is refused',
      await ok(assertFails(as(ME).collection('swipes').get())));

    t.check('you cannot query someone else\'s swipes',
      await ok(assertFails(as(ME).collection('swipes').where('from', '==', OTHER).get())));

    /* ---- immutability ---- */
    t.check('a swipe can never be updated, even your own',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_' + THIRD).update({ action: 'pass' }))));

    /* ---- delete: rewind, and account deletion ---- */
    t.check('you can delete your own swipe (the rewind path)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_' + THIRD).delete())));

    t.check('you can delete a like aimed at you (account deletion purges inbound likes)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + OTHER + '_' + ME).delete())));

    t.check('and a super like aimed at you',
      await ok(assertSucceeds(as(ME).doc('swipes/' + STARRER + '_' + ME).delete())));

    // Account deletion is the only reason the target may delete at all, and it
    // purges likes, because a pass is not the target's to read. Deleting one is
    // not harmless either: the id is `from_to`, so the person passed on knows it,
    // and a pass deleted is a person back in its author's deck, which leaves out
    // everybody its author has a swipe for.
    t.check('but not a pass aimed at you, which would put you back in its author\'s deck',
      await ok(assertFails(as(ME).doc('swipes/' + PASSER + '_' + ME).delete())));

    // And so not a miss aimed at you either. Were a miss allowed to the target and
    // a pass refused, the refusal would be the pass, the oracle the read rule
    // refuses a miss aimed at you to deny.
    t.check('nor delete a missing swipe aimed at you, so a refused delete does not single out a pass',
      await ok(assertFails(as(ME).doc('swipes/' + FOURTH + '_' + ME).delete())));

    // The pass is still its author's to rewind: the target branch narrowed, the
    // author's did not.
    t.check('while the one who passed can still delete it (the rewind path)',
      await ok(assertSucceeds(as(PASSER).doc('swipes/' + PASSER + '_' + ME).delete())));

    t.check('you cannot delete a swipe between two other people',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + THIRD).delete())));

    // The absent case again, on delete this time. undoSwipe deletes without reading
    // the swipe first, so a second rewind of the same card — two tabs on one deck,
    // or a retry — deletes a document that is already gone. `resource` is null
    // then, the rule dereferenced it, and the whole rewind came back
    // permission-denied in Firebase mode where demo mode answers `{ ok: true }`.
    // The rewind-path check above has already deleted this one.
    t.check('you can delete your own swipe again once it is gone (a second rewind)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_' + THIRD).delete())));

    // ...allowed by the id, to its author alone, as the read of a miss is: a stranger
    // gets the same refusal whether or not the document is there and learns nothing
    // from it.
    t.check('but you cannot delete a missing swipe between two other people',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + FOURTH).delete())));

    t.check('and a signed-out visitor cannot delete a missing one either',
      await ok(assertFails(anon().doc('swipes/' + ME + '_never-swiped').delete())));
  }
};
