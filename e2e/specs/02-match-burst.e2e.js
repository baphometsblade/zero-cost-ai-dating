/* Swiping right onto one of the seeded inbound likers must produce the match
   overlay, and its openers must be usable rather than decorative. The overlay
   goes up when the like's write answers, not when the like is made, so it is
   also made to arrive at two moments that gap leaves room for: in the middle
   of the next card's drag, and while the keyboard-shortcuts dialog is open. */
'use strict';

// The demo seed gives you nine inbound likes among thirty-two profiles, so a
// match arrives within a few right swipes — but which swipe depends on the
// ranking, hence the bounded loop rather than a fixed count.
const MAX_SWIPES = 14;

/** The uid on the deck's top card, or null when there is none. */
function topUid(page) {
  return page.evaluate(function () {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    return card ? card.dataset.uid || null : null;
  });
}

/**
 * Pass until somebody who has already liked this account is on top of the
 * deck, and answer with their uid; null when the deck runs out first.
 * @param {Object} page a Playwright Page
 * @param {Object} h the harness
 * @returns {Promise<string|null>}
 */
async function likerOnTop(page, h) {
  const likers = await page.evaluate(function () {
    return window.ZC.store.getLikesReceived(window.ZC.auth.current.uid).then(function (list) {
      return list.map(function (doc) { return doc.uid; });
    });
  });
  for (let i = 0; i < 20; i += 1) {
    const uid = await topUid(page);
    if (!uid || likers.indexOf(uid) !== -1) return uid;
    await h.pressDeckKey(page, 'ArrowLeft', await h.topCardName(page));
  }
  return null;
}

/**
 * Hold every swipe write until the spec opens the gate, the way the network
 * holds it in firebase mode: against the emulators with a 150 ms round trip,
 * the overlay for a like went up 0.9 to 1.1 seconds after the next card had
 * come up, measured twice, which is time enough to be dragging that card.
 * A gate rather than a delay, so that what happens before the answer and what
 * happens after it are decided by the spec and not by a race.
 * `window.__zcSwipeAnswered` turns true once a held write has answered; the
 * deck's own handling of that answer runs in the same task, so it is done by
 * the time anything outside the page can see the flag.
 * @param {Object} page a Playwright Page
 * @returns {Promise<void>}
 */
function holdSwipeWrites(page) {
  return page.evaluate(function () {
    const store = window.ZC.store;
    const real = window.__zcRealRecordSwipe || store.recordSwipe;
    let open = null;
    const gate = new Promise(function (resolve) { open = resolve; });
    window.__zcRealRecordSwipe = real;
    window.__zcOpenSwipeGate = open;
    window.__zcSwipeAnswered = false;
    store.recordSwipe = function () {
      const args = arguments;
      return gate.then(function () { return real.apply(store, args); }).then(function (out) {
        window.__zcSwipeAnswered = true;
        return out;
      });
    };
  });
}

