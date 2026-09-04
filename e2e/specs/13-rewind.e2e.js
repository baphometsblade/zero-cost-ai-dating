/* Rewind, and the one thing it must never do.

   The deck refuses to rewind across a match — "you two already have a
   conversation" — and it decides that from `entry.matched`, a flag stamped on
   the history entry when the swipe was saved and never looked at again. It is
   true only for the swipe that *completed* the pair.

   The case it cannot see is the ordinary one. You like somebody who has not
   liked you back: no match, flag false, correctly. They like you back a minute
   later while your card is still the last thing in your history. Now the match
   exists for both of you, either of you can already have written in it, and
   the flag still says there is nothing there. The old code deleted the match
   and every message in it, told nobody, and the other person's conversation
   simply disappeared.

   So the refusal moved into the store, where the database can be asked, and
   this spec drives the whole thing through the browser: swipe, have them like
   back through the real store exactly as their own device would, then press
   the button. Nothing may be deleted, and the page has to say why — in the
   toast and in the live region, because a refusal nobody perceives is the same
   as no refusal at all.

   The happy path is here too. A guard that refused everything would pass every
   check below on its own.

   Note the two waits on storage. A swipe is written *after* its card animates
   away, and the deck declines to rewind one that is still in flight, so
   pressing the button as soon as the deck moves is a race this spec would lose
   intermittently and blame on something else. */
'use strict';

/**
 * Wait until the signed-in account has exactly `count` outbound swipes stored.
 * @param {Object} page a Playwright Page
 * @param {string} uid the signed-in account
 * @param {number} count how many swipes to wait for
 * @returns {Promise<void>}
 */
function waitForSwipes(page, uid, count) {
  return page.waitForFunction(function (args) {
    return window.ZC.store.getSwipes(args.uid).then(function (list) {
      return list.length === args.count;
    });
  }, { uid: uid, count: count });
}

/** The uids this account has swiped on, in storage order. */
function swipeTargets(page, uid) {
  return page.evaluate(function (id) {
    return window.ZC.store.getSwipes(id).then(function (list) {
      return list.map(function (swipe) { return swipe.to; });
    });
  }, uid);
}

module.exports = {
  title: 'Rewind puts a swipe back, and refuses to take a match down',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    // Rewind is premium-gated, and that gate is spec 11's subject rather than
    // this one's. The plan is set through the store as a fixture: canSpend
    // re-reads the user document on every check, so the deck picks it up with
    // no reload and no dependency on the upgrade page's markup.
    const setup = await page.evaluate(async function () {
      const uid = window.ZC.auth.current.uid;
      await window.ZC.store.updateUser(uid, { plan: 'premium' });
      const budget = await window.ZC.store.canSpend(uid, 'rewinds');
      return { uid: uid, allowed: !!budget.allowed };
    });
    t.check('the account has rewinds to spend, so the button is reachable at all',
      setup.allowed, 'uid=' + setup.uid);

    // Not zero: the demo seed gives this account two conversations, which it
    // could only have by having liked those two people.
    const seeded = (await swipeTargets(page, setup.uid)).length;

    /* ---- 1. a swipe nobody answered comes back ------------------------- */

    // A pass, deliberately: it can never create a match, so this half stays a
    // test of the rewind rather than of who happens to be in the seed.
    const passed = await h.topCardName(page);
    await h.pressDeckKey(page, 'ArrowLeft', passed);
    await waitForSwipes(page, setup.uid, seeded + 1);

    await page.waitForSelector('#btn-rewind:not([disabled])');
    await page.click('#btn-rewind');
    await page.waitForFunction(function (name) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const on = card && card.querySelector('.swipe-name');
      return !!on && on.textContent.trim() === name;
    }, passed);
    t.check('rewinding a pass puts that card back on top', (await h.topCardName(page)) === passed, passed);

    const left = (await swipeTargets(page, setup.uid)).length;
    t.check('and the swipe itself is gone from storage', left === seeded,
      left + ' stored, ' + seeded + ' before the pass');

    /* ---- 2. a swipe that has since become a match does not -------------- */

    // Right-swipe until one lands without a match overlay. Nine of the seeded
    // profiles have already liked this account and match on contact, and those
    // are the case the deck's own flag already covers correctly.
    let liked = null;
    let them = null;
    for (let attempt = 0; attempt < 8 && them === null; attempt += 1) {
      const known = await swipeTargets(page, setup.uid);
      const before = await h.topCardName(page);
      const moved = await h.pressDeckKey(page, 'ArrowRight', before);
      await waitForSwipes(page, setup.uid, known.length + 1);
      if (moved.burst) { await h.closeBurst(page); continue; }
      const now = await swipeTargets(page, setup.uid);
      them = now.filter(function (uid) { return known.indexOf(uid) === -1; })[0] || null;
      liked = before;
    }
    t.check('a like landed on somebody who had not already liked back', !!them, String(them));
    // Everything below needs somebody to have liked. Stopping cleanly rather
    // than throwing on a null uid keeps the failure readable — and the missing
    // checks still fail the run, because the suite total is claimed.
    if (!them) return;

    // Their device, a minute later. Nothing about the deck's state changes:
    // the history entry still says this swipe made no match, because when it
    // was written that was true.
    const matchId = await page.evaluate(async function (args) {
      const out = await window.ZC.store.recordSwipe(args.them, args.uid, 'like');
      return (out && out.matchId) || null;
    }, { uid: setup.uid, them: them });
    t.check('they like back, and the pair now have a match', !!matchId, String(matchId));

    await page.waitForSelector('#btn-rewind:not([disabled])');
    await page.click('#btn-rewind');
    // Wait for either outcome: the refusal appearing, or the deck putting the
    // card back, which is what the old code did. Waiting only for the refusal
    // would report a regression as a twenty-second timeout on a selector,
    // under the name "spec ran to completion" — the checks below say what
    // actually happened instead.
    await page.waitForFunction(function (name) {
      if (document.querySelector('.toast-warn')) return true;
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const on = card && card.querySelector('.swipe-name');
      return !!on && on.textContent.trim() === name;
    }, liked);

    const refusal = await page.evaluate(function () {
      const toasts = document.querySelectorAll('.toast-warn');
      const status = document.getElementById('deck-status');
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const on = card && card.querySelector('.swipe-name');
      return {
        toast: toasts.length ? (toasts[toasts.length - 1].textContent || '').trim() : '',
        status: status ? (status.textContent || '').trim() : '',
        top: on ? on.textContent.trim() : null
      };
    });
    t.check('the refusal is shown, and says a match is the reason',
      /match/i.test(refusal.toast) && /liked you back/i.test(refusal.toast), refusal.toast);
    t.check('and announced to a screen reader, not only drawn on the screen',
      /match/i.test(refusal.status), refusal.status);
    t.check('the card is not put back on a deck it no longer belongs on',
      refusal.top !== liked, String(refusal.top));

    const survived = await page.evaluate(async function (args) {
      const swipes = await window.ZC.store.getSwipes(args.uid);
      return {
        match: !!(await window.ZC.store.getMatch(args.matchId, args.uid)),
        mine: swipes.filter(function (swipe) { return swipe.to === args.them; }).length
      };
    }, { uid: setup.uid, them: them, matchId: matchId });

    // The half that belongs to somebody who never touched this button.
    t.check('the match survives the refused rewind', survived.match, 'matches/' + matchId);
    t.check('so does the swipe it would have deleted', survived.mine === 1, survived.mine + ' swipe(s)');
  }
};
