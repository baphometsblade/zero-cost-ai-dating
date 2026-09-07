/* ==========================================================================
   Zero Cost AI Dating — store test harness

   Shared plumbing for the store suite: where to find the packages this repo
   deliberately does not depend on, and the open ruleset the suite's own
   project runs under.

   Package resolution is not reinvented here — it is rules-tests/harness's
   moduleRoots/resolveOutside, imported wholesale, so the two emulator suites
   can never disagree about where NODE_PATH points. Only the install hint
   differs, because this suite needs one package more than the rules suite:
   the `firebase` client SDK, whose compat build is the API shape
   public/js/data-store.js is written against.
   ========================================================================== */
'use strict';

const rules = require('../rules-tests/harness');

const ROOT = rules.ROOT;

const INSTALL_HINT =
  'Store tests need the firebase client SDK, @firebase/rules-unit-testing and\n' +
  'firebase-tools, which are deliberately NOT dependencies of this repo. Install them\n' +
  'somewhere else and point NODE_PATH at it, e.g.\n' +
  '  mkdir -p /tmp/zc-emu && cd /tmp/zc-emu \\\n' +
  '    && npm install firebase @firebase/rules-unit-testing firebase-tools\n' +
  '  cd ' + ROOT + ' && NODE_PATH=/tmp/zc-emu/node_modules npm run test:store';

/**
 * The emulator project this suite owns. The rules suite uses a different one,
 * so the two can share a single emulator process without either one's
 * documents or ruleset leaking into the other's.
 */
const PROJECT_ID = 'demo-zc-store';

/**
 * A second project, used only to replay a stored write against the *real*
 * firestore.rules. Kept apart from PROJECT_ID because that project runs open
 * rules and loading two rulesets onto one project id would mean whichever
 * suite ran last decided what the other was testing against.
 */
const RULES_PROJECT_ID = 'demo-zc-store-rules';

/**
 * The ruleset PROJECT_ID runs under. The client SDK cannot mint an auth token
 * without the Auth emulator, so a rules-enforcing project would reject every
 * write this suite makes and prove nothing about atomicity. What the shipped
 * transaction writes *is* checked against the real rules — see
 * specs/04-rules-accept.store.js, which replays the stored value as the
 * document's owner.
 */
const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
  ''
].join('\n');

/**
 * Wrap a compat Firestore so every document a read returns is tallied.
 *
 * Firestore bills a query that matches nothing as one read, so an empty result
 * counts as one here too — the point is to model the bill, not the payload.
 * Snapshot listeners are counted the same way, per delivery, which is what
 * makes "an idle listener costs nothing" a measurable claim rather than a
 * quotation from the documentation.
 *
 * Deliberately not counted: reads made through a transaction's own `tx.get`,
 * which never passes through this object. Nothing measured with it uses one,
 * and a helper that silently under-counted would be worse than no helper, so it
 * is said out loud instead of assumed. That exclusion is also load-bearing now
 * that writes ARE counted through transactions: adding `tx.get` here would move
 * numbers in five specs that have nothing to do with writes.
 *
 * WRITES are counted too, and only the ones Firestore would bill:
 *
 *   - a rejected `set`/`update`/`delete` is not a write, so the tally moves when
 *     the promise resolves rather than when the call is made. A rules denial
 *     costs nothing and must not read as a write;
 *   - a transaction's callback is REPLAYED on contention, so `tx.set` can run
 *     several times for one committed write. Each attempt starts its own count
 *     and only the attempt that committed is added — counting at call time
 *     would report a contended bump as two or three writes, which is precisely
 *     the situation `specs/01-concurrency` exists to create;
 *   - a batch is counted at `commit()`, for both reasons at once.
 *
 * `tally.writes` is created on demand, so a spec that only cares about reads can
 * keep passing `{reads: 0, calls: 0}`. Pass a `wrote` array as well to collect
 * `collection/id:op` strings — "three writes" is satisfied by three writes to
 * the wrong documents, so the identities are worth having.
 *
 * @param {Object} target the real compat Firestore, or one of its refs
 * @param {{reads:number, calls:number, writes?:number, wrote?:string[]}} tally
 *   accumulator, mutated in place
 * @returns {Object} a stand-in that behaves identically and records reads and writes
 */
/** Record one billed write against the tally. */
function noteWrite(tally, path, op) {
  tally.writes = (tally.writes || 0) + 1;
  if (Array.isArray(tally.wrote)) tally.wrote.push(String(path || '?') + ':' + op);
}

/** The write operations a document reference, transaction or batch can perform. */
const WRITE_OPS = { set: 1, update: 1, delete: 1 };

/**
 * A transaction or batch whose buffered writes land in `pending` rather than in
 * the tally, so a replayed attempt can be discarded and only the committed one
 * counted.
 * @param {Object} target the real transaction or WriteBatch
 * @param {{writes:number, wrote:string[]}} pending this attempt's buffer
 * @returns {Object} a stand-in that behaves identically
 */
function bufferingWrites(target, pending) {
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        if (WRITE_OPS[prop]) {
          pending.writes += 1;
          pending.wrote.push(String((arguments[0] && arguments[0].path) || '?') + ':' + prop);
        }
        return value.apply(obj, arguments);
      };
    }
  });
}

