/* The accessibility this project claims in prose.

   The README says the app "respects `prefers-reduced-motion`" and "is fully
   operable from the keyboard"; docs/ARCHITECTURE.md lists focus-trapping among
   the utilities. All of it was true, and none of it was executed — the deck's
   arrow keys were the only keyboard behaviour any test touched. An audit that
   nothing runs is the same kind of claim this repository spent a round making
   enforceable everywhere else, so here it is, run.

   Writing it found the place where the claim had already stopped being true,
   and the shape of it is worth stating exactly, because the first reading was
   wrong. Opening a conversation repaints the left pane and destroys the row
   the click came from, so focus falls to <body> unless something moves it.
   Something did: one line at the end of openMatch() — guarded by isWide().

   So the desktop was fine and the phone was not, which is the wrong way
   round. On a phone the list is *replaced* by the conversation, so a keyboard
   or switch user was returned to the top of a document whose visible half no
   longer contained their focus at all, with only the live region to tell them
   anything had happened. The guard has been replaced by one that asks whether
   a person actually activated a row — which also stops a `?m=` deep link from
   dropping the caret into a text field on a page somebody merely followed a
   link to. The last two checks here are that fix, and they fail on both
   viewports without it.

   What this spec deliberately does not do is score the pages against a rules
   engine. Every check below is a specific promise made in the documentation or
   a specific way a keyboard user gets stranded — a number out of a hundred
   would be less honest and much harder to act on. */
'use strict';

/** Pages that must each stand on their own for a screen reader. */
const PAGES = ['index.html', 'auth.html', 'dashboard.html', 'profile.html',
  'matches.html', 'settings.html', 'subscription.html'];

/**
 * Describe whatever currently has focus, in terms a failure message can use.
 * @param {Object} page Playwright page
 * @returns {Promise<Object>} tag, accessible-ish name, and where it sits
 */
function activeElement(page) {
  return page.evaluate(function () {
    const node = document.activeElement;
    if (!node || node === document.body) return { tag: 'BODY', isBody: true, name: '' };
    return {
      tag: node.tagName,
      isBody: false,
      id: node.id || '',
      name: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40),
      inModal: !!(node.closest && node.closest('.modal-backdrop')),
      inChat: !!(node.closest && node.closest('#chat-pane'))
    };
  });
}

