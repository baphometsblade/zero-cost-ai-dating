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
