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
 * Record one billed read against the tally, empty results included — unless
 * the client's cache answered it. A `get` with `{ source: 'cache' }` never
 * reaches Firestore and resolves with `metadata.fromCache` set, so nothing was
 * billed, and this used to count it all the same. Any read whose snapshot says
 * it came from the cache is passed over alike.
 * @param {Object} tally accumulator
 * @param {Object} snap the snapshot that came back
 */
function noteRead(tally, snap) {
  if (snap && snap.metadata && snap.metadata.fromCache === true) return;
  tally.calls += 1;
  tally.reads += (snap && typeof snap.size === 'number') ? Math.max(1, snap.size) : 1;
}

/** Record one billed write against the tally. */
function noteWrite(tally, path, op) {
  tally.writes = (tally.writes || 0) + 1;
  if (Array.isArray(tally.wrote)) tally.wrote.push(String(path || '?') + ':' + op);
}

/**
 * The write operations a document reference, transaction or batch can perform.
 *
 * `add` is here for completeness rather than for current use: the shipped store
 * creates every document through `.doc(id).set(...)`, including messages, so
 * nothing it does reaches `add` — `specs/19-write-cost` calls it directly so
 * the branch is exercised anyway. It is listed because the alternative is a
 * silent under-count the day somebody writes `messages.add(...)`: a counter
 * that quietly reports 1 where the bill is 2. A transaction and a batch have
 * no `add`, so only the reference path can reach it.
 *
 * A Set, and asked with `has`. This was an object literal asked
 * `WRITE_OPS[prop]`, which is a property read, and a property read walks the
 * prototype chain: `toString`, `valueOf`, `hasOwnProperty` and every other
 * name on `Object.prototype` came back truthy, so turning a counted ref into
 * text recorded a write that never touched Firestore. That is the over-count,
 * the mirror image of the failure above, and just as quiet in a spec that
 * checks only `tally.writes`.
 */
const WRITE_OPS = new Set(['set', 'update', 'delete', 'add']);

/**
 * The methods that mark a handle. `get` is a read on a reference or a query
 * and a field lookup on a document snapshot, and both are wanted: a snapshot's
 * `ref` is a reference. `onSnapshot` marks a reference or a query too,
 * `collection` the database or a document reference, and `docChanges` a query
 * snapshot, whose `docs` are document snapshots.
 */
const HANDLE_METHODS = ['get', 'onSnapshot', 'collection', 'docChanges'];

/**
 * Whether a value is one of the compat SDK's own objects with a handle's
 * methods. Every compat class keeps the modular object it wraps in
 * `_delegate`, so an object without one is not the SDK's, whatever methods it
 * has; and an SDK object without a handle's methods — a `FieldValue`, the app
 * the database belongs to — is not a handle.
 * @param {*} value anything
 * @returns {boolean} true for the database, a reference, a query or a snapshot
 */
function isSdkHandle(value) {
  return !!value && typeof value === 'object' && !!value._delegate &&
    typeof value._delegate === 'object' && typeof value.then !== 'function' &&
    HANDLE_METHODS.some(function (name) { return typeof value[name] === 'function'; });
}

/**
 * Whether Firestore handed back something a billed call can be made through,
 * directly or by way of its members.
 *
 * Methods alone are not enough, which a test by methods alone showed while this
 * counter was learning to follow snapshots (`specs/19-write-cost`, section 14,
 * keeps it shown). It took anything with one of `HANDLE_METHODS` for a handle,
 * and anything whose `doc` was one, asking that of `doc` again however deep it
 * went. What a converter's `fromFirestore` returns is the app's own model,
 * `data()` hands it back, and a Map has a `get`: the Map came back as a
 * counting stand-in, its own `set` and `delete` were tallied as billed writes,
 * and a model whose `doc` was itself sent the question round until `data()`
 * threw. So a handle must also be the SDK's own object (see `isSdkHandle`), and
 * a `DocumentChange` — an SDK object with no methods, only the snapshot in its
 * `doc` — is asked about that one field and no deeper. Anything else comes back
 * as it came: a model, and contents, whose maps are plain objects.
 *
 * The test reads a few of the value's members, and a getter can throw, so a
 * throw here means "not a handle" rather than an exception inside the call
 * being measured: the counter may miss a read, but it may not break the app.
 * @param {*} value anything a Firestore object handed back
 * @returns {boolean} true for the database, a reference, a query, a snapshot
 *   or a document change
 */
