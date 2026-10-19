/* ==========================================================================
   The projection has to agree with the document it projects.

   updateUser writes two documents: the private users/{uid} and the public
   discovery/{uid} that everybody else's deck reads. It used to write them
   separately — the transaction committed, and then a follow-up set published
   the projection.

   Two saves racing that way commit their user documents in one order and can
   publish their projections in the other, because two independent promises
   settle on their own schedule. The loser is the *public* profile: it keeps
   an older name, bio or location than the account it is supposed to mirror,
   and nothing ever corrects it, because the next write publishes from the
   next value rather than reconciling this one.

   Putting the projection inside the same transaction is what makes that
   impossible: both documents commit together, and whichever save commits
   second has read the first. This spec pins the invariant — the two
   documents agree — rather than the mechanism, so it keeps its meaning if
   the implementation changes again.

   Read this check honestly. It is a GUARD, not a reproduction. Reverting the
   fix — publishing the projection after the transaction, the way it used to
   — leaves this spec green: run against the emulator over loopback, twenty
   racing saves settled in commit order every time, three runs out of three.
   Every request here travels the same near-zero distance, so the window the
   bug needs barely exists. It is wider wherever latency varies, which is
   everywhere else. So the fix rests on the ordering argument above, and this
   spec exists to catch a regression that breaks the invariant outright — not
   to prove the race was real. Nothing in this suite proves that.

   The second half is the same invariant with time as the other writer. The
   private document holds a birthdate and `normalizeUser` re-derives the age
   from it on every read; the projection holds only the age, as it was when
   the profile was last saved. Nobody else may see the birthdate, so a
   birthday since that save could only reach other decks through a write, and
   the only `discovery/{uid}` write an ordinary visit makes — the second of
   the presence touch's two — carried `lastActiveAt` alone. A 29-year-old went on being served as 28, and passed
   a 28-and-under filter, until something next saved their document through
   `updateUser` (Profile, Settings, Plans, a block). The demo deck reads whole
   documents, re-derived, so there the same person was 29 the morning of their
   birthday. */
'use strict';

const path = require('path');

/** Concurrent saves. Enough that an ordering inversion would show up. */
const N = 20;

/** How far back the profile save is made: long enough to cross a birthday. */
const SAVED_DAYS_AGO = 240;

/**
 * Run `fn` with the wall clock moved `offsetMs` into the past — every
 * `new Date()` and `Date.now()` the store makes, which is what stamps the age
 * a save derives.
 * @param {number} offsetMs how far back
 * @param {Function} fn what to run then
 * @returns {Promise<*>} what `fn` resolved to
 */
async function inThePast(offsetMs, fn) {
  const RealDate = Date;
  class ThenDate extends RealDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(RealDate.now() - offsetMs);
    }
    static now() { return RealDate.now() - offsetMs; }
  }
  globalThis.Date = ThenDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * A birthdate whose birthday fell thirty days ago: after a save made
 * SAVED_DAYS_AGO days back, and before today.
 * @param {number} years how old the person turned on it
 * @returns {string} YYYY-MM-DD
 */
function birthdayLastMonth(years) {
  const then = new Date(Date.now() - 30 * 86400000);
  return (then.getFullYear() - years) + '-' + String(then.getMonth() + 1).padStart(2, '0') + '-' +
    String(then.getDate()).padStart(2, '0');
}