module.exports = {
  title: 'Accessibility: the promises the docs make, executed',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    /* ---- every page stands on its own ---- */

    const structural = [];
    const unnamed = [];
    for (const name of PAGES) {
      await page.goto(ctx.base + '/' + name, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main, [role="main"]', { timeout: 5000 }).catch(function () {});
      const report = await page.evaluate(function () {
        const out = { main: document.querySelectorAll('main, [role="main"]').length, h1: document.querySelectorAll('h1').length, unnamed: [] };
        // A control nobody can name is a control a screen reader announces as
        // "button". Only visible ones: the pages keep panels in the DOM.
        document.querySelectorAll('button, a[href]').forEach(function (node) {
          if (node.offsetParent === null) return;
          const label = (node.textContent || '').trim() || node.getAttribute('aria-label') || node.getAttribute('title') || '';
          if (!label) out.unnamed.push((node.tagName + '.' + node.className).slice(0, 40));
        });
        document.querySelectorAll('input, select, textarea').forEach(function (node) {
          if (node.type === 'hidden' || node.offsetParent === null) return;
          const label = (node.labels && node.labels.length && (node.labels[0].textContent || '').trim()) ||
            node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || node.getAttribute('title') || '';
          if (!label) out.unnamed.push((node.tagName + '#' + (node.id || node.name)).slice(0, 40));
        });
        // An <img> with no alt attribute at all is announced by its filename;
        // alt="" is the correct way to say "decorative" and passes.
        document.querySelectorAll('img').forEach(function (img) {
          if (img.getAttribute('alt') === null) out.unnamed.push('img[no alt] ' + img.src.slice(-24));
        });
        return out;
      });
      if (report.main !== 1 || report.h1 !== 1) {
        structural.push(name + ' has ' + report.main + ' main / ' + report.h1 + ' h1');
      }
      report.unnamed.forEach(function (item) { unnamed.push(name + ' → ' + item); });
    }

    t.check('every page has exactly one main landmark and one h1',
      structural.length === 0, structural.join('; ') || 'all ' + PAGES.length + ' pages');
    t.check('every visible control, field and image has an accessible name',
      unnamed.length === 0, unnamed.slice(0, 4).join('; ') || 'nothing unnamed across ' + PAGES.length + ' pages');

    /* ---- prefers-reduced-motion ---- */

    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const cardTransition = function () {
      return page.evaluate(function () {
        return getComputedStyle(document.querySelector('#deck-stack .swipe-card')).transitionDuration;
      });
    };
    const moving = await cardTransition();
    t.check('the deck animates by default, so the next check is not vacuous',
      /[1-9]/.test(moving), JSON.stringify(moving));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const stilled = await cardTransition();
    // Not "0s": the stylesheet uses 0.001ms deliberately, because a genuinely
    // zero duration stops transitionend from firing and the code that waits
    // for it would hang. Anything under a frame is the promise being kept.
    const seconds = parseFloat(stilled) || 0;
    t.check('under prefers-reduced-motion the deck stops animating',
      seconds < 0.016, JSON.stringify(stilled));

    const arbitrary = await page.evaluate(function () {
      const probe = document.createElement('div');
      probe.style.transition = 'opacity 400ms';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return value;
    });
    t.check('and the reduction is global, not just the one component anybody remembered',
      (parseFloat(arbitrary) || 0) < 0.016, JSON.stringify(arbitrary));
    await page.emulateMedia({ reducedMotion: null });

    /* ---- the modal: trapped, labelled, escapable, and returned ---- */

    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#premium-cta');
    await page.focus('#premium-cta');
    await page.click('#premium-cta');
    await page.waitForSelector('.modal-backdrop .modal-body');

    const opened = await activeElement(page);
    t.check('opening a dialog moves focus into it',
      opened.inModal === true, JSON.stringify(opened.name));

    const dialog = await page.evaluate(function () {
      const node = document.querySelector('.modal-backdrop .modal');
      const labelledBy = node.getAttribute('aria-labelledby');
      const label = labelledBy ? document.getElementById(labelledBy) : null;
      return {
        role: node.getAttribute('role'),
        modal: node.getAttribute('aria-modal'),
        label: label ? (label.textContent || '').trim() : ''
      };
    });
    t.check('the dialog announces itself as a modal dialog with a name',
      dialog.role === 'dialog' && dialog.modal === 'true' && dialog.label.length > 0,
      JSON.stringify(dialog));

    // Tab further than there are controls: a trap that only holds for one
    // cycle is not a trap, and this is the loop that proves it wraps.
    const escapes = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await activeElement(page);
      if (!where.inModal) escapes.push(i + ': ' + where.tag + ' ' + where.name);
    }
    t.check('focus cannot leave the dialog, however long you hold Tab',
      escapes.length === 0, escapes.slice(0, 3).join('; ') || '12 presses, all inside');

    const backwards = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      const where = await activeElement(page);
      if (!where.inModal) backwards.push(i + ': ' + where.tag + ' ' + where.name);
    }
    t.check('and it holds going backwards too, which is the half that gets forgotten',
      backwards.length === 0, backwards.slice(0, 3).join('; ') || '6 presses, all inside');

    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const returned = await activeElement(page);
    t.check('Escape closes it and focus goes back to the control that opened it',
      returned.id === 'premium-cta', JSON.stringify(returned));

    /* ---- the deck, by keyboard alone ---- */

    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');

    const live = await page.evaluate(function () {
      return Array.prototype.map.call(
        document.querySelectorAll('[aria-live], [role="status"], [role="alert"]'),
        function (node) { return node.id || node.className; }
      );
    });
    t.check('the deck has live regions, so what changes without a page load is spoken',
      live.length >= 2, JSON.stringify(live));

    const card = await page.evaluate(function () {
      const node = document.querySelector('#deck-stack .swipe-card');
      return { tabindex: node.getAttribute('tabindex'), label: node.getAttribute('aria-label') || '' };
    });
    t.check('the card is reachable by keyboard and describes who is on it',
      card.tabindex === '0' && /\d/.test(card.label), JSON.stringify(card));

    // The behaviour that makes the deck usable without a pointer: passing a
    // card must not strand you. The card you were on is removed, so focus has
    // to be moved deliberately or it falls to <body>.
    await page.focus('#deck-stack .swipe-card');
    const before = await activeElement(page);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(function (name) {
      const node = document.querySelector('#deck-stack .swipe-card');
      return node && node.getAttribute('aria-label') !== name;
    }, before.name, { timeout: 5000 });
    const after = await activeElement(page);
    t.check('passing a card by keyboard leaves focus on the next one, not on the document',
      after.isBody === false && after.name !== before.name,
      JSON.stringify(before.name) + ' → ' + JSON.stringify(after.name));

    /* ---- the pane swap that was stranding people ---- */

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.match-row, .new-match');
    const row = await page.$('.match-row');
    if (!row) {
      t.check('a conversation row is present to open', false, 'no .match-row rendered');
    } else {
      await row.focus();
      const fromRow = await activeElement(page);
      t.check('a conversation row takes focus before it is opened',
        fromRow.isBody === false, JSON.stringify(fromRow.name));

      await page.keyboard.press('Enter');
      await page.waitForSelector('#chat-input', { state: 'visible' });
      const inThread = await activeElement(page);
      // The defect this spec was written after: focus fell to <body> here on a
      // phone, because opening repaints the list, destroys the row it came
      // from, and the one line that moved focus onward only ran when both
      // panes were visible.
      t.check('opening a conversation by keyboard puts focus inside the conversation',
        inThread.isBody === false && inThread.inChat === true, JSON.stringify(inThread));

      t.check('and specifically on the composer, which is what you came to do',
        inThread.id === 'chat-input', JSON.stringify(inThread.id));
    }
  }
};