function isHandle(value) {
  try {
    return isSdkHandle(value) ||
      (!!value && typeof value === 'object' && !!value._delegate && isSdkHandle(value.doc));
  } catch (err) {
    return false;
  }
}

/**
 * Hand back what Firestore handed back, counted if a billed call could be made
 * through it. An array with a handle in it — a query snapshot's `docs`,
 * `docChanges()`, a list of references `snap.get(field)` returns — comes back
 * as a new array of the same entries, each carried; the compat SDK builds each
 * of those afresh on every read anyway, so nothing could have been holding on
 * to the old one. An array without one comes back as it came.
 * @param {*} value what came out of a counted object
 * @param {Object} tally where anything carried goes on counting
 * @returns {*} the value, or a counting stand-in for it
 */
function carry(value, tally) {
  if (Array.isArray(value)) {
    return value.some(isHandle) ? value.map(function (entry) { return carry(entry, tally); }) : value;
  }
  return isHandle(value) ? countingDb(value, tally) : value;
}

/**
 * A method's arguments, with every callback among them handed what the SDK
 * hands it carried — `snap.forEach(function (doc) { ... })` is as much a way
 * out of the counter as `snap.docs`. A listener is not passed through here:
 * `onSnapshot` counts and carries its deliveries itself, and finds the
 * listener where the SDK does (see `listenerAt`).
 * @param {Arguments|Array} args what the method was called with
 * @param {Object} tally where anything carried goes on counting
 * @returns {Array} the arguments to call the real method with
 */
function carryCallbacks(args, tally) {
  return Array.prototype.map.call(args, function (arg) {
    if (typeof arg !== 'function') return arg;
    return function () {
      return arg.apply(this, Array.prototype.map.call(arguments, function (given) {
        return carry(given, tally);
      }));
    };
  });
}

/**
 * Whether an `onSnapshot` argument is an observer object. The same test the
 * compat SDK makes in its own `isPartialObserver`: an object with at least one
 * of `next`, `error` and `complete` as a function.
 * @param {*} value one argument to `onSnapshot`
 * @returns {boolean} true for an observer, false for a function or options
 */
function isObserver(value) {
  return !!value && typeof value === 'object' && ['next', 'error', 'complete'].some(function (name) {
    return typeof value[name] === 'function';
  });
}

/**
 * Where among its arguments `onSnapshot` will find the listener, asked in the
 * order the compat SDK's own `wrapObserver` asks it: an observer first, then
 * an observer second, then a function first, and otherwise whatever is
 * second. That covers the four forms its typings declare — an observer or a
 * function, alone or after an options object — and one they do not, a
 * function followed by an observer, which the SDK accepts and listens to with
 * the observer, never calling the function.
 * @param {Array} args what `onSnapshot` was called with
 * @returns {number} the index of the listener
 */
function listenerAt(args) {
  if (isObserver(args[0])) return 0;
  if (isObserver(args[1])) return 1;
  return typeof args[0] === 'function' ? 0 : 1;
}

