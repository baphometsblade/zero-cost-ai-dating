/* ==========================================================================
   Does firestore.rules let the transaction through?

   firestore.rules needed no change for the atomic counter — `allow update`
   re-validates the merged document, and the usage validator already accepts
   {date: a 10-character string, non-negative numbers} while uid, email and
   createdAt stay frozen. That was reasoning, not evidence: nothing had ever
   run a real bump past the real rules.

   The client SDK cannot mint an auth token without the Auth emulator, so the
   rest of this suite runs on a project with open rules and could not tell.
   This spec closes the loop the only honest way left: let the shipped
   transaction store a value, then replay *that exact value* against the real
   ruleset as the document's owner.
   ========================================================================== */
'use strict';

module.exports = {
  title: 'The value the transaction stores is one the rules accept',

  async run(t, k) {
    const today = k.ctx.ZC.util.todayKey();
    const doc = k.fs.doc;
    const setDoc = k.fs.setDoc;
    const updateDoc = k.fs.updateDoc;

    /* ---- what does the shipped code actually write? ---------------------- */

    const uid = 'rules-owner';
    await k.admin.set('users', uid, k.h.userDoc(uid, { usage: { date: today, likes: 0, superLikes: 0, rewinds: 0 } }));
    await k.store.bumpUsage(uid, 'superLikes');
    k.ctx.drainWarnings();
    const written = (await k.admin.get('users', uid) || {}).usage;

    t.check(
      'the bump under test stored something to replay',
      !!written && written.superLikes === 1,
      k.show(written)
    );

    /* ---- replay it against the real firestore.rules ---------------------- */

    // A separate project, so this ruleset and the open one the rest of the
    // suite uses can never overwrite each other.
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'users', uid),
        k.h.userDoc(uid, { usage: { date: today, likes: 0, superLikes: 0, rewinds: 0 } }));
    });
    const owner = k.rulesEnv.authenticatedContext(uid).firestore();

    t.check(
      'the owner may update usage alone, without restamping anything else',
      await k.ok(k.testing.assertSucceeds(updateDoc(doc(owner, 'users', uid), { usage: written }))),
      k.show(written)
    );

    // The counterweight, so the check above cannot pass vacuously: the rules
    // do reject a usage map, which is also why nextUsage clamps at zero
    // instead of trusting a caller's negative `by`.
    const negative = { date: today, likes: -1, superLikes: 0, rewinds: 0 };
    t.check(
      'a negative counter is refused, so the clamp is load-bearing',
      await k.ok(k.testing.assertFails(updateDoc(doc(owner, 'users', uid), { usage: negative }))),
      k.show(negative)
    );

    /* ---- and the same loop for the public projection --------------------- */

    // The other document the store writes, and the one with a history. It is
    // published best-effort — a failed projection write must never fail the
    // profile save that caused it — so if the rules refuse it, nothing throws,
    // nothing is logged where anybody looks, and the account simply stops
    // appearing in other people's decks. That has happened once already, when
    // the projection emitted `lastActiveAt: null` and the rules accepted that
    // key only as a string.
    //
    // `tests/projection.test.js` compares the projection's KEY SET against the
    // rules' allowlists, with no emulator. It cannot compare values, and both
    // times this broke it was a value. So: let the shipped code project a real
    // account, then replay that exact document against the real ruleset.
    const puid = 'rules-projected';
    await k.store.updateUser(puid, {
      uid: puid,
      email: puid + '@example.com',
      displayName: 'Projected',
      createdAt: '2026-01-01T00:00:00.000Z',
      profile: {
        birthdate: '1995-02-19',
        age: 31,
        gender: 'woman',
        bio: 'A short, valid bio.',
        interests: ['hiking', 'coffee'],
        // A sixth axis the private half tolerated for eight rounds. The rules
        // close the key list on both sides now, so a projection that copied this
        // across verbatim would be refused — silently.
        personality: { openness: 70, conscientiousness: 60, extraversion: 50,
                       agreeableness: 65, stability: 55, chaos: 99 },
        location: { label: 'Portland, OR', lat: 45.52, lng: -122.68 }
      }
    });
    k.ctx.drainWarnings();
    const projected = await k.admin.get('discovery', puid);

    t.check(
      'the shipped code published a projection to replay',
      !!projected && !!projected.profile,
      projected ? k.show(Object.keys(projected)) : 'nothing was written'
    );

    t.check(
      'and it published the five axes without the sixth the private half held',
      !!projected && k.same(Object.keys(projected.profile.personality || {}).sort(),
        ['agreeableness', 'conscientiousness', 'extraversion', 'openness', 'stability']),
      k.show(projected && projected.profile.personality)
    );

    const pOwner = k.rulesEnv.authenticatedContext(puid).firestore();

    t.check(
      'and firestore.rules accepts exactly what was published',
      await k.ok(k.testing.assertSucceeds(setDoc(doc(pOwner, 'discovery', puid), projected))),
      k.show(projected && projected.profile.personality)
    );

    // The counterweight. Without it the check above would pass against rules
    // that accepted anything at all under `personality`, which is what they did
    // until this round.
    const smuggled = JSON.parse(JSON.stringify(projected));
    smuggled.profile.personality.chaos = 99;
    t.check(
      'while the un-normalised version the projection used to publish is refused',
      await k.ok(k.testing.assertFails(setDoc(doc(pOwner, 'discovery', puid), smuggled))),
      k.show(smuggled.profile.personality)
    );
  }
};
