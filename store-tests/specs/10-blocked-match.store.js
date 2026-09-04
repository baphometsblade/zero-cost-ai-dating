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
 * @returns {Object} a stand-in for ZC.firebase.db
 */
function refusingMatchWrites(real, tally) {
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
                    const err = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
                    err.code = 'permission-denied';
                    return Promise.reject(err);
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
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, tally);

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

    // Swallowing the rejection silently would hide a real fault behind a
    // feature. One warning, carrying the rejection.
    t.check('the refusal is warned about exactly once, with the reason attached',
      warnings.length === 1 && warnings[0].indexOf(matchId) !== -1,
      k.show(warnings));
  }
};
