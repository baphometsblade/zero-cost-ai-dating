/* The deck has to fit the phone it was designed for. It stopped fitting once
   already, and nothing in the unit suites can see a layout. */
'use strict';

/**
 * Measure the deck screen: how far the page can scroll, and anything sticking
 * out sideways.
 * @param {Object} page a Playwright Page
 * @returns {Promise<Object>} the measurements
 */
function measureDeck(page) {
  return page.evaluate(function () {
    const doc = document.scrollingElement;
    const vw = document.documentElement.clientWidth;
    const overflowing = [];
    Array.prototype.forEach.call(document.querySelectorAll('body *'), function (node) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // A one-pixel allowance: sub-pixel layout rounds outwards.
      if (rect.right > vw + 1 || rect.left < -1) {
        overflowing.push(node.tagName.toLowerCase() + '.' + String(node.className || '').trim().split(/\s+/)[0]);
      }
    });
    const actions = document.querySelector('.deck-actions');
    const row = actions ? actions.getBoundingClientRect() : null;
    return {
      viewportHeight: window.innerHeight,
      scrollHeight: doc.scrollHeight,
      verticalOverflow: doc.scrollHeight - window.innerHeight,
      // Null for a row with no box as well as for a missing one: a row that is
      // display:none reports a bottom edge of 0, which is inside any viewport.
      // Measured: the phone check below passed that way, "actions bottom=0".
      actionsBottom: row && row.height > 0 ? Math.round(row.bottom) : null,
      cards: document.querySelectorAll('#deck-stack .swipe-card').length,
      overflowing: overflowing.slice(0, 6)
    };
  });
}

/**
 * Try each swipe action the way a desktop visitor reaches it: scroll the page
 * vertically until the button is in view — this screen may run past the fold
 * on a desktop — and then ask what is under its centre, with the page never
 * scrolled sideways. A button counts as reachable only when it is rendered,
 * lies within the viewport's width, and is itself what a click there would
 * land on.
 * @param {Object} page a Playwright Page
 * @returns {Promise<{buttons:number, unreachable:string[]}>} each failure named
 */
function measureReach(page) {
  return page.evaluate(function () {
    const vw = document.documentElement.clientWidth;
    const buttons = document.querySelectorAll('.deck-actions .action-btn');
    const unreachable = [];
    Array.prototype.forEach.call(buttons, function (button) {
      // 'instant', because the stylesheet asks for smooth scrolling and the
      // measurement below must see where the scroll ends, not where it starts.
      const top = button.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ left: 0, top: Math.max(0, top - window.innerHeight / 2), behavior: 'instant' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const where = '#' + button.id + ' at ' + Math.round(rect.left) + '..' + Math.round(rect.right) +
        ' x ' + Math.round(rect.top) + '..' + Math.round(rect.bottom);
      if (rect.width === 0 || rect.height === 0) {
        unreachable.push('#' + button.id + ' not rendered');
      } else if (rect.left < -1 || rect.right > vw + 1 || y < 0 || y > window.innerHeight) {
        // The same one-pixel allowance measureDeck makes.
        unreachable.push(where);
      } else {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !button.contains(hit)) {
          unreachable.push(where + ' under ' +
            (hit ? hit.tagName.toLowerCase() + '.' + String(hit.className || '').trim().split(/\s+/)[0] : 'nothing'));
        }
      }
    });
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    return { buttons: buttons.length, unreachable: unreachable };
  });
}

module.exports = {
  title: 'Deck fits the viewport',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);
    // The stack animates in; measure it settled rather than mid-transition.
    await page.waitForFunction(function () {
      return document.querySelectorAll('#deck-stack .swipe-card').length > 0;
    });
    const deck = await measureDeck(page);

    // More than one: the wait above has already seen one, so "> 0" could not
    // fail here. And the cards behind the top one are part of the layout being
    // measured — they peek out below it, by the allowance the action row's
    // padding keeps clear of the buttons.
    t.check('the deck renders a stack of cards', deck.cards > 1, 'cards=' + deck.cards);
    t.check('nothing overflows horizontally', deck.overflowing.length === 0, deck.overflowing.join(', '));

    // "The whole deck fits, no scrolling" is a phone contract: the card, the
    // action row and the hint are sized off the viewport height so a thumb
    // never has to scroll to reach them. On a desktop the same screen is a
    // normal document and is allowed to run past the fold.
    if (ctx.viewport.key === 'mobile') {
      t.check('the swipe actions are inside the viewport',
        deck.actionsBottom !== null && deck.actionsBottom <= deck.viewportHeight,
        deck.actionsBottom === null
          ? 'the action row is not rendered'
          : 'actions bottom=' + deck.actionsBottom + ' of ' + deck.viewportHeight);
      t.check('the deck screen does not scroll the page',
        deck.verticalOverflow <= 1,
        'scrollHeight=' + deck.scrollHeight + ' viewport=' + deck.viewportHeight);
    } else {
      // This used to be `actionsBottom !== null`, which, measured as the row's
      // bottom then was, only said .deck-actions is in dashboard.html — and it
      // always is, so it passed with the row hidden, invisible or pushed off to
      // the side. Measured: with the row set to display:none at the desktop
      // breakpoint, every desktop check in this spec stayed green. Whether a
      // pointer can actually get to each button is what the name promises.
      const reach = await measureReach(page);
      t.check('the swipe actions are reachable without a horizontal scroll',
        reach.buttons > 0 && reach.unreachable.length === 0,
        reach.buttons + ' buttons' + (reach.unreachable.length ? '; unreachable: ' + reach.unreachable.join(', ') : ''));
    }
  }
};
