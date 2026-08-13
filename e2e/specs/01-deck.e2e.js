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
