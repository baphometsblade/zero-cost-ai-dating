/* ==========================================================================
   Does firestore.rules let the transaction through?

   firestore.rules needed no change for the atomic counter — `allow update`
   re-validates the merged document, and the usage validator already accepts
   {date: a 10-character string, non-negative numbers} while uid, email and
   createdAt stay frozen. That was reasoning, not evidence: nothing had ever
   run a real bump past the real rules.

   The store this suite drives is connected to the emulator without an auth
   token, so most of the suite runs on a project with open rules and could not
   tell. This spec closes the loop by replay: let the shipped transaction
   store a value, then write *that exact value* against the real ruleset as
   the document's owner. (The other way through is to point `ZC.firebase.db`
   at a rules-unit-testing authenticated context, so the shipped call itself
   runs under the real rules; 08-conversation does that to rewind one swipe
   twice.)
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

    // The other document the store writes. It used to be published
    // best-effort, after the profile save and outside it, so a refusal would
    // have thrown nothing, logged nothing where anybody looks, and quietly
    // taken the account out of other people's decks. The rules and the data
    // model have disagreed about a value before — on the private document:
    // userDocOk accepted `lastActiveAt` only as a string while normalizeUser
    // writes null for an account never seen, and users/{uid} writes were
    // refused (58e16d4). updateUser now writes the projection in the same
    // transaction as the account, so a refusal fails the whole save instead;
    // createUser's first projection is still best-effort and only warns.
    // Either way only the real rules can refuse it, and most of this suite
    // runs on open ones.
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

    /* ---- the account document's identity, written by the shipped calls ---- */

    // Not a replay this time: the store is pointed at the real ruleset as the
    // account itself, with the email on its token that Firebase Auth puts
    // there, and makes the calls auth.js makes. Every one of them was refused,
    // or stored something the next one was refused over, and the demo adapter
    // accepted all of it: a create carrying the 70-character name Google hands
    // over, an upsert that stored email '', and the email repair auth.js sends
    // on every page load after that.
    const iuid = 'rules-identity';
    const iemail = iuid + '@example.com';
    const long = 'Maria Fernanda de los Angeles Garcia-Rodriguez Montenegro y Bustamante';
    const openDb = k.ctx.ZC.firebase.db;
    const priorAuth = k.ctx.ZC.auth;
    const answer = function (err) { return { rejected: (err && err.code) || String(err) }; };
    const stored = async function () {
      let data = null;
      await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
        const snap = await k.fs.getDoc(k.fs.doc(c.firestore(), 'users', iuid));
        data = snap.exists() ? snap.data() : null;
      });
      return data;
    };
    let created = null;
    let upserted = null;
    let repaired = null;
    let misdirected = null;
    let afterUpsert = null;
    let afterRepair = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(iuid, { email: iemail }).firestore();

      created = await k.store.createUser(iuid, { email: iemail, displayName: long }).catch(answer);

      // Settings saving while auth.js holds an in-memory stand-in: the
      // document is missing, and ZC.auth.current is the account.
      await k.rulesEnv.withSecurityRulesDisabled(function (c) {
        return k.fs.deleteDoc(k.fs.doc(c.firestore(), 'users', iuid));
      });
      k.ctx.ZC.auth = { current: { uid: iuid, email: iemail, displayName: 'Maria' } };
      upserted = await k.store.updateUser(iuid, { preferences: { theme: 'dark' } }).catch(answer);
      afterUpsert = await stored();

      // A document stored with the wrong address, which is what that upsert
      // used to leave and what an address changed outside the app leaves.
      await k.rulesEnv.withSecurityRulesDisabled(function (c) {
        return k.fs.setDoc(k.fs.doc(c.firestore(), 'users', iuid), k.h.userDoc(iuid, { email: '' }));
      });
      repaired = await k.store.updateUser(iuid, { email: iemail }).catch(answer);
      afterRepair = await stored();
      misdirected = await k.store.updateUser(iuid, { email: 'someone-else@example.com' }).catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
      k.ctx.ZC.auth = priorAuth;
    }
    k.ctx.drainWarnings();

    t.check(
      'under the real rules, createUser is accepted for a provider name longer than they allow',
      !!created && !created.rejected && created.displayName === long.slice(0, 60),
      k.show(created && (created.rejected ? created : { displayName: created.displayName }))
    );

    t.check(
      'updateUser on a missing document stores the signed-in account\'s email, not an empty one',
      !!upserted && !upserted.rejected && !!afterUpsert && afterUpsert.email === iemail &&
        afterUpsert.preferences.theme === 'dark',
      k.show(upserted && upserted.rejected ? upserted : afterUpsert && { email: afterUpsert.email })
    );

    t.check(
      'and the email repair auth.js sends is accepted, and stored',
      !!repaired && !repaired.rejected && !!afterRepair && afterRepair.email === iemail,
      k.show(repaired && repaired.rejected ? repaired : afterRepair && { email: afterRepair.email })
    );

    // The counterweight: the repair is accepted because it is the token's
    // address, not because email stopped being frozen.
    t.check(
      'while an address that is not the account\'s own is still refused',
      !!misdirected && misdirected.rejected === 'permission-denied',
      k.show(misdirected && (misdirected.rejected ? misdirected : { email: misdirected.email }))
    );

    /* ---- two more values the public half is held to more tightly ---------- */

    // firestore.rules holds the projection's interests to the vocabulary and its
    // lastActiveAt to a toISOString() stamp no later than a day past the server's
    // clock. The private document is held only to a count, a character total and a
    // short string, so it can carry values the projection's rules refuse — and the
    // projection is written in the same transaction as the profile save, so either
    // one fails the save.
    const vuid = 'rules-vocab';
    await k.store.updateUser(vuid, {
      uid: vuid,
      email: vuid + '@example.com',
      displayName: 'Vocabulary',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: '9999-12-31T23:59:59.999Z',
      profile: { age: 31, gender: 'woman', interests: ['hiking', '__x__', 'coffee'] }
    });
    k.ctx.drainWarnings();
    const vProjected = await k.admin.get('discovery', vuid);

    t.check(
      'the shipped code publishes only the interests the vocabulary holds',
      !!vProjected && k.same(vProjected.profile.interests, ['hiking', 'coffee']),
      k.show(vProjected && vProjected.profile.interests)
    );

    t.check(
      'and an activity stamp no later than now',
      !!vProjected && Date.parse(vProjected.lastActiveAt) <= Date.now(),
      k.show(vProjected && vProjected.lastActiveAt)
    );

    const vOwner = k.rulesEnv.authenticatedContext(vuid).firestore();
    t.check(
      'and firestore.rules accepts exactly that',
      !!vProjected && await k.ok(k.testing.assertSucceeds(setDoc(doc(vOwner, 'discovery', vuid), vProjected))),
      k.show(vProjected && { interests: vProjected.profile.interests, lastActiveAt: vProjected.lastActiveAt })
    );

    const verbatim = JSON.parse(JSON.stringify(vProjected || {}));
    if (verbatim.profile) verbatim.profile.interests = ['hiking', '__x__', 'coffee'];
    t.check(
      'while the private interests copied across verbatim are refused',
      !!vProjected && await k.ok(k.testing.assertFails(setDoc(doc(vOwner, 'discovery', vuid), verbatim))),
      k.show(verbatim.profile && verbatim.profile.interests)
    );

    /* ---- the learning map, after a stranger's cards have filled it -------- */

    // Every card's interests go into the swiper's own learning map, and the rules
    // cap that map at 1200 key characters. Five strangers with one 239-character tag
    // each — accepted, before the vocabulary — left 1195 of them used, and from then
    // on a save that learned any slug longer than five characters (42 of the 48), or
    // two new tags at once, came back permission-denied, page load after page load.
    // The rules now refuse those tags, but maps filled before they did are
    // still stored, and they have to heal on their next save rather than stay stuck.
    // Run the deck's own sequence against the real ruleset as the account itself:
    // read the stored map, fold one ordinary like into it, save it.
    const learner = 'rules-learner';
    const filled = { interestAffinity: {}, likeCount: 0, passCount: 5 };
    ['a2', 'a3', 'a4', 'a5', 'a6'].forEach(function (u) {
      filled.interestAffinity[u + '-' + 'y'.repeat(236)] = -0.0525;
    });
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'users', learner), k.h.userDoc(learner, { learning: filled }));
    });
    const engine = require(require('path').join(k.h.ROOT, 'public', 'js', 'matching-engine.js'));
    const dbBefore = k.ctx.ZC.firebase.db;
    let saved = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(learner).firestore();
      const me = await k.store.getUser(learner);
      const ordinary = { uid: 'ordinary', profile: { interests: ['yoga', 'cooking'] } };
      const next = engine.updateLearning(me.learning, ordinary, 'like');
      saved = await k.store.saveLearning(learner, next).then(function () { return 'saved'; },
        function (err) { return (err && err.code) || String(err); });
    } finally {
      k.ctx.ZC.firebase.db = dbBefore;
    }
    k.ctx.drainWarnings();
    let kept = null;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      kept = ((await k.fs.getDoc(doc(c.firestore(), 'users', learner))).data() || {}).learning || null;
    });

    t.check(
      'a learning map strangers\' tags had filled saves again on the next swipe, under the real rules',
      saved === 'saved',
      String(saved)
    );

    t.check(
      'and what it saved is the vocabulary part, with the counts carried on',
      !!kept && k.same(Object.keys(kept.interestAffinity || {}).sort(), ['cooking', 'yoga']) &&
        kept.likeCount === 1 && kept.passCount === 5,
      k.show(kept && { keys: Object.keys(kept.interestAffinity || {}).map(function (key) {
        return key.length > 12 ? key.slice(0, 6) + '…(' + key.length + ')' : key;
      }), likeCount: kept.likeCount, passCount: kept.passCount })
    );
  }
};
