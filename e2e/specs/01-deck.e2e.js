/* Landing -> demo sign-in -> the deck, and the keyboard that drives it. */
'use strict';

/**
 * Wait for `selector` to reach `state`, and answer rather than throw.
 *
 * Three checks in this spec used to record a literal `true` straight after a
 * wait for the thing they name. That shape cannot fail. The wait had no bound
 * of its own, only the session's twenty-second default, and running out of it
 * throws; the runner records the throw as "spec ran to completion", so the
 * check that names the regression never prints at all. Measured with the demo
 * button left hidden, Escape left inert and "?" left inert in turn. Answered
 * here instead, the outcome is something a check can say FAIL about.
 * @param {Object} page a Playwright Page
 * @param {string} selector what to wait for
 * @param {string} state 'visible' or 'detached'
 * @returns {Promise<boolean>} whether it got there within five seconds
 */
function reached(page, selector, state) {
  return page.waitForSelector(selector, { state: state, timeout: 5000 })
    .then(function () { return true; }, function () { return false; });
}

/** The uid and the name on the deck's top card; empty strings when there is none. */
function topCard(page) {
  return page.evaluate(function () {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    const name = card && card.querySelector('.swipe-name');
    return { uid: (card && card.dataset.uid) || '', name: name ? name.textContent.trim() : '' };
  });
}

/**
 * Whether the deck moves off the card `uid` within five seconds: another card
 * on top, or none left. Answered rather than thrown, for the reason `reached`
 * gives.
 * @param {Object} page a Playwright Page
 * @param {string} uid the card that was on top
 * @returns {Promise<boolean>}
 */
