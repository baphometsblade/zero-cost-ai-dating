/* Editing your own profile, and the settings that change the app around you. */
'use strict';

const MARKER = ' Edited by the e2e suite.';

module.exports = {
  title: 'Profile editing and settings',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    /* ---- profile ---- */
    await page.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    const loaded = await page.evaluate(function () {
      return {
        bio: document.getElementById('input-bio').value,
        name: document.getElementById('input-name').value,
        interests: document.querySelectorAll('#interest-groups input:checked').length
      };
    });
    t.check('the profile form loads the signed-in account', loaded.name.trim().length > 0, loaded.name);
    t.check('the profile loads its existing bio', loaded.bio.length > 0, 'bio chars=' + loaded.bio.length);
    t.check('the profile loads its existing interests', loaded.interests > 0, 'interests=' + loaded.interests);

    await page.fill('#input-bio', loaded.bio + MARKER);
    await page.click('#save-btn');
    await page.waitForFunction(function () {
      return /saved/i.test(document.getElementById('save-status').textContent);
    });
    t.check('saving the profile reports success', true, (await page.textContent('#save-status')).trim());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    const reloadedBio = await page.inputValue('#input-bio');
    t.check('the edit survives a reload', reloadedBio.indexOf(MARKER) !== -1);

    /* ---- settings ---- */
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#theme-group');
    // The radio itself is visually hidden inside its chip, so click the label
    // the way a person does.
    await page.click('label.chip[for="theme-dark"]');
    await page.waitForFunction(function () {
      return document.documentElement.getAttribute('data-theme') === 'dark';
    });
    t.check('choosing dark applies the theme immediately', true);

    await page.click('label.chip[for="theme-light"]');
    await page.waitForFunction(function () {
      return document.documentElement.getAttribute('data-theme') === 'light';
    });
    t.check('choosing light applies the theme immediately', true);

    // The theme is a stored preference, not a per-page toggle.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    t.check('the chosen theme carries to the next page',
      (await page.getAttribute('html', 'data-theme')) === 'light');
  }
};
