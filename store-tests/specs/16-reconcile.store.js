/* ==========================================================================
   Finishing a match check that was started and never answered.

   `recordSwipe` writes the swipe and THEN looks for a reciprocal like. When the
   swipe lands and the match step does not, nothing anywhere retried: my swipe
   exists, so `listCandidates` filters that person out of my deck for good; their
   like is answered, so I leave their who-liked-you list. Neither client calls
   `recordSwipe` for the pair again. The two are matched and neither of them will
   ever be told.

   A sweep cannot find them, and that is the whole reason this is a note rather
   than a scan. `unmatch` deletes the match document and leaves BOTH swipes — so
   "mutual like with no match document" is byte-for-byte what a deliberately
   ended conversation looks like, and a sweep would reopen every one of them on
   every page load. That claim is executed here rather than asserted, because it
   is the load-bearing one.

   The failing client leaves a note instead, and the next page load finishes what
   this device knows it began. What this spec measures is the firebase half —
   `finishMatchCheck` against a real Firestore, its read cost, and its behaviour
   when the repair itself is refused.

   Costs are counted with `harness.countingDb`, the same stand-in the read-cost
   and live-cost specs use.
   ========================================================================== */
'use strict';

/**
 * The same compat Firestore with one difference: creating a match document is
 * refused, the way the rules refuse it for a caller the other person blocked.
 * Lifted verbatim from `specs/10-blocked-match.store.js`, which explains why the
 * denial has to be injected: this suite's own project runs open rules and cannot
 * produce a real one.
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
function unavailable() {
  const err = new Error('Failed to get document because the client is offline.');
  err.code = 'unavailable';
  return err;
}

/** An outage whose error cannot be written to, so it can only be wrapped. */
function frozenOutage() {
  const err = new Error('Backend unavailable.');
  err.code = 'unavailable';
  return Object.freeze(err);
}