/** Put the real swipe write back. */
function releaseSwipeWrites(page) {
  return page.evaluate(function () {
    if (window.__zcOpenSwipeGate) window.__zcOpenSwipeGate();
    if (window.__zcRealRecordSwipe) window.ZC.store.recordSwipe = window.__zcRealRecordSwipe;
    delete window.__zcRealRecordSwipe;
    delete window.__zcOpenSwipeGate;
  });
}

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
    await page.waitForURL(h.pageUrl('matches'));
    await page.waitForSelector('#chat:not(.hidden)');
    const draft = await page.inputValue('#chat-input');
    t.check('the chosen opener arrives pre-filled in the composer', draft === chosen, draft);

    /* ---- the overlay arrives while the next card is being dragged ---- */

    // The deck moves on the moment a like is committed, and the overlay goes up
    // only when the write answers, so somebody can already be dragging the next
    // card when it does. The release then landed on a deck that cannot commit
    // under an overlay, and nothing put the card back: it stayed where the drag
    // left it, tilted and stamped "Like", with no swipe stored. A drag far
    // enough to commit is started, the held like is let through, and the
    // pointer comes up under the overlay.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const me = await page.evaluate(function () { return window.ZC.auth.current.uid; });
    const dragLiker = await likerOnTop(page, h);
    if (!t.check('somebody who already liked this account can be brought to the top of the deck',
      !!dragLiker, String(dragLiker))) return;

    await holdSwipeWrites(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(function (was) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      return !!card && card.dataset.uid !== was;
    }, dragLiker, { timeout: 5000 });
    const dragged = await page.evaluate(function () {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      card.scrollIntoView({ block: 'center' });
      const box = card.getBoundingClientRect();
      return { uid: card.dataset.uid, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    });
    await page.mouse.move(dragged.x, dragged.y);
    await page.mouse.down();
    for (let i = 1; i <= 15; i += 1) await page.mouse.move(dragged.x + i * 12, dragged.y);
    // Proof the drag is live before the overlay arrives: a card already at
    // rest when the pointer comes up would pass the check below by itself.
    const midDrag = await page.evaluate(function (uid) {
      const card = document.querySelector('#deck-stack .swipe-card[data-uid="' + uid + '"]');
      const stamp = card && card.querySelector('.swipe-stamp.is-visible');
      return { moved: !!card && card.style.transform !== '', stamp: stamp ? stamp.textContent : null };
    }, dragged.uid);
    await page.evaluate(function () { window.__zcOpenSwipeGate(); });
    const overlaid = await page.waitForSelector('.match-burst', { timeout: 5000 })
      .then(function () { return true; }, function () { return false; });
    await page.mouse.up();
    const released = await page.evaluate(function (uid) {
      const card = document.querySelector('#deck-stack .swipe-card[data-uid="' + uid + '"]:not([data-exiting])');
      const stamp = card && card.querySelector('.swipe-stamp.is-visible');
      return {
        onTop: !!card && card === document.querySelector('#deck-stack .swipe-card:not([data-exiting])'),
        transform: card ? card.style.transform : null,
        stamp: stamp ? stamp.textContent : null
      };
    }, dragged.uid);
    await h.closeBurst(page);
    await releaseSwipeWrites(page);
    const draggedStored = await page.evaluate(function (args) {
      return window.ZC.store.getSwipes(args.me).then(function (list) {
        return list.some(function (swipe) { return swipe.to === args.uid; });
      });
    }, { me: me, uid: dragged.uid });
    t.check('a drag released under the match overlay springs back unstamped, and nothing is stored for it',
      midDrag.moved && midDrag.stamp === 'Like' && overlaid && released.onTop &&
        released.transform === '' && released.stamp === null && !draggedStored,
      JSON.stringify({ midDrag: midDrag, overlay: overlaid, released: released, stored: draggedStored }));

    /* ---- the overlay arrives while the shortcuts dialog is open ---- */

    // It used to open over the dialog and leave the dialog's focus trap
    // holding the keyboard. Escape closed the dialog and handed the focus to
    // the card underneath, where Escape reaches only the deck — which stands
    // down while an overlay is up — so the overlay could not be closed from
    // the keyboard at all, short of a Tab through every control behind it.
    const modalLiker = await likerOnTop(page, h);
    if (!t.check('and a second one, for the shortcuts dialog', !!modalLiker, String(modalLiker))) return;
    await holdSwipeWrites(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(function (was) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      return !!card && card.dataset.uid !== was;
    }, modalLiker, { timeout: 5000 });
    await page.keyboard.press('Shift+Slash');
    const asked = await page.waitForSelector('.modal-backdrop', { timeout: 5000 })
      .then(function () { return true; }, function () { return false; });
    await page.evaluate(function () { window.__zcOpenSwipeGate(); });
    await page.waitForFunction(function () { return window.__zcSwipeAnswered === true; }, null, { timeout: 5000 });
    const layers = function () {
      return page.evaluate(function () {
        const burst = document.querySelector('.match-burst');
        return {
          dialog: !!document.querySelector('.modal-backdrop'),
          burst: !!burst,
          focusInBurst: !!burst && burst.contains(document.activeElement)
        };
      });
    };
    const answered = await layers();
    // The Escape is held rather than pressed: a second keydown before the
    // keyup is sent with `repeat` set, the way the operating system repeats a
    // key held down. The first one closes the dialog and raises the overlay,
    // and the repeat used to close the overlay too, before anybody had seen
    // its openers.
    await page.keyboard.down('Escape');
    const firstEscape = await layers();
    await page.keyboard.down('Escape');
    const heldEscape = await layers();
    await page.keyboard.up('Escape');
    t.check('a match that lands under the shortcuts dialog waits for it to close, then takes the focus',
      asked && answered.dialog && !answered.burst && !firstEscape.dialog && firstEscape.burst && firstEscape.focusInBurst,
      JSON.stringify({ dialogOpened: asked, whenTheMatchLanded: answered, afterEscape: firstEscape }));
    t.check('and the Escape that closed the dialog, held down, leaves the overlay up with the focus in it',
      firstEscape.burst && !heldEscape.dialog && heldEscape.burst && heldEscape.focusInBurst,
      JSON.stringify({ afterEscape: firstEscape, afterItsRepeat: heldEscape }));
    // And Escape closes it wherever the focus is. A click on its heading, where
    // nothing can take the focus, leaves the focus on <body>, and a handler on
    // the overlay itself never hears an Escape pressed there.
    if (heldEscape.burst) await page.click('.match-burst h2');
    const clicked = await page.evaluate(function () { return document.activeElement === document.body; });
    await page.keyboard.press('Escape');
    const secondEscape = await layers();
    t.check('and Escape closes the overlay, even once a click on its text has put the focus on the page',
      firstEscape.burst && clicked && !secondEscape.burst,
      JSON.stringify({ afterEscape: firstEscape, focusOnThePageAfterTheClick: clicked, afterTheNextEscape: secondEscape }));
    await releaseSwipeWrites(page);
  }
};
