/* users/{uid} — the private account document.

   The headline claim, added in PR #2 and repeated in the README and DEPLOY.md,
   is that this document is readable ONLY by its owner: email, birthdate, block
   lists, usage counters and learned affinities must never be readable by
   another account. That claim is the first thing this spec executes. */
'use strict';

module.exports = {
  title: 'users/{uid} — owner-only, and shape-validated on write',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const OTHER = 'other';

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('users/' + ME).set(h.userDoc(ME));
      await db.doc('users/' + OTHER).set(h.userDoc(OTHER));
    });

    /* ---- reads ---- */
    t.check('the owner can read their own document',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).get())));

    t.check('another signed-in account CANNOT read it (the private-data split)',
      await ok(assertFails(as(OTHER).doc('users/' + ME).get())));

    t.check('a signed-out visitor cannot read it',
      await ok(assertFails(anon().doc('users/' + ME).get())));

    t.check('nobody can list the collection to harvest accounts',
      await ok(assertFails(as(OTHER).collection('users').get())));

    /* ---- create ---- */
    t.check('an account can create its own document',
      await ok(assertSucceeds(as('fresh').doc('users/fresh').set(h.userDoc('fresh')))));

    t.check('the embedded uid must match the document id',
      await ok(assertFails(as('fresh2').doc('users/fresh2').set(h.userDoc('somebody-else')))));

    t.check('an account cannot create a document for someone else',
      await ok(assertFails(as(OTHER).doc('users/victim').set(h.userDoc('victim')))));

    /* ---- identity is frozen after creation ---- */
    t.check('uid cannot be rewritten',
      await ok(assertFails(as(ME).doc('users/' + ME).set(h.userDoc(ME, { uid: 'someone-else' })))));

    t.check('email cannot be rewritten',
      await ok(assertFails(as(ME).doc('users/' + ME).set(h.userDoc(ME, { email: 'new@example.com' })))));

    t.check('createdAt cannot be back-dated',
      await ok(assertFails(as(ME).doc('users/' + ME).set(h.userDoc(ME, { createdAt: '2020-01-01T00:00:00.000Z' })))));

    /* ---- field validation, one field at a time ---- */
    const bad = [
      ['a bio over 500 characters', { profile: prof({ bio: 'x'.repeat(501) }) }],
      ['more than 12 interests', { profile: prof({ interests: Array.from({ length: 13 }, function (_, i) { return 'tag' + i; }) }) }],
      ['more than 6 photos', { profile: prof({ photos: Array.from({ length: 7 }, function (_, i) { return 'https://e/' + i + '.png'; }) }) }],
      ['an unknown gender', { profile: prof({ gender: 'unspecified' }) }],
      ['an age under 18', { profile: prof({ age: 17 }) }],
      ['a plan outside the enum', { plan: 'platinum' }],
      ['ageMin below 18', { preferences: prefs({ ageMin: 17 }) }],
      ['ageMax above 100', { preferences: prefs({ ageMax: 101 }) }],
      ['an inverted age range', { preferences: prefs({ ageMin: 40, ageMax: 30 }) }],
      ['a distance beyond 500 km', { preferences: prefs({ maxDistanceKm: 501 }) }],
      ['an out-of-range personality axis', { profile: prof({ personality: { openness: 101 } }) }],
      ['an impossible latitude', { profile: prof({ location: { label: 'X', lat: 91, lng: 0 } }) }],
      ['an affinity map over 60 keys', { learning: { interestAffinity: bigMap(61), likeCount: 0, passCount: 0 } }],
      ['a negative usage counter', { usage: { date: '2026-01-01', likes: -1, superLikes: 0, rewinds: 0 } }]
    ];
    for (const [label, over] of bad) {
      t.check('write rejected: ' + label,
        await ok(assertFails(as(ME).doc('users/' + ME).set(h.userDoc(ME, over)))));
    }

    // Everything above rewrites an existing document, so it proves the UPDATE
    // path only. The rules validate creates through the same function, but a
    // suite that never exercises it would not notice if that stopped being so.
    t.check('the same bounds apply when creating, not just editing',
      await ok(assertFails(as('newbie').doc('users/newbie').set(h.userDoc('newbie', {
        profile: Object.assign({}, h.userDoc('newbie').profile, { bio: 'x'.repeat(501) })
      })))));

    t.check('a valid profile edit is still allowed',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).set(h.userDoc(ME, { profile: prof({ bio: 'An edited bio.' }) })))));

    /* ---- delete ---- */
    t.check('another account cannot delete your document',
      await ok(assertFails(as(OTHER).doc('users/' + ME).delete())));

    t.check('the owner can delete their own account',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).delete())));

    /** Merge overrides into the fixture's profile block. */
    function prof(over) { return Object.assign({}, h.userDoc(ME).profile, over); }
    /** Merge overrides into the fixture's preferences block. */
    function prefs(over) { return Object.assign({}, h.userDoc(ME).preferences, over); }
    /** An affinity map with `n` keys, to exercise the size cap. */
    function bigMap(n) {
      const out = {};
      for (let i = 0; i < n; i++) out['tag' + i] = 0.5;
      return out;
    }
  }
};
