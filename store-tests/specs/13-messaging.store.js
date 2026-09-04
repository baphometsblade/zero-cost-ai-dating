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
    const forged = Object.assign({}, firstStored.data, { from: B });
    t.check('while a message claiming to be from the other person is refused',
      await k.ok(k.testing.assertFails(
        setDoc(doc(author, 'matches', matchId, 'messages', firstStored.id), forged))),
      'from: ' + forged.from);

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
  }
};
