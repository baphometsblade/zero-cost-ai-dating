/* Deleting the account. It is the one flow that cannot be walked back, so the
   guard in front of it and the emptiness behind it both matter. */
'use strict';

module.exports = {
  title: 'Account deletion',
  viewports: ['mobile'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#delete-account');
    t.check('the delete button starts disabled',
      await page.locator('#delete-account').isDisabled());

    // The gate is an exact phrase, and it must actually be exact.
    await page.fill('#delete-confirm', 'delete please');
    t.check('a near-miss phrase leaves the button disabled',
      await page.locator('#delete-account').isDisabled());

    await page.fill('#delete-confirm', 'DELETE');
    t.check('the exact phrase unlocks the button',
      await page.locator('#delete-account').isEnabled());

    await page.click('#delete-account');
    await page.waitForURL('**/index.html');
    t.check('deleting the account returns you to the landing page', true, page.url().split('/').pop());

    // Nothing may survive: the guard on a signed-in page has to turn you away.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/auth\.html/);
    t.check('the deleted account can no longer reach the deck', true, page.url().split('/').pop());
  }
};