module.exports = {
  title: 'A racing save cannot leave the public projection behind',

  async run(t, k) {
    const uid = 'projection-order';
    await k.admin.set('users', uid, k.h.userDoc(uid));

    // All at once, deliberately: these are not sequenced the way the deck
    // sequences a swipe, because the point is the ordering between two
    // independent saves rather than the deck's own pattern.
    const names = [];
    const saves = [];
    for (let i = 1; i <= N; i++) {
      const displayName = 'Name ' + i;
      names.push(displayName);
      saves.push(k.store.updateUser(uid, { displayName: displayName }));
    }
    const rejected = [];
    await Promise.all(saves.map(function (p) {
      return p.catch(function (err) { rejected.push(err && err.message ? err.message : String(err)); });
    }));

    const user = (await k.admin.get('users', uid)) || {};
    const shadow = (await k.admin.get('discovery', uid)) || {};
    const userName = user.displayName;
    const shadowName = shadow.displayName;

    t.check(
      'every save committed',
      rejected.length === 0,
      rejected.length + ' rejection(s)' + (rejected.length ? ': ' + rejected[0] : '')
    );
    t.check(
      'the winning name is one of the names actually written',
      names.indexOf(userName) !== -1,
      'stored ' + k.show(userName)
    );
    t.check(
      'the public projection shows the same name as the private document',
      shadowName === userName,
      'users/' + uid + ' says ' + k.show(userName) +
        ', discovery/' + uid + ' says ' + k.show(shadowName)
    );
    t.check(
      'the projection still carries only the public shape',
      shadow.email === undefined && shadow.blocked === undefined &&
        shadow.usage === undefined && shadow.learning === undefined,
      k.show(Object.keys(shadow).sort())
    );

    /* ---- a birthday since the last save -------------------------------- */

    const util = k.ctx.ZC.util;
    const engine = require(path.join(k.h.ROOT, 'public', 'js', 'matching-engine.js'));
    const aged = 'projection-birthday';
    const viewer = 'projection-birthday-viewer';
    const birthdate = birthdayLastMonth(29);
    const ageThen = await inThePast(SAVED_DAYS_AGO * 86400000, async function () {
      await k.store.createUser(aged, { email: aged + '@example.com', displayName: 'Xavi' });
      await k.store.updateUser(aged, {
        profileComplete: true,
        profile: { birthdate: birthdate, gender: 'man', bio: 'Saved a while ago.', interests: ['hiking'] },
        preferences: { interestedIn: ['woman'], ageMin: 18, ageMax: 100 }
      });
      return util.ageFromBirthdate(birthdate);
    });
    const ageNow = util.ageFromBirthdate(birthdate);
    const projectedThen = ((await k.admin.get('discovery', aged)) || { profile: {} }).profile.age;

    // A page load months later, as every page makes one: auth.js reads the
    // account, then the presence touch. Counted, because this is the write
    // budget's most frequent entry.
    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0, writes: 0, wrote: [] };
    let loaded = null;
    let touched = null;
    k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
    try {
      loaded = await k.store.getUser(aged);
      tally.reads = 0;
      tally.writes = 0;
      tally.wrote = [];
      touched = await k.store.touchActive(aged);
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    const projectedNow = ((await k.admin.get('discovery', aged)) || { profile: {} }).profile.age;

    t.check('the fixture crossed a birthday: saved at ' + (ageNow - 1) + ', ' + ageNow + ' today',
      ageThen === ageNow - 1 && projectedThen === ageThen && loaded && loaded.profile.age === ageNow,
      k.show({ birthdate: birthdate, ageThen: ageThen, projectedThen: projectedThen, ownAge: loaded && loaded.profile.age }));
    t.check('after a birthday, the next visit\'s touch brings the public age up to the private one',
      touched === true && projectedNow === ageNow,
      'discovery says ' + k.show(projectedNow) + ', the account says ' + ageNow);
    t.check('and the touch carries it without costing anything more: two writes, no read',
      tally.writes === 2 && tally.reads === 0,
      tally.writes + ' write(s), ' + tally.reads + ' read(s): ' + k.show(tally.wrote));

    // What it was for: somebody whose upper bound is the old age is not shown
    // the person they no longer match, as the demo deck already does not.
    await k.store.createUser(viewer, { email: viewer + '@example.com', displayName: 'Yara' });
    const me = await k.store.updateUser(viewer, {
      profileComplete: true,
      profile: { birthdate: '1997-01-01', gender: 'woman', bio: 'Looking.', interests: ['hiking'] },
      preferences: { interestedIn: ['man'], ageMin: 18, ageMax: ageThen }
    });
    const deck = await k.store.listCandidates(viewer, { limit: 60 });
    k.ctx.drainWarnings();
    const card = deck.filter(function (c) { return c.uid === aged; })[0] || null;
    const verdict = card ? engine.scoreCandidate(me, card, { now: Date.now() }) : null;
    // And with the bound raised to today's age the same deck does offer them,
    // at that age, so the absence above is about the age and not about a deck
    // that came back without them for some other reason.
    const wider = await k.store.updateUser(viewer, { preferences: { ageMax: ageNow } });
    const shown = (await k.store.listCandidates(viewer, { limit: 60 })).filter(function (c) { return c.uid === aged; })[0] || null;
    k.ctx.drainWarnings();
    const shownVerdict = shown ? engine.scoreCandidate(wider, shown, { now: Date.now() }) : null;
    t.check('so a deck limited to ' + ageThen + ' and under no longer offers them, and one limited to ' + ageNow +
        ' offers them at ' + ageNow,
      (!card || (!!verdict && verdict.hardFail === 'age')) &&
        !!shown && shown.profile.age === ageNow && !!shownVerdict && !shownVerdict.hardFail,
      k.show({
        under: card ? { age: card.profile.age, hardFail: verdict && verdict.hardFail } : 'not in the deck',
        upTo: shown ? { age: shown.profile.age, hardFail: shownVerdict && shownVerdict.hardFail } : 'not in the deck'
      }));
  }
};