function movedOff(page, uid) {
  return page.waitForFunction(function (was) {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    return !card || card.dataset.uid !== was;
  }, uid, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
}

/**
 * The decision the signed-in account has stored on `uid`, looked for until
 * five seconds have passed; null when there is none by then.
 *
 * The polling happens inside the page because `page.waitForFunction` cannot
 * wait on the store. A predicate that returns a Promise counts as true the
 * first time it is called, so the wait settles on that single read and its
 * timeout never applies. Measured: a value set 800 ms later came back as null
 * after 59 ms, and with the demo store's swipe write delayed by 150 ms — a
 * latency, not a regression — the version of the key checks below that waited
 * that way failed all three.
 * @param {Object} page a Playwright Page
 * @param {string} me the signed-in account
 * @param {string} uid the person swiped on
 * @returns {Promise<string|null>} 'pass', 'like' or 'super', or null
 */
function storedAction(page, me, uid) {
  return page.evaluate(function (args) {
    const deadline = Date.now() + 5000;
    function poll() {
      return window.ZC.store.getSwipes(args.me).then(function (list) {
        const swipe = list.filter(function (item) { return item.to === args.uid; })[0];
        if (swipe) return swipe.action;
        if (Date.now() > deadline) return null;
        return new Promise(function (resolve) { window.setTimeout(resolve, 50); }).then(poll);
      });
    }
    return poll();
  }, { me: me, uid: uid });
}

module.exports = {
  title: 'Deck, scoring and keyboard',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;

    await page.goto(ctx.base + '/index.html', { waitUntil: 'domcontentloaded' });
    // The button ships with .hidden, and decorateLanding takes it off only
    // where a demo session is possible.
    const offered = await reached(page, '[data-cta="demo"]:not(.hidden)', 'visible');
    const cta = await page.evaluate(function () {
      const button = document.querySelector('[data-cta="demo"]');
      if (!button) return 'no demo button on the page';
      return '"' + button.textContent.trim() + '"' + (button.classList.contains('hidden') ? ', still hidden' : '');
    });
    // Everything after this starts from that button.
    if (!t.check('landing offers the demo sign-in', offered, cta)) return;

    await page.click('[data-cta="demo"]');
    await page.waitForURL(h.pageUrl('dashboard'));
    await page.waitForSelector('#deck-stack .swipe-card');

    const card = await page.evaluate(function () {
      const top = document.querySelector('#deck-stack .swipe-card');
      const score = top.querySelector('.match-score-value');
      return {
        name: (top.querySelector('.swipe-name') || {}).textContent || '',
        score: score ? score.textContent.trim() : null,
        reasons: top.querySelectorAll('.reason').length,
        usage: (document.getElementById('usage-hint') || {}).textContent || ''
      };
    });
    t.check('demo sign-in reaches the dashboard with a card', card.name.trim().length > 0, card.name.trim());
    t.check('the card carries a match score', /^\d{1,3}$/.test(String(card.score)), 'score=' + card.score);
    t.check('the card explains itself with reasons', card.reasons > 0, 'reasons=' + card.reasons);
    t.check('the usage hint names the daily like budget', /likes/i.test(card.usage), card.usage.trim());

    /* ---- the like count drops as the card leaves, not when the write lands ---- */

    // `remainingOf` subtracts a `reserved` counter that `commit` bumps the moment
    // a swipe is committed, so the hint can drop before the write has landed —
    // which is what `updateUsageHint`'s comment claims. Nothing on the committed
    // path repainted it, so the number sat at its old value until `persistSwipe`
    // finished and `refreshBudgets` came back. Read synchronously right after the
    // key, with no wait: a check that polled would be satisfied by the late
    // repaint this exists to stop relying on.
    // The write is slowed to two seconds first, and that is what makes this a
    // check rather than decoration. The counter is read once the deck has
    // advanced, and in demo mode the write lands before that — so the late
    // repaint through `refreshBudgets` produced the same number, and a first
    // version of this check passed against a build with the fix removed.
    // With `recordSwipe` held open, the only thing that can have moved the
    // counter is the reservation.
    await page.evaluate(function () {
      const store = window.ZC.store;
      const real = store.recordSwipe.bind(store);
      window.__zcRealRecordSwipe = store.recordSwipe;
      store.recordSwipe = function () {
        const args = arguments;
        return new Promise(function (resolve) { window.setTimeout(resolve, 2000); })
          .then(function () { return real.apply(null, args); });
      };
    });

    const readLikes = function () {
      return page.evaluate(function () {
        const m = /(\d+) of (\d+) likes left/.exec(document.getElementById('usage-hint').textContent || '');
        return m ? Number(m[1]) : null;
      });
    };
    const likesBefore = await readLikes();
    const liked = await topCard(page);
    // Pressed directly rather than through `pressDeckKey`, whose wait throws
    // when the deck does not move. That throw came before every check that
    // names a key, so an ArrowRight that did nothing, or a keyboard handler
    // that ignored every key, was reported only as "spec ran to completion".
    // Measured, both.
    await page.keyboard.press('ArrowRight');
    const moved = await movedOff(page, liked.uid);
    const likesAfter = await readLikes();
    await h.closeBurst(page);

    t.check('a like drops the counter under the deck immediately, not when the write lands',
      moved && likesBefore !== null && likesAfter === likesBefore - 1,
      moved
        ? likesBefore + ' -> ' + likesAfter + ' likes left, with the swipe write still in ' +
          'flight — only the reservation can have moved it'
        : 'ArrowRight left ' + (liked.name || 'no card') + ' on top; ' +
          likesBefore + ' -> ' + likesAfter + ' likes left');

    // Put it back, and let the held write finish: everything after this drives the
    // deck at its ordinary speed, and a store left wrapped times the rest out.
    await page.evaluate(function () {
      window.ZC.store.recordSwipe = window.__zcRealRecordSwipe;
    });
    await page.waitForTimeout(2200);

    /* ---- keyboard swipes advance the deck ---- */
    // A right or up swipe onto someone who already liked you raises the match
    // overlay, which then owns the keyboard — so each step clears it first,
    // BEFORE its key. The held like above is one of those on this seed: its
    // overlay goes up during the wait just before this loop, and a key pressed
    // under it does nothing.
    //
    // Not pressed through `pressDeckKey`, whose wait — "a match overlay is up,
    // or the top card changed" — was this check's entire condition, so the
    // check could only print PASS, and that leftover overlay satisfied it before
    // the key had done anything. Measured: "ArrowLeft advances the deck" passed,
    // as "Theo L.25 -> match overlay", against a build whose ArrowLeft did
    // nothing, and the whole spec stayed green with ArrowLeft liking instead of
    // passing. So each key is checked by what it leaves behind: its own
    // decision stored against the card that was on top, and another card there.
    const me = await page.evaluate(function () { return window.ZC.auth.current.uid; });
    const decisions = { ArrowLeft: 'pass', ArrowUp: 'super', ArrowRight: 'like' };
    const words = { pass: 'a pass', super: 'a super like', like: 'a like' };
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight']) {
      await h.closeBurst(page);
      const before = await topCard(page);
      await page.keyboard.press(key);
      // A swipe is written after its card has gone, so the store is looked at
      // until the deadline, and "nothing stored" is an answer the check
      // reports rather than a throw.
      const stored = await storedAction(page, me, before.uid);
      const after = await topCard(page);
      const burst = (await page.locator('.match-burst').count()) > 0;
      t.check(key + ' advances the deck with ' + words[decisions[key]],
        before.uid !== '' && stored === decisions[key] && after.uid !== before.uid,
        (before.name || 'no card') + ' -> ' + (after.name || 'no card') + (burst ? ' and a match overlay' : '') +
        ', stored for ' + (before.name || 'nobody') + ': ' + (stored || 'nothing'));
    }
    await h.closeBurst(page);

    /* ---- a swipe that lands but cannot finish ---- */

    // recordSwipe writes the swipe and then goes looking for a match, so a
    // failure can arrive after the decision is already stored. The deck used to
    // read every failure as "the swipe is not stored" and put the card back —
    // which invites a second, contradictory decision that the store silently
    // drops, because a recorded swipe stands.
    await page.evaluate(function () {
      const real = window.ZC.store.recordSwipe;
      window.__zcRealRecordSwipe = real;
      window.ZC.store.recordSwipe = async function () {
        await real.apply(window.ZC.store, arguments);
        const err = new Error('Failed to get document because the client is offline.');
        err.code = 'unavailable';
        err.swipeStored = true;
        throw err;
      };
    });

    const stranded = await h.topCardName(page);

    // Pressed directly rather than through pressDeckKey, which waits for the top
    // card to change: the failure path being tested *puts the card back*, and on
    // the demo store it does so fast enough to win that race — so the helper
    // would time out before any check ran, reporting a regression as "spec ran
    // to completion" rather than as the thing that regressed. It did exactly
    // that the first two times this was written.
    await page.keyboard.press('ArrowLeft');

    // Wait for whichever answer the deck gives — the two differ only in their
    // words, and waiting for one of them turns a regression into a twenty-second
    // selector timeout reported as "spec ran to completion" instead of as the
    // check that means something. Which is what it did, the first time.
    const said = await page.waitForFunction(function () {
      const toasts = Array.prototype.map.call(document.querySelectorAll('.toast'), function (node) {
        return (node.textContent || '').trim();
      }).filter(function (text) { return /saved|did not save/i.test(text); });
      return toasts.length ? toasts[toasts.length - 1] : null;
    }).then(function (handle) { return handle.jsonValue(); });

    t.check('a swipe that saved is not reported as lost',
      !/did not save/i.test(said) && /saved/i.test(said), said);

    t.check('and the card it was aimed at does not come back',
      (await h.topCardName(page)) !== stranded, stranded + ' -> ' + (await h.topCardName(page)));

    // The deck renders a stack, not one card, so a card put back into the queue
    // would sit behind the top one and resurface on the next advance. The
    // exiting card is excluded rather than waited out: it is still in the DOM
    // while its animation runs, and counting it made this check red for the
    // wrong reason the first time it was written.
    const requeued = await page.evaluate(function (name) {
      return Array.prototype.map.call(
        document.querySelectorAll('#deck-stack .swipe-card:not([data-exiting]) .swipe-name'),
        function (node) { return node.textContent.trim(); }
      );
    }, stranded);
    t.check('nor anywhere else in the stack',
      requeued.indexOf(stranded) === -1, 'stack: ' + JSON.stringify(requeued));

    await page.evaluate(function () {
      window.ZC.store.recordSwipe = window.__zcRealRecordSwipe;
      delete window.__zcRealRecordSwipe;
    });
    await h.closeBurst(page);

    /* ---- the shortcuts modal ---- */
    await page.click('#btn-shortcuts');
    await page.waitForSelector('.modal[role="dialog"]');
    const opened = await page.evaluate(function () {
      const dialog = document.querySelector('.modal[role="dialog"]');
      const title = dialog.querySelector('.modal-title');
      return {
        modal: dialog.getAttribute('aria-modal') === 'true',
        labelled: !!(title && title.id && dialog.getAttribute('aria-labelledby') === title.id),
        focusInside: dialog.contains(document.activeElement)
      };
    });
    t.check('the shortcuts modal is a labelled dialog', opened.modal && opened.labelled, JSON.stringify(opened));
    t.check('focus moves into the shortcuts modal', opened.focusInside);
    const shortcutsTitle = (await page.textContent('.modal[role="dialog"] .modal-title')).trim();

    await page.keyboard.press('Escape');
    const closed = await reached(page, '.modal[role="dialog"]', 'detached');
    const focusAfter = await page.evaluate(function () {
      return document.activeElement ? document.activeElement.id : null;
    });
    const escaped = t.check('Escape closes the shortcuts modal', closed, closed ? '' : 'still open after Escape');
    t.check('Escape returns focus to the opener', focusAfter === 'btn-shortcuts', 'activeElement=#' + focusAfter);
    // With the dialog still up, the one below would be found before "?" did anything.
    if (!escaped) return;

    // The "?" key is the documented way in, and it is a separate code path.
    // Told apart by its title, because any dialog at all satisfied the wait
    // this check used to follow.
    await page.keyboard.press('Shift+Slash');
    const asked = await reached(page, '.modal[role="dialog"]', 'visible');
    const askedTitle = asked ? (await page.textContent('.modal[role="dialog"] .modal-title')).trim() : '';
    t.check('"?" opens the shortcuts modal', asked && askedTitle === shortcutsTitle,
      asked ? 'title=' + askedTitle : 'no dialog opened');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[role="dialog"]', { state: 'detached' });
  }
};
