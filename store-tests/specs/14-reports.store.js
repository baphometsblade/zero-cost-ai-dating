/* ==========================================================================
   The abuse-report path, against a real Firestore, for the first time.

   `reportUser`, `getMyReports` and `retractReport` were three more of the
   fifteen facade methods this suite had never called in firebase mode. As with
   messaging, the *rules* are covered — `rules-tests/specs/06-reports.rules.js`
   executes them against hand-written fixtures — and the demo adapter's versions
   are covered by `tests/data-store.test.js`. The join between them was not.

   That join matters more here than most: the report `id` sat on the rules'
   closed key list with no validator at all until this round, so nothing had
   ever checked that the id the adapter writes is the id the rules demand.
   ========================================================================== */
'use strict';

/**
 * A Firestore whose `reports/*` reads reject with a given error, so the
 * "nothing left to retract" path can be reached without an Auth token.
 * Everything else behaves normally.
 * @param {Object} real the emulator-backed compat Firestore
 * @param {{denied:number}} tally counts injections, so a check cannot pass
 *   because the injection silently stopped working
 * @param {Function} rejection builds the error each refused read rejects with
 * @returns {Object} a stand-in for ZC.firebase.db
 */
function refusingReportReads(real, tally, rejection) {
  function bound(obj, key) {
    const value = obj[key];
    return typeof value === 'function' ? value.bind(obj) : value;
  }
  return new Proxy(real, {
    get: function (obj, prop) {
      if (prop !== 'collection') return bound(obj, prop);
      return function (name) {
        const collection = obj.collection.apply(obj, arguments);
        if (name !== 'reports') return collection;
        return new Proxy(collection, {
          get: function (c, key) {
            if (key !== 'doc') return bound(c, key);
            return function () {
              const ref = c.doc.apply(c, arguments);
              return new Proxy(ref, {
                get: function (r, inner) {
                  if (inner !== 'get') return bound(r, inner);
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

/** A refusal as the modular SDK spells it. */
function denied() {
  const err = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
  err.code = 'permission-denied';
  return err;
}

/** The same refusal as the compat SDK spells it, namespaced. */
function deniedCompat() {
  const err = new Error('PERMISSION_DENIED: Missing or insufficient permissions.');
  err.code = 'firestore/permission-denied';
  return err;
}

module.exports = {
  title: 'The abuse-report path stores what firestore.rules accepts',

  async run(t, k) {
    const R = 'report-from';
    const S = 'report-about';
    const reportId = R + '_' + S;
    const doc = k.fs.doc;
    const setDoc = k.fs.setDoc;

    await k.admin.set('users', R, k.h.userDoc(R));
    await k.admin.set('discovery', S, k.h.discoveryDoc(S));

    /* ---- filing ---------------------------------------------------------- */

    const filed = await k.store.reportUser(R, S, 'harassment', '  Said something vile.  ');
    k.ctx.drainWarnings();

    t.check('reportUser reports success, under the id that bounds the queue',
      filed && filed.ok === true && filed.id === reportId, k.show(filed));

    const stored = await k.admin.get('reports', reportId);
    t.check('and the report is stored where it said it was', !!stored, k.show(stored && Object.keys(stored).sort()));
    if (!stored) return;

    // The rules require `id == reportId`. They did not until this round — `id`
    // was on the closed key list with nothing validating it — so nothing had
    // ever checked that the adapter agrees with the convention it documents.
    t.check('the stored report carries the id of its own document',
      stored.id === reportId, stored.id + ' vs ' + reportId);

    t.check('and the details are trimmed, not stored as typed',
      stored.details === 'Said something vile.', k.show(stored.details));

    /* ---- listing --------------------------------------------------------- */

    const mine = await k.store.getMyReports(R);
    t.check('getMyReports finds the report its author filed',
      mine.length === 1 && mine[0].id === reportId && mine[0].about === S,
      k.show(mine.map(function (r) { return r.id; })));

    /* ---- retracting ------------------------------------------------------ */

    const gone = await k.store.retractReport(R, S);
    t.check('retractReport removes it and says so',
      gone && gone.ok === true && gone.removed === true, k.show(gone));

    t.check('and the document really is gone',
      (await k.admin.get('reports', reportId)) === null, 'reports/' + reportId);

    const again = await k.store.retractReport(R, S);
    t.check('retracting twice is not an error, and does not claim a second removal',
      again && again.ok === true && again.removed === false, k.show(again));

    /* ---- the refusal that means "nothing left to retract" ---------------- */

    // The rules deny an author's read of a *missing* report, so that a reported
    // party cannot probe whether one exists. `retractReport` reads that denial
    // as "nothing to retract" — which is right, and is the only way the settings
    // page can offer the button without leaking the queue.
    //
    // The suite runs on open rules and cannot mint an auth token, so the denial
    // is injected. Both spellings are tried, because the file's own
    // `isPermissionDenied` accepts both and this function did not.
    const real = k.ctx.ZC.firebase.db;
    for (const [label, rejection] of [['permission-denied', denied],
                                      ['firestore/permission-denied', deniedCompat]]) {
      const tally = { denied: 0 };
      k.ctx.ZC.firebase.db = refusingReportReads(real, tally, rejection);
      let outcome;
      try {
        outcome = await k.store.retractReport(R, S);
      } catch (err) {
        outcome = { threw: (err && err.code) || String(err) };
      } finally {
        k.ctx.ZC.firebase.db = real;
      }
      k.ctx.drainWarnings();
      t.check('the injection fired for ' + label, tally.denied === 1, tally.denied + ' refused read(s)');
      t.check('a refused read reads as "nothing to retract" — ' + label,
        outcome && outcome.ok === true && outcome.removed === false, k.show(outcome));
    }

    // The counterweight, and it is the whole reason this is a helper rather than
    // `catch { return removed: false }`. `retractReport`'s own comment says any
    // other failure must propagate, because "already removed" while the report
    // still sits in the queue is a lie told to somebody who reported harassment.
    // Nothing had ever held it to that.
    const tally = { denied: 0 };
    k.ctx.ZC.firebase.db = refusingReportReads(real, tally, function () {
      const err = new Error('Failed to get document because the client is offline.');
      err.code = 'unavailable';
      return err;
    });
    let propagated = null;
    try {
      await k.store.retractReport(R, S);
    } catch (err) {
      propagated = (err && err.code) || String(err);
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    t.check('but an outage propagates instead of claiming the report is gone',
      propagated === 'unavailable', propagated === null ? 'it returned instead of throwing' : propagated);

    /* ---- and the join: does firestore.rules accept what was stored? ------ */

    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'discovery', S), k.h.discoveryDoc(S));
    });
    const author = k.rulesEnv.authenticatedContext(R).firestore();

    t.check('the report the adapter produced is one the rules accept',
      await k.ok(k.testing.assertSucceeds(setDoc(doc(author, 'reports', reportId), stored))),
      k.show(Object.keys(stored).sort()));

    // The counterweight for the id pin added this round: the same report under
    // any other id must be refused, or the queue is not bounded by its id at all.
    t.check('while the same report under a different id is refused',
      await k.ok(k.testing.assertFails(
        setDoc(doc(author, 'reports', R + '_someone-else'), stored))),
      'reports/' + R + '_someone-else');

    /* ---- a harasser cannot leave the queue by unpublishing -------------- */

    // The shipped reportUser and sendMessage, each signed in as its own account,
    // against the real ruleset. The rules used to demand that a report's subject
    // exist in `discovery`, a document its subject may delete at any time and that
    // no conversation depends on — so a match could delete it, go on writing, and
    // every report about them came back refused while matches.js said "The report
    // could not be filed, but you can still block them."
    const H = 'report-harasser';
    const V = 'report-victim';
    const matchId = k.h.pairId(H, V);
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      for (const uid of [H, V]) {
        await setDoc(doc(db, 'users', uid), k.h.userDoc(uid));
        await setDoc(doc(db, 'discovery', uid), k.h.discoveryDoc(uid));
      }
      await setDoc(doc(db, 'swipes', H + '_' + V), k.h.swipeDoc(H, V, 'like'));
      await setDoc(doc(db, 'swipes', V + '_' + H), k.h.swipeDoc(V, H, 'like'));
      await setDoc(doc(db, 'matches', matchId), k.h.matchDoc(H, V));
    });
    const openDb = k.ctx.ZC.firebase.db;
    const answer = function (err) { return { rejected: (err && err.code) || String(err) }; };
    let unpublished = false;
    let filedAbout = null;
    let wroteOn = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(H).firestore();
      unpublished = await k.ok(k.testing.assertSucceeds(
        k.fs.deleteDoc(doc(k.rulesEnv.authenticatedContext(H).firestore(), 'discovery', H))));
      wroteOn = await k.store.sendMessage(matchId, H, 'still here').then(function () { return 'sent'; }, answer);
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(V).firestore();
      filedAbout = await k.store.reportUser(V, H, 'harassment', 'abusive messages').catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
    }
    k.ctx.drainWarnings();

    t.check('the subject can delete their own projection and go on writing',
      unpublished && wroteOn === 'sent', 'deleted: ' + unpublished + ', message: ' + k.show(wroteOn));

    t.check('and the person they are writing to can still report them',
      !!filedAbout && filedAbout.ok === true && filedAbout.duplicate === false, k.show(filedAbout));

    /* ---- the settings page still names a subject who has paused --------- */

    // settings.js resolves the name of every account a person has reported through
    // getPublicProfiles, and shows "a deleted account" for one it cannot read. A
    // subject who turns off "Show me in other people's decks" is readable now only
    // by the accounts that know them. The report menu is in a conversation, so a
    // reporter is a match, and the dialog's next question is whether to unmatch;
    // unmatching deletes the match and leaves the like under it, which is what
    // still names the subject here. The report itself opens nothing: anybody may
    // file one about any published account and withdraw it again. And the face
    // cache — one blob per browser, kept across a sign-out — must not hand the
    // reporter's copy to the next account either.
    const P = 'report-paused';
    const PR = 'report-paused-reporter';
    const STRANGER = 'report-paused-stranger';
    const FILER = 'report-paused-filer';
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      await setDoc(doc(db, 'discovery', P), k.h.discoveryDoc(P, {
        preferences: Object.assign({}, k.h.discoveryDoc(P).preferences, { discoverable: false })
      }));
      // Matched once, and since unmatched: both likes, no match document.
      await setDoc(doc(db, 'swipes', P + '_' + PR), k.h.swipeDoc(P, PR, 'like'));
      await setDoc(doc(db, 'swipes', PR + '_' + P), k.h.swipeDoc(PR, P, 'like'));
      await setDoc(doc(db, 'reports', PR + '_' + P), k.h.reportDoc(PR, P));
    });
    let reporterSees = null;
    let strangerSees = null;
    let filerFiled = null;
    let filerSees = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(PR).firestore();
      reporterSees = await k.store.getPublicProfiles([P]).catch(answer);
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(STRANGER).firestore();
      strangerSees = await k.store.getPublicProfiles([P]).catch(answer);
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(FILER).firestore();
      filerFiled = await k.store.reportUser(FILER, P, 'other', 'to see who this is').catch(answer);
      filerSees = await k.store.getPublicProfiles([P]).catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
    }
    k.ctx.drainWarnings();

    t.check('under the real rules, a reporter who has since unmatched can still name a subject who paused',
      !!reporterSees && !!reporterSees[P] && reporterSees[P].displayName === 'Test ' + P,
      k.show(reporterSees && reporterSees[P] ? reporterSees[P].displayName : reporterSees));

    t.check('while the next account on the same browser cannot, from the server or the face cache',
      !!strangerSees && !strangerSees.rejected && !strangerSees[P],
      k.show(strangerSees && strangerSees[P] ? 'shown: ' + strangerSees[P].displayName : strangerSees));

    t.check('nor can a stranger by filing a report about them, which anybody may',
      !!filerFiled && filerFiled.ok === true && !!filerSees && !filerSees.rejected && !filerSees[P],
      k.show({
        filed: filerFiled,
        sees: filerSees && filerSees[P] ? 'shown: ' + filerSees[P].displayName : filerSees
      }));
  }
};
