/* ==========================================================================
   The messaging path, against a real Firestore, for the first time.

   `sendMessage`, `markRead`, `getMessages` and `getMatch` are four of the
   fifteen facade methods this suite had never called in firebase mode. Their
   *rules* are covered — `rules-tests/specs/05-messages.rules.js` executes them
   against hand-written fixtures — and the demo adapter's versions are covered
   by `tests/data-store.test.js`. What nothing covered is the join between the
   two: whether the documents the Firestore adapter actually produces are the
   documents those rules accept.

   That gap has a history. The projection emitted `lastActiveAt: null`, the
   rules accepted that key only as a string, and account creation broke in
   firebase mode while every demo test stayed green — because the rules were
   tested with fixtures somebody wrote by hand, and the adapter was tested
   somewhere the rules were not. This spec closes the same gap for messaging:
   drive the shipped adapter, then replay what it stored against the real
   `firestore.rules`.

   It also pins something about the harness. `sendMessage` chooses between
   `FieldValue.increment` and a read-modify-write fallback on
   `typeof firebase === 'undefined'`, and `context.js` did not make `firebase`
   global — so the shipped file, loaded whole, silently took a branch no browser
   takes. The first check below is there so that cannot come back quietly.
   ========================================================================== */
'use strict';

/** Long enough for two ISO timestamps to differ, so ordering is well defined. */
const TICK_MS = 12;

/** @returns {Promise<void>} */
function tick() {
  return new Promise(function (resolve) { setTimeout(resolve, TICK_MS); });
}

/** Wait until `test()` is true, or give up. Deliveries cross a network. */
function until(test, ms) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const timer = setInterval(function () {
      let ok = false;
      try { ok = !!test(); } catch (err) { ok = false; }
      if (ok || Date.now() - started > ms) {
        clearInterval(timer);
        resolve(ok);
      }
    }, 20);
  });
}

/** The message carrying `text` in one listener delivery, or null. */
function carrying(list, text) {
  return (list || []).filter(function (m) { return m.text === text; })[0] || null;
}

