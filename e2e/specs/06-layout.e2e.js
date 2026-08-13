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
    return {
      viewportHeight: window.innerHeight,
      scrollHeight: doc.scrollHeight,
      verticalOverflow: doc.scrollHeight - window.innerHeight,
      actionsBottom: actions ? Math.round(actions.getBoundingClientRect().bottom) : null,
      cards: document.querySelectorAll('#deck-stack .swipe-card').length,
      overflowing: overflowing.slice(0, 6)
    };
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

    t.check('the deck renders a stack of cards', deck.cards > 0, 'cards=' + deck.cards);
    t.check('nothing overflows horizontally', deck.overflowing.length === 0, deck.overflowing.join(', '));

    // "The whole deck fits, no scrolling" is a phone contract: the card, the
    // action row and the hint are sized off the viewport height so a thumb
    // never has to scroll to reach them. On a desktop the same screen is a
    // normal document and is allowed to run past the fold.
    if (ctx.viewport.key === 'mobile') {
      t.check('the swipe actions are inside the viewport',
        deck.actionsBottom !== null && deck.actionsBottom <= deck.viewportHeight,
        'actions bottom=' + deck.actionsBottom + ' of ' + deck.viewportHeight);
      t.check('the deck screen does not scroll the page',
        deck.verticalOverflow <= 1,
        'scrollHeight=' + deck.scrollHeight + ' viewport=' + deck.viewportHeight);
    } else {
      t.check('the swipe actions are reachable without a horizontal scroll',
        deck.actionsBottom !== null, 'actions bottom=' + deck.actionsBottom);
    }
  }
};
