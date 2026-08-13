/* Swiping right onto one of the seeded inbound likers must produce the match
   overlay, and its openers must be usable rather than decorative. */
'use strict';

// The demo seed gives you nine inbound likes among thirty-two profiles, so a
// match arrives within a few right swipes — but which swipe depends on the
// ranking, hence the bounded loop rather than a fixed count.
const MAX_SWIPES = 14;

module.exports = {
  title: 'Match burst and icebreakers',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    let swipes = 0;
    let matched = false;
    while (swipes < MAX_SWIPES && !matched) {
      const before = await h.topCardName(page);
      if (!before) break;
      const after = await h.pressDeckKey(page, 'ArrowRight', before);
      swipes += 1;
      matched = after.burst;
    }
    if (!t.check('a right swipe onto a seeded liker raises the match overlay', matched, 'swipes=' + swipes)) return;

    const burst = await page.evaluate(function () {
      const overlay = document.querySelector('.match-burst');
      const lines = Array.prototype.map.call(overlay.querySelectorAll('.icebreaker'), function (node) {
        return node.textContent.trim();
      });
      return {
        modal: overlay.getAttribute('aria-modal') === 'true',
        heading: (overlay.querySelector('h2') || {}).textContent || '',
        lines: lines,
        focusInside: overlay.contains(document.activeElement)
      };
    });
    t.check('the overlay announces the match', /match/i.test(burst.heading), burst.heading.trim());
    t.check('the overlay is a modal dialog holding focus', burst.modal && burst.focusInside);
    t.check('the overlay offers icebreakers', burst.lines.length > 0, 'lines=' + burst.lines.length);
    // A template that leaked its own placeholder would read as a bug to a user.
    const unfilled = burst.lines.filter(function (line) { return /\{[a-z_]+\}/i.test(line); });
    t.check('every icebreaker is fully rendered', unfilled.length === 0, unfilled.join(' | '));

    // Taking an opener must land in the conversation with that text ready to send.
    const chosen = burst.lines[0];
    await page.locator('.match-burst .icebreaker').first().click();
    await page.waitForURL('**/matches.html*');
    await page.waitForSelector('#chat:not(.hidden)');
    const draft = await page.inputValue('#chat-input');
    t.check('the chosen opener arrives pre-filled in the composer', draft === chosen, draft);
  }
};
