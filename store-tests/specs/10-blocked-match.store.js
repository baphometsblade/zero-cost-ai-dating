/* ==========================================================================
   A refused match document does not read as a lost swipe.

   `firestore.rules` now refuses to create a match when the other person has
   blocked the caller — which is the only place a block can be enforced, since
   the list lives in a private document this client never sees. The rules suite
   proves the refusal. This proves the other half: what the shipped store does
   when it happens.

   It matters because the failure lands in the middle of `recordSwipe`, after
   the swipe document is already stored. Letting the rejection propagate would
   reach `persistSwipe` in dashboard.js, which treats any throw from
   `recordSwipe` as "the swipe is not stored" — it puts the card back on the
   deck and says "That swipe did not save." Both halves of that would be false,
   and the second tells somebody they have been blocked by showing them an
   error nobody else gets.

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

    t.check('the refusal actually happened, so this spec is testing something',
      tally.denied === 1, tally.denied + ' refused write(s)');

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
    // recorded invites a second, contradictory decision the store will silently
    // drop, because a recorded swipe stands.
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
  }
};
