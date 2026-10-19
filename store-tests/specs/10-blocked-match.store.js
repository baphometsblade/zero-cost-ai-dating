/* ==========================================================================
   A refused match document does not read as a lost swipe.

   `firestore.rules` now refuses to create a match when the other person has
   blocked the caller — which is the only place a block can be enforced, since
   the list lives in a private document this client never sees. The rules suite
   proves the refusal. This proves the other half: what the shipped store does
   when it happens.

   It matters because the failure lands in the middle of `recordSwipe`, after
   the swipe document is already stored. Letting the rejection propagate would
   reach `persistSwipe` in dashboard.js as a swipe that was stored and an
   exchange that did not finish, and the deck would say "Saved, but we could
   not check for a match just then." That tells somebody they have been
   blocked by showing them a warning nobody else gets.

   The rejection is injected rather than provoked. This suite's own project
   runs open rules and cannot produce a real denial — see the caveat in
   store-tests/README.md — so `matches/*` writes are made to reject with the
   error a denied write actually produces. What is under test is the shipped
   code's response to that rejection, which is exactly the part the rules
   suite cannot reach.
   ========================================================================== */
'use strict';

/**
 * The same compat Firestore with one difference: creating a match document is
 * refused, the way the rules refuse it for a blocked caller. Everything else —
 * reads, swipe writes, subcollections — behaves normally, so the spec measures
 * one failure rather than a broken database.
 *
 * Methods are bound rather than re-proxied: the compat SDK chains refs off each
 * other, and a bound method keeps `this` pointing at the real object.
 *
 * @param {Object} real the emulator-backed compat Firestore
 * @param {{denied:number}} tally counts refusals, so a spec cannot pass because
 *   the injection silently stopped working
 * @param {Function} rejection builds the error each refused write rejects with
 * @returns {Object} a stand-in for ZC.firebase.db
 */
function refusingMatchWrites(real, tally, rejection) {
  function bound(obj, key) {
    const value = obj[key];
    return typeof value === 'function' ? value.bind(obj) : value;
  }
  return new Proxy(real, {
    get: function (obj, prop) {
      if (prop !== 'collection') return bound(obj, prop);
      return function (name) {
        const collection = obj.collection.apply(obj, arguments);
        if (name !== 'matches') return collection;
        return new Proxy(collection, {
          get: function (c, key) {
            if (key !== 'doc') return bound(c, key);
            return function () {
              const ref = c.doc.apply(c, arguments);
              return new Proxy(ref, {
                get: function (r, inner) {
                  if (inner !== 'set') return bound(r, inner);
                  return function () {
                    tally.denied += 1;
                    return Promise.reject(rejection());
                  };
                }
              });
            };
          }
        });
      };
    }
  });
}

/** What a rules refusal looks like coming back from the compat SDK. */
function denial() {
  const err = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
  err.code = 'permission-denied';
  return err;
}

/** Anything else: offline, an exhausted quota, a transient failure. */
function outage() {
  const err = new Error('Failed to get document because the client is offline.');
  err.code = 'unavailable';
  return err;
}

/**
 * A rejection that cannot be written to. Firestore does not produce one today,
 * but marking an error is an assignment, and assigning to a frozen object throws
 * under `'use strict'` — which would replace the real rejection with a
 * meaningless TypeError carrying no mark at all, and send the deck down exactly
 * the path the mark exists to avoid.
 */
function frozenOutage() {
  const err = new Error('Backend unavailable.');
  err.code = 'unavailable';
  return Object.freeze(err);
}

/**
 * A failure that is not a refusal but says the words anyway — a wrapped error,
 * a proxy, a log line quoted into a message. The refusal test used to fall back
 * to matching the message when no code was present, which would have swallowed
 * this and answered "no match" for a write whose outcome is unknown.
 */
function impostor() {
  return new Error('Upstream request failed: PERMISSION_DENIED reported by the gateway.');
}