module.exports = {
  title: 'The messaging path stores what firestore.rules accepts',

  async run(t, k) {
    const A = 'msg-a';
    const B = 'msg-b';
    const matchId = k.h.pairId(A, B);
    const doc = k.fs.doc;
    const setDoc = k.fs.setDoc;

    /* ---- the harness gives the shipped file a browser's globals ---------- */

    // Not a formality. Without `globalThis.firebase` the guard inside
    // `fieldValue()` fails open, `sendMessage` falls back to read-modify-write,
    // and every check below would be evidence about a branch the app never runs.
    const FV = globalThis.firebase && globalThis.firebase.firestore &&
      globalThis.firebase.firestore.FieldValue;
    t.check('the shipped fieldValue() can find FieldValue, as it does in a page',
      !!(FV && typeof FV.increment === 'function'),
      FV ? 'increment is a function' : 'MISSING — sendMessage would take its fallback');

    /* ---- a match to talk in ---------------------------------------------- */

    await k.admin.set('users', A, k.h.userDoc(A));
    await k.admin.set('users', B, k.h.userDoc(B));
    await k.admin.set('discovery', B, k.h.discoveryDoc(B));
    await k.admin.set('matches', matchId, k.h.matchDoc(A, B));

    /* ---- sending -------------------------------------------------------- */

    const first = await k.store.sendMessage(matchId, A, '  Hello there.  ');
    await tick();
    const second = await k.store.sendMessage(matchId, A, 'And again.');
    k.ctx.drainWarnings();

    const stored = await k.admin.list('matches/' + matchId + '/messages');
    t.check('both messages are stored under the match', stored.length === 2, stored.length + ' of 2');

    const firstStored = stored.filter(function (row) { return row.id === first.id; })[0];
    t.check('the stored message carries the id of its own document, which the rules require',
      !!firstStored && firstStored.data.id === firstStored.id,
      firstStored ? firstStored.data.id + ' vs ' + firstStored.id : 'not found');

    t.check('and the text it stored is the trimmed text, not what was typed',
      !!firstStored && firstStored.data.text === 'Hello there.',
      firstStored ? k.show(firstStored.data.text) : 'not found');

    /* ---- the conversation preview and the unread counters ---------------- */

    const afterTwo = await k.admin.get('matches', matchId);
    t.check('the match preview shows the last message sent',
      afterTwo.lastMessage === 'And again.' && afterTwo.lastMessageAt === second.createdAt,
      k.show({ lastMessage: afterTwo.lastMessage, at: afterTwo.lastMessageAt }));

    // Two sends, and the counter reads 2. This says the counter accumulates
    // rather than being set — but note what it does NOT say: it passes just as
    // well against the read-modify-write fallback, because these two sends are
    // sequential and awaited, so nothing races. That was measured, not assumed;
    // with `globalThis.firebase` removed, every check in this spec except the
    // first still passed. Which is precisely why the branch flip was invisible.
    t.check('the other side is owed two messages, and the sender none',
      (afterTwo.unread || {})[B] === 2 && (afterTwo.unread || {})[A] === 0,
      k.show(afterTwo.unread));

    await tick();
    await k.store.sendMessage(matchId, B, 'Replying.');
    k.ctx.drainWarnings();
    const bothWaiting = await k.admin.get('matches', matchId);
    t.check('and a reply the other way counts against the first sender',
      (bothWaiting.unread || {})[A] === 1 && (bothWaiting.unread || {})[B] === 2,
      k.show(bothWaiting.unread));

    /* ---- reading back ---------------------------------------------------- */

    const conversation = await k.store.getMessages(matchId);
    t.check('getMessages hands back the whole conversation oldest-first',
      conversation.length === 3 && conversation[0].id === first.id &&
      conversation[2].text === 'Replying.',
      k.show(conversation.map(function (m) { return m.text; })));

    /* ---- marking read ---------------------------------------------------- */

    // A clears A's own counter. B's must not move: a shared `unread` map is
    // exactly the shape where "clear the counter" quietly clears both.
    t.check('markRead reports success', await k.store.markRead(matchId, A) === true, 'true');
    const afterRead = await k.admin.get('matches', matchId);
    t.check('and clears only the reader\'s counter, leaving the other side owed',
      (afterRead.unread || {})[A] === 0 && (afterRead.unread || {})[B] === 2,
      k.show(afterRead.unread));

    /* ---- the view the chat page renders ---------------------------------- */

    // The chat page's shape, which is not the badge listener's: `getMatch` and
    // `getMatches` return `{matchId, otherUid, other, …}` through `toMatchView`,
    // while `listenMatches` returns `{id, users, …}` through `matchRow`. Two
    // shapes for one noun is a trap worth pinning rather than discovering, and
    // the two adapters do at least agree — both listeners go through `matchRow`.
    const view = await k.store.getMatch(matchId, A);
    t.check('getMatch returns the conversation from the caller\'s side',
      !!view && view.matchId === matchId && view.otherUid === B &&
      view.other && view.other.uid === B,
      view ? k.show({ matchId: view.matchId, otherUid: view.otherUid }) : 'null');

    t.check('and the unread count it carries is the caller\'s, not the other side\'s',
      !!view && view.unread === 0,
      view ? 'unread ' + view.unread + ' for ' + A + ', who has just read' : 'null');

    /* ---- and now the join: does firestore.rules accept all of that? ------ */

    // Everything below dereferences the stored message. If the checks above have
    // already said it is not there, stop: a spec that crashes reports
    // "spec ran to completion" and names nothing, burying the checks that did
    // name the problem. This project has been misled by that shape before.
    if (!firstStored) return;

    // Every check above ran against this suite's open-rules project, because the
    // client SDK cannot mint an auth token without the Auth emulator. So the
    // documents the adapter produced are replayed here against the real ruleset
    // on a separate project, as the account that wrote them.
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'matches', matchId), k.h.matchDoc(A, B));
    });
    const author = k.rulesEnv.authenticatedContext(A).firestore();

    t.check('the message the adapter produced is one the rules accept',
      await k.ok(k.testing.assertSucceeds(
        setDoc(doc(author, 'matches', matchId, 'messages', firstStored.id), firstStored.data))),
      k.show(Object.keys(firstStored.data).sort()));

    t.check('and the match document it left behind is too',
      await k.ok(k.testing.assertSucceeds(
        setDoc(doc(author, 'matches', matchId), afterRead))),
      k.show(Object.keys(afterRead).sort()));

    // The counterweights, so neither check above can pass against rules that
    // accept anything at all in this collection.
    // Its own fresh document id, and that is the whole point. Written to
    // `firstStored.id` — which the check above has just created on this project — a
    // `set` is evaluated as an update, and `allow update: if false` on the messages
    // subcollection refuses it. Measured: with the authorship clause deleted from
    // firestore.rules this check still passed, green for the immutability rule's
    // reason rather than its own. `01-users` and `06-reports` both carry this
    // warning; this spec walked into it anyway, and an audit found it, not the suite.
    const forgedId = firstStored.id + '-forged';
    const forged = Object.assign({}, firstStored.data, { id: forgedId, from: B });
    t.check('while a message claiming to be from the other person is refused',
      await k.ok(k.testing.assertFails(
        setDoc(doc(author, 'matches', matchId, 'messages', forgedId), forged))),
      'from: ' + forged.from + ', into a document that does not exist yet');

    const padded = Object.assign({}, afterRead, { lastMessage: 'x'.repeat(1001) });
    t.check('and a preview longer than a message may be is refused',
      await k.ok(k.testing.assertFails(setDoc(doc(author, 'matches', matchId), padded))),
      'lastMessage: ' + padded.lastMessage.length + ' chars');

    /* ---- last, because it adds messages: the branch made observable -------- */

    // Three sends at once, all three counted. A real property worth pinning: an
    // unread badge that drops messages under load is a badge nobody can trust.
    //
    // What it is NOT is a way to tell the two branches apart, and the first
    // draft of this comment claimed it was. Run against the read-modify-write
    // fallback it still reports 5 — because all three calls share one Firestore
    // client, and that client's local cache already reflects its own pending
    // writes, so the reads serialise instead of racing. The race the fallback
    // would actually lose is between two *devices*, which needs two clients and
    // is out of this suite's reach (see the caveats in the README).
    //
    // So the check above it, on `globalThis.firebase`, is the only thing that
    // pins which branch runs. That is a thin thread, and it is deliberate that
    // it is a named check rather than a comment in context.js.
    //
    // Kept to the end because it leaves three extra messages behind, which is
    // exactly what it did to the ordering check when it sat higher up.
    const beforeRace = (await k.admin.get('matches', matchId)).unread[B];
    await Promise.all([
      k.store.sendMessage(matchId, A, 'racing one'),
      k.store.sendMessage(matchId, A, 'racing two'),
      k.store.sendMessage(matchId, A, 'racing three')
    ]);
    k.ctx.drainWarnings();
    const raced = await k.admin.get('matches', matchId);
    t.check('three messages sent at once are three the other side is owed',
      (raced.unread || {})[B] === beforeRace + 3,
      (raced.unread || {})[B] + ' after ' + beforeRace + ' + 3 concurrent sends');

    /* ---- a message the server has not taken yet --------------------------- */

    // With no connection, `set()` neither resolves nor rejects: the SDK keeps
    // the write in memory until the server acknowledges it, and with offline
    // persistence off, leaving the page throws it away. The live thread shows
    // it at once all the same — the SDK delivers its own writes before the
    // server has them — and that delivery used to be indistinguishable from a
    // stored message, so the chat drew a message that was about to be lost as
    // sent. The demo adapter delivers only what it has already stored.
    //
    // A conversation of its own, so nothing above is counted twice.
    // `disableNetwork()` is the SDK's own offline switch, and for a plain
    // `set()` it holds the write for real: the check below reads the server
    // while it is off and finds nothing. (It does not for a transaction — see
    // `03-writes`.)
    const C = 'msg-c';
    const quiet = k.h.pairId(A, C);
    await k.admin.set('users', C, k.h.userDoc(C));
    await k.admin.set('matches', quiet, k.h.matchDoc(A, C));
    const deliveries = [];
    const stop = k.store.listenMessages(quiet, function (list) { deliveries.push(list); });
    const TEXT = 'Running late, see you at eight?';
    let settled = 'pending';
    let heldAt = -1;
    let settledWhileHeld = null;
    let storedWhileHeld = null;
    try {
      await until(function () { return deliveries.length > 0; }, 5000);
      await k.ctx.db.disableNetwork();
      try {
        k.store.sendMessage(quiet, A, TEXT).then(function () { settled = 'resolved'; },
          function (err) { settled = 'rejected: ' + ((err && (err.code || err.message)) || err); });
        await until(function () { return !!carrying(deliveries[deliveries.length - 1], TEXT); }, 5000);
        heldAt = deliveries.length - 1;
        settledWhileHeld = settled;
        storedWhileHeld = (await k.admin.list('matches/' + quiet + '/messages')).length;
      } finally {
        await k.ctx.db.enableNetwork();
      }
      await until(function () { return settled !== 'pending'; }, 10000);
      await until(function () {
        const now = carrying(deliveries[deliveries.length - 1], TEXT);
        return !!now && !now.pending;
      }, 10000);
    } finally {
      stop();
    }
    k.ctx.drainWarnings();
    const held = heldAt === -1 ? null : carrying(deliveries[heldAt], TEXT);
    t.check('a message the server has not acknowledged is delivered marked pending, while the send waits',
      !!held && held.pending === true && settledWhileHeld === 'pending' && storedWhileHeld === 0,
      held ? k.show({ pending: held.pending, send: settledWhileHeld, onServer: storedWhileHeld })
        : 'never delivered while offline');

    // Without a later delivery the mark would outlive the acknowledgement:
    // the server taking the write changes no data, only the snapshot's
    // metadata, and a listener hears about that only when it asks to.
    const later = heldAt === -1 ? [] : deliveries.slice(heldAt + 1).map(function (list) { return carrying(list, TEXT); })
      .filter(function (m) { return !!m && !m.pending; });
    const landed = (await k.admin.list('matches/' + quiet + '/messages')).filter(function (row) {
      return row.data.text === TEXT;
    });
    const acked = later[later.length - 1] || null;
    t.check('and once the server has it, it is delivered again unmarked, in the shape the demo adapter stores',
      settled === 'resolved' && landed.length === 1 && !!acked &&
        k.same(Object.keys(acked).sort(), ['createdAt', 'from', 'id', 'text']),
      k.show({ send: settled, stored: landed.length, after: acked && Object.keys(acked).sort() }));

    /* ---- a connection that drops and comes back, and nothing else -------- */

    // Asking the SDK for the acknowledgement above means asking for every
    // snapshot whose metadata changes, and the connection changing is one:
    // each query's `fromCache` flips when it goes and again when it comes
    // back, with no document changed. Passed on, that was the same list
    // delivered again, and matches.js repainted an empty conversation's
    // openers each time, taking a keyboard user's focus with them. The demo
    // adapter's `deliver()` drops a list it has already delivered.
    //
    // The witness is the adapter's own query (newest first, the live window
    // of 200), so the two share one watch target and hear each flip together.
    // The SDK calls each listener back on its own `setTimeout(0)`, queued in
    // the order the listeners were added, so by the time the witness, added
    // second, has heard a flip, the adapter has already had its chance to
    // pass it on.
    const D = 'msg-d';
    const still = k.h.pairId(A, D);
    await k.admin.set('users', D, k.h.userDoc(D));
    await k.admin.set('matches', still, k.h.matchDoc(A, D));
    const heard = [];
    const flips = [];
    const unhear = k.store.listenMessages(still, function (list) { heard.push(list.length); });
    let unwitness = function () {};
    const flipped = { away: false, back: false };
    try {
      await until(function () { return heard.length > 0; }, 5000);
      unwitness = k.ctx.db.collection('matches').doc(still).collection('messages')
        .orderBy('createdAt', 'desc').limit(200)
        .onSnapshot({ includeMetadataChanges: true }, function (snap) { flips.push(snap.metadata.fromCache); });
      await until(function () { return flips[flips.length - 1] === false; }, 5000);
      await k.ctx.db.disableNetwork();
      try {
        flipped.away = await until(function () { return flips[flips.length - 1] === true; }, 5000);
      } finally {
        await k.ctx.db.enableNetwork();
      }
      flipped.back = await until(function () { return flips[flips.length - 1] === false; }, 10000);
    } finally {
      unwitness();
      unhear();
    }
    k.ctx.drainWarnings();
    t.check('a connection that drops and comes back delivers the conversation again only if it changed',
      flipped.away && flipped.back && k.same(heard, [0]),
      k.show({ deliveries: heard, witnessFromCache: flips }));

    /* ---- a held message that lands after a newer one ---------------------- */

    // A message sent with no connection waits in the page and is committed when
    // the connection comes back, and the other person may have written in the
    // meantime. The preview update that follows it was unconditional, so it put
    // the older message back as the latest in both people's lists and moved
    // `lastMessageAt`, which the list sorts by, back in time, while the thread,
    // ordered by `createdAt`, ended with the newer one. The other side's message
    // and preview are written the way their device leaves them, through the
    // admin access, because this suite's one client is the device holding the
    // write.
    const F = 'msg-f';
    const late = k.h.pairId(A, F);
    await k.admin.set('users', F, k.h.userDoc(F));
    await k.admin.set('matches', late, k.h.matchDoc(A, F));
    const HELD = 'Written on the train, offline';
    const NEWER = 'Newest message, from the other side';
    let lateSent = 'pending';
    let newerAt = null;
    await k.ctx.db.disableNetwork();
    try {
      k.store.sendMessage(late, A, HELD).then(function (message) { lateSent = message; },
        function (err) { lateSent = 'rejected: ' + ((err && (err.code || err.message)) || err); });
      await tick();
      newerAt = new Date().toISOString();
      const owed = {};
      owed[A] = 1;
      owed[F] = 0;
      await k.admin.set('matches/' + late + '/messages', 'from-f', { id: 'from-f', from: F, text: NEWER, createdAt: newerAt });
      await k.admin.set('matches', late, k.h.matchDoc(A, F, { lastMessage: NEWER, lastMessageAt: newerAt, unread: owed }));
    } finally {
      await k.ctx.db.enableNetwork();
    }
    await until(function () { return lateSent !== 'pending'; }, 10000);
    k.ctx.drainWarnings();
    const lateMatch = (await k.admin.get('matches', late)) || {};
    const lateThread = (await k.store.getMessages(late)).map(function (m) { return m.text; });
    t.check('a held message that lands after a newer reply leaves the newer one as the preview, and is still owed',
      typeof lateSent === 'object' && lateSent.createdAt < newerAt && k.same(lateThread, [HELD, NEWER]) &&
        lateMatch.lastMessage === NEWER && lateMatch.lastMessageAt === newerAt &&
        (lateMatch.unread || {})[F] === 1 && (lateMatch.unread || {})[A] === 1,
      k.show({ sent: typeof lateSent === 'object' ? lateSent.createdAt : lateSent, newerAt: newerAt, thread: lateThread,
        preview: { lastMessage: lateMatch.lastMessage, at: lateMatch.lastMessageAt }, unread: lateMatch.unread }));

    /* ---- a count the other side parked, under the real rules -------------- */

    // Each participant may write either count, and firestore.rules bounds the value
    // a count may hold. A bound on the value alone made `increment(1)` a tripwire:
    // the other person parked their own count at the ceiling, and from then on every
    // message sent to them was stored with its preview update refused — no
    // `lastMessage`, no new count, a warning on every send. The shipped send, signed
    // in as its author, against the real ruleset.
    const E = 'msg-e';
    const parkedId = k.h.pairId(A, E);
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'matches', parkedId), k.h.matchDoc(A, E));
    });
    const park = {};
    park['unread.' + E] = 1000000;
    const parkedOk = await k.ok(k.testing.assertSucceeds(
      k.fs.updateDoc(doc(k.rulesEnv.authenticatedContext(E).firestore(), 'matches', parkedId), park)));
    // The rules context's Firestore is the testing library's copy of the SDK, and
    // the store builds its `increment(1)` from the global `firebase`. Under
    // ZC_STORE_SDK that global is the pages' version, and a FieldValue from one
    // copy is "invalid data" to the other, so for this one send the global is
    // the testing library's too. A page has one copy of each and never meets this.
    const openDb = k.ctx.ZC.firebase.db;
    const openFirebase = globalThis.firebase;
    const testingFirebase = (function () {
      const app = require('firebase/compat/app');
      require('firebase/compat/firestore');
      return app.default || app;
    })();
    let sentParked = null;
    k.ctx.drainWarnings();
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(A).firestore();
      globalThis.firebase = testingFirebase;
      sentParked = await k.store.sendMessage(parkedId, A, 'Are you there?')
        .catch(function (err) { return { rejected: (err && err.code) || String(err) }; });
    } finally {
      k.ctx.ZC.firebase.db = openDb;
      globalThis.firebase = openFirebase;
    }
    const parkedWarnings = k.ctx.drainWarnings();
    let parkedMatch = null;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      parkedMatch = (await k.fs.getDoc(doc(c.firestore(), 'matches', parkedId))).data() || null;
    });
    t.check('a count the other side parked at the ceiling does not stop a message updating the preview',
      parkedOk && !!sentParked && !sentParked.rejected && !!parkedMatch &&
        parkedMatch.lastMessage === 'Are you there?' && (parkedMatch.unread || {})[E] === 1000001 &&
        parkedWarnings.length === 0,
      k.show({ parked: parkedOk, sent: sentParked && (sentParked.rejected || 'stored'),
        lastMessage: parkedMatch && parkedMatch.lastMessage, unread: parkedMatch && parkedMatch.unread,
        warnings: parkedWarnings.map(function (w) { return w.slice(0, 90); }) }));

    /* ---- a message dated more than a day back, under the real rules ------- */

    // firestore.rules refuses a message dated more than a day before the server's
    // clock. An honest device writes one in two ways the rules cannot tell apart:
    // its clock runs that slow, or the message waited that long in an open page for
    // a connection. Either way the send has to reject rather than resolve, because
    // matches.js gives the words back from its catch, and resolving clears the box.
    // The slow clock stands in for the wait: the server sees the same stamp. The
    // global `firebase` is the testing library's for the send, for the reason the
    // parked count above gives, so that a send the rules took would move the
    // preview as it does in a page.
    const G = 'msg-g';
    const slowId = k.h.pairId(A, G);
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await setDoc(doc(c.firestore(), 'matches', slowId), k.h.matchDoc(A, G));
    });
    const RealDate = Date;
    class SlowDate extends RealDate {
      constructor(...args) {
        if (args.length) super(...args);
        else super(RealDate.now() - 25 * 3600000);
      }
      static now() { return RealDate.now() - 25 * 3600000; }
    }
    let sentSlow = null;
    k.ctx.drainWarnings();
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(A).firestore();
      globalThis.firebase = testingFirebase;
      globalThis.Date = SlowDate;
      sentSlow = await k.store.sendMessage(slowId, A, 'From a clock a day slow')
        .then(function () { return 'resolved'; }, function (err) { return (err && err.code) || String(err); });
    } finally {
      globalThis.Date = RealDate;
      globalThis.firebase = openFirebase;
      k.ctx.ZC.firebase.db = openDb;
    }
    k.ctx.drainWarnings();
    let slowMatch = null;
    let slowStored = null;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      slowMatch = (await k.fs.getDoc(doc(c.firestore(), 'matches', slowId))).data() || null;
      slowStored = (await k.fs.getDocs(k.fs.collection(c.firestore(), 'matches', slowId, 'messages'))).size;
    });
    t.check('a message from a device clock a day and an hour slow is refused, and the send rejects with nothing stored',
      sentSlow === 'permission-denied' && slowStored === 0 && !!slowMatch && slowMatch.lastMessage === null,
      k.show({ send: sentSlow, stored: slowStored, lastMessage: slowMatch && slowMatch.lastMessage }));
  }
};
