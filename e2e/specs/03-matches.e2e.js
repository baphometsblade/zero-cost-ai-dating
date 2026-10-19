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

    // Every interval the page starts, and whether it has been cleared, so the
    // stamp ticker's life can be read back — and its callback run on demand,
    // because waiting a real minute for it is not a test anybody would keep.
    await page.addInitScript(function () {
      window.__zcIntervals = {};
      const realSet = window.setInterval;
      const realClear = window.clearInterval;
      window.setInterval = function (fn, delay) {
        const id = realSet.apply(window, arguments);
        window.__zcIntervals[id] = { delay: Number(delay) || 0, fn: fn, live: true };
        return id;
      };
      window.clearInterval = function (id) {
        if (window.__zcIntervals[id]) window.__zcIntervals[id].live = false;
        return realClear.apply(window, arguments);
      };
      window.__zcStampTickers = function () {
        return Object.keys(window.__zcIntervals).map(function (id) { return window.__zcIntervals[id]; })
          .filter(function (entry) { return entry.live && entry.delay === 60000; });
      };
    });

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const rows = await page.locator('#match-list .match-row').allTextContents();
    t.check('both seeded conversations are listed', rows.length === 2, 'rows=' + rows.length);

    // The list's relative stamps are left out of its fingerprint on purpose, so
    // a list where nothing else changes is never repainted, and its "2m" stays
    // "2m" unless the ticker rewrites it. The ticker used to start only when a
    // conversation opened, so a list loaded with no `?m=` sat on its first
    // stamps for as long as nothing else moved.
    // Run once by hand over a stamp made stale on purpose: the claim is that the
    // ticker exists AND that it is what keeps the rows honest.
    const listTicker = await page.evaluate(function () {
      const tickers = window.__zcStampTickers();
      const stamp = document.querySelector('#match-list .match-row .match-row-time');
      if (!stamp) return { tickers: tickers.length, rewritten: false, text: 'no stamp' };
      const honest = stamp.textContent;
      stamp.textContent = 'stale';
      tickers.forEach(function (entry) { entry.fn(); });
      return { tickers: tickers.length, rewritten: stamp.textContent === honest, text: stamp.textContent };
    });
    t.check('a list opened with no conversation keeps its relative stamps ticking',
      listTicker.tickers === 1 && listTicker.rewritten,
      listTicker.tickers + ' live one-minute ticker(s); a stale stamp ' +
      (listTicker.rewritten ? 'was rewritten by it' : 'still reads "' + listTicker.text + '"'));

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
    // Bounded, and its answer is the check. Written as a wait with no bound of
    // its own and then `check(name, true)`, a message that never appeared ran
    // out the session's twenty-second default inside the wait, which threw and
    // was recorded as "spec ran to completion", and this line never printed.
    const appeared = await page.waitForFunction(function (needle) {
      return document.getElementById('chat-log').textContent.indexOf(needle) !== -1;
    }, text, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    t.check('a sent message appears in the log', appeared);
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

    /* ---- Escape on a dialog belongs to the dialog ---- */

    // Below the two-pane width, Escape also backs out of an open conversation,
    // from a handler on the document. The dialog's own Escape closed the dialog
    // and then bubbled up to it, where the "is a dialog open?" guard looked for
    // a backdrop that close() had already removed: the conversation shut behind
    // the dialog, `?m=` went, and the composer was emptied with a half-written
    // reply in it. Where both panes show, that handler stands down, so at
    // 1280x800 only the count of Escapes reaching the document can fail here.
    // The fix has two halves, and each is enough on its own for this page, so
    // each has a check of its own: the dialog stops the Escape it used, and the
    // page ignores an Escape that something else has already handled.
    await page.evaluate(function () {
      window.__zcEscapesSeen = 0;
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') window.__zcEscapesSeen += 1;
      });
    });
    const unsent = 'half a reply that a dialog must not throw away';
    const chatState = function () {
      return page.evaluate(function () {
        const chat = document.getElementById('chat');
        const active = document.activeElement;
        return {
          chatOpen: !!chat && !chat.classList.contains('hidden') && chat.offsetParent !== null,
          m: window.ZC.util.qs('m'),
          draft: document.getElementById('chat-input').value,
          focus: active ? (active.id || active.tagName) : null,
          escapesSeen: window.__zcEscapesSeen
        };
      });
    };
    await page.fill('#chat-input', unsent);
    await page.focus('#chat-menu');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal-backdrop .modal-foot');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const escaped = await chatState();
    t.check('Escape on a dialog over a conversation closes the dialog and goes no further: not the conversation, not its draft',
      escaped.chatOpen && !!escaped.m && escaped.draft === unsent && escaped.focus === 'chat-menu' &&
        escaped.escapesSeen === 0,
      JSON.stringify(escaped));
    // Put the thread back if it was lost, so one failure here is not the cause
    // of every failure after it.
    if (!escaped.chatOpen) await openConversation(page, 'Devin');

    // The page's half, reached without a dialog: a control that handles Escape
    // itself and says so with preventDefault, but lets the event bubble. Only
    // the phone viewport can fail this one: where both panes show, the page's
    // handler stands down for every Escape, with that guard or without it.
    await page.evaluate(function () {
      const input = document.getElementById('chat-input');
      input.addEventListener('keydown', function consume(event) {
        if (event.key !== 'Escape') return;
        input.removeEventListener('keydown', consume);
        event.preventDefault();
      });
    });
    await page.focus('#chat-input');
    await page.keyboard.press('Escape');
    const consumed = await chatState();
    t.check('and an Escape another control has already handled does not close the conversation either',
      consumed.chatOpen && !!consumed.m && consumed.draft === unsent &&
        consumed.escapesSeen - escaped.escapesSeen === 1,
      JSON.stringify(consumed) + ' (one more Escape reached the document, or this tested nothing)');
    if (!consumed.chatOpen) await openConversation(page, 'Devin');
    await page.fill('#chat-input', '');

    /* ---- a held Enter cannot carry through a destructive confirmation ---- */

    // The Enter that picks "Unmatch" in the options dialog is still down when the
    // confirmation opens, and a held key repeats: once its auto-repeat delay has
    // passed, the OS sends more keydowns, marked repeat. The confirmation used to
    // open with focus on its own "Unmatch", so the first repeat answered it, and
    // the match was gone with no second decision. A second `down` of a key that
    // Playwright still holds is sent marked repeat, as the OS sends it. Counted
    // at the facade: a confirmed unmatch calls it from the same microtask
    // checkpoint as the click, so the count is settled by the time the dialog is
    // seen to be gone.
    await page.evaluate(function () {
      const store = window.ZC.store;
      const real = store.unmatch;
      window.__zcUnmatches = 0;
      store.unmatch = function () {
        window.__zcUnmatches += 1;
        return real.apply(store, arguments);
      };
    });
    await page.focus('#chat-menu');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal-backdrop .modal-foot');
    await page.locator('.modal-backdrop .modal-foot button', { hasText: /^Unmatch$/ }).focus();
    await page.keyboard.down('Enter');
    await page.waitForFunction(function () {
      const title = document.querySelector('.modal-backdrop .modal-title');
      return !!title && /^Unmatch /.test(title.textContent);
    });
    const confirmFocus = await page.evaluate(function () {
      const active = document.activeElement;
      return active ? (active.textContent || active.tagName).trim() : null;
    });
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const held = await page.evaluate(function () {
      return {
        unmatches: window.__zcUnmatches,
        m: window.ZC.util.qs('m'),
        rows: document.querySelectorAll('#match-list .match-row').length
      };
    });
    t.check('a destructive confirmation opens on Cancel, so a held Enter dismisses it instead of unmatching',
      confirmFocus === 'Cancel' && held.unmatches === 0 && !!held.m && held.rows === 2,
      'focus on opening: ' + JSON.stringify(confirmFocus) + '; after the repeat: ' + JSON.stringify(held));

    /* ---- the thread nobody has written to ---- */
    // On phones the chat covers the list, so step back to it first.
    if (ctx.viewport.key === 'mobile') {
      await page.click('#chat-back');
      await page.waitForSelector('#match-list .match-row');
      // Back is `closeMatch`, which used to stop the ticker on its way out — so
      // the list a phone returns to was the one list with nothing rewriting it.
      const backTickers = await page.evaluate(function () { return window.__zcStampTickers().length; });
      t.check('going back to the list from a conversation leaves its stamps ticking',
        backTickers === 1, backTickers + ' live one-minute ticker(s) after Back');
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

    /* ---- a conversation longer than the live window ---- */

    // Firestore delivers a conversation's newest LIVE_MESSAGE_WINDOW messages,
    // oldest first, so past that length every new message SLIDES the window: the
    // delivery no longer starts with what is on screen. `renderMessages` read
    // that as history changing, rebuilt the whole log — every bubble replaced,
    // and anything the reader had selected gone with them, on every message —
    // and announced every message from the other side in the window as new.
    // (The reader's scroll position survived it, measured on both viewports: the
    // log is emptied and refilled with no layout in between.) The demo adapter
    // delivers everything and never slides, which is why no demo check could see
    // it; `?zcwindow=` gives it the Firestore shape, at a length a seeded
    // conversation can reach.
    await page.addInitScript(function () {
      const size = Number(new URLSearchParams(window.location.search).get('zcwindow')) || 0;
      if (!size) return;
      const wrap = function () {
        if (!window.ZC || !window.ZC.store || window.ZC.store.__windowed) return;
        window.ZC.store.__windowed = true;
        const real = window.ZC.store.listenMessages;
        window.ZC.store.listenMessages = function (matchId, cb) {
          return real.call(window.ZC.store, matchId, function (list) {
            cb(Array.isArray(list) ? list.slice(-size) : list);
          });
        };
      };
      document.addEventListener('DOMContentLoaded', wrap);
      window.setTimeout(wrap, 0);
      window.setTimeout(wrap, 50);
    });
    const WINDOW = 20;
    const long = await page.evaluate(async function () {
      const store = window.ZC.store;
      const me = window.ZC.auth.current.uid;
      const list = await store.getMatches(me);
      const target = list.filter(function (m) { return !!m.lastMessageAt; })[0] || list[0];
      // Both sides, so a rebuild has plenty from the other side to over-announce.
      for (let i = 0; i < 24; i += 1) {
        await store.sendMessage(target.matchId, i % 2 ? target.otherUid : me, 'earlier message ' + i);
      }
      return { matchId: target.matchId, otherUid: target.otherUid, name: String(target.other.displayName || '').trim() };
    });
    await page.goto(ctx.base + '/matches.html?m=' + encodeURIComponent(long.matchId) + '&zcwindow=' + WINDOW,
      { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function (size) {
      return document.querySelectorAll('#chat-log .msg').length === size;
    }, WINDOW);

    // On a phone the open conversation used to be sized by its content: the
    // log never scrolled, the page did, and a long thread opened at its oldest
    // message with the newest and the composer far below the screen. It is now
    // the screen between the header and the tab bar, and its log scrolls.
    //
    // On a laptop the chat was min(74vh, 720px) tall wherever the page heading
    // ended: at 1280x800 its composer finished at 826px, below the window, and
    // the page scrolled 475px to reach it. The page fills the window there now.
    {
      const opened = await page.evaluate(function () {
        const msgs = document.querySelectorAll('#chat-log .msg');
        const newest = msgs[msgs.length - 1].getBoundingClientRect();
        const form = document.getElementById('chat-form').getBoundingClientRect();
        // The tab bar is the floor where it shows; on a wide screen it is
        // hidden and measures nothing, and the window's edge is the floor.
        const bar = document.querySelector('.tabbar');
        const shown = bar && bar.getBoundingClientRect().height > 0;
        const floor = shown ? bar.getBoundingClientRect().top : window.innerHeight;
        return {
          newest: [Math.round(newest.top), Math.round(newest.bottom)],
          composerBottom: Math.round(form.bottom),
          floor: Math.round(floor),
          pageScroll: document.scrollingElement.scrollHeight - window.innerHeight
        };
      });
      t.check('a long conversation opens at its newest message, with the composer on screen',
        opened.newest[0] >= 0 && opened.newest[1] <= opened.floor && opened.composerBottom <= opened.floor &&
          opened.pageScroll <= 1,
        JSON.stringify(opened));
    }

    // Part way up, so a jump in either direction is distinguishable from staying.
    // Whichever box actually scrolls: the log is its own scroller at both
    // sizes now, but this measures whichever one moves rather than assuming.
    const placed = await page.evaluate(function () {
      const log = document.getElementById('chat-log');
      const scroller = log.scrollHeight > log.clientHeight + 1 ? log : document.scrollingElement;
      const first = log.querySelector('.msg');
      first.dataset.zcFirst = '1';
      // `instant`, because the page's own scroll is `scroll-behavior: smooth`
      // and would still be travelling when it is read back.
      scroller.scrollTo({ top: Math.floor((scroller.scrollHeight - scroller.clientHeight) / 3), behavior: 'instant' });
      // A reader part way through copying something out of the conversation.
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.selectAllChildren(first.querySelector('.msg-text'));
      return {
        which: scroller === log ? 'the log' : 'the page',
        scrollTop: scroller.scrollTop,
        room: scroller.scrollHeight - scroller.clientHeight,
        selected: selection.toString()
      };
    });
    const pastWindow = 'one past the window ' + Date.now();
    await page.evaluate(function (send) {
      return window.ZC.store.sendMessage(send.matchId, send.otherUid, send.text);
    }, { matchId: long.matchId, otherUid: long.otherUid, text: pastWindow });
    await page.waitForFunction(function (needle) {
      return document.getElementById('chat-log').textContent.indexOf(needle) !== -1;
    }, pastWindow);
    const slid = await page.evaluate(function (which) {
      const log = document.getElementById('chat-log');
      const scroller = which === 'the log' ? log : document.scrollingElement;
      return {
        status: document.getElementById('chat-status').textContent,
        scrollTop: scroller.scrollTop,
        kept: !!log.querySelector('.msg[data-zc-first="1"]'),
        selected: window.getSelection().toString()
      };
    }, placed.which);
    t.check('one message past the live window is announced as one message',
      slid.status === 'New message from ' + long.name + ': ' + pastWindow,
      JSON.stringify(slid.status));
    t.check('and the log is extended, not rebuilt: what the reader had selected stays selected, and so do they',
      slid.kept && placed.selected.length > 0 && slid.selected === placed.selected &&
      placed.room > 0 && placed.scrollTop > 0 && Math.abs(slid.scrollTop - placed.scrollTop) <= 1,
      placed.which + ' scrolled to ' + placed.scrollTop + ' of ' + placed.room + ', then ' + slid.scrollTop +
      (slid.kept ? '' : '; the log was rebuilt — the first bubble is a new node') +
      '; selected ' + JSON.stringify(placed.selected.slice(0, 20)) + ' -> ' + JSON.stringify(slid.selected.slice(0, 20)));

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
      let badgeCalls = 0;
      let likeCalls = 0;
      window.__zcBadgeSubs = 0;
      window.__zcLikeSubs = 0;
      const dead = params.get('zcdead') === '1';
      const deadBadge = params.get('zcdeadbadge') === '1';
      const deadLikes = params.get('zcdeadlikes') === '1';
      const deadLater = params.get('zcdeadlater') === '1';
      const silent = params.get('zcsilent') === '1';
      const wrap = function () {
        if (!window.ZC || !window.ZC.store || window.ZC.store.__wrapped) return;
        window.ZC.store.__wrapped = true;

        // The nav badge's own stream, wrapped the same way the list's is below.
        // It shares the store's match stream with the list but subscribes through
        // a different method, so killing one says nothing about the other.
        const realMatches = window.ZC.store.listenMatches;
        window.ZC.store.listenMatches = function (uid, cb, onError) {
          window.__zcBadgeSubs += 1;
          badgeCalls += 1;
          if (deadBadge && badgeCalls === 1) {
            // Guarded, because the point of the check is that `onError` used not
            // to be passed at all: calling an undefined handler would throw here
            // instead of reporting what the page does with the death.
            window.setTimeout(function () {
              if (typeof onError === 'function') onError(new Error('Missing or insufficient permissions.'));
            }, 0);
            return function () { /* already over */ };
          }
          return realMatches.call(window.ZC.store, uid, cb, onError);
        };

        // Which of the two who-liked-you reads the page makes. The free plan must
        // ask for a number; only premium may ask for the people.
        window.__zcLikesList = 0;
        window.__zcLikesCount = 0;
        const realList = window.ZC.store.getLikesReceived;
        window.ZC.store.getLikesReceived = function () {
          window.__zcLikesList += 1;
          return realList.apply(window.ZC.store, arguments);
        };
        const realCount = window.ZC.store.countLikesReceived;
        window.ZC.store.countLikesReceived = function () {
          window.__zcLikesCount += 1;
          return realCount.apply(window.ZC.store, arguments);
        };

        // The premium who-liked-you badge, killed the same way. Guarded for the
        // same reason as above: the defect was that no handler was passed.
        const realLikes = window.ZC.store.listenLikesReceived;
        window.ZC.store.listenLikesReceived = function (uid, cb, onError) {
          window.__zcLikeSubs += 1;
          likeCalls += 1;
          if (deadLikes && likeCalls === 1) {
            window.setTimeout(function () {
              if (typeof onError === 'function') onError(new Error('Missing or insufficient permissions.'));
            }, 0);
            return function () { /* already over */ };
          }
          return realLikes.call(window.ZC.store, uid, cb, onError);
        };

        const real = window.ZC.store.listenMatchViews;
        window.ZC.store.listenMatchViews = function (uid, onViews, onError) {
          window.__zcSubs += 1;
          calls += 1;
          if (dead && calls === 1) {
            window.setTimeout(function () { onError(new Error('Missing or insufficient permissions.')); }, 0);
            return function () { /* already over */ };
          }
          // Dies AFTER delivering — the list has loaded, and then the stream goes.
          if (deadLater && calls === 1) {
            let stopReal = null;
            let killed = false;
            stopReal = real.call(window.ZC.store, uid, function (views) {
              onViews(views);
              if (killed) return;
              killed = true;
              window.setTimeout(function () {
                if (stopReal) stopReal();
                window.__zcKilledAfterLoad = true;
                onError(new Error('Missing or insufficient permissions.'));
              }, 0);
            }, onError);
            return function () { if (stopReal) stopReal(); };
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

    // 1a. A list that LOADED, and then lost its stream. Case 1 kills the stream
    // before its first delivery, so its recovery goes through `firstViews`, the
    // one place the error was cleared. This one cannot: the first delivery has
    // already happened, so the retry's rows arrived under an error panel that
    // never went away — `renderList` hides the list while `state.error` is set.
    //
    // Whether the error panel was ever VISIBLE is not the claim, and is not
    // observable reliably: `pageshow` re-subscribes on its own, so with the fix
    // the panel can come and go between two polls. The claim is the end state
    // after a death that is known to have happened, which the hook records.
    await page.goto(ctx.base + '/matches.html?zcdeadlater=1', { waitUntil: 'domcontentloaded' });
    const laterFailed = await page.waitForFunction(function () { return window.__zcKilledAfterLoad === true; },
      null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    const laterBack = await page.waitForFunction(function () {
      const error = document.getElementById('list-error');
      const rows = document.querySelectorAll('#match-list .match-row');
      const list = document.getElementById('match-list');
      return window.__zcSubs >= 2 && error.classList.contains('hidden') &&
        rows.length > 0 && !list.classList.contains('hidden');
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    const laterState = await page.evaluate(function () {
      return {
        subs: window.__zcSubs,
        errorShown: !document.getElementById('list-error').classList.contains('hidden'),
        rows: document.querySelectorAll('#match-list .match-row').length
      };
    });
    t.check('a list that loaded, lost its stream and came back clears its error and shows the rows',
      laterFailed && laterBack,
      (laterFailed ? '' : 'the stream was never killed, so this tested nothing — ') + JSON.stringify(laterState));

    // 1b. The same death, on the NAV BADGE's subscription rather than the list's.
    // `app.js` passed no error handler at all, so when the shared stream died the
    // store cleared its subscribers and deleted the record while `matchStop` kept
    // holding a live-looking handle to it — and the `if (!matchStop)` guard then
    // refused every re-subscription for the life of the page. The list recovered on
    // focus and the badge beside it sat on a stale number with nothing said.
    ctx.session.expectConsoleError(/badge could not update/);
    await page.goto(ctx.base + '/matches.html?zcdeadbadge=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const badgeBefore = await page.evaluate(function () { return window.__zcBadgeSubs; });
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    const badgeBack = await page.waitForFunction(function () {
      return window.__zcBadgeSubs >= 2;
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    const badgeSubs = await page.evaluate(function () { return window.__zcBadgeSubs; });
    // Handed back, not cleared. The offline case below runs while case 1's
    // pattern is still in force and relies on it; clearing here made its
    // "conversation list stopped" line an unexpected console error.
    ctx.session.expectConsoleError(/conversation list stopped/);
    t.check('a nav badge whose stream dies re-subscribes instead of freezing',
      badgeBack && badgeSubs === 2,
      badgeSubs + ' badge subscription(s) after a death and a focus (was ' + badgeBefore +
      ' before) — without an onError the handle is never released and every ' +
      're-subscribe is a no-op, so the count stays at 1 forever');

    // 1c. Its sibling, the premium who-liked-you badge, which kept the defect 1b
    // fixed: `listenLikesReceived` took no error handler and `app.js` passed
    // none, so a dead likes stream left `likeStop` holding a dead handle and
    // `if (!likeStop)` refused every re-subscription. Premium is set through the
    // store as a fixture — the badge only subscribes on a plan that sees likes —
    // and put back afterwards so nothing below runs on a plan it did not expect.
    await page.evaluate(function () {
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, { plan: 'premium' });
    });
    ctx.session.expectConsoleError(/badge could not update/);
    await page.goto(ctx.base + '/matches.html?zcdeadlikes=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const likesSubscribed = await page.waitForFunction(function () {
      return window.__zcLikeSubs >= 1;
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    const likesBack = await page.waitForFunction(function () {
      return window.__zcLikeSubs >= 2;
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    const likeSubs = await page.evaluate(function () { return window.__zcLikeSubs; });
    await page.waitForSelector('#likes-card:not(.hidden)', { timeout: 5000 }).catch(function () { return null; });
    const premiumReads = await page.evaluate(function () {
      return { list: window.__zcLikesList, count: window.__zcLikesCount };
    });
    await page.evaluate(function () {
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, { plan: 'free' });
    });
    ctx.session.expectConsoleError(/conversation list stopped/);
    t.check('a premium likes badge whose stream dies re-subscribes instead of freezing',
      likesSubscribed && likesBack && likeSubs === 2,
      likeSubs + ' likes subscription(s) after a death and a focus' +
      (likesSubscribed ? '' : ' — it never subscribed at all, so the plan fixture did not take'));

    // 1d. The free plan's who-liked-you panel draws placeholder faces beside
    // "free accounts never receive the real ones", and used to fetch the real
    // ones anyway — `getLikesReceived(...).length` — then draw only the number.
    // Premium is the control, measured on the page above: it must still ask for
    // the people, or "free never asks" would pass against a page that asks
    // nobody anything.
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#likes-card:not(.hidden)', { timeout: 5000 });
    const freeReads = await page.evaluate(function () {
      return {
        list: window.__zcLikesList,
        count: window.__zcLikesCount,
        panel: (document.getElementById('likes-body').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
      };
    });
    t.check('on the free plan the who-liked-you panel asks for a number, never for the people',
      freeReads.list === 0 && freeReads.count >= 1 && premiumReads.list >= 1,
      'free: ' + freeReads.list + ' list read(s), ' + freeReads.count + ' count read(s) — "' + freeReads.panel +
      '"; premium (control): ' + premiumReads.list + ' list read(s)');

    // 1e. Who liked you counts everyone waiting on an answer, and the store
    // applies only block lists to that. The deck applies the engine's hard
    // filters as well, so a viewer who narrows their own filters has likers
    // the deck will never show — and Premium was told every one of them "liked
    // you and is still in your deck", with a link to Discover that led nowhere.
    // Fifty kilometres leaves five of the nine seeded likers outside the deck.
    // One of them also pauses Discover, which keeps her out whatever this
    // account's filters say, so Settings is no answer for her and the panel
    // may not send her there. Both decks are worked out the way dashboard.js
    // builds one, the store's candidates ranked by the engine, which drops
    // whoever fails a filter: once as this account is, and once with its own
    // filters opened all the way, which is what widening them can reach.
    const distanceWas = await page.evaluate(function () {
      const uid = window.ZC.auth.current.uid;
      return window.ZC.store.getUser(uid).then(function (me) {
        const was = me.preferences.maxDistanceKm;
        return window.ZC.store.updateUser('fatima-bennani', { preferences: { discoverable: false } })
          .then(function () {
            return window.ZC.store.updateUser(uid, { plan: 'premium', preferences: { maxDistanceKm: 50 } });
          })
          .then(function () { return was; });
      });
    });
    const readLikes = function () {
      return page.evaluate(async function () {
        const uid = window.ZC.auth.current.uid;
        const me = await window.ZC.store.getUser(uid);
        const pool = await window.ZC.store.listCandidates(uid, { limit: 1000 });
        const deckOf = function (viewer) {
          return window.ZC.matching.rankCandidates(viewer, pool, {}).map(function (r) { return r.uid; });
        };
        const deck = deckOf(me);
        const wide = deckOf(Object.assign({}, me, {
          preferences: Object.assign({}, me.preferences, { interestedIn: [], ageMin: null, ageMax: null, maxDistanceKm: null })
        }));
        const likers = await window.ZC.store.getLikesReceived(uid);
        const body = document.getElementById('likes-body');
        const text = (body.textContent || '').replace(/\s+/g, ' ').trim();
        const claim = /(\d+|One) (?:people|person) liked you and (?:are|is) still in your deck/.exec(text);
        const navBadge = document.querySelector('[data-badge="dashboard"]');
        return {
          likers: likers.map(function (doc) {
            return { name: doc.displayName, inDeck: deck.indexOf(doc.uid) !== -1, inWide: wide.indexOf(doc.uid) !== -1 };
          }),
          entries: Array.prototype.map.call(body.querySelectorAll('.new-match'), function (node) {
            return { label: node.getAttribute('aria-label') || node.textContent.trim(), href: node.getAttribute('href') };
          }),
          claim: claim ? (claim[1] === 'One' ? 1 : Number(claim[1])) : 0,
          badge: navBadge ? navBadge.textContent.trim() : null,
          text: text
        };
      });
    };
    const namedIn = function (people) {
      return function (e) { return people.some(function (l) { return e.label.indexOf(l.name + ' ') === 0; }); };
    };
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#likes-card:not(.hidden) #likes-body > *', { timeout: 5000 });
    // The nav badge is painted by its own subscription; it is compared below,
    // so it has to have spoken. Bounded, so a badge that never does is reported.
    await page.waitForFunction(function () {
      const node = document.querySelector('[data-badge="dashboard"]');
      return !!node && node.textContent.trim() !== '';
    }, null, { timeout: 5000 }).catch(function () {});
    const narrowed = await readLikes();
    const deckLikers = narrowed.likers.filter(function (l) { return l.inDeck; });
    const outside = narrowed.likers.filter(function (l) { return !l.inDeck; });
    const widenable = outside.filter(function (l) { return l.inWide; });
    const sentToDiscover = narrowed.entries.filter(function (e) { return e.href === 'dashboard.html'; });
    const notInDeck = sentToDiscover.filter(function (e) { return !namedIn(deckLikers)(e); });
    t.check('on Premium, who liked you sends to Discover only the likers the deck will show',
      outside.length > 0 && notInDeck.length === 0 && sentToDiscover.length === deckLikers.length &&
        narrowed.claim === deckLikers.length,
      deckLikers.length + ' of ' + narrowed.likers.length + ' likers in the deck; ' + sentToDiscover.length +
      ' sent to Discover' + (notInDeck.length ? ' (' + notInDeck.map(function (e) { return e.label.split(' liked')[0]; }).join(', ') +
      ' are not in it)' : '') + '; the panel says ' + narrowed.claim + ' are "still in your deck"');
    const toSettings = narrowed.entries.filter(function (e) { return e.href === 'settings.html'; });
    const misSent = toSettings.filter(function (e) { return !namedIn(widenable)(e); });
    const unlinked = narrowed.entries.filter(function (e) { return !e.href; });
    t.check('and the rest are listed apart, sent to Settings only when widening your filters would bring them back',
      widenable.length > 0 && widenable.length < outside.length && misSent.length === 0 &&
        toSettings.length === widenable.length && unlinked.length === outside.length - widenable.length &&
        /outside your current filters/.test(narrowed.text) && /would not bring them back/.test(narrowed.text),
      toSettings.length + ' sent to Settings for ' + widenable.length + ' that widening would bring back' +
      (misSent.length ? ' (' + misSent.map(function (e) { return e.label.split(' liked')[0]; }).join(', ') + ' would not come back)' : '') +
      '; ' + unlinked.length + ' left unlinked of ' + (outside.length - widenable.length) + ' it would not');
    t.check('so the panel still counts everyone the nav badge does',
      narrowed.entries.length === narrowed.likers.length && narrowed.badge === String(narrowed.likers.length),
      narrowed.entries.length + ' faces for ' + narrowed.likers.length + ' likers; nav badge ' + JSON.stringify(narrowed.badge));

    // Free is told a number and never who, so it cannot be told which of them
    // the deck will show. It may not promise that all of them are there.
    await page.evaluate(function () {
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, { plan: 'free' });
    });
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#likes-card:not(.hidden) #likes-body > *', { timeout: 5000 });
    const freeNarrowed = await readLikes();
    t.check('and on the free plan the count no longer promises that every one of them is in the deck',
      new RegExp('(?:^|\\D)' + freeNarrowed.likers.length + ' people have already liked you').test(freeNarrowed.text) &&
        !/find them in the deck|still in your deck/.test(freeNarrowed.text),
      JSON.stringify(freeNarrowed.text.replace(/^(Hidden)+/, '').slice(0, 240)));
    await page.evaluate(function (was) {
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, { preferences: { maxDistanceKm: was } })
        .then(function () {
          return window.ZC.store.updateUser('fatima-bennani', { preferences: { discoverable: true } });
        });
    }, distanceWas);

    // 1f. A match's full card ("View profile") is scored as the deck scores,
    // and the deck's hard filters fail for things only the other person did:
    // pausing Discover, which Settings promises leaves existing matches where
    // they are, or narrowing their own age range. The card then lost its score
    // ring and reasons, printed the engine's "Not shown — …" on a card that is
    // being shown, and told the viewer "your current filters" were the cause.
    // Devin is the seeded match; each case changes one side's settings through
    // the store and is undone before the next.
    const viewDevin = async function (mine, his) {
      await page.evaluate(function (patch) {
        return window.ZC.store.updateUser(window.ZC.auth.current.uid, { preferences: patch.mine })
          .then(function () { return window.ZC.store.updateUser('devin-alvarez', { preferences: patch.his }); });
      }, { mine: mine, his: his });
      await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
      await openConversation(page, 'Devin');
      await page.click('#chat-menu');
      await h.clickModalAction(page, 'View profile');
      await page.waitForSelector('.modal-backdrop .swipe-card');
      const card = await page.evaluate(function () {
        const body = document.querySelector('.modal-backdrop .modal-body');
        return {
          ring: !!body.querySelector('.match-score'),
          reasons: body.querySelectorAll('.reason').length,
          notes: Array.prototype.map.call(body.querySelectorAll('p.text-muted, p.field-hint'), function (p) {
            return p.textContent.trim();
          }).join(' | ')
        };
      });
      await h.clickModalAction(page, 'Close');
      await page.waitForSelector('.modal-backdrop', { state: 'detached' });
      return card;
    };
    const settingsWere = await page.evaluate(function () {
      return Promise.all([
        window.ZC.store.getUser(window.ZC.auth.current.uid),
        window.ZC.store.getUser('devin-alvarez')
      ]).then(function (both) {
        const pick = function (doc) {
          return { discoverable: doc.preferences.discoverable, ageMin: doc.preferences.ageMin, ageMax: doc.preferences.ageMax };
        };
        const mine = pick(both[0]);
        mine.maxDistanceKm = both[0].preferences.maxDistanceKm;
        return { mine: mine, his: pick(both[1]) };
      });
    });
    const asSeeded = await viewDevin(settingsWere.mine, settingsWere.his);
    const hePaused = await viewDevin(settingsWere.mine, { discoverable: false });
    const heNarrowed = await viewDevin(settingsWere.mine, { discoverable: true, ageMin: 18, ageMax: 28 });
    const iNarrowed = await viewDevin({ ageMax: 30 }, settingsWere.his);
    // Devin is a few kilometres away; a one-kilometre limit fails the one
    // filter whose limit is also part of the score.
    const iCloser = await viewDevin({ ageMax: settingsWere.mine.ageMax, maxDistanceKm: 1 }, settingsWere.his);
    await page.evaluate(function (were) {
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, { preferences: were.mine })
        .then(function () { return window.ZC.store.updateUser('devin-alvarez', { preferences: were.his }); });
    }, settingsWere);
    const blames = function (card) { return /Not shown|your current filters/.test(card.notes); };
    t.check('a match\'s card keeps its score and reasons when their own settings would keep them out of your deck, and blames nobody',
      asSeeded.ring && asSeeded.reasons > 0 &&
        [hePaused, heNarrowed].every(function (card) {
          return card.ring && card.reasons === asSeeded.reasons && !blames(card);
        }),
      JSON.stringify({ paused: hePaused, narrowed: heNarrowed, seeded: asSeeded }));
    t.check('and names your filters only when they are what changed, without "Not shown" on a card that is shown',
      [iNarrowed, iCloser].every(function (card) {
        return card.ring && card.reasons > 0 &&
          /your current filters would no longer put them in your deck/.test(card.notes) && !/Not shown/.test(card.notes);
      }),
      JSON.stringify({ distance: iCloser, age: iNarrowed }));

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

    /* ---- a counter the store refuses to clear ---- */

    // Both adapters report a refused `markRead` by resolving false, never by
    // rejecting. The page ignored the answer: it had already zeroed its own copy,
    // so the row read as read and `#unread-badge` dropped while the stored
    // counter — and the nav badge drawn from it — stayed where they were. What
    // asked again was not the reader but the next delivery of the list, which
    // carries the stored count back in; coming back to the tab did not. In
    // firebase mode the refusal makes that delivery itself — the SDK rolls the
    // write back and the list re-delivers the old count — so the page asked
    // again, and again: measured against the emulator, sixty refused writes in
    // four seconds. A refusal is given here the way both adapters give it, and a
    // delivery from another conversation stands in for the rollback.
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const refusing = await page.evaluate(async function () {
      const store = window.ZC.store;
      const me = window.ZC.auth.current.uid;
      const list = await store.getMatches(me);
      const devin = list.filter(function (m) { return /devin/.test(m.otherUid); })[0];
      const sam = list.filter(function (m) { return /sam/.test(m.otherUid); })[0];
      await store.sendMessage(devin.matchId, devin.otherUid, 'waiting to be read ' + Date.now());
      const real = store.markRead;
      window.__zcRefuseRead = true;
      window.__zcReadCalls = 0;
      store.markRead = function () {
        window.__zcReadCalls += 1;
        return window.__zcRefuseRead ? Promise.resolve(false) : real.apply(store, arguments);
      };
      return { devin: devin.matchId, sam: sam ? { matchId: sam.matchId, otherUid: sam.otherUid } : null };
    });
    const readState = function () {
      return page.evaluate(function (matchId) {
        const row = Array.prototype.filter.call(document.querySelectorAll('#match-list .match-row'), function (node) {
          return node.dataset.matchId === matchId;
        })[0];
        const pageBadge = document.getElementById('unread-badge');
        const nav = document.querySelector('[data-badge="matches"]');
        return {
          calls: window.__zcReadCalls,
          row: row ? row.classList.contains('is-unread') : null,
          page: pageBadge.classList.contains('hidden') ? 0 : parseInt(pageBadge.textContent, 10) || 0,
          nav: nav ? parseInt(nav.textContent, 10) || 0 : null
        };
      }, refusing.devin);
    };
    await page.waitForFunction(function () {
      return Array.prototype.some.call(document.querySelectorAll('#match-list .match-row'), function (node) {
        return /devin/.test(node.dataset.matchId) && node.classList.contains('is-unread');
      });
    });
    await openConversation(page, 'Devin');
    await page.waitForTimeout(600);
    const afterRefusal = await readState();
    t.check('a counter the store refuses to clear is still shown as unread, as the nav badge shows it',
      afterRefusal.calls >= 1 && afterRefusal.row === true && afterRefusal.page > 0 && afterRefusal.page === afterRefusal.nav,
      JSON.stringify(afterRefusal));

    // A delivery of the list is not a reason to ask again: in firebase mode the
    // refusal itself produces one. A message in the OTHER conversation makes one.
    if (refusing.sam) {
      await page.evaluate(function (sam) {
        return window.ZC.store.sendMessage(sam.matchId, sam.otherUid, 'meanwhile ' + Date.now());
      }, refusing.sam);
    }
    await page.waitForTimeout(600);
    const afterDelivery = await readState();
    // Coming back to the tab is: a person looking at the conversation again.
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    await page.waitForTimeout(300);
    const afterFocus = await readState();
    t.check('it is asked again when the reader comes back to the tab, and not by every delivery in between',
      !!refusing.sam && afterDelivery.calls === afterRefusal.calls && afterFocus.calls > afterDelivery.calls,
      'calls: ' + afterRefusal.calls + ' after opening, ' + afterDelivery.calls + ' after a delivery, ' +
      afterFocus.calls + ' after a focus');

    // ...and once the store takes it, the row clears and the two badges agree —
    // on the one message still waiting in the other conversation.
    await page.evaluate(function () { window.__zcRefuseRead = false; });
    await page.evaluate(function () { window.dispatchEvent(new Event('focus')); });
    const clearedAll = await page.waitForFunction(function (matchId) {
      const row = Array.prototype.filter.call(document.querySelectorAll('#match-list .match-row'), function (node) {
        return node.dataset.matchId === matchId;
      })[0];
      const badge = document.getElementById('unread-badge');
      const pageCount = badge.classList.contains('hidden') ? 0 : parseInt(badge.textContent, 10) || 0;
      const nav = document.querySelector('[data-badge="matches"]');
      const navCount = nav ? parseInt(nav.textContent, 10) || 0 : 0;
      return !!row && !row.classList.contains('is-unread') && pageCount === navCount;
    }, refusing.devin, { timeout: 3000 }).then(function () { return true; }, function () { return false; });
    const clearedState = await readState();
    t.check('and once the store takes it, the row clears and the page badge and the nav badge agree',
      clearedAll && clearedState.row === false, JSON.stringify(clearedState));

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');

    /* ---- a send that fails after the reader has moved on ---- */

    // In firebase mode a send settles only when the server answers, which with
    // no connection is whenever it comes back, so the reader can be in another
    // conversation by the time a refusal arrives (the match ended meanwhile).
    // The failed text used to go into whichever composer was open, over the
    // draft there, under "Your text is still in the box", and the next Enter
    // sent the first person's words to the second (measured against the
    // emulator). The demo store answers at once, so here the next send is held
    // until this check refuses it, the way a refused Firestore write rejects.
    // Toasts are recorded as they are made: they leave the screen on a timer.
    // The recorder is put in once per page, so a second hold does not record
    // every toast twice.
    const holdNextSend = function () {
      const store = window.ZC.store;
      const realSend = store.sendMessage;
      window.__zcHeld = { sends: [], toasts: [], refuse: null };
      store.sendMessage = function (matchId, from, text) {
        window.__zcHeld.sends.push({ matchId: matchId, text: text });
        store.sendMessage = realSend;
        return new Promise(function (resolve, reject) {
          window.__zcHeld.refuse = function () { reject(new Error('Refused by the e2e suite.')); };
        });
      };
      if (window.__zcToastsRecorded) return;
      window.__zcToastsRecorded = true;
      const realToast = window.ZC.ui.toast;
      window.ZC.ui.toast = function (message) {
        window.__zcHeld.toasts.push(String(message));
        return realToast.apply(window.ZC.ui, arguments);
      };
    };
    await page.evaluate(holdNextSend);
    const MEANT = 'Meant for Devin and nobody else';
    const SAM_DRAFT = 'Half a reply to Sam';
    await openConversation(page, 'Devin');
    const devinId = await page.evaluate(function () { return window.ZC.util.qs('m'); });
    await page.fill('#chat-input', MEANT);
    await page.press('#chat-input', 'Enter');
    await page.waitForFunction(function () { return typeof window.__zcHeld.refuse === 'function'; });
    if (ctx.viewport.key !== 'desktop') await page.click('#chat-back');
    await openConversation(page, 'Sam');
    await page.waitForFunction(function (id) {
      return /Sam/.test(document.getElementById('chat-peer-name').textContent) && window.ZC.util.qs('m') !== id;
    }, devinId);
    await page.fill('#chat-input', SAM_DRAFT);
    await page.evaluate(function () { window.__zcHeld.refuse(); });
    await page.waitForFunction(function () { return !document.getElementById('chat-send').hasAttribute('aria-busy'); });
    const elsewhere = await page.evaluate(function () {
      return {
        open: document.getElementById('chat-peer-name').textContent,
        box: document.getElementById('chat-input').value,
        toasts: window.__zcHeld.toasts.slice()
      };
    });
    t.check('a send refused after the reader opened another conversation leaves that one\'s box alone, and names who it was for',
      elsewhere.box === SAM_DRAFT && elsewhere.toasts.length === 1 && /Devin/.test(elsewhere.toasts[0]),
      JSON.stringify(elsewhere));

    // The words are not dropped either: they go back to the conversation they
    // were written for, the next time it is opened.
    if (ctx.viewport.key !== 'desktop') await page.click('#chat-back');
    await openConversation(page, 'Devin');
    await page.waitForFunction(function (id) { return window.ZC.util.qs('m') === id; }, devinId);
    const backHome = await page.evaluate(function () {
      return { box: document.getElementById('chat-input').value, sends: window.__zcHeld.sends.length };
    });
    t.check('and they are back in the box of the conversation they were written for when it is opened again',
      backHome.box === MEANT && backHome.sends === 1, JSON.stringify(backHome));

    // In their own conversation the words go back ahead of whatever was typed
    // there since, and the box holds 1000 characters. A pair longer than that
    // loses the end of the later text, and the toast used to say "Your text is
    // still in the box" all the same.
    await page.evaluate(holdNextSend);
    await page.fill('#chat-input', MEANT);
    await page.press('#chat-input', 'Enter');
    await page.waitForFunction(function () { return typeof window.__zcHeld.refuse === 'function'; });
    const LONG_SINCE = 'typed while it was sending '.repeat(37);
    await page.fill('#chat-input', LONG_SINCE);
    await page.evaluate(function () { window.__zcHeld.refuse(); });
    await page.waitForFunction(function () { return !document.getElementById('chat-send').hasAttribute('aria-busy'); });
    const overflow = await page.evaluate(function () {
      return { box: document.getElementById('chat-input').value, toasts: window.__zcHeld.toasts.slice() };
    });
    t.check('and when they and what was typed since are more than the box holds, the toast says the end was cut',
      overflow.box === (MEANT + '\n' + LONG_SINCE).slice(0, 1000) && overflow.toasts.length === 1 &&
        /cut/.test(overflow.toasts[0]),
      JSON.stringify({ boxLength: overflow.box.length, boxStart: overflow.box.slice(0, 40), toasts: overflow.toasts }));

    // And when their conversation has ended, there is no box of theirs left:
    // its row leaves the list, and it can never be opened again. Both orders
    // happen. Against the emulator the refusal arrived first and the list's
    // delivery of the ending a moment later. A list that delivers first is
    // the other order. Either way the last thing the reader is told is that the
    // message was not sent because its conversation has ended, and the open
    // conversation's draft is left alone. Each order runs in a session of its
    // own, because each ends one of the two seeded matches, and this page
    // needs both of them below.
    const endedElsewhere = async function (refuseFirst) {
      const s = await h.openSession(page.context().browser(), ctx.viewport);
      const p = s.page;
      let seen = null;
      try {
        await h.signIn(p, ctx.base);
        await p.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
        await p.waitForSelector('#match-list .match-row');
        await p.evaluate(holdNextSend);
        await openConversation(p, 'Devin');
        const leaving = await p.evaluate(function () { return window.ZC.util.qs('m'); });
        await p.fill('#chat-input', 'Meant for Devin, who is leaving');
        await p.press('#chat-input', 'Enter');
        await p.waitForFunction(function () { return typeof window.__zcHeld.refuse === 'function'; });
        if (ctx.viewport.key !== 'desktop') await p.click('#chat-back');
        await openConversation(p, 'Sam');
        await p.waitForFunction(function (id) {
          return /Sam/.test(document.getElementById('chat-peer-name').textContent) && window.ZC.util.qs('m') !== id;
        }, leaving);
        await p.fill('#chat-input', SAM_DRAFT);
        const refuse = async function () {
          await p.evaluate(function () { window.__zcHeld.refuse(); });
          await p.waitForFunction(function () { return !document.getElementById('chat-send').hasAttribute('aria-busy'); });
        };
        const unmatch = async function () {
          await p.evaluate(function (id) {
            return window.ZC.store.unmatch(id, window.ZC.auth.current.uid);
          }, leaving);
          await p.waitForFunction(function (id) {
            return !Array.prototype.some.call(document.querySelectorAll('#match-list .match-row'), function (row) {
              return row.dataset.matchId === id;
            });
          }, leaving);
        };
        if (refuseFirst) {
          await refuse();
          await unmatch();
        } else {
          await unmatch();
          await refuse();
        }
        seen = await p.evaluate(function () {
          return {
            open: document.getElementById('chat-peer-name').textContent,
            box: document.getElementById('chat-input').value,
            toasts: window.__zcHeld.toasts.slice()
          };
        });
      } finally {
        await s.context.close();
      }
      const last = seen ? seen.toasts[seen.toasts.length - 1] || '' : '';
      return {
        told: !!seen && seen.box === SAM_DRAFT && /Devin/.test(last) && /not sent/.test(last) && /ended/.test(last),
        seen: seen,
        clean: s.errors.length === 0,
        detail: JSON.stringify(seen && { last: last, toasts: seen.toasts.length, box: seen.box, open: seen.open }) +
          (s.errors.length ? ' | ' + s.errors.slice(0, 2).join(' | ') : '')
      };
    };
    const refusedThenEnded = await endedElsewhere(true);
    t.check('a send refused elsewhere whose conversation then ends is said not to have been sent, after the refusal',
      refusedThenEnded.clean && refusedThenEnded.told && refusedThenEnded.seen.toasts.length === 2,
      refusedThenEnded.detail);
    const endedThenRefused = await endedElsewhere(false);
    t.check('and one whose conversation ended before the refusal is said not to have been sent, with no box promised',
      endedThenRefused.clean && endedThenRefused.told && endedThenRefused.seen.toasts.length === 1,
      endedThenRefused.detail);

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await openConversation(page, 'Sam');

    /* ---- a restored page keeps the open conversation live ---- */

    // `pagehide` tears down the message listener, the stamp ticker and the list
    // subscription; the back-forward cache then restores the document with all
    // its JavaScript state intact and re-runs none of the boot path. The
    // handler put back the list and nothing else, so `state.active` survived
    // while `state.unsubscribe` did not: the chat log froze permanently — no
    // inbound message and not even the reader's own — while the list beside it
    // kept updating and `markRead` kept clearing the unread count for messages
    // they could not see.
    //
    // The events are dispatched rather than driven through real back/forward
    // navigation on purpose: whether headless Chromium actually bfcaches a page
    // is its policy and changes between versions, but `persisted: true` is the
    // contract the handler is written against, and that is the thing worth
    // pinning.
    //
    // The browser keeps what was in the box through a restore, and the page
    // used to empty it: re-opening the conversation reset the composer.
    const KEPT = 'Half a reply written before leaving for another page';
    await page.fill('#chat-input', KEPT);
    const restoredText = await page.evaluate(async function () {
      window.dispatchEvent(new Event('pagehide'));
      let show;
      try {
        show = new PageTransitionEvent('pageshow', { persisted: true });
      } catch (err) {
        show = new Event('pageshow');
        Object.defineProperty(show, 'persisted', { value: true });
      }
      window.dispatchEvent(show);

      const store = window.ZC.store;
      const me = window.ZC.auth.current.uid;
      const matchId = window.ZC.util.qs('m');
      const list = await store.getMatches(me);
      const target = list.filter(function (m) { return m.matchId === matchId; })[0];
      const text = 'sent after a restore ' + Date.now();
      await store.sendMessage(matchId, target.otherUid, text);
      return text;
    });
    const reachedThread = await page.waitForFunction(function (want) {
      const log = document.getElementById('chat-log');
      return !!log && log.textContent.indexOf(want) !== -1;
    }, restoredText, { timeout: 3000 }).then(function () { return true; }, function () { return false; });

    t.check('a conversation restored from the back-forward cache is still live',
      reachedThread,
      reachedThread
        ? 'a message sent after the restore reached the open thread'
        : 'nothing reached the thread in 3s — the restore put the list back and left ' +
          'the message listener dead');
    const keptBox = await page.inputValue('#chat-input');
    t.check('and it keeps what was typed in its box',
      keptBox === KEPT, 'the box holds ' + JSON.stringify(keptBox));

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

    // The list beside an ended conversation — on desktop, on screen — still has
    // stamps to keep. Ending used to stop the ticker along with the listener.
    const endedTickers = await page.evaluate(function () { return window.__zcStampTickers().length; });
    t.check('and the list beside it keeps its stamps ticking',
      endedTickers === 1, endedTickers + ' live one-minute ticker(s) after the conversation ended');

    // An ended conversation has no listener for a restore to put back, and
    // re-opening it found no match to open, so the restore closed it and
    // emptied the box the ended conversation had just promised to keep.
    const endedRestore = await page.evaluate(function () {
      window.dispatchEvent(new Event('pagehide'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      return {
        typed: document.getElementById('chat-input').value,
        ended: !!document.getElementById('chat-ended'),
        tickers: window.__zcStampTickers().length
      };
    });
    t.check('and a restore from the back-forward cache leaves the ended conversation, and what was typed, where they were',
      endedRestore.typed === typed && endedRestore.ended && endedRestore.tickers === 1, JSON.stringify(endedRestore));

    /* ---- and the NEXT conversation is not left disabled ---- */

    // Ending a conversation disables its composer, and only `closeMatch` used to
    // turn it back on. On desktop the list stays beside the thread, so the
    // ordinary next move is to click another conversation — which goes through
    // `openMatch`, not `closeMatch`, and opened it with a textarea nobody could
    // type into. Mobile cannot reach this: the list is hidden while a thread is
    // open, so getting back to it means pressing Back, which is `closeMatch`.
    //
    // Sending a message is the check rather than reading `disabled`: the point
    // is that the person can talk, and a field that is enabled but still refused
    // by a stale flag would pass a property check.
    if (ctx.viewport.key === 'desktop' && after.rows > 0) {
      await page.click('#match-list .match-row');
      await page.waitForFunction(function (endedId) {
        const params = new URLSearchParams(location.search);
        return params.get('m') && params.get('m') !== endedId && !document.getElementById('chat-ended');
      }, openId, { timeout: 3000 });
      const next = await page.evaluate(function () {
        return { inputDisabled: document.getElementById('chat-input').disabled };
      });
      const reply = 'the next conversation still works ' + Date.now();
      let delivered = false;
      if (!next.inputDisabled) {
        await page.fill('#chat-input', reply);
        await page.click('#chat-send');
        delivered = await page.waitForFunction(function (needle) {
          return document.getElementById('chat-log').textContent.indexOf(needle) !== -1;
        }, reply, { timeout: 3000 }).then(function () { return true; }, function () { return false; });
      }
      t.check('opening another conversation after one ended can be typed into and sent from',
        !next.inputDisabled && delivered,
        next.inputDisabled ? 'the textarea is still disabled' : (delivered ? 'sent' : 'typed, but nothing was delivered'));
    }

    /* ---- a press on a row outlasts a delivery that changes nothing ---- */

    // `renderList` runs on every delivery of the live list, and some deliveries
    // change nothing it draws: in firebase mode the other person reading what
    // was sent rewrites their own counter on the shared match document, and
    // that alone is a delivery (measured against the emulator). Rebuilding the
    // rows under a held press detaches the row the press began on, and the
    // click never arrives; the list's fingerprint is what lets such a delivery
    // leave the rows alone. The demo stream only fires when this account's own
    // row changes, so the delivery is made here by handing the page the list
    // it already has.
    await page.addInitScript(function () {
      const wrap = function () {
        if (!window.ZC || !window.ZC.store || window.ZC.store.__redelivering) return;
        window.ZC.store.__redelivering = true;
        const real = window.ZC.store.listenMatchViews;
        window.ZC.store.listenMatchViews = function (uid, onViews, onError) {
          return real.call(window.ZC.store, uid, function (views) {
            window.__zcRedeliver = function () { onViews(JSON.parse(JSON.stringify(views))); };
            return onViews(views);
          }, onError);
        };
      };
      document.addEventListener('DOMContentLoaded', wrap);
      window.setTimeout(wrap, 0);
      window.setTimeout(wrap, 50);
    });
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await page.waitForFunction(function () { return typeof window.__zcRedeliver === 'function'; });
    const pressed = page.locator('#match-list .match-row').first();
    const pressedId = await pressed.getAttribute('data-match-id');
    const pressBox = await pressed.boundingBox();
    await page.mouse.move(pressBox.x + pressBox.width / 2, pressBox.y + pressBox.height / 2);
    await page.mouse.down();
    const rowSurvived = await page.evaluate(function () {
      const before = document.querySelector('#match-list .match-row');
      window.__zcRedeliver();
      return document.querySelector('#match-list .match-row') === before;
    });
    await page.mouse.up();
    const pressOpened = await page.waitForFunction(function (id) {
      return new URLSearchParams(window.location.search).get('m') === id &&
        !document.getElementById('chat').classList.contains('hidden');
    }, pressedId, { timeout: 2000 }).then(function () { return true; }, function () { return false; });
    t.check('a press on a conversation outlasts a delivery of the list that changes nothing on it',
      rowSurvived && pressOpened,
      (rowSurvived ? 'the row was left alone' : 'the row was rebuilt under the press') + ', and the click ' +
      (pressOpened ? 'opened the conversation' : 'never arrived'));

    /* ---- a send refused in a conversation that ended while it was held ---- */

    // The usual reason a held write is refused: the other side ended the match
    // first. The ended conversation disables its box and its Send button and
    // keeps what was typed since the send, and the refusal then put the sent
    // words back in that box over it. The send's own clean-up also re-enabled
    // Send from what was in the box, without asking whether the conversation
    // was still there to send to. The send is held as above; the unmatch is
    // the real store's.
    const heldInEnded = await page.evaluate(function () {
      const store = window.ZC.store;
      const realSend = store.sendMessage;
      window.__zcHeld = { refuse: null };
      store.sendMessage = function () {
        store.sendMessage = realSend;
        return new Promise(function (resolve, reject) {
          window.__zcHeld.refuse = function () { reject(new Error('Refused by the e2e suite.')); };
        });
      };
      return window.ZC.util.qs('m');
    });
    const LAST_WORDS = 'Sent just as the match ended';
    await page.fill('#chat-input', LAST_WORDS);
    await page.press('#chat-input', 'Enter');
    await page.waitForFunction(function () { return typeof window.__zcHeld.refuse === 'function'; });
    const TYPED_SINCE = 'and typed while it was sending';
    await page.fill('#chat-input', TYPED_SINCE);
    await page.evaluate(function (matchId) {
      return window.ZC.store.unmatch(matchId, window.ZC.auth.current.uid);
    }, heldInEnded);
    await page.waitForSelector('#chat-ended', { timeout: 3000 });
    await page.evaluate(function () { window.__zcHeld.refuse(); });
    await page.waitForFunction(function () { return !document.getElementById('chat-send').hasAttribute('aria-busy'); });
    const endedRefusal = await page.evaluate(function () {
      return {
        box: document.getElementById('chat-input').value,
        boxDisabled: document.getElementById('chat-input').disabled,
        sendDisabled: document.getElementById('chat-send').disabled
      };
    });
    t.check('a send refused after its conversation ended puts the words back ahead of what was typed since',
      endedRefusal.box === LAST_WORDS + '\n' + TYPED_SINCE, JSON.stringify(endedRefusal.box));
    t.check('and leaves the ended conversation\'s box and Send button disabled',
      endedRefusal.boxDisabled && endedRefusal.sendDisabled, JSON.stringify(endedRefusal));

    /* ---- "Yesterday" is the calendar's yesterday, on the days clocks change ---- */

    // The separator used to take "yesterday" as whatever day it was 24 hours
    // ago. The day clocks go forward is short, so just after it that lands two
    // days back: in New York at 00:30 on Monday 9 March 2026, "Yesterday"
    // headed Saturday's messages and Sunday's got a date. The same time of day
    // one date back is no better where the hour skipped is the last of its day.
    // Nuuk went from 23:00 on Saturday 28 March 2026 straight to Sunday, so at
    // 23:30 on Sunday "Saturday, 23:30" does not exist and resolves to Sunday
    // 00:30, and Saturday's messages lose their "Yesterday".
    // Each case is a session of its own: an installed clock stays installed for
    // the life of its context, the time zone is set on that context, and Sam's
    // thread in this one was ended above. One viewport: the arithmetic is the
    // same at both, and the panes play no part in it. Sam's seeded thread starts
    // empty, so every message in a fresh one is one this check sent, at a time
    // it chose. The time zone and the instant are read back too: without them
    // either case would be an ordinary day, where every formula is right.
    if (ctx.viewport.key === 'desktop') {
      // Sends one message to Sam at noon on Saturday and one at noon on Sunday,
      // then opens the thread at `view` and reads the separator over each.
      const daysSeenAt = async function (timezoneId, saturdayNoon, sundayNoon, view) {
        const dst = await h.openSession(page.context().browser(), ctx.viewport);
        const cdp = await dst.context.newCDPSession(dst.page);
        let days = null;
        try {
          await cdp.send('Emulation.setTimezoneOverride', { timezoneId: timezoneId });
          await dst.page.clock.install({ time: new Date(saturdayNoon) });
          await h.signIn(dst.page, ctx.base);
          await dst.page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
          await dst.page.waitForSelector('#match-list .match-row');
          const sendAs = function (text) {
            return dst.page.evaluate(async function (body) {
              const store = window.ZC.store;
              const me = window.ZC.auth.current.uid;
              const sam = (await store.getMatches(me)).filter(function (m) { return /sam/.test(m.otherUid); })[0];
              await store.sendMessage(sam.matchId, sam.otherUid, body);
              return sam.matchId;
            }, text);
          };
          await sendAs('sent on Saturday');
          await dst.page.clock.setSystemTime(new Date(sundayNoon));
          const samId = await sendAs('sent on Sunday');
          await dst.page.clock.setSystemTime(new Date(view));
          await dst.page.goto(ctx.base + '/matches.html?m=' + encodeURIComponent(samId), { waitUntil: 'domcontentloaded' });
          await dst.page.waitForFunction(function () {
            return document.querySelectorAll('#chat-log .msg').length === 2;
          });
          days = await dst.page.evaluate(function () {
            const now = new Date();
            const heading = {};
            let current = '';
            Array.prototype.forEach.call(document.getElementById('chat-log').children, function (node) {
              if (node.classList.contains('chat-day')) current = node.textContent.trim();
              const text = node.querySelector && node.querySelector('.msg-text');
              if (text) heading[text.textContent.trim()] = current;
            });
            return {
              now: now.toString().slice(0, 21),
              offset: now.getTimezoneOffset(),
              saturday: heading['sent on Saturday'],
              sunday: heading['sent on Sunday']
            };
          });
        } finally {
          await cdp.detach().catch(function () {});
          await dst.context.close();
        }
        return { days: days, detail: JSON.stringify(days) + (dst.errors.length ? ' | ' + dst.errors.slice(0, 2).join(' | ') : ''), clean: dst.errors.length === 0 };
      };

      // New York: noon on Saturday 7 March (EST), noon on Sunday (EDT by then),
      // and half past midnight on Monday, when 24 hours ago was Saturday, 23:30.
      const ny = await daysSeenAt('America/New_York',
        '2026-03-07T17:00:00Z', '2026-03-08T16:00:00Z', '2026-03-09T04:30:00Z');
      t.check('at 00:30 the night after clocks go forward, "Yesterday" heads the day before, not the day before that',
        ny.clean && !!ny.days && /^Mon Mar 09 2026 00:/.test(ny.days.now) && ny.days.offset === 240 &&
          ny.days.sunday === 'Yesterday' && !!ny.days.saturday && ny.days.saturday !== 'Yesterday',
        ny.detail);

      // Nuuk: noon on Saturday 28 March (UTC-2), noon on Sunday (UTC-1 since
      // midnight), and 23:30 on Sunday.
      const nuuk = await daysSeenAt('America/Nuuk',
        '2026-03-28T14:00:00Z', '2026-03-29T13:00:00Z', '2026-03-30T00:30:00Z');
      t.check('and at 23:30 the day after clocks skip from 23:00 to midnight, "Yesterday" still heads the day before',
        nuuk.clean && !!nuuk.days && /^Sun Mar 29 2026 23:/.test(nuuk.days.now) && nuuk.days.offset === 60 &&
          nuuk.days.saturday === 'Yesterday' && nuuk.days.sunday === 'Today',
        nuuk.detail);

      // A conversation left open across midnight. Separators were labelled
      // once, when drawn, and the one-minute ticker rewrote every stamp but
      // them: after midnight the evening's messages still sat under "Today",
      // and the first message of the new day drew a second "Today" below it.
      // Tokyo keeps no daylight saving, so this night is an ordinary one.
      const night = await h.openSession(page.context().browser(), ctx.viewport);
      const nightCdp = await night.context.newCDPSession(night.page);
      let nightLog = null;
      try {
        await nightCdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
        // 23:50 in Tokyo on Sunday 18 October 2026.
        await night.page.clock.install({ time: new Date('2026-10-18T14:50:00Z') });
        await h.signIn(night.page, ctx.base);
        await night.page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
        await night.page.waitForSelector('#match-list .match-row');
        await openConversation(night.page, 'Sam');
        await night.page.fill('#chat-input', 'sent ten minutes before midnight');
        await night.page.press('#chat-input', 'Enter');
        await night.page.waitForFunction(function () {
          return document.querySelectorAll('#chat-log .msg').length === 1;
        });
        // Twenty minutes with the conversation open: the ticker runs twenty times.
        await night.page.clock.runFor(20 * 60 * 1000);
        await night.page.evaluate(async function () {
          const store = window.ZC.store;
          const matchId = window.ZC.util.qs('m');
          const sam = (await store.getMatches(window.ZC.auth.current.uid))
            .filter(function (m) { return m.matchId === matchId; })[0];
          await store.sendMessage(matchId, sam.otherUid, 'answered ten minutes after');
        });
        await night.page.waitForFunction(function () {
          return document.querySelectorAll('#chat-log .msg').length === 2;
        });
        nightLog = await night.page.evaluate(function () {
          return {
            now: new Date().toString().slice(0, 21),
            log: Array.prototype.map.call(document.getElementById('chat-log').children, function (node) {
              if (node.classList.contains('chat-day')) return '[' + node.textContent.trim() + ']';
              const text = node.querySelector('.msg-text');
              return text ? text.textContent.trim() : node.className;
            })
          };
        });
      } finally {
        await nightCdp.detach().catch(function () {});
        await night.context.close();
      }
      t.check('a conversation left open past midnight moves its evening under "Yesterday" and draws one "Today"',
        night.errors.length === 0 && !!nightLog && /^Mon Oct 19 2026 00:1/.test(nightLog.now) &&
          JSON.stringify(nightLog.log) === JSON.stringify(
            ['[Yesterday]', 'sent ten minutes before midnight', '[Today]', 'answered ten minutes after']),
        JSON.stringify(nightLog) + (night.errors.length ? ' | ' + night.errors.slice(0, 2).join(' | ') : ''));
    }
  }
};
