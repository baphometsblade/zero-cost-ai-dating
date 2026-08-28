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
  }
};
