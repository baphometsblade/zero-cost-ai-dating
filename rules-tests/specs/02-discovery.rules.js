/* discovery/{uid} — the public projection.

   A discoverable projection is readable by every signed-in user, which is what
   makes on-device matching possible. Its safety therefore rests on the closed
   key list: if a tampered client could smuggle `email` or `blocked` into its
   own projection, the private-data split of PR #2 would be worth nothing.
   That is the central assertion here.

   The other is what "Show me in other people's decks" turned off means. The
   client only ever filtered on it, so a paused projection stayed readable by
   everybody, and `where('preferences.discoverable', '==', false)` listed
   exactly the people who had asked to disappear. A paused projection is now
   readable by its owner and by the accounts that already know the person:
   their matches and the people they liked. Not by somebody who reports them,
   because a report is something anybody can file, and withdraw, alone. */
'use strict';

module.exports = {
  title: 'discovery/{uid} — readable while discoverable, and only the public shape',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const OTHER = 'other';
    // A projection with "Show me in other people's decks" turned off, and the
    // accounts around it: one matched with it, one it liked, one it passed on,
    // one that reports it, and one that has never met it.
    const PAUSED = 'paused';
    const MATCH = 'paused-match';
    const LIKED = 'paused-liked';
    const PASSED = 'paused-passed';
    const REPORTER = 'paused-reporter';
    const STRANGER = 'paused-stranger';
    const hidden = h.discoveryDoc(PAUSED, {
      preferences: Object.assign({}, h.discoveryDoc(PAUSED).preferences, { discoverable: false })
    });

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('discovery/' + ME).set(h.discoveryDoc(ME));
      await db.doc('discovery/' + OTHER).set(h.discoveryDoc(OTHER));
      await db.doc('discovery/' + PAUSED).set(hidden);
      await db.doc('matches/' + h.pairId(PAUSED, MATCH)).set(h.matchDoc(PAUSED, MATCH));
      await db.doc('swipes/' + PAUSED + '_' + LIKED).set(h.swipeDoc(PAUSED, LIKED, 'like'));
      await db.doc('swipes/' + PAUSED + '_' + PASSED).set(h.swipeDoc(PAUSED, PASSED, 'pass'));
    });

    /* ---- reads: open while discoverable ---- */
    t.check('any signed-in user can read a discoverable projection (discovery needs this)',
      await ok(assertSucceeds(as(OTHER).doc('discovery/' + ME).get())));

    // The query listCandidates makes, which is the only list of this collection
    // the app asks for: it names `discoverable == true`, so every document it can
    // return is one the read rule allows to anybody.
    t.check('a signed-in user can query the collection the way the deck does',
      await ok(assertSucceeds(as(OTHER).collection('discovery')
        .where('profileComplete', '==', true)
        .where('preferences.discoverable', '==', true)
        .orderBy('lastActiveAt', 'desc')
        .limit(5).get())));

    // ...and the deck's fallback for a project whose composite index is missing,
    // which keeps the same equality so the rules can still allow it.
    t.check('and the deck\'s unindexed fallback, which keeps the discoverable filter',
      await ok(assertSucceeds(as(OTHER).collection('discovery')
        .where('preferences.discoverable', '==', true)
        .limit(5).get())));

    t.check('a signed-out visitor cannot',
      await ok(assertFails(anon().doc('discovery/' + ME).get())));

    /* ---- reads: a paused projection ---- */
    t.check('a stranger cannot read a paused projection',
      await ok(assertFails(as(STRANGER).doc('discovery/' + PAUSED).get())));

    t.check('nor list the people who paused',
      await ok(assertFails(as(STRANGER).collection('discovery')
        .where('preferences.discoverable', '==', false).get())));

    // A query that does not say `discoverable == true` could return a paused
    // projection, so the rules refuse it whole: they are not a filter.
    t.check('nor scan the collection without the discoverable filter',
      await ok(assertFails(as(STRANGER).collection('discovery').limit(5).get())));

    t.check('the owner can still read their own paused projection',
      await ok(assertSucceeds(as(PAUSED).doc('discovery/' + PAUSED).get())));

    // settings.html promises "Your existing matches and conversations stay exactly
    // where they are", and a conversation is drawn with the other person's face.
    t.check('a match can still read it, so the conversation keeps its face',
      await ok(assertSucceeds(as(MATCH).doc('discovery/' + PAUSED).get())));

    // The who-liked-you list reads the face of everybody still waiting.
    t.check('so can somebody they liked, for the who-liked-you list',
      await ok(assertSucceeds(as(LIKED).doc('discovery/' + PAUSED).get())));

    // Asked by the action, not by whether the swipe exists: if any swipe were
    // enough, a readable paused profile that is not in your likes would mean
    // that person passed on you, and a pass is private to its author.
    t.check('but not somebody they passed on, which would tell them about the pass',
      await ok(assertFails(as(PASSED).doc('discovery/' + PAUSED).get())));

    // A report is not a relationship. Anybody signed in may file one about any
    // published account, a paused one included, and withdraw it again, so a read
    // it opened would be one a stranger holding the uid could grant themselves,
    // use and retract, leaving nothing in the queue. The settings page names a
    // report it cannot read "a deleted account", as it does one it cannot fetch.
    t.check('but filing a report about them does not open it to the reporter',
      await ok(assertSucceeds(as(REPORTER).doc('reports/' + REPORTER + '_' + PAUSED)
        .set(h.reportDoc(REPORTER, PAUSED))))
        && await ok(assertFails(as(REPORTER).doc('discovery/' + PAUSED).get())));

    // fetchProfiles asks about people who may have deleted their account since,
    // and the settings page names each of those "a deleted account": a miss has
    // always been an empty snapshot, and stays one. Beside a paused profile's
    // refusal it tells somebody who already holds a uid that the account exists
    // and has paused, which is less than the whole profile they could read before.
    t.check('a projection that does not exist still reads as missing',
      await ok(assertSucceeds(as(STRANGER).doc('discovery/never-published').get())));

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

    // This is the one collection other people read: every signed-in user pulls the
    // discoverable documents to build a deck, so a megabyte here is a megabyte on
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

    // The same pair in the public copy, which is the one that matters: a
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
    // and deleting `hasOnly` from the public copy left the whole suite green.
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