/**
 * A transaction or batch whose buffered writes land in `pending` rather than in
 * the tally, so a replayed attempt can be discarded and only the committed one
 * counted — and whose reads, if it has any, go straight to the tally, because a
 * replayed attempt's reads were billed.
 *
 * `set`, `update` and `delete` return the batch or transaction itself, so that
 * writes can be chained — and this used to return what they returned, which is
 * the REAL one. Everything chained after the first write went around the
 * buffer: `tx.set(a, x).set(b, y)` counted one write for two, and a chained
 * `batch.set(a, x).commit()` committed a batch the tally never heard of, so it
 * counted none. The stand-in now hands back itself in its place. For the same
 * reason a batch's `commit` is counted here, on the one proxy, rather than on a
 * second proxy wrapped around this one that a chain would bypass.
 *
 * A write is buffered once the real call has returned. It used to be noted
 * before the call, so a `set` the SDK refused on the spot — it throws on an
 * `undefined` field, say — stayed in the tally though it was never sent, and
 * a caller that caught the throw and committed anyway was billed for it.
 * @param {Object} target the real transaction or WriteBatch
 * @param {{writes:number, wrote:string[]}} pending this attempt's buffer
 * @param {Object} [tally] where a transaction's own reads are counted; a
 *   WriteBatch has no `get`, so it is passed without one
 * @param {Function} [committed] called once a batch's `commit()` resolves, to
 *   move `pending` into the tally; a transaction is committed by
 *   `runTransaction` instead, so it is passed without one
 * @returns {Object} a stand-in that behaves identically
 */
function bufferingWrites(target, pending, tally, committed) {
  const stand = new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        const out = value.apply(obj, arguments);
        // After the call, not before it: a write whose data the SDK refuses
        // throws right here and is never sent, so it must not be buffered.
        if (WRITE_OPS.has(prop)) {
          pending.writes += 1;
          pending.wrote.push(String((arguments[0] && arguments[0].path) || '?') + ':' + prop);
        }
        if (prop === 'get' && tally && out && typeof out.then === 'function') {
          return out.then(function (snap) {
            noteRead(tally, snap);
            return carry(snap, tally);
          });
        }
        if (prop === 'commit' && committed && out && typeof out.then === 'function') {
          return out.then(function (result) {
            committed();
            return result;
          });
        }
        return out === obj ? stand : out;
      };
    }
  });
  return stand;
}

