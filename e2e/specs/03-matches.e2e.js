/* The matches list, an existing conversation, sending a message that survives
   a reload, and the empty thread that has to offer openers instead of a void. */
'use strict';

/** Open the conversation whose row name starts with `name`. */
async function openConversation(page, name) {
  await page.locator('#match-list .match-row', { hasText: name }).first().click();
  await page.waitForSelector('#chat:not(.hidden)');
}

module.exports = {
  title: 'Matches list, chat and persistence',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    // Counted from before the page script runs. The conversation list used to be
    // a twenty-second `getMatches` poll — one match document and a profile for
    // each of them, every tick, plus one on every window focus and one on every
    // message sent. This wrapper is what pins all four of those call sites at
    // once: the number it reports has to stay zero through everything below.
    await page.addInitScript(function () {
      window.__zcGetMatches = 0;
      const wrap = function () {
        if (!window.ZC || !window.ZC.store || window.ZC.store.__counted) return;
        const real = window.ZC.store.getMatches;
        window.ZC.store.__counted = true;
        window.ZC.store.getMatches = function () {
          window.__zcGetMatches += 1;
          return real.apply(window.ZC.store, arguments);
        };
      };
      document.addEventListener('DOMContentLoaded', wrap);
      window.setTimeout(wrap, 0);
      window.setTimeout(wrap, 50);
    });

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const rows = await page.locator('#match-list .match-row').allTextContents();
    t.check('both seeded conversations are listed', rows.length === 2, 'rows=' + rows.length);

    /* ---- the seeded thread with history ---- */
    await openConversation(page, 'Devin');
    await page.waitForSelector('#chat-log .msg');
    const seeded = await page.evaluate(function () {
      const bubbles = Array.prototype.map.call(document.querySelectorAll('#chat-log .msg'), function (node) {
        return node.className.indexOf('msg-me') !== -1 ? 'me' : 'them';
      });
      return { total: bubbles.length, mine: bubbles.filter(function (s) { return s === 'me'; }).length };
    });
    t.check('the seeded conversation renders its history', seeded.total === 6, 'bubbles=' + seeded.total);
    t.check('both sides of the conversation are shown',
      seeded.mine > 0 && seeded.mine < seeded.total, 'mine=' + seeded.mine + '/' + seeded.total);

    /* ---- sending, and surviving a reload ---- */
    const text = 'Sent by the e2e suite at ' + ctx.viewport.label;
    await page.fill('#chat-input', text);
    await page.click('#chat-send');
    await page.waitForFunction(function (needle) {
      return document.getElementById('chat-log').textContent.indexOf(needle) !== -1;
    }, text);
    t.check('a sent message appears in the log', true);
    t.check('the composer clears after sending', (await page.inputValue('#chat-input')) === '');

    // syncUrl put ?m= in the address bar, so a plain reload reopens the thread.
    const conversationUrl = page.url();
    t.check('the open conversation is linkable', /[?&]m=/.test(conversationUrl), conversationUrl.split('?')[1]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#chat-log .msg');
    const persisted = await page.evaluate(function (needle) {
      return document.getElementById('chat-log').textContent.indexOf(needle) !== -1;
    }, text);
    t.check('the sent message survives a reload', persisted);

    /* ---- the thread nobody has written to ---- */
    // On phones the chat covers the list, so step back to it first.
    if (ctx.viewport.key === 'mobile') {
      await page.click('#chat-back');
      await page.waitForSelector('#match-list .match-row');
    }
    await openConversation(page, 'Sam');
    await page.waitForSelector('#chat-log .empty');
    const empty = await page.evaluate(function () {
      const log = document.getElementById('chat-log');
      return {
        messages: log.querySelectorAll('.msg').length,
        openers: Array.prototype.map.call(log.querySelectorAll('.icebreaker'), function (node) {
          return node.textContent.trim();
        })
      };
    });
    t.check('the empty conversation shows no phantom messages', empty.messages === 0, 'msgs=' + empty.messages);
    t.check('the empty conversation offers openers', empty.openers.length > 0, 'openers=' + empty.openers.length);

    await page.locator('#chat-log .icebreaker').first().click();
    t.check('choosing an opener loads it into the composer',
      (await page.inputValue('#chat-input')) === empty.openers[0]);

    /* ---- the page never asks for the whole list again ---- */

    // The counter resets on the reload above, so the send that happened before it
    // is NOT covered — measured: putting the old `refreshMatches()` back into
    // `sendMessage` left this check green until a send was moved after the
    // reload. So: send from here, raise a focus event, and sit idle for longer
    // than the poll that used to be here. That exercises all four call sites the
    // change removes — the first paint, a message sent, a focus, and the empty
    // thread opened just above — after the last reset of the counter.
    await page.click('#chat-send');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#chat-log .msg').length > 0;
    });
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(2500);
    const asked = await page.evaluate(function () { return window.__zcGetMatches; });
    t.check('the page never re-reads the whole conversation list',
      asked === 0,
      'ZC.store.getMatches called ' + asked + ' time(s) — the poll it replaces called it ' +
      'on a timer, on focus, on every message sent and on every empty thread opened');

    /* ---- an inbound message arrives without waiting for a tick ---- */

    // A bound, not an unbounded wait: the twenty-second poll would satisfy
    // "eventually" too. Two seconds is far longer than a push needs and far
    // shorter than the timer that used to be the only thing delivering this.
    const pushed = await page.evaluate(function () {
      const store = window.ZC.store;
      const me = window.ZC.auth.current.uid;
      return store.getMatches(me).then(function (list) {
        const target = list.filter(function (m) { return !!m.lastMessageAt; })[0] || list[0];
        const text = 'pushed at ' + Date.now();
        return store.sendMessage(target.matchId, target.otherUid, text).then(function () {
          return { matchId: target.matchId, text: text };
        });
      });
    });
    const landed = await page.waitForFunction(function (want) {
      const row = Array.prototype.filter.call(
        document.querySelectorAll('#match-list .match-row'),
        function (node) { return node.dataset.matchId === want.matchId; })[0];
      return !!row && row.textContent.indexOf(want.text) !== -1;
    }, pushed, { timeout: 2000 }).then(function () { return true; }, function () { return false; });
    t.check('a message from the other side reaches the list without waiting for a poll',
      landed,
      landed ? 'the preview updated within 2s' : 'nothing arrived in 2s — the list is not live');

    /* ---- the two ways a list can fail, which are not the same thing ---- */

    // Both are injected through the URL rather than by patching the live page: each
    // needs its own fresh document, and a wrapper applied to the old one goes with
    // it on navigation. Same deferred-wrap shape as the counter above — `window.ZC`
    // does not exist yet when an init script runs.
    await page.addInitScript(function () {
      window.__zcSubs = 0;
      const params = new URLSearchParams(window.location.search);
      if (params.get('zcoffline') === '1') {
        // What `startListDeadline` reads. The page must not sit for twelve seconds
        // waiting for a delivery a browser that knows it is offline will not get.
        Object.defineProperty(window.navigator, 'onLine', { get: function () { return false; } });
      }
      let calls = 0;
      const dead = params.get('zcdead') === '1';
      const silent = params.get('zcsilent') === '1';
      const wrap = function () {
        if (!window.ZC || !window.ZC.store || window.ZC.store.__wrapped) return;
        window.ZC.store.__wrapped = true;
        const real = window.ZC.store.listenMatchViews;
        window.ZC.store.listenMatchViews = function (uid, onViews, onError) {
          window.__zcSubs += 1;
          calls += 1;
          if (dead && calls === 1) {
            window.setTimeout(function () { onError(new Error('Missing or insufficient permissions.')); }, 0);
            return function () { /* already over */ };
          }
          // A stream that is open and simply never delivers — which is what an
          // `onSnapshot` does with no network and no offline persistence.
          if (silent) return function () { /* nothing to unsubscribe */ };
          return real.call(window.ZC.store, uid, onViews, onError);
        };
      };
      document.addEventListener('DOMContentLoaded', wrap);
      window.setTimeout(wrap, 0);
      window.setTimeout(wrap, 50);
    });

    // 1. A stream that DIED. Nothing more is coming, so the page has to let go of
    // the subscription — otherwise `subscribeList` is a no-op forever and the retry
    // button is the only way back, from a failure a reconnect may already have
    // fixed.
    ctx.session.expectConsoleError(/conversation list stopped/);
    await page.goto(ctx.base + '/matches.html?zcdead=1', { waitUntil: 'domcontentloaded' });
    const failed = await page.waitForSelector('#list-error:not(.hidden)', { timeout: 5000 })
      .then(function () { return true; }, function () { return false; });
    t.check('a conversation list that cannot load says so instead of showing none',
      failed, failed ? 'the error state is shown' : '#list-error never appeared');

    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    // Presence, not visibility: on a phone the panes swap, and the claim is that the
    // list came back rather than that it is the thing on screen.
    const recovered = await page.waitForFunction(function () {
      return document.querySelectorAll('#match-list .match-row').length > 0;
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    const deadSubs = await page.evaluate(function () { return window.__zcSubs; });
    t.check('and returning to the tab re-subscribes rather than leaving it stuck',
      recovered && deadSubs === 2,
      recovered ? deadSubs + ' subscription(s) — the second is the recovery'
        : 'the list never came back after ' + deadSubs + ' subscription(s); a dead ' +
          'stream the page still holds makes every re-subscribe a no-op');

    // 2. A stream that is merely SLOW — here, a browser that says it is offline, which
    // takes the same path without a twelve-second wait. The subscription is alive and
    // Firestore reconnects on its own, so the handle is KEPT: releasing it would have
    // every return to the tab stack a second stream on top of the first.
    //
    // What this check does NOT assert, and why: that the failure stays on screen.
    // In demo mode the delivery arrives within a tick, so the soft deadline does
    // exactly what it is supposed to — the late list clears the error and paints.
    // The half that IS observable here is the one the two paths differ on.
    await page.goto(ctx.base + '/matches.html?zcoffline=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(300);
    const offline = await page.evaluate(function () {
      return { subs: window.__zcSubs, onLine: window.navigator.onLine };
    });
    ctx.session.expectConsoleError(null);
    t.check('a browser that says it is offline keeps the one subscription it already has',
      offline.onLine === false && offline.subs === 1,
      'navigator.onLine=' + offline.onLine + ' (false or this check is vacuous), ' +
      offline.subs + ' subscription(s) after a focus — the stream here is alive and ' +
      'merely slow, so a second one would be stacked on top of it');

    // 3. ...and it must not WAIT to find that out. With a stream that is open and
    // never delivers — an `onSnapshot` with no network and no offline persistence —
    // the deadline alone would leave a skeleton on screen for twelve seconds. Three
    // is comfortably inside that and comfortably outside the short-circuit, so the
    // bound is what makes this a check rather than a wait.
    ctx.session.expectConsoleError(/conversation list stopped/);
    await page.goto(ctx.base + '/matches.html?zcoffline=1&zcsilent=1', { waitUntil: 'domcontentloaded' });
    const saidSoonEnough = await page.waitForSelector('#list-error:not(.hidden)', { timeout: 3000 })
      .then(function () { return true; }, function () { return false; });
    ctx.session.expectConsoleError(null);
    t.check('and says so at once rather than waiting out the twelve-second deadline',
      saidSoonEnough,
      saidSoonEnough ? 'reported inside 3s' : 'nothing in 3s — a page that already knows ' +
        'it is offline sat on a skeleton waiting for a delivery that was never coming');

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await openConversation(page, 'Sam');

    /* ---- and a conversation the other side ends keeps what was typed ---- */

    const typed = 'half a reply nobody should lose';
    await page.fill('#chat-input', typed);
    const openId = await page.evaluate(function () { return window.ZC.util.qs('m'); });
    await page.evaluate(function (matchId) {
      return window.ZC.store.unmatch(matchId, window.ZC.auth.current.uid);
    }, openId);
    const ended = await page.waitForSelector('#chat-ended', { timeout: 3000 })
      .then(function () { return true; }, function () { return false; });
    const after = await page.evaluate(function () {
      return {
        typed: document.getElementById('chat-input').value,
        sendDisabled: document.getElementById('chat-send').disabled,
        rows: document.querySelectorAll('#match-list .match-row').length
      };
    });
    t.check('a conversation the other side ends says so without discarding what was typed',
      ended && after.typed === typed && after.sendDisabled === true,
      h.show ? h.show(after) : JSON.stringify(after));
  }
};