module.exports = {
  title: 'A match document the rules refuse does not read as a lost swipe',

  async run(t, k) {
    const me = 'refused-me';
    const them = 'refused-them';
    const matchId = [me, them].sort().join('_');

    await k.admin.set('users', me, k.h.userDoc(me));
    await k.admin.set('users', them, k.h.userDoc(them, { blocked: [me] }));

    // They liked me first, so everything except the block says this is a match.
    await k.admin.set('swipes', them + '_' + me, {
      id: them + '_' + me, from: them, to: me, action: 'like', createdAt: '2026-01-02T00:00:00.000Z'
    });

    const real = k.ctx.ZC.firebase.db;
    const tally = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, tally, denial);

    let outcome = null;
    let threw = null;
    try {
      outcome = await k.store.recordSwipe(me, them, 'like');
    } catch (err) {
      threw = err;
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    const warnings = k.ctx.drainWarnings();

    // Twice, and exactly twice: once dated now, and once more dated by the like it
    // answers, which is what a device clock more than a day fast needs (see the end of
    // this spec). A block refuses both, and nothing tries a third time.
    t.check('the refusal actually happened, so this spec is testing something',
      tally.denied === 2, tally.denied + ' refused write(s)');

    t.check('recordSwipe does not throw, so the deck cannot take the card back',
      threw === null, threw ? String(threw.message) : 'resolved');

    // Not "matched: true with no document": the deck would raise the match
    // overlay and send them to a conversation that does not exist.
    t.check('it answers plainly that no match was made',
      !!outcome && outcome.matched === false && outcome.matchId === null && outcome.created === false,
      k.show(outcome));

    t.check('the swipe itself is stored, which is what the caller was told',
      (await k.admin.get('swipes', me + '_' + them)) !== null, 'swipes/' + me + '_' + them);

    t.check('and no match document exists', (await k.admin.get('matches', matchId)) === null,
      'matches/' + matchId);

    // A breadcrumb, so a real fault does not vanish behind a feature — but not the
    // reason. A console line carrying `permission-denied` tells a blocked account it
    // was blocked, which is the one thing this whole path exists to avoid. It is not a
    // seal: the refused write is still a 403 in the network tab.
    t.check('the refusal is warned about exactly once, naming the document',
      warnings.length === 1 && warnings[0].indexOf(matchId) !== -1, k.show(warnings));

    t.check('and the warning does not carry the reason it was refused',
      warnings.length === 1 && !/permission|denied/i.test(warnings[0]), k.show(warnings));

    /* ---- and everything that is not a refusal still surfaces --------------- */

    // The first version of this caught every rejection, which turned an offline write
    // or an exhausted quota into a confident "you did not match" — a claim it cannot
    // make, since the pair may be mutual and the write may land on a retry. Only the
    // rules refusal is answerable; the rest belong to the caller.
    const other = 'refused-other';
    await k.admin.set('users', other, k.h.userDoc(other));
    await k.admin.set('swipes', other + '_' + me, {
      id: other + '_' + me, from: other, to: me, action: 'like', createdAt: '2026-01-02T00:00:00.000Z'
    });

    const outageTally = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, outageTally, outage);
    let outageError = null;
    try {
      await k.store.recordSwipe(me, other, 'like');
    } catch (err) {
      outageError = err;
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    t.check('a failure that is not a refusal is not answered as "no match"',
      outageError !== null && outageError.code === 'unavailable',
      outageError ? outageError.code + ': ' + outageError.message : 'resolved instead of throwing');

    // And it says the swipe survived, which the caller cannot work out for
    // itself. dashboard.js reads any throw from recordSwipe as "the swipe is
    // not stored" and puts the card back — true of the first write in that
    // function and of nothing after it. Taking a card back that was in fact
    // recorded invites a second, contradictory decision the store will not
    // record, because a recorded swipe stands.
    t.check('and says the swipe itself was already stored',
      !!outageError && outageError.swipeStored === true,
      outageError ? 'swipeStored=' + outageError.swipeStored : 'no error');

    t.check('which it was',
      (await k.admin.get('swipes', me + '_' + other)) !== null, 'swipes/' + me + '_' + other);

    // And the refusal is decided by the code, not by the words. A rejection that
    // merely *says* permission denied — a wrapped error, a gateway message quoted
    // into one — is still a failure of unknown outcome, and answering "no match"
    // for it would be the same false confidence in a different disguise.
    const third = 'refused-third';
    await k.admin.set('users', third, k.h.userDoc(third));
    await k.admin.set('swipes', third + '_' + me, {
      id: third + '_' + me, from: third, to: me, action: 'like', createdAt: '2026-01-02T00:00:00.000Z'
    });

    const impostorTally = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, impostorTally, impostor);
    let impostorError = null;
    try {
      await k.store.recordSwipe(me, third, 'like');
    } catch (err) {
      impostorError = err;
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    t.check('a failure that only says "permission denied" is not treated as one',
      impostorError !== null && !impostorError.code,
      impostorError ? String(impostorError.message) : 'resolved instead of throwing');

    /* ---- and a rejection that refuses to be marked ---------------------- */

    const fourth = 'refused-fourth';
    await k.admin.set('users', fourth, k.h.userDoc(fourth));
    await k.admin.set('swipes', fourth + '_' + me, {
      id: fourth + '_' + me, from: fourth, to: me, action: 'like', createdAt: '2026-01-02T00:00:00.000Z'
    });

    const frozenTally = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, frozenTally, frozenOutage);
    let frozenError = null;
    try {
      await k.store.recordSwipe(me, fourth, 'like');
    } catch (err) {
      frozenError = err;
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    // The signal has to survive a frozen error, because losing it is not a
    // degraded outcome: the deck takes the card back and invites a second
    // decision the store will drop.
    t.check('a rejection that cannot be marked still says the swipe was stored',
      !!frozenError && frozenError.swipeStored === true,
      frozenError ? 'swipeStored=' + frozenError.swipeStored : 'no error');

    t.check('and keeps the code and the message it arrived with',
      !!frozenError && frozenError.code === 'unavailable' && /Backend unavailable/.test(String(frozenError.message)),
      frozenError ? frozenError.code + ': ' + frozenError.message : 'no error');

    /* ---- a reciprocal swipe the rules will not show is not a match ------ */

    // Real, not injected: the shipped recordSwipe and finishMatchCheck, signed in
    // as the swiper, against the real firestore.rules. Those let an account read a
    // swipe aimed at it only when it is a like or a super like, and refuse a pass
    // and a missing swipe alike, because answering the miss would make the refusal
    // mean "they passed". So the reciprocal read that every like ends in is now
    // refused far more often than it is answered — on every first like — and a
    // store that let that refusal through would have had the deck say "Saved, but
    // we could not check for a match just then" on nearly every card.
    const swiper = 'recip-me';
    const passer = 'recip-passer';
    const silent = 'recip-silent';
    const liker = 'recip-liker';
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      for (const uid of [swiper, passer, silent, liker]) {
        await k.fs.setDoc(k.fs.doc(db, 'users', uid), k.h.userDoc(uid));
      }
      await k.fs.setDoc(k.fs.doc(db, 'swipes', passer + '_' + swiper), k.h.swipeDoc(passer, swiper, 'pass'));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', liker + '_' + swiper), k.h.swipeDoc(liker, swiper, 'like'));
    });

    const openDb = k.ctx.ZC.firebase.db;
    const answer = function (err) { return { rejected: (err && err.code) || String(err), swipeStored: !!(err && err.swipeStored) }; };
    const outcomes = {};
    k.ctx.drainWarnings();
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(swiper).firestore();
      outcomes.passer = await k.store.recordSwipe(swiper, passer, 'like').catch(answer);
      outcomes.silent = await k.store.recordSwipe(swiper, silent, 'super').catch(answer);
      // A check a page load lost, as `16-reconcile` writes one: the next page load
      // finishes it through finishMatchCheck, which ends in the same read.
      const KEY = k.ctx.ZC.store.KEYS.pendingMatch;
      const owed = {};
      owed[swiper] = {};
      owed[swiper][passer] = { at: new Date().toISOString(), last: null };
      globalThis.localStorage.setItem(KEY, JSON.stringify(owed));
      outcomes.finished = await k.store.reconcileMatches(swiper).catch(answer);
      outcomes.liker = await k.store.recordSwipe(swiper, liker, 'like').catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
    }
    const recipWarnings = k.ctx.drainWarnings();
    const noMatch = function (o) { return !!o && o.matched === false && o.matchId === null && !o.rejected; };

    t.check('under the real rules, liking somebody who passed on you is plainly no match',
      noMatch(outcomes.passer), k.show(outcomes.passer));

    t.check('and so is liking somebody who has not swiped yet, which is the same refusal',
      noMatch(outcomes.silent), k.show(outcomes.silent));

    // Answered and spent. A refusal that propagated would keep the note and fail
    // the same way on every page load after this one.
    t.check('finishing a lost check against a pass settles it, rather than failing every page load',
      !!outcomes.finished && outcomes.finished.checked === 1 && outcomes.finished.repaired === 0 &&
        outcomes.finished.pending === 0, k.show(outcomes.finished));

    // The control: a like aimed at the swiper is still readable, so the refusal
    // above cannot be a store that has stopped asking.
    t.check('while liking somebody who liked you still makes the match',
      !!outcomes.liker && outcomes.liker.matched === true && outcomes.liker.created === true,
      k.show(outcomes.liker));

    // Not even the breadcrumb a refused match write leaves: this refusal is what
    // most likes get, and it says nothing that is wrong.
    t.check('and the refusals are not logged',
      recipWarnings.length === 0, k.show(recipWarnings));

    /* ---- the other refusal a match document can meet: a fast clock ------ */

    // firestore.rules also refuses a match stamped more than a day past the server's
    // clock, and a device running that fast stamps every one of them so. That refusal
    // came back as the same quiet "no match" a block gets, the facade then spent the
    // note that would have retried it, and neither side's deck offers the other again
    // once both have swiped: a mutual like lost, with one warning to show for it.
    // Real, not injected: the shipped recordSwipe, signed in as the swiper, with every
    // `new Date()` and `Date.now()` it makes running 25 hours ahead.
    const fast = 'fast-me';
    const fastLiker = 'fast-liker';
    const fastBlocker = 'fast-blocker';
    const likedAt = new Date(Date.now() - 3600000).toISOString();
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      await k.fs.setDoc(k.fs.doc(db, 'users', fast), k.h.userDoc(fast));
      await k.fs.setDoc(k.fs.doc(db, 'users', fastLiker), k.h.userDoc(fastLiker));
      await k.fs.setDoc(k.fs.doc(db, 'users', fastBlocker), k.h.userDoc(fastBlocker, { blocked: [fast] }));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', fastLiker + '_' + fast),
        Object.assign(k.h.swipeDoc(fastLiker, fast, 'like'), { createdAt: likedAt }));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', fastBlocker + '_' + fast),
        Object.assign(k.h.swipeDoc(fastBlocker, fast, 'like'), { createdAt: likedAt }));
    });
    const RealDate = Date;
    class FastDate extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(RealDate.now() + 25 * 3600000);
      }
      static now() { return RealDate.now() + 25 * 3600000; }
    }
    const fastOutcomes = {};
    k.ctx.drainWarnings();
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(fast).firestore();
      globalThis.Date = FastDate;
      fastOutcomes.liked = await k.store.recordSwipe(fast, fastLiker, 'like').catch(answer);
      fastOutcomes.blocked = await k.store.recordSwipe(fast, fastBlocker, 'like').catch(answer);
    } finally {
      globalThis.Date = RealDate;
      k.ctx.ZC.firebase.db = openDb;
    }
    const fastWarnings = k.ctx.drainWarnings();
    let fastMatch = null;
    let blockedMatch = null;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      fastMatch = (await k.fs.getDoc(k.fs.doc(db, 'matches', k.h.pairId(fast, fastLiker)))).data() || null;
      blockedMatch = (await k.fs.getDoc(k.fs.doc(db, 'matches', k.h.pairId(fast, fastBlocker)))).data() || null;
    });

    const likedWarned = fastWarnings.filter(function (w) { return w.indexOf(k.h.pairId(fast, fastLiker)) !== -1; });
    t.check('with the device clock more than a day fast, a mutual like still makes the match',
      !!fastOutcomes.liked && fastOutcomes.liked.matched === true && fastOutcomes.liked.created === true &&
        !!fastMatch && likedWarned.length === 0,
      k.show({ answered: fastOutcomes.liked, stored: fastMatch ? 'exists' : 'MISSING', warnings: likedWarned }));

    // Dated by the like it answers: a stamp the other person's device wrote, earlier
    // than this one's, and one the rules accept.
    t.check('dated by the like it answers, since the clock\'s own stamp is refused',
      !!fastMatch && fastMatch.createdAt === likedAt,
      k.show({ createdAt: fastMatch && fastMatch.createdAt, likedAt: likedAt }));

    // The control: the block is still the quiet refusal it was, clock or no clock —
    // no throw, no match, and one breadcrumb that does not say why.
    const blockedWarned = fastWarnings.filter(function (w) { return w.indexOf(k.h.pairId(fast, fastBlocker)) !== -1; });
    t.check('while somebody who blocked that account is still plainly no match',
      noMatch(fastOutcomes.blocked) && blockedMatch === null && blockedWarned.length === 1 &&
        !/permission|denied/i.test(blockedWarned[0]),
      k.show({ answered: fastOutcomes.blocked, stored: blockedMatch ? 'EXISTS' : 'none', warnings: fastWarnings }));

    /* ---- a like answered long after it was given ------------------------- */

    // A like can be weeks old when it is answered, and `createdAt` is what both
    // people's lists sort and label a match by: the new-matches strip sorts by it,
    // the conversation list by `lastMessageAt` or it, and the conversation header
    // says "matched" and its date. Dated by a like twenty days old, a match made
    // now went below a conversation that had been quiet for three days, in the
    // list of the other person, whose clock is right. They were on the app ten
    // minutes ago here, and a stamp like that goes through the same rule.
    const oldLiker = 'fast-old-liker';
    const talker = 'fast-old-talker';
    const oldLike = new Date(Date.now() - 20 * 86400000).toISOString();
    const seenAt = new Date(Date.now() - 10 * 60000).toISOString();
    const quietAt = new Date(Date.now() - 3 * 86400000).toISOString();
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      await k.fs.setDoc(k.fs.doc(db, 'users', oldLiker), k.h.userDoc(oldLiker));
      await k.fs.setDoc(k.fs.doc(db, 'users', talker), k.h.userDoc(talker));
      await k.fs.setDoc(k.fs.doc(db, 'discovery', fast), k.h.discoveryDoc(fast));
      await k.fs.setDoc(k.fs.doc(db, 'discovery', talker), k.h.discoveryDoc(talker));
      await k.fs.setDoc(k.fs.doc(db, 'discovery', oldLiker), k.h.discoveryDoc(oldLiker, { lastActiveAt: seenAt }));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', oldLiker + '_' + fast),
        Object.assign(k.h.swipeDoc(oldLiker, fast, 'like'), { createdAt: oldLike }));
      await k.fs.setDoc(k.fs.doc(db, 'matches', k.h.pairId(oldLiker, talker)), k.h.matchDoc(oldLiker, talker, {
        createdAt: new Date(Date.now() - 30 * 86400000).toISOString(), lastMessage: 'see you', lastMessageAt: quietAt
      }));
    });
    const lateTally = { reads: 0, calls: 0, writes: 0, wrote: [] };
    let answeredLate = null;
    let theirList = null;
    try {
      k.ctx.ZC.firebase.db = k.h.countingDb(k.rulesEnv.authenticatedContext(fast).firestore(), lateTally);
      globalThis.Date = FastDate;
      answeredLate = await k.store.recordSwipe(fast, oldLiker, 'like').catch(answer);
      globalThis.Date = RealDate;
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(oldLiker).firestore();
      theirList = (await k.store.getMatches(oldLiker)).map(function (view) {
        return { other: view.otherUid, createdAt: view.createdAt, lastMessageAt: view.lastMessageAt };
      });
    } finally {
      globalThis.Date = RealDate;
      k.ctx.ZC.firebase.db = openDb;
    }
    const lateWarnings = k.ctx.drainWarnings();
    let lateMatch = null;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      lateMatch = (await k.fs.getDoc(k.fs.doc(c.firestore(), 'matches', k.h.pairId(fast, oldLiker)))).data() || null;
    });
    t.check('a like twenty days old is answered with a match dated by the liker\'s last visit, ' +
        'which their list puts above a conversation quiet for three days',
      !!answeredLate && answeredLate.matched === true && answeredLate.created === true &&
        !!lateMatch && lateMatch.createdAt === seenAt &&
        !!theirList && theirList.length === 2 && theirList[0].other === fast && lateWarnings.length === 0,
      k.show({ answered: answeredLate, createdAt: lateMatch && lateMatch.createdAt, likedAt: oldLike, seenAt: seenAt,
        reads: lateTally.reads, list: theirList, warnings: lateWarnings }));
  }
};