/**
 * Wrap a compat Firestore so every document a read returns is tallied.
 *
 * Firestore bills a query that matches nothing as one read, so an empty result
 * counts as one here too — the point is to model the bill, not the payload.
 * Snapshot listeners are counted the same way, per delivery, which is what
 * makes "an idle listener costs nothing" a measurable claim rather than a
 * quotation from the documentation.
 *
 * A transaction's own `tx.get` IS counted, and this is the second thing this
 * header has said about it. It used to say the reads were deliberately excluded,
 * on two grounds: that "nothing measured with it uses one", and that counting
 * them "would move numbers in five specs that have nothing to do with writes".
 * The first was never true — `bumpUsage` is a transaction, so every roll-over
 * and every counted swipe was paying for a read this tally reported as free.
 * The second was checkable and nobody had checked it: counting them moves no
 * number this suite asserts. (`specs/19-write-cost` does measure paths that take
 * a transaction — it checks their writes, not their reads.) A gap that is
 * documented is better than a silent one, but a documented gap defended by two
 * reasons that do not survive being executed is how an under-count keeps its
 * place for several rounds.
 *
 * The reads are counted where they happen rather than buffered like the writes,
 * because the asymmetry is real: a replayed attempt's writes were never billed,
 * and its reads were.
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
 * WHAT IT HANDS OUT GOES ON COUNTING. A query is returned by `where`; a
 * snapshot is what `get()` resolves to, in a transaction or out of one; its
 * `ref` and `docs` are properties; `forEach` passes documents to a callback,
 * and a listener is handed snapshots; `add()` resolves to a reference. This
 * used to carry the tally along the first of those routes only, so a snapshot
 * and every reference hanging off it were the real ones — and
 * `deleteAccountData` reaches each match it deletes as `matches.docs[i].ref`,
 * so its per-match message scan and the match's own delete were billed and
 * never counted. Each of those routes now hands out a stand-in when what
 * leaves is a handle (see `isHandle`), and only then.
 *
 * One count runs the other way. A `get()` of a query that a live listener on
 * the same page already holds is counted document by document, as a fresh
 * query would be; the SDK can answer it from the listener's existing target,
 * and whether Firestore bills those documents again is not something a
 * wrapper around the SDK can see. Treat such a count as an upper bound, and
 * measure a listener and a read of the same query in separate runs when the
 * difference matters.
 *
 * These ways out are known to be left open, and data-store.js takes none of
 * them; the list is what has been found, not a proof that there is no other.
 *   - A reference stored as a field's value comes back from `data()` as the
 *     real one. `snap.get(field)` carries one it returns alone or in a list,
 *     but not one inside a map it returns. No number here depends on it,
 *     because this app stores no reference: data-store.js takes `.ref` off a
 *     snapshot five times, each time to delete that document or to search
 *     under it, and no write the store makes anywhere in this suite carries
 *     one.
 *   - A converter. Its `fromFirestore` is handed a snapshot the SDK builds
 *     for it, which is the real one, and the model it returns is the app's
 *     own object and comes back from `data()` untouched (see `isHandle`).
 *     The store never calls `withConverter`.
 *   - The database's `app`. It is not a handle, so it is not carried, and
 *     `db.app.firestore()` is the real database. The store never reads it.
 *   - A promise is carried where it resolves only when it is a read or a
 *     write. The one other compat promise that resolves to a handle is
 *     `namedQuery`'s, and the store never calls it.
 *   - Properties whose names begin with an underscore, below.
 * What a `runTransaction` callback returns is passed back untouched, being the
 * app's own value; a snapshot the callback read with `tx.get` is a stand-in
 * already. Properties whose names begin with an underscore are passed
 * through untouched: they are the SDK's own plumbing — `_delegate` is how the
 * compat layer reaches the modular object underneath, and it reads it off
 * whatever it is handed, stand-ins included. That is a precaution, not a
 * repair: nothing the app does goes through them, and this way the stand-ins
 * stay on the app's side of the SDK. (Methods with such names are wrapped
 * like any other — `__lookupGetter__`, inherited from `Object.prototype`, is —
 * and the compat classes define none of their own.) Everything
 * carried comes off the real object — one of its properties, the result of a
 * method run against it, or an argument the SDK passes to a callback — so a
 * stand-in is never wrapped in another and nothing is counted twice.
 *
 * @param {Object} target the real compat Firestore, or one of its refs
 * @param {{reads:number, calls:number, writes?:number, wrote?:string[]}} tally
 *   accumulator, mutated in place
 * @returns {Object} a stand-in that behaves identically and records reads and writes
 */