module.exports = {
  title: 'A match check that was never answered is finished on the next page load',

  async run(t, k) {
    const me = 'rec-me';
    const KEY = k.ctx.ZC.store.KEYS.pendingMatch;

    /** Put a note in the log the way a device that failed mid-check would. */
    function note(fromUid, toUid) {
      const map = JSON.parse(globalThis.localStorage.getItem(KEY) || '{}');
      if (!map[fromUid]) map[fromUid] = {};
      map[fromUid][toUid] = { at: new Date().toISOString(), last: null };
      globalThis.localStorage.setItem(KEY, JSON.stringify(map));
    }

    function notesFor(uid) {
      const map = JSON.parse(globalThis.localStorage.getItem(KEY) || '{}');
      return Object.keys(map[uid] || {});
    }

    globalThis.localStorage.removeItem(KEY);
    await k.admin.set('users', me, k.h.userDoc(me));

    /* ---- 0. a page load with nothing owed does nothing at all ----------- */

    const real = k.ctx.ZC.firebase.db;
    const idle = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, idle);
    const nothing = await k.store.reconcileMatches(me);
    k.ctx.ZC.firebase.db = real;

    t.check('a page load with nothing owed costs nothing at all',
      idle.reads === 0 && idle.calls === 0 && nothing.checked === 0,
      idle.reads + ' read(s) in ' + idle.calls + ' call(s) — this runs on every page, ' +
      'so anything but zero is a tax on everyone who never lost a check');

    /* ---- 1. the repair itself ------------------------------------------- */

    // The state being repaired: both swipes on disk, no match document. Written
    // through the admin path rather than through the store, because the whole
    // point is that the client's own attempt did not finish.
    const lost = 'rec-lost';
    await k.admin.set('discovery', lost, k.h.discoveryDoc(lost));
    await k.admin.set('swipes', lost + '_' + me, k.h.swipeDoc(lost, me, 'like'));
    await k.admin.set('swipes', me + '_' + lost, k.h.swipeDoc(me, lost, 'like'));
    note(me, lost);

    const repair = { reads: 0, calls: 0, writes: 0, wrote: [] };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, repair);
    const fixed = await k.store.reconcileMatches(me);
    k.ctx.ZC.firebase.db = real;
    const created = await k.admin.get('matches', [me, lost].sort().join('_'));

    t.check('an unfinished check is finished, and the conversation exists',
      fixed.repaired === 1 && !!created && k.same((created.users || []).slice().sort(), [me, lost].sort()),
      k.show(fixed) + ', match ' + (created ? 'created' : 'MISSING'));

    // The write is counted, not just named. This check has said "three reads and
    // one write" since it was written and asserted only the reads — the counter
    // could not see a write at all until `harness.countingDb` learned to tally
    // both halves. A check whose title promises more than its condition measures
    // is the shape this suite exists to remove.
    t.check('and it costs three reads and one write, not a scan',
      repair.reads === 3 && repair.writes === 1 &&
        k.same(repair.wrote.map(function (e) { return e.split('/')[0]; }), ['matches']),
      repair.reads + ' read(s): my swipe, their swipe, and the match that was not there; ' +
      repair.writes + ' write(s): ' + k.show(repair.wrote) + '. Walking a swipe history ' +
      'would grow with how long the account has been used');

    t.check('the note is spent, so the next load does nothing',
      notesFor(me).length === 0, k.show(notesFor(me)));

    const second = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, second);
    await k.store.reconcileMatches(me);
    k.ctx.ZC.firebase.db = real;
    t.check('and the load after a repair is free again',
      second.reads === 0, second.reads + ' read(s)');

    /* ---- 2. the case a sweep could never get right ---------------------- */

    // `unmatch` leaves both swipes behind, so an ended conversation is
    // indistinguishable from an unfinished check by inspection alone. Executed,
    // because this is the claim the whole design rests on.
    const ended = 'rec-ended';
    await k.admin.set('discovery', ended, k.h.discoveryDoc(ended));
    await k.admin.set('swipes', ended + '_' + me, k.h.swipeDoc(ended, me, 'like'));
    const endedId = [me, ended].sort().join('_');
    await k.store.recordSwipe(me, ended, 'like');
    const madeIt = await k.admin.get('matches', endedId);
    await k.store.unmatch(endedId, me);
    const afterUnmatch = await k.admin.get('matches', endedId);
    // Put it back, so the note-then-unmatch ordering below has a conversation to
    // end. This is the same pair deliberately: the point is that the DATA cannot
    // tell the two situations apart.
    await k.store.recordSwipe(me, ended, 'like');
    const swipesLeft = [
      await k.admin.get('swipes', me + '_' + ended),
      await k.admin.get('swipes', ended + '_' + me)
    ];

    t.check('ending a conversation deletes the match and leaves both swipes',
      !!madeIt && afterUnmatch === null && swipesLeft.every(function (s) { return !!s; }),
      'match ' + (afterUnmatch === null ? 'gone' : 'still there') + ', ' +
      swipesLeft.filter(Boolean).length + ' of 2 swipes still on disk — which is why a ' +
      'sweep for "mutual like, no match" would reopen it');

    // The note is placed BEFORE the unmatch, which is the reachable order: a
    // device can have an unfinished check for a pair and then end the
    // conversation. What stops the repair reopening it is that `unmatch` spends
    // the note — nothing downstream could tell the difference by looking at the
    // data, as the check above just demonstrated.
    note(me, ended);
    await k.store.unmatch(endedId, me);
    const notesAfterUnmatch = notesFor(me).indexOf(ended) === -1;
    await k.store.reconcileMatches(me);

    t.check('and ending it spends any check still owed for that pair',
      notesAfterUnmatch && (await k.admin.get('matches', endedId)) === null,
      (notesAfterUnmatch ? 'note cleared' : 'NOTE STILL THERE') + ', conversation ' +
      ((await k.admin.get('matches', endedId)) === null ? 'stays ended' : 'WAS REOPENED'));

    /* ---- 3. a note that outlived its swipe ------------------------------ */

    // The rules prove the OTHER person liked me and never look at my side, so a
    // note trusted rather than checked would be a server-permitted resurrection
    // of a swipe that was rewound on another device.
    const rewound = 'rec-rewound';
    await k.admin.set('discovery', rewound, k.h.discoveryDoc(rewound));
    await k.admin.set('swipes', rewound + '_' + me, k.h.swipeDoc(rewound, me, 'like'));
    note(me, rewound);
    const ghosted = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, ghosted);
    const nothingToDo = await k.store.reconcileMatches(me);
    k.ctx.ZC.firebase.db = real;

    t.check('a note whose swipe is not there creates nothing, for one read',
      nothingToDo.repaired === 0 && ghosted.reads === 1 &&
        (await k.admin.get('matches', [me, rewound].sort().join('_'))) === null,
      ghosted.reads + ' read(s), repaired ' + nothingToDo.repaired);

    t.check('and no swipe was written to justify it either',
      (await k.admin.get('swipes', me + '_' + rewound)) === null,
      'swipes/' + me + '_' + rewound);

    /* ---- 4. a refused repair is silent, and terminal -------------------- */

    // A block is enforced by the rules refusing the match write. Retrying it on
    // every page load would make the repetition itself the tell.
    const blocked = 'rec-blocked';
    await k.admin.set('discovery', blocked, k.h.discoveryDoc(blocked));
    await k.admin.set('swipes', blocked + '_' + me, k.h.swipeDoc(blocked, me, 'like'));
    await k.admin.set('swipes', me + '_' + blocked, k.h.swipeDoc(me, blocked, 'like'));
    note(me, blocked);

    const denials = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingMatchWrites(real, denials, denial);
    let threw = null;
    try {
      await k.store.reconcileMatches(me);
    } catch (err) {
      threw = err;
    }
    k.ctx.ZC.firebase.db = real;
    k.ctx.drainWarnings();

    t.check('a repair the rules refuse does not throw at the caller',
      denials.denied > 0 && threw === null,
      denials.denied + ' refusal(s), ' + (threw ? 'threw: ' + threw.message : 'no throw'));

    t.check('and the note is spent, so a blocked pair is not retried forever',
      notesFor(me).indexOf(blocked) === -1,
      'notes left: ' + k.show(notesFor(me)));

    /* ---- 5. an outage keeps the note ------------------------------------ */

    // The opposite of a refusal: nothing was decided, so the note has to survive
    // for the next page load to try again.
    const offline = 'rec-offline';
    await k.admin.set('swipes', me + '_' + offline, k.h.swipeDoc(me, offline, 'like'));
    note(me, offline);
    const dead = {
      collection: function () {
        return {
          doc: function () {
            return {
              get: function () {
                const err = new Error('Failed to get document because the client is offline.');
                err.code = 'unavailable';
                return Promise.reject(err);
              }
            };
          }
        };
      }
    };
    k.ctx.ZC.firebase.db = dead;
    const outage = await k.store.reconcileMatches(me);
    k.ctx.ZC.firebase.db = real;
    k.ctx.drainWarnings();

    t.check('an outage leaves the note where it is, to try again later',
      outage.checked === 0 && notesFor(me).indexOf(offline) !== -1,
      'checked ' + outage.checked + ', notes left: ' + k.show(notesFor(me)));

    /* ---- 6. a pair decided earlier, whose match check fails ------------- */

    // A swipe on a pair that already has a decision writes nothing and runs the
    // match check on the decision on record. When that check succeeds, the
    // answer says the pair was decided already and which decision stands, and
    // the deck neither counts the swipe nor teaches it. When it failed, the
    // rejection said only that the swipe was stored, so the deck counted and
    // taught a swipe that was never recorded. The like here was made where this
    // device kept no note of it (another device, or a write reported lost that
    // landed), and the swipe made now is a pass, which this device used to
    // leave unnoted.
    const decided = 'rec-decided';
    await k.admin.set('swipes', decided + '_' + me, k.h.swipeDoc(decided, me, 'like'));
    await k.admin.set('swipes', me + '_' + decided, k.h.swipeDoc(me, decided, 'like'));
    const frozen = 'rec-frozen';
    await k.admin.set('swipes', frozen + '_' + me, k.h.swipeDoc(frozen, me, 'like'));
    await k.admin.set('swipes', me + '_' + frozen, k.h.swipeDoc(me, frozen, 'like'));

    const failing = { denied: 0 };
    let failed = null;
    let frozenFailed = null;
    try {
      k.ctx.ZC.firebase.db = refusingMatchWrites(real, failing, unavailable);
      await k.store.recordSwipe(me, decided, 'pass').catch(function (err) { failed = err; });
      k.ctx.ZC.firebase.db = refusingMatchWrites(real, failing, frozenOutage);
      await k.store.recordSwipe(me, frozen, 'like').catch(function (err) { frozenFailed = err; });
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    const told = function (err) {
      return err ? { code: err.code, swipeStored: err.swipeStored, existing: err.existing, action: err.action }
        : 'resolved instead of throwing';
    };

    // And the like is what is on record: no pass was written over it.
    const onRecord = await k.admin.get('swipes', me + '_' + decided);
    t.check('a match check that fails on a pair decided earlier says which decision stands',
      failing.denied === 2 && !!failed && failed.code === 'unavailable' && failed.swipeStored === true &&
        failed.existing === true && failed.action === 'like' && !!onRecord && onRecord.action === 'like',
      failing.denied + ' failed match write(s); ' + k.show(told(failed)) + ', on record: ' +
        (onRecord ? onRecord.action : 'nothing'));

    t.check('and says so through an error that cannot be marked, too',
      !!frozenFailed && frozenFailed.code === 'unavailable' && frozenFailed.swipeStored === true &&
        frozenFailed.existing === true && frozenFailed.action === 'like',
      k.show(told(frozenFailed)));

    // The note is what makes "We will try again next time you open the app"
    // true, and the facade notes the action it is handed before the adapter
    // runs, so the pass alone left none.
    const owed = notesFor(me).indexOf(decided) !== -1;
    await k.store.reconcileMatches(me);
    const finished = await k.admin.get('matches', [me, decided].sort().join('_'));
    t.check('and the check is owed to the like on record, so the next page load finishes it',
      owed && !!finished,
      (owed ? 'noted' : 'NO NOTE') + ', match ' + (finished ? 'created' : 'MISSING'));

    globalThis.localStorage.removeItem(KEY);
  }
};
