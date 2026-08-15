/* discovery/{uid} — the public projection.

   This collection is deliberately readable by every signed-in user, which is
   what makes on-device matching possible. Its safety therefore rests entirely
   on the closed key list: if a tampered client could smuggle `email` or
   `blocked` into its own projection, the private-data split of PR #2 would be
   worth nothing. That is the central assertion here. */
'use strict';

module.exports = {
  title: 'discovery/{uid} — world-readable, but only the public shape',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const OTHER = 'other';

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('discovery/' + ME).set(h.discoveryDoc(ME));
      await db.doc('discovery/' + OTHER).set(h.discoveryDoc(OTHER));
    });

    /* ---- reads: open by design ---- */
    t.check('any signed-in user can read a projection (discovery needs this)',
      await ok(assertSucceeds(as(OTHER).doc('discovery/' + ME).get())));

    t.check('a signed-in user can query the collection',
      await ok(assertSucceeds(as(OTHER).collection('discovery').limit(5).get())));

    t.check('a signed-out visitor cannot',
      await ok(assertFails(anon().doc('discovery/' + ME).get())));

    /* ---- the closed key list is the whole safety argument ---- */
    const smuggled = [
      ['email', { email: 'me@example.com' }],
      ['blocked', { blocked: ['someone'] }],
      ['learning', { learning: { interestAffinity: {}, likeCount: 0, passCount: 0 } }],
      ['usage', { usage: { date: '2026-01-01', likes: 0, superLikes: 0, rewinds: 0 } }],
      ['plan', { plan: 'premium' }]
    ];
    for (const [field, over] of smuggled) {
      t.check('a private field cannot be smuggled into the projection: ' + field,
        await ok(assertFails(as(ME).doc('discovery/' + ME).set(h.discoveryDoc(ME, over)))));
    }

    t.check('the birthdate cannot be added to the public profile',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, { birthdate: '1995-02-19' }) })
      ))));

    t.check('a private preference cannot be added either',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { preferences: Object.assign({}, h.discoveryDoc(ME).preferences, { notifications: true }) })
      ))));

    /* ---- ownership ---- */
    t.check('the owner can write their own projection',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).set(h.discoveryDoc(ME)))));

    t.check('nobody can write someone else\'s projection',
      await ok(assertFails(as(OTHER).doc('discovery/' + ME).set(h.discoveryDoc(ME)))));

    // Both of the above rewrite a seeded document, so they only prove the
    // UPDATE path. These two target an id nobody has written, so they are
    // evaluated as creates.
    t.check('nor create one in someone else\'s name',
      await ok(assertFails(as(OTHER).doc('discovery/unseeded').set(h.discoveryDoc('unseeded')))));

    t.check('and the closed key list holds on create too, not just on edit',
      await ok(assertFails(as('unseeded').doc('discovery/unseeded').set(
        h.discoveryDoc('unseeded', { email: 'unseeded@example.com' })
      ))));

    t.check('the embedded uid must match the document id',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(h.discoveryDoc('someone-else')))));

    /* ---- the same bounds as the private document ---- */
    t.check('an over-long bio is rejected here too',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, { bio: 'x'.repeat(501) }) })
      ))));

    t.check('the lastActiveAt-only refresh the store makes is allowed',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).update({ lastActiveAt: '2026-02-02T00:00:00.000Z' }))));

    t.check('the owner can delete their projection',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).delete())));

    t.check('nobody else can delete it',
      await ok(assertFails(as(ME).doc('discovery/' + OTHER).delete())));
  }
};
