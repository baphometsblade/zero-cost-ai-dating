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

    // One unexpected key is the whole test. `hasAll` admitted any number of them at any
    // size, so an account could pad its own document to Firestore's 1 MiB ceiling with
    // fields nothing reads; a spec that wrote a real megabyte would prove the same thing
    // and take a hundred times as long.
    t.check('a user document carrying a field the shape does not name is refused',
      await ok(assertFails(as(ME).doc('users/' + ME).set(
        h.userDoc(ME, { padding: 'x'.repeat(64) })
      ))));

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
      ['a negative usage counter', { usage: { date: '2026-01-01', likes: -1, superLikes: 0, rewinds: 0 } }],

      // Contents rather than counts. Every one of these satisfies the size()
      // cap above it — one photo is not more than six — and every one of them
      // was accepted until `listCharsOk` was added. `docs/DEPLOY.md` listed
      // them by name as the hole that could not be closed, because the rules
      // language cannot iterate a list. It does not have to: `join` makes the
      // whole list one string and a string can be measured.
      ['one photo link padded to a quarter of a megabyte',
        { profile: prof({ photos: ['https://e/' + 'x'.repeat(250000) + '.png'] }) }],
      ['six photo links that are legal apart and too much together',
        { profile: prof({ photos: Array.from({ length: 6 }, function (_, i) { return 'https://e/' + i + 'x'.repeat(1200); }) }) }],
      ['an interest slug longer than the whole interest list may be',
        { profile: prof({ interests: ['x'.repeat(400)] }) }],
      ['an interestedIn entry that is not one of the four words',
        { preferences: prefs({ interestedIn: ['x'.repeat(200)] }) }],
      ['a single blocked uid the size of a block list',
        { blocked: ['x'.repeat(48001)] }],
      ['an affinity keyed by a padded slug',
        { learning: { interestAffinity: padKey(1300), likeCount: 0, passCount: 0 } }],
      // The one that mattered most: a map's *values* were never looked at, so
      // `{ hiking: <a megabyte of x> }` was one key, well inside the cap of 60.
      ['an affinity whose value is a string rather than a weight',
        { learning: { interestAffinity: { hiking: 'x'.repeat(2000) }, likeCount: 0, passCount: 0 } }]
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

    // The store writes lastActiveAt: null for an account that has never been
    // seen — the same way it writes planSince: null — and every fixture here
    // used a string, so 127 checks said nothing about the shape the store
    // actually produces. A browser driving the real SDK found it: the whole
    // create was denied, and the deny read as "permission", not "shape".
    t.check('a never-active account may store lastActiveAt as null',
      await ok(assertSucceeds(as('never-active').doc('users/never-active').set(
        h.userDoc('never-active', { lastActiveAt: null })
      ))));

    t.check('but a non-string, non-null lastActiveAt is still refused',
      await ok(assertFails(as('bad-active').doc('users/bad-active').set(
        h.userDoc('bad-active', { lastActiveAt: 1767225600000 })
      ))));

    // Controls. A bound nobody can reach is not a bound, it is a broken feature,
    // and every refusal above would read identically against a cap of zero.
    t.check('but six photo links at the length the editor allows are accepted',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).set(h.userDoc(ME, {
        profile: prof({ photos: Array.from({ length: 6 }, function (_, i) {
          // 1024 characters each, which is public/js/profile.js's MAX_PHOTO_URL,
          // and exactly the rule's allowance across all six. tests/limits.test.js
          // is what keeps those two numbers the same one.
          return ('https://example.com/' + i + '/').padEnd(1024, 'x');
        }) })
      })))));

    t.check('and a full 60-slug affinity map of real weights is accepted',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).set(h.userDoc(ME, {
        learning: { interestAffinity: bigMap(60, -0.1234), likeCount: 0, passCount: 0 }
      })))));

    t.check('and a block list of a thousand real uids is accepted',
      await ok(assertSucceeds(as(ME).doc('users/' + ME).set(h.userDoc(ME, {
        // 28 characters is what Firebase Auth issues.
        blocked: Array.from({ length: 1000 }, function (_, i) { return String(i).padStart(28, 'u'); })
      })))));

    // `userDocOk` used to carry a `hasAll` naming seven required keys, and it was
    // removed to buy back evaluation budget (see `08-budget`) on the grounds that
    // every one of those keys is dereferenced unconditionally below, and reading a
    // key a map does not have is an error that denies. That is a claim about the
    // rules language, so it is executed rather than asserted: each key is removed
    // in turn and the write must still be refused.
    for (const key of ['uid', 'email', 'displayName', 'createdAt', 'plan', 'profile', 'preferences']) {
      const missing = h.userDoc('missing-' + key);
      delete missing[key];
      t.check('a user document with no ' + key + ' is refused, with no hasAll to say so',
        await ok(assertFails(as('missing-' + key).doc('users/missing-' + key).set(missing))));
    }

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
    function bigMap(n, value) {
      const out = {};
      const v = value === undefined ? 0.5 : value;
      for (let i = 0; i < n; i++) out['tag' + i] = v;
      return out;
    }
    /** An affinity map whose single key is `n` characters long. */
    function padKey(n) {
      const out = {};
      out['x'.repeat(n)] = 0.5;
      return out;
    }
  }
};
