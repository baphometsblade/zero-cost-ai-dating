/* swipes/{from_to} — one immutable record per decision.

   The deterministic id is load-bearing: it is what makes recording a swipe
   idempotent and what stops a client inventing two conflicting swipes for the
   same pair. Deletes are allowed in both directions because a rewind removes
   your own, and account deletion (PR #2) must be able to purge inbound likes. */
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

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('swipes/' + OTHER + '_' + ME).set(h.swipeDoc(OTHER, ME, 'like'));
      await db.doc('swipes/' + OTHER + '_' + THIRD).set(h.swipeDoc(OTHER, THIRD, 'like'));
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

    t.check('you cannot swipe on yourself',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_' + ME).set(h.swipeDoc(ME, ME, 'like')))));

    t.check('an action outside like/pass/super is rejected',
      await ok(assertFails(as(ME).doc('swipes/' + ME + '_x').set(h.swipeDoc(ME, 'x', 'adore')))));

    t.check('a signed-out visitor cannot record anything',
      await ok(assertFails(anon().doc('swipes/anon_x').set(h.swipeDoc('anon', 'x', 'like')))));

    t.check('a signed-out visitor cannot read a swipe',
      await ok(assertFails(anon().doc('swipes/' + OTHER + '_' + ME).get())));

    t.check('a signed-out visitor cannot scrape the collection',
      await ok(assertFails(anon().collection('swipes').get())));

    t.check('nor scrape it with the same constraint a signed-in user may use',
      await ok(assertFails(anon().collection('swipes').where('to', '==', ME).get())));

    /* ---- read: your own, in either direction ---- */
    t.check('you can read a swipe you made',
      await ok(assertSucceeds(as(ME).doc('swipes/' + ME + '_' + THIRD).get())));

    t.check('you can read a swipe aimed at you (match detection needs this)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + OTHER + '_' + ME).get())));

    t.check('you cannot read a swipe between two other people',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + THIRD).get())));

    t.check('a query constrained to your own swipes is allowed',
      await ok(assertSucceeds(as(ME).collection('swipes').where('from', '==', ME).get())));

    t.check('a query for likes aimed at you is allowed ("who liked you")',
      await ok(assertSucceeds(as(ME).collection('swipes').where('to', '==', ME).get())));

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

    t.check('you can delete a swipe aimed at you (account deletion purges inbound likes)',
      await ok(assertSucceeds(as(ME).doc('swipes/' + OTHER + '_' + ME).delete())));

    t.check('you cannot delete a swipe between two other people',
      await ok(assertFails(as(ME).doc('swipes/' + OTHER + '_' + THIRD).delete())));
  }
};
