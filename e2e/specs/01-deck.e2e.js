/* Landing -> demo sign-in -> the deck, and the keyboard that drives it. */
'use strict';

module.exports = {
  title: 'Deck, scoring and keyboard',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;

    await page.goto(ctx.base + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-cta="demo"]:not(.hidden)');
    t.check('landing offers the demo sign-in', true);

    await page.click('[data-cta="demo"]');
    await page.waitForURL('**/dashboard.html');
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

    /* ---- keyboard swipes advance the deck ---- */
    // A right or up swipe onto someone who already liked you raises the match
    // overlay, which then owns the keyboard — so each step clears it first.
    let name = await h.topCardName(page);
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight']) {
      const before = name;
      const after = await h.pressDeckKey(page, key, before);
      t.check(key + ' advances the deck', after.burst || (after.name && after.name !== before),
        before + ' -> ' + (after.burst ? 'match overlay' : after.name));
      await h.closeBurst(page);
      name = await h.topCardName(page);
    }

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

    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[role="dialog"]', { state: 'detached' });
    const focusAfter = await page.evaluate(function () {
      return document.activeElement ? document.activeElement.id : null;
    });
    t.check('Escape closes the shortcuts modal', true);
    t.check('Escape returns focus to the opener', focusAfter === 'btn-shortcuts', 'activeElement=#' + focusAfter);

    // The "?" key is the documented way in, and it is a separate code path.
    await page.keyboard.press('Shift+Slash');
    await page.waitForSelector('.modal[role="dialog"]');
    t.check('"?" opens the shortcuts modal', true);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[role="dialog"]', { state: 'detached' });
  }
};
