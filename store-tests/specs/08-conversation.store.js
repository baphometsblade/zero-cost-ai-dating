/* ==========================================================================
   A conversation keeps working, and outlives everything except an unmatch.

   All four properties here are about the Firebase adapter alone. The demo
   adapter holds every message in one array in one tab, so it has none of the
   first three problems and none could be found by a demo-mode test — which is
   the shape of divergence this repository has been bitten by before. Nor the
   fourth, for a different reason: it looks for the swipe before deleting it,
   and no rules stand between it and localStorage to refuse the delete.

   1. The live stream used to ask for the 500 *oldest* messages
      (`orderBy('createdAt','asc').limit(500)`). Below the window that is
      indistinguishable from correct. At the window it fills with the beginning
      of the conversation and never moves again: every later message is written,
      stored, counted as unread by the other side, and never delivered. The chat
      stops updating, with no error, permanently. `getMessages` twenty lines
      above already took the newest end and reversed it — the two functions
      disagreed about which end of a conversation matters.

   2. A rewind used to delete the match, and the conversation inside it.
      dashboard.js refuses to rewind across a match — "you two already have a
      conversation" — but it decides that from `entry.matched`, stamped when
      the swipe was saved and never revisited. It is true only for the swipe
      that completed the pair. Like somebody who has not liked you back and it
      is false and stays false; when they like you back a minute later the
      match is real, messages can already be in it, and the stale flag still
      says there is nothing there. The refusal now happens in the store, in a
      transaction, against the database — because the reciprocal like arriving
      after the swipe was recorded is precisely the case the caller cannot see.

   3. What may legitimately remove a match is `unmatch`, and it has to take the
      messages first. The message-delete rule proves membership through the
      parent match, so once the parent is gone nothing can authorise deleting
      them: they are not merely orphaned, they are permanently undeletable —
      real message content left in the project with no way to reach or remove
      it. Nothing had ever run `unmatch` against a real Firestore.

   4. Rewinding a swipe that is already gone is a no-op, as it is in demo
      mode. The delete rule dereferenced `resource`, which is null for a
      missing document, so the second of two rewinds was refused — and only the
      real ruleset could show it, so that part runs against the real ruleset.

   And an unmatch has to stay ended (section 6, under the real rules too; the
   demo adapter is held to the same in tests/data-store.test.js). It used to
   leave both likes under the deleted match, so a stale deck tab of either
   person's, a note on another device, or the other person at the console
   wrote the conversation back.

   The window in (1) is deliberately exceeded here rather than assumed. A test
   that seeds ten messages passes against both the broken and the fixed
   listener.
   ========================================================================== */
'use strict';

/**
 * Past BOTH the current window (LIVE_MESSAGE_WINDOW, 200) and the 500 the
 * listener used to ask for.
 *
 * 230 was the first number here, and it was not enough: it exceeds today's
 * window, so the spec passed and the fix looked proven — but restoring the
 * original `orderBy('asc').limit(500)` left it passing too, because 230
 * messages fit inside 500 and the freeze cannot show itself below the limit.
 * A regression test that does not fail on the code as it actually shipped is
 * not a regression test. Seeding past the old limit as well is what makes the
 * mutation red.
 */
const OVER_WINDOW = 520;

