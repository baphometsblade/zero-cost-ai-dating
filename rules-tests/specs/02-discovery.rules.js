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

    // This is the one world-readable collection in the project: every signed-in user
    // pulls these documents to build a deck, so a megabyte here is a megabyte on
    // everybody's bandwidth and on the project's egress, not just on its storage.
    t.check('a timestamp longer than a timestamp is refused',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { lastActiveAt: 'x'.repeat(200) })
      ))));

    // `location` was on the key list and validated by nothing at all, so this passed.
    t.check('a location that is not a coordinate pair is refused',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          location: 'x'.repeat(200)
        }) })
      ))));

    t.check('a location label longer than a label is refused',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          location: { label: 'x'.repeat(200), lat: 45.5, lng: -122.7 }
        }) })
      ))));

    // Contents, not counts — and this is the copy that matters most. `photos: 6`
    // bounded the number of links and not their length, so one element could be
    // a quarter of a megabyte in the only collection every signed-in account
    // downloads. The private document has the same hole and the same fix; this
    // is where it is paid for by everybody rather than by its owner.
    t.check('one enormous photo link is refused even though it is only one photo',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          photos: ['https://e/' + 'x'.repeat(250000) + '.png']
        }) })
      ))));

    t.check('and an interest slug longer than the whole interest list may be',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          interests: ['x'.repeat(400)]
        }) })
      ))));

    // The same pair in the world-readable copy, which is the one that matters: a
    // padded projection is downloaded by every signed-in account building a deck.
    t.check('a legal interestedIn word repeated past the length cap is refused here too',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { preferences: Object.assign({}, h.discoveryDoc(ME).preferences, {
          interestedIn: new Array(5000).fill('woman')
        }) })
      ))));

    // The value bound, which had NO test in this match block at all. The two checks
    // above are both refused by `size() <= 4` — the 5000-element list obviously, and
    // `'woman'` because `String.size()` is 5 — so neither ever reached `hasOnly`,
    // and deleting `hasOnly` from the world-readable copy left the whole suite green.
    // One element, inside the length bound, so only its VALUE can deny it.
    t.check('an interestedIn holding a word outside the four is refused here too',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { preferences: Object.assign({}, h.discoveryDoc(ME).preferences, {
          interestedIn: ['everyone']
        }) })
      ))));

    t.check('and an interestedIn that is a short string, not a list',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { preferences: Object.assign({}, h.discoveryDoc(ME).preferences, {
          interestedIn: 'man'
        }) })
      ))));

    // The control, in the collection where a cap set too tight would be worst:
    // a projection nobody can publish is a deck nobody appears in.
    t.check('but six photo links at the length the editor allows still publish',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          photos: Array.from({ length: 6 }, function (_, i) {
            return ('https://example.com/' + i + '/').padEnd(1024, 'x');
          })
        }) })
      ))));

    // `personality` sat on discoveryProfileOk's closed key list with nothing
    // validating it, while the private profileOk held the same field to five
    // numeric axes — so the copy every signed-in account downloads accepted
    // whatever it liked under that name, and the two halves of one decision had
    // drifted without a word. `location` had the identical defect and was found by
    // eye a few rounds earlier; this one survived that pass and was found by asking
    // the question mechanically instead (tests/limits.test.js).
    t.check('a personality that is not five numeric axes is refused here too',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          personality: 'x'.repeat(5000)
        }) })
      ))));

    t.check('and an axis outside 0..100 is refused, as it is in the private document',
      await ok(assertFails(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          personality: { openness: 101 }
        }) })
      ))));

    // The control: the projection the store actually writes still publishes.
    t.check('but the five real axes still publish',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).set(
        h.discoveryDoc(ME, { profile: Object.assign({}, h.discoveryDoc(ME).profile, {
          personality: { openness: 70, conscientiousness: 60, extraversion: 50, agreeableness: 65, stability: 55 }
        }) })
      ))));

    t.check('the lastActiveAt-only refresh the store makes is allowed',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).update({ lastActiveAt: '2026-02-02T00:00:00.000Z' }))));

    t.check('the owner can delete their projection',
      await ok(assertSucceeds(as(ME).doc('discovery/' + ME).delete())));

    t.check('nobody else can delete it',
      await ok(assertFails(as(ME).doc('discovery/' + OTHER).delete())));
  }
};
