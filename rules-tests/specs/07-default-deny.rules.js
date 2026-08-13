/* The catch-all.

   firestore.rules ends with `match /{document=**} { allow read, write: if false; }`.
   That line is what makes every rule above a whitelist rather than a
   suggestion: a collection nobody thought about is closed, not open. It is
   also the easiest line to break by accident when adding a rule block, so it
   gets its own checks. */
'use strict';

module.exports = {
  title: 'everything else — denied by default',

  async run(t, ctx) {
    const { testing, seed, as, anon } = ctx;
    const { assertFails } = testing;
    const ME = 'me';

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('admin/secrets').set({ token: 'super-secret' });
      await db.doc('analytics/aggregate').set({ signups: 42 });
      await db.doc('users/' + ME + '/private/notes').set({ text: 'a subcollection nobody declared' });
    });

    const closed = [
      ['admin/secrets', 'a collection that only an owner should ever see'],
      ['analytics/aggregate', 'an undeclared analytics collection'],
      ['anything/at-all', 'a collection that does not exist yet']
    ];

    for (const [docPath, why] of closed) {
      t.check('read denied — ' + why,
        await ok(assertFails(as(ME).doc(docPath).get())));
      t.check('write denied — ' + why,
        await ok(assertFails(as(ME).doc(docPath).set({ mine: true }))));
    }

    t.check('an undeclared subcollection under your OWN user document is closed too',
      await ok(assertFails(as(ME).doc('users/' + ME + '/private/notes').get())));

    t.check('and cannot be written',
      await ok(assertFails(as(ME).doc('users/' + ME + '/private/notes').set({ text: 'mine' }))));

    t.check('a signed-out visitor is denied as well',
      await ok(assertFails(anon().doc('admin/secrets').get())));
  }
};

/** Resolve an assertSucceeds/assertFails promise to a boolean. */
async function ok(promise) {
  try {
    await promise;
    return true;
  } catch (err) {
    return false;
  }
}
