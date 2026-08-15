/* reports/{from_about} — the abuse queue.

   Two properties matter and both came out of review. The deterministic id caps
   the queue at one report per (reporter, subject) pair, so a disposable account
   cannot flood it or burn the Spark write quota with random ids (PR #2). And a
   report is visible only to its own author — including for missing documents,
   so the reported party cannot even probe whether one exists — which is also
   what lets account deletion purge the reports an account filed (PR #3). */
'use strict';

module.exports = {
  title: 'reports/{from_about} — bounded, author-only, unprobeable',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const SUBJECT = 'subject';
    const OTHER = 'other';
    const GHOST = 'ghost';   // deliberately absent from discovery

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('discovery/' + SUBJECT).set(h.discoveryDoc(SUBJECT));
      await db.doc('discovery/' + OTHER).set(h.discoveryDoc(OTHER));
      await db.doc('discovery/' + ME).set(h.discoveryDoc(ME));
      // A report filed by somebody else, for the visibility checks.
      await db.doc('reports/' + OTHER + '_' + SUBJECT).set(h.reportDoc(OTHER, SUBJECT));
    });

    /* ---- create ---- */
    t.check('you can file a report about a real account',
      await ok(assertSucceeds(as(ME).doc('reports/' + ME + '_' + SUBJECT).set(h.reportDoc(ME, SUBJECT)))));

    t.check('the id must be exactly from_about (this is what bounds the queue)',
      await ok(assertFails(as(ME).doc('reports/random-id').set(h.reportDoc(ME, SUBJECT)))));

    // An UNSEEDED id whose subject does exist, so create-time authorship is the
    // only thing left to deny it. Aiming at the seeded other_subject document
    // would be an update, which `allow update: if false` refuses by itself —
    // and the check would survive the authorship rule being deleted.
    t.check('you cannot file a report in someone else\'s name',
      await ok(assertFails(as(ME).doc('reports/' + OTHER + '_' + ME).set(h.reportDoc(OTHER, ME)))));

    t.check('you cannot report a uid that does not exist',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + GHOST).set(h.reportDoc(ME, GHOST)))));

    t.check('you cannot report yourself',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + ME).set(h.reportDoc(ME, ME)))));

    t.check('a reason outside the closed list is rejected',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + OTHER).set(h.reportDoc(ME, OTHER, { reason: 'vibes' })))));

    t.check('detail over 500 characters is rejected',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + OTHER).set(h.reportDoc(ME, OTHER, { details: 'x'.repeat(501) })))));

    t.check('an extra field cannot be smuggled in',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + OTHER).set(h.reportDoc(ME, OTHER, { severity: 'high' })))));

    t.check('a signed-out visitor cannot file reports',
      await ok(assertFails(anon().doc('reports/anon_' + SUBJECT).set(h.reportDoc('anon', SUBJECT)))));

    /* ---- re-reporting cannot rewrite the original ---- */
    t.check('re-reporting the same person cannot overwrite the first report',
      await ok(assertFails(as(ME).doc('reports/' + ME + '_' + SUBJECT).update({ reason: 'scam-or-spam' }))));

    /* ---- visibility: author only, and no probing ---- */
    t.check('you can read a report you filed (Settings lists them)',
      await ok(assertSucceeds(as(ME).doc('reports/' + ME + '_' + SUBJECT).get())));

    t.check('a query for your own reports is allowed',
      await ok(assertSucceeds(as(ME).collection('reports').where('from', '==', ME).get())));

    t.check('the reported party cannot read a report about them',
      await ok(assertFails(as(SUBJECT).doc('reports/' + ME + '_' + SUBJECT).get())));

    t.check('nobody can read a report somebody else filed',
      await ok(assertFails(as(ME).doc('reports/' + OTHER + '_' + SUBJECT).get())));

    t.check('a missing report also denies, so existence cannot be probed',
      await ok(assertFails(as(SUBJECT).doc('reports/' + SUBJECT + '_nobody').get())));

    t.check('the queue cannot be enumerated',
      await ok(assertFails(as(ME).collection('reports').get())));

    t.check('a signed-out visitor cannot read a report',
      await ok(assertFails(anon().doc('reports/' + ME + '_' + SUBJECT).get())));

    t.check('a signed-out visitor cannot enumerate the queue',
      await ok(assertFails(anon().collection('reports').get())));

    t.check('nor read one with the author constraint a signed-in author may use',
      await ok(assertFails(anon().collection('reports').where('from', '==', ME).get())));

    t.check('you cannot query for reports about yourself',
      await ok(assertFails(as(SUBJECT).collection('reports').where('about', '==', SUBJECT).get())));

    /* ---- delete: retraction, and account deletion ---- */
    t.check('the reported party cannot delete a report about them',
      await ok(assertFails(as(SUBJECT).doc('reports/' + ME + '_' + SUBJECT).delete())));

    t.check('you can retract a report you filed',
      await ok(assertSucceeds(as(ME).doc('reports/' + ME + '_' + SUBJECT).delete())));
  }
};
