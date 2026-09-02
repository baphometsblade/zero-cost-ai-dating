/* The premium simulation, which is the one page in this app that makes an
   ethical claim rather than a technical one: that it is honest about taking
   no money. The README calls it "an honest, non-deceptive plan comparison",
   Limitations says "no payment is processed", and until now nothing checked
   either sentence. subscription.js was the only page script in the project
   with no test of any kind.

   That mattered twice over. The disclosure is a promise to whoever runs this,
   and it is exactly the kind of copy that gets softened later by someone
   making the page "convert better". And the same page is the entitlement
   switch: `plan` gates rewind, the who-liked-you list, the adaptive term in
   the ranking engine and the daily limits, so a bug here is not cosmetic.

   So this checks the words AND the behaviour, and in particular that
   declining the confirmation changes nothing — a dialog you cannot say no to
   is not consent. */
'use strict';

/** Phrases the disclosure must actually contain, not merely gesture at. */
const DISCLOSURE = ['no payment', 'no card', 'simulation'];

module.exports = {
  title: 'The premium simulation: honest about it, and correct about it',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);
    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#subscription-page');

    /* ---- the disclosure itself ---- */

    const notice = ((await page.locator('#simulation-notice').textContent()) || '').toLowerCase();
    const missing = DISCLOSURE.filter(function (phrase) { return notice.indexOf(phrase) === -1; });
    t.check('the page says plainly that nothing is charged',
      missing.length === 0,
      missing.length ? 'missing from the notice: ' + missing.join(', ') : 'all present');

    // A page that takes no money has no business asking for any. This is the
    // check that would fail first if the simulation ever grew a real checkout
    // without the docs catching up.
    const paymentFields = await page.evaluate(function () {
      const suspect = /card|cvv|cvc|expiry|billing|iban|account.?number/i;
      return Array.prototype.filter.call(
        document.querySelectorAll('input, select, textarea'),
        function (el) {
          return suspect.test((el.name || '') + ' ' + (el.id || '') + ' ' +
            (el.placeholder || '') + ' ' + (el.getAttribute('autocomplete') || ''));
        }
      ).length;
    });
    t.check('and collects no payment details anywhere on it',
      paymentFields === 0, paymentFields + ' payment-ish field(s)');

    const cta = ((await page.locator('#premium-cta').textContent()) || '').toLowerCase();
    t.check('the upgrade button itself says there is no payment',
      cta.indexOf('no payment') !== -1, JSON.stringify(cta.trim()));

    /* ---- declining has to mean declining ---- */

    const planOf = function () {
      return page.evaluate(function () {
        return window.ZC.auth.doc ? window.ZC.auth.doc.plan : null;
      });
    };
    t.check('the account starts on the free plan', (await planOf()) === 'free', String(await planOf()));

    await page.click('#premium-cta');
    await page.waitForSelector('.modal-backdrop .modal-body');
    const dialog = ((await page.locator('.modal-backdrop .modal-body').textContent()) || '').toLowerCase();
    t.check('the confirmation repeats the disclosure rather than assuming it was read',
      dialog.indexOf('no payment') !== -1 || dialog.indexOf('simulat') !== -1,
      JSON.stringify(dialog.trim().slice(0, 80)));

    await h.clickModalAction(page, 'Not now');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    t.check('declining the confirmation leaves the plan alone',
      (await planOf()) === 'free', String(await planOf()));

    /* ---- accepting it, and the entitlement that follows ---- */

    await page.click('#premium-cta');
    await h.clickModalAction(page, 'Switch it on (no payment)');
    await page.waitForFunction(function () {
      return window.ZC.auth.doc && window.ZC.auth.doc.plan === 'premium';
    });
    t.check('accepting it switches the plan on', (await planOf()) === 'premium', 'premium');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#subscription-page');
    await page.waitForFunction(function () { return !!window.ZC.auth.doc; });
    t.check('and it survives a reload, so it was stored rather than shown',
      (await planOf()) === 'premium', String(await planOf()));

    // The point of the switch: the deck has to actually treat the account
    // differently. Checking the stored flag alone would pass even if every
    // gate ignored it.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const budget = ((await page.locator('#usage-hint').textContent()) || '').toLowerCase();
    t.check('the deck reports the account as premium, not just the plan field',
      budget.indexOf('premium') !== -1, JSON.stringify(budget.trim().slice(0, 60)));

    /* ---- and back, because a simulation you cannot leave is worse ---- */

    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#free-cta');
    await page.click('#free-cta');
    await h.clickModalAction(page, 'Switch back to Free');
    await page.waitForFunction(function () {
      return window.ZC.auth.doc && window.ZC.auth.doc.plan === 'free';
    });
    const after = await page.evaluate(function () {
      return { plan: window.ZC.auth.doc.plan, since: window.ZC.auth.doc.planSince };
    });
    t.check('switching back to Free clears the premium stamp as well as the plan',
      after.plan === 'free' && !after.since, JSON.stringify(after));
  }
};