function countingDb(target, tally) {
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        if (WRITE_OPS[prop]) {
          // On resolution, not on call: a write the rules refuse is not billed,
          // and this suite provokes those on purpose.
          const path = obj.path;
          const out = value.apply(obj, arguments);
          if (out && typeof out.then === 'function') {
            return out.then(function (result) {
              noteWrite(tally, path, prop);
              return result;
            });
          }
          noteWrite(tally, path, prop);
          return out;
        }

        if (prop === 'runTransaction') {
          const fn = arguments[0];
          // Reset per attempt. Firestore replays the callback when the document
          // moved under it, and the writes of an attempt that never committed
          // were never billed.
          let attempt = null;
          return value.call(obj, function (tx) {
            attempt = { writes: 0, wrote: [] };
            return fn(bufferingWrites(tx, attempt));
          }).then(function (result) {
            if (attempt) {
              tally.writes = (tally.writes || 0) + attempt.writes;
              if (Array.isArray(tally.wrote)) {
                attempt.wrote.forEach(function (entry) { tally.wrote.push('tx:' + entry); });
              }
            }
            return result;
          });
        }

        if (prop === 'batch') {
          const pending = { writes: 0, wrote: [] };
          const real = value.apply(obj, arguments);
          return new Proxy(bufferingWrites(real, pending), {
            get: function (b, p) {
              const v = b[p];
              if (p !== 'commit' || typeof v !== 'function') return v;
              return function () {
                return v.apply(b, arguments).then(function (result) {
                  tally.writes = (tally.writes || 0) + pending.writes;
                  if (Array.isArray(tally.wrote)) {
                    pending.wrote.forEach(function (entry) { tally.wrote.push('batch:' + entry); });
                  }
                  pending.writes = 0;
                  pending.wrote.length = 0;
                  return result;
                });
              };
            }
          });
        }

        if (prop === 'onSnapshot') {
          const args = Array.prototype.slice.call(arguments);
          if (typeof args[0] === 'function') {
            const next = args[0];
            let first = true;
            args[0] = function (snap) {
              tally.calls += 1;
              // Deltas, not the result set. Firestore bills a listener for the
              // documents in its first snapshot and then for each document that
              // changes — so a delivery that carries twelve rows because one of
              // them moved is one read, not twelve. Counting `size` every time
              // measured the payload instead of the bill, and made a listener
              // look exactly as expensive as the poll it replaced.
              //
              // `docChanges()` reports every document as "added" on the first
              // delivery, so it is right for both cases; the minimum-one-read
              // rule applies only to that first one, where an empty result still
              // costs a read.
              //
              // What this CANNOT see, and a spec believed otherwise once: two
              // listeners on the same query report their reads twice here, and
              // Firestore bills them once — the client SDK shares one server
              // target between listeners whose queries are exactly equal. Counting
              // per callback is right for one listener and wrong for two, so a
              // spec comparing shared against unshared subscriptions is measuring
              // this helper rather than the bill.
              const changed = snap && typeof snap.docChanges === 'function'
                ? snap.docChanges().length
                : (snap && typeof snap.size === 'number' ? snap.size : 1);
              tally.reads += first ? Math.max(1, changed) : changed;
              first = false;
              return next.apply(null, arguments);
            };
          }
          return value.apply(obj, args);
        }
        const out = value.apply(obj, arguments);
        if (prop === 'get' && out && typeof out.then === 'function') {
          return out.then(function (snap) {
            tally.calls += 1;
            tally.reads += (snap && typeof snap.size === 'number') ? Math.max(1, snap.size) : 1;
            return snap;
          });
        }
        // Refs and queries are chained off each other, so they have to carry the
        // tally forward. Promises must not be wrapped: a thenable behind a proxy
        // is still awaited, but nothing good comes of proxying one.
        if (out && typeof out === 'object' && typeof out.then !== 'function') return countingDb(out, tally);
        return out;
      };
    }
  });
}

module.exports = {
  ROOT: ROOT,
  RULES_PATH: rules.RULES_PATH,
  INSTALL_HINT: INSTALL_HINT,
  PROJECT_ID: PROJECT_ID,
  RULES_PROJECT_ID: RULES_PROJECT_ID,
  OPEN_RULES: OPEN_RULES,
  emulatorAddress: rules.emulatorAddress,
  resolveOutside: rules.resolveOutside,
  loadOutside: rules.loadOutside,
  readRules: rules.readRules,
  ok: rules.ok,
  // All seven fixtures, not the two that happened to be needed first: a spec
  // reaching for `matchDoc` and finding `undefined` learns nothing about the
  // store, and a suite whose fixtures differ from the rules suite's is how the
  // two ended up disagreeing about `lastActiveAt: null` in the first place.
  userDoc: rules.userDoc,
  discoveryDoc: rules.discoveryDoc,
  swipeDoc: rules.swipeDoc,
  matchDoc: rules.matchDoc,
  messageDoc: rules.messageDoc,
  reportDoc: rules.reportDoc,
  pairId: rules.pairId,
  countingDb: countingDb
};