module.exports = {
  title: 'A conversation stays live, survives a rewind, and dies with an unmatch',

  async run(t, k) {
    const a = 'convo-a';
    const b = 'convo-b';
    const matchId = [a, b].sort().join('_');

    await k.admin.set('users', a, k.h.userDoc(a));
    await k.admin.set('users', b, k.h.userDoc(b));
    await k.admin.set('matches', matchId, {
      matchId: matchId, users: [a, b].sort(), createdAt: '2026-01-01T00:00:00.000Z'
    });

    /* ---- 1. the live stream follows the newest end -------------------- */

    // Timestamps are lexicographically ordered ISO strings, so message N is
    // strictly newer than message N-1 however the emulator sorts ties.
    const messages = [];
    for (let i = 0; i < OVER_WINDOW; i += 1) {
      const stamp = '2026-01-01T00:00:00.' + String(i).padStart(4, '0') + 'Z';
      messages.push({ id: 'm' + String(i).padStart(4, '0'), data: { from: i % 2 ? b : a, text: 'message ' + i, createdAt: stamp } });
    }
    await k.admin.setMany('matches/' + matchId + '/messages', messages);
    t.check('the conversation is longer than the live window', messages.length > 200, String(messages.length));

    const delivered = await new Promise(function (resolve) {
      let stop = null;
      let timer = null;
      let settled = false;
      const done = function (value) {
        if (settled) return;
        settled = true;
        if (typeof stop === 'function') stop();
        // Cleared on the happy path too: a pending timer keeps the event loop
        // alive, so leaving it would stall every passing run for the full
        // fifteen seconds after the work was already done.
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      stop = k.store.listenMessages(matchId, function (list) { done(list); });
      // A listener that never fires must fail as a timeout with a name, not
      // hang the suite until the runner is killed.
      timer = setTimeout(function () { done(null); }, 15000);
    });
    k.ctx.drainWarnings();

    t.check('the live listener delivered something at all', Array.isArray(delivered),
      delivered === null ? 'timed out after 15s' : typeof delivered);

    if (Array.isArray(delivered)) {
      const last = messages[messages.length - 1].data.text;
      const first = messages[0].data.text;
      const texts = delivered.map(function (m) { return m.text; });

      // The check that fails on the old code: the newest message must be in
      // view. Ordering ascending with a limit put the window at the other end.
      t.check('the newest message is in the live window',
        texts.indexOf(last) !== -1,
        'last delivered: ' + k.show(texts[texts.length - 1]) + ' of ' + texts.length);

      t.check('the oldest message has fallen out of the window, as a window implies',
        texts.indexOf(first) === -1, 'window holds ' + texts.length + ' of ' + messages.length);

      // Reversed back to reading order: the UI appends in array order, so a
      // newest-first array would render the conversation upside down.
      const ascending = delivered.every(function (m, i) {
        return i === 0 || String(delivered[i - 1].createdAt) <= String(m.createdAt);
      });
      t.check('the window is handed over oldest-first, the order a chat log reads in',
        ascending, k.show(texts.slice(0, 2).concat(['…']).concat(texts.slice(-1))));
    }

    /* ---- 2. a rewind cannot take a match down -------------------------- */

    // The swipe that made the match, so undoSwipe has something to undo. The
    // rewind is asked for by `a`, who at swipe time had no match: this is the
    // reciprocal-like-arrived-later case, the one the dashboard's own flag
    // cannot see, and the one that used to delete everything below.
    await k.admin.set('swipes', a + '_' + b, {
      from: a, to: b, action: 'like', createdAt: '2026-01-01T00:00:00.000Z'
    });

    const rewind = await k.store.undoSwipe(a, b);
    k.ctx.drainWarnings();
    t.check('the rewind is refused, and says why',
      !!rewind && rewind.ok === false && rewind.reason === 'matched', k.show(rewind));

    t.check('the swipe it would have deleted is still there',
      (await k.admin.get('swipes', a + '_' + b)) !== null, 'swipes/' + a + '_' + b);

    t.check('the match is still there', (await k.admin.get('matches', matchId)) !== null,
      'matches/' + matchId);

    // The half that matters to the other person: not one word of the
    // conversation may go because somebody pressed rewind on their own swipe.
    const stillThere = await k.admin.list('matches/' + matchId + '/messages');
    t.check('and every message in it survived',
      stillThere.length === messages.length, stillThere.length + ' of ' + messages.length);

    /* ---- 3. unmatching does take the conversation with it -------------- */

    const ended = await k.store.unmatch(matchId, a);
    k.ctx.drainWarnings();
    t.check('the unmatch reports that it removed the match',
      !!ended && ended.removed === true, k.show(ended));

    t.check('the match document is gone', (await k.admin.get('matches', matchId)) === null,
      'matches/' + matchId);

    const leftBehind = await k.admin.list('matches/' + matchId + '/messages');
    // The whole point. These documents would be unreachable by the app once
    // their parent was deleted, and unreachable is not the same as gone: still
    // in the project, still billable, and no rule could now authorise removing
    // them. All 520 have to go, which is more than one batch.
    t.check('no message survived the match it belonged to',
      leftBehind.length === 0,
      leftBehind.length + ' orphaned message(s), e.g. ' + k.show((leftBehind[0] || {}).data));

    /* ---- 4. a second rewind of the same swipe is a no-op --------------- */

    // Against the REAL ruleset, signed in as the swiper, because the open rules the
    // rest of this suite runs on could not see this. undoSwipe deletes without
    // reading the swipe first, and firestore.rules dereferenced `resource` on a
    // swipe delete — null for a document that is already gone — so asking twice
    // (a second tab on the same deck, or a retry) came back permission-denied in
    // Firebase mode, where the demo adapter answers `{ ok: true }` and
    // tests/data-store.test.js pins that as the contract. The shipped function is
    // pointed at that project for these two calls only.
    const from = 'conv-rewinder';
    const to = 'conv-rewound';
    const swipeId = from + '_' + to;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      await k.fs.setDoc(k.fs.doc(c.firestore(), 'swipes', swipeId),
        { id: swipeId, from: from, to: to, action: 'like', createdAt: '2026-01-01T00:00:00.000Z' });
    });
    const openDb = k.ctx.ZC.firebase.db;
    const answer = function (err) { return { rejected: (err && err.code) || String(err) }; };
    let first = null;
    let second = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(from).firestore();
      first = await k.store.undoSwipe(from, to).catch(answer);
      second = await k.store.undoSwipe(from, to).catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
    }
    k.ctx.drainWarnings();
    let gone = false;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      gone = !(await k.fs.getDoc(k.fs.doc(c.firestore(), 'swipes', swipeId))).exists();
    });

    t.check('under the real rules, a rewind removes the swipe',
      !!first && first.ok === true && gone, k.show(first) + (gone ? '' : ', and the swipe is still there'));

    t.check('and asking again once it is gone answers ok, as the demo adapter does, rather than being refused',
      !!second && second.ok === true, k.show(second));

    /* ---- 5. a match who pauses keeps their face in the conversation ---- */

    // settings.html says of "Show me in other people's decks": "Turn this off to
    // disappear from discovery. Your existing matches and conversations stay
    // exactly where they are." firestore.rules now hides a paused projection from
    // everybody who does not already know the person, so this is the read that
    // promise rests on: the list and the open conversation draw the other side
    // from `discovery/{uid}`, and a refusal there is a nameless placeholder.
    const viewer = 'conv-real-viewer';
    const pausedMatch = 'conv-real-paused';
    const pausedPair = [viewer, pausedMatch].sort().join('_');
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      await k.fs.setDoc(k.fs.doc(db, 'discovery', pausedMatch), k.h.discoveryDoc(pausedMatch, {
        preferences: Object.assign({}, k.h.discoveryDoc(pausedMatch).preferences, { discoverable: false })
      }));
      await k.fs.setDoc(k.fs.doc(db, 'matches', pausedPair), k.h.matchDoc(viewer, pausedMatch));
    });
    let listed = null;
    let opened = null;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(viewer).firestore();
      listed = await k.store.getMatches(viewer).catch(answer);
      opened = await k.store.getMatch(pausedPair, viewer).catch(answer);
    } finally {
      k.ctx.ZC.firebase.db = openDb;
    }
    k.ctx.drainWarnings();
    const named = 'Test ' + pausedMatch;

    t.check('under the real rules, the conversation list still names a match who paused',
      Array.isArray(listed) && listed.length === 1 && listed[0].other.displayName === named,
      Array.isArray(listed) ? k.show(listed.map(function (m) { return m.other.displayName; })) : k.show(listed));

    t.check('and so does the open conversation',
      !!opened && !!opened.other && opened.other.displayName === named,
      k.show(opened && opened.other ? opened.other.displayName : opened));

    /* ---- 6. and an unmatch stays ended ---------------------------------- */

    // `unmatch` used to delete the match and leave both likes under it, and a
    // mutual pair with no match document is what three things here write one
    // for: a deck tab of either person's that still shows the card, on any key,
    // because the like on record is the decision that stands; a pending-match
    // note on a device the unmatch did not run on; and the other person writing
    // the document themselves, which the create rule allows on the proof that
    // the caller was liked. Each is tried, signed in, under the real rules,
    // after a real unmatch, and anything one lets through is removed again so
    // the next starts from the ended state.
    const ender = 'conv-ender';
    const leftUid = 'conv-left';
    const endedPair = k.h.pairId(ender, leftUid);
    const KEY = k.ctx.ZC.store.KEYS.pendingMatch;
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = c.firestore();
      await k.fs.setDoc(k.fs.doc(db, 'users', ender), k.h.userDoc(ender));
      await k.fs.setDoc(k.fs.doc(db, 'users', leftUid), k.h.userDoc(leftUid));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', ender + '_' + leftUid), k.h.swipeDoc(ender, leftUid, 'like'));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', leftUid + '_' + ender), k.h.swipeDoc(leftUid, ender, 'like'));
      await k.fs.setDoc(k.fs.doc(db, 'matches', endedPair), k.h.matchDoc(ender, leftUid));
      await k.fs.setDoc(k.fs.doc(db, 'matches', endedPair, 'messages', 'm1'), k.h.messageDoc(leftUid));
    });
    const signedIn = function (uid) { return k.rulesEnv.authenticatedContext(uid).firestore(); };
    const stored = async function (path) {
      let data = null;
      await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
        const snap = await k.fs.getDoc(k.fs.doc(c.firestore(), path));
        data = snap.exists() ? snap.data() : null;
      });
      return data;
    };
    const comeBack = async function () {
      const back = (await stored('matches/' + endedPair)) !== null;
      if (back) {
        await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
          await k.fs.deleteDoc(k.fs.doc(c.firestore(), 'matches', endedPair));
        });
      }
      return back;
    };
    const owe = function (fromUid, toUid) {
      const map = {};
      map[fromUid] = {};
      map[fromUid][toUid] = { at: new Date().toISOString(), last: null };
      globalThis.localStorage.setItem(KEY, JSON.stringify(map));
    };
    const tried = {};
    try {
      k.ctx.ZC.firebase.db = signedIn(ender);
      tried.unmatch = await k.store.unmatch(endedPair, ender).catch(answer);
      tried.unmatchLeft = await stored('matches/' + endedPair);
      k.ctx.ZC.firebase.db = signedIn(leftUid);
      tried.theirTab = await k.store.recordSwipe(leftUid, ender, 'pass').catch(answer);
      tried.theirTabBack = await comeBack();
      tried.console = await k.fs.setDoc(k.fs.doc(signedIn(leftUid), 'matches', endedPair),
        k.h.matchDoc(ender, leftUid)).then(function () { return 'written'; }, function (err) { return err.code; });
      tried.consoleBack = await comeBack();
      owe(leftUid, ender);
      tried.theirNote = await k.store.reconcileMatches(leftUid).catch(answer);
      tried.theirNoteBack = await comeBack();
      k.ctx.ZC.firebase.db = signedIn(ender);
      tried.myTab = await k.store.recordSwipe(ender, leftUid, 'like').catch(answer);
      tried.myTabBack = await comeBack();
      owe(ender, leftUid);
      tried.myNote = await k.store.reconcileMatches(ender).catch(answer);
      tried.myNoteBack = await comeBack();
    } finally {
      k.ctx.ZC.firebase.db = openDb;
      globalThis.localStorage.removeItem(KEY);
    }
    k.ctx.drainWarnings();

    t.check('under the real rules, an unmatch removes the match',
      !!tried.unmatch && tried.unmatch.removed === true && tried.unmatchLeft === null,
      k.show(tried.unmatch) + (tried.unmatchLeft === null ? '' : ', and the match is still there'));

    t.check('and a stale deck tab of the other person\'s does not bring it back, on a pass or any key',
      !!tried.theirTab && tried.theirTab.matched === false && !tried.theirTabBack,
      k.show(tried.theirTab) + (tried.theirTabBack ? ', and the match document was written again' : ''));

    t.check('nor can the other person write the match document again themselves',
      tried.console === 'permission-denied' && !tried.consoleBack, k.show(tried.console));

    t.check('nor does a check still owed on another device, on either side',
      !!tried.theirNote && !tried.theirNote.rejected && !tried.theirNoteBack &&
        !!tried.myNote && !tried.myNote.rejected && !tried.myNoteBack,
      k.show({ theirs: tried.theirNote, reopened: tried.theirNoteBack, mine: tried.myNote, reopenedMine: tried.myNoteBack }));

    t.check('nor a stale deck tab of the person who ended it, which finds their pass on record',
      !!tried.myTab && tried.myTab.matched === false && tried.myTab.existing === true &&
        tried.myTab.action === 'pass' && !tried.myTabBack,
      k.show(tried.myTab) + (tried.myTabBack ? ', and the match document was written again' : ''));

    const enderSwipe = await stored('swipes/' + ender + '_' + leftUid);
    const leftSwipe = await stored('swipes/' + leftUid + '_' + ender);
    t.check('because the unmatch recorded the ender\'s pass in place of their like, and left the other like alone',
      !!enderSwipe && enderSwipe.action === 'pass' && !!leftSwipe && leftSwipe.action === 'like',
      k.show({ ender: enderSwipe && enderSwipe.action, other: leftSwipe && leftSwipe.action }));
  }
};
