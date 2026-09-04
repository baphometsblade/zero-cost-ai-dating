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

    /* ---- a photo link the rules would refuse, refused here instead ---- */

    // `firestore.rules` bounds the photo list by the total characters across all
    // six, because rules can measure a joined list and cannot walk one. That makes
    // the form the only place a person can be told *which* link is the problem: a
    // save that trips the rule comes back as `permission-denied` naming no field.
    // So the refusal has to happen here, and it has to say why.
    const badgeBefore = (await page.textContent('#photo-badge')).trim();
    await page.fill('#input-photo', 'https://example.com/' + 'x'.repeat(1200) + '.png');
    await page.click('#btn-add-photo');
    const photoError = (await page.textContent('#error-photo')).trim();

    t.check('an over-long photo link is refused by the form', photoError.length > 0, photoError);

    t.check('and the message says how far over it is, not just that it is over',
      /\d+ characters too long/.test(photoError), photoError);

    const badgeAfterBad = (await page.textContent('#photo-badge')).trim();
    t.check('and the link is not added',
      badgeAfterBad === badgeBefore, badgeBefore + ' → ' + badgeAfterBad);

    // The control. A cap that refuses everything is a broken field, not a cap, and
    // every check above would read the same against one.
    await page.fill('#input-photo', 'https://example.com/ordinary.png');
    await page.click('#btn-add-photo');
    const badgeAfterGood = (await page.textContent('#photo-badge')).trim();
    t.check('but a link of ordinary length still goes on',
      badgeAfterGood !== badgeBefore, badgeBefore + ' → ' + badgeAfterGood);

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
