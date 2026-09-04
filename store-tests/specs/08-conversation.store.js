/* ==========================================================================
   A conversation keeps working, and outlives everything except an unmatch.

   All three properties here are about the Firebase adapter alone. The demo
   adapter holds every message in one array in one tab, so it has none of these
   problems and none could be found by a demo-mode test — which is the shape of
   divergence this repository has been bitten by before.

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
  }
};