function countingDb(target, tally) {
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') {
        return typeof prop === 'string' && prop.charAt(0) !== '_' ? carry(value, tally) : value;
      }
      return function () {
        if (WRITE_OPS.has(prop)) {
          // On resolution, not on call: a write the rules refuse is not billed,
          // and this suite provokes those on purpose.
          const path = obj.path;
          const out = value.apply(obj, carryCallbacks(arguments, tally));
          if (out && typeof out.then === 'function') {
            return out.then(function (result) {
              noteWrite(tally, path, prop);
              // `add()` resolves to the reference it created, and a write made
              // through that is as billed as any other.
              return carry(result, tally);
            });
          }
          noteWrite(tally, path, prop);
          return carry(out, tally);
        }

        if (prop === 'runTransaction') {
          const fn = arguments[0];
          // Reset per attempt. Firestore replays the callback when the document
          // moved under it, and the writes of an attempt that never committed
          // were never billed.
          let attempt = null;
          return value.call(obj, function (tx) {
            attempt = { writes: 0, wrote: [] };
            return fn(bufferingWrites(tx, attempt, tally));
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
          return bufferingWrites(value.apply(obj, arguments), pending, null, function () {
            tally.writes = (tally.writes || 0) + pending.writes;
            if (Array.isArray(tally.wrote)) {
              pending.wrote.forEach(function (entry) { tally.wrote.push('batch:' + entry); });
            }
            pending.writes = 0;
            pending.wrote.length = 0;
          });
        }

        if (prop === 'onSnapshot') {
          const args = Array.prototype.slice.call(arguments);
          // This used to look at a function first and nowhere else, so a
          // listener registered any other way was neither counted nor carried —
          // a first delivery of three documents read as no reads.
          const at = listenerAt(args);
          const given = args[at];
          const observer = isObserver(given);
          if (observer || typeof given === 'function') {
            let first = true;
            const counted = function (snap) {
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
              // A REMOVAL IS NOT ALWAYS A READ, and this counted it as one.
              // Firestore's pricing page draws the line inside the word:
              // "You are also charged for a read when a document is removed from
              // the result set because the document has changed. (In contrast,
              // when a document is deleted, you are not charged for a read.)"
              // `docChanges()` reports both as type 'removed' and the client
              // cannot tell them apart — the removed document's snapshot still
              // carries its last known data either way.
              //
              // For two of the three live queries in this app it can be settled
              // from the rules rather than from the snapshot, which is why
              // removals are dropped outright rather than caveated. `swipes`
              // carries `allow update: if false`, so the likes listener's
              // `where to == uid` result can never be edited out of its own
              // query; and a match update must keep `users` exactly as it was,
              // which makes the list listener's `where users array-contains uid`
              // equally immutable. A removal from either is a deletion, and a
              // deletion is free.
              //
              // The third is NOT settled, and this rule only guesses at it.
              // `listenMessages` watches a window — the newest
              // `LIVE_MESSAGE_WINDOW` (200) messages of one conversation — and a
              // document leaves a window without being deleted or changed: past
              // 200, each new message pushes the oldest out, and `docChanges()`
              // reports that as 'removed' too. Messages cannot be edited, so it
              // is never the billed kind of removal the pricing page names; it is
              // not a deletion either, and the page says nothing about it. Run
              // against the emulator, the delivery that carries the 201st message
              // is one 'added' and one 'removed', for a document that still
              // exists, and this counts it as one read. Nothing measures
              // `listenMessages` through this helper (specs/08-conversation runs
              // it against the real database), so no number in this suite rests
              // on the guess; the first spec that measures a conversation past
              // 200 messages inherits it.
              //
              // What this still CANNOT see, and a spec believed otherwise once:
              // two listeners on the same query report their reads twice here, and
              // Firestore bills them once — the client SDK shares one server
              // target between listeners whose queries are exactly equal. Counting
              // per callback is right for one listener and wrong for two, so a
              // spec comparing shared against unshared subscriptions is measuring
              // this helper rather than the bill.
              const changes = snap && typeof snap.docChanges === 'function'
                ? snap.docChanges()
                : null;
              const changed = changes
                ? changes.filter(function (c) { return c && c.type !== 'removed'; }).length
                : (snap && typeof snap.size === 'number' ? snap.size : 1);
              tally.reads += first ? Math.max(1, changed) : changed;
              first = false;
              const delivered = carry(snap, tally);
              if (!observer) return given.call(null, delivered);
              return typeof given.next === 'function' ? given.next(delivered) : undefined;
            };
            if (observer) {
              // A new observer rather than the app's with its `next` swapped. The
              // SDK calls `error` bound to the observer it is given, so the app's
              // is handed on bound to the app's observer; left off, a refused
              // listener would only be logged by the SDK. (`complete` is never
              // called: a listener's observer inside the SDK has no such method.)
              args[at] = { next: counted };
              if (typeof given.error === 'function') args[at].error = given.error.bind(given);
            } else {
              args[at] = counted;
            }
          }
          return value.apply(obj, args);
        }
        const out = value.apply(obj, carryCallbacks(arguments, tally));
        if (prop === 'get' && out && typeof out.then === 'function') {
          return out.then(function (snap) {
            noteRead(tally, snap);
            return carry(snap, tally);
          });
        }
        // Refs and queries are chained off each other, so they have to carry the
        // tally forward. Promises are not wrapped: a thenable behind a proxy is
        // still awaited, but nothing good comes of proxying one — what a read or
        // a write resolves to is carried instead, where it resolves.
        return carry(out, tally);
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
