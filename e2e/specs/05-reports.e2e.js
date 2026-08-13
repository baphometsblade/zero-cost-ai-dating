/* Reporting someone from a conversation, seeing the report in Settings, and
   taking it back — the whole loop, because a report you cannot retract is a
   different product from the one the docs describe. */
'use strict';

const DETAILS = 'Filed by the e2e suite; safe to ignore.';

module.exports = {
  title: 'Reporting a user and retracting it',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    const subject = (await page.locator('#match-list .match-row .match-row-name').first().textContent()).trim();
    await page.locator('#match-list .match-row').first().click();
    await page.waitForSelector('#chat:not(.hidden)');

    /* ---- file the report ---- */
    await page.click('#chat-menu');
    await h.clickModalAction(page, 'Report');
    await page.waitForSelector('.modal-backdrop select.select');
    const reasons = await page.locator('.modal-backdrop select.select option').count();
    t.check('the report dialog offers the store\'s reason list', reasons > 1, 'reasons=' + reasons);

    await page.selectOption('.modal-backdrop select.select', { index: 1 });
    const reason = await page.inputValue('.modal-backdrop select.select');
    await page.fill('.modal-backdrop textarea.textarea', DETAILS);
    await h.clickModalAction(page, 'Send report');

    // Reporting offers to block as well; decline, so the conversation stays
    // and the retraction below has something to undo.
    await page.waitForSelector('.modal-backdrop .modal-title');
    t.check('reporting offers to block as well',
      /^Block /.test((await page.textContent('.modal-backdrop .modal-title')).trim()));
    await h.clickModalAction(page, 'Cancel');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });

    /* ---- it shows up in Settings ---- */
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#reports-list li');
    const listed = await page.evaluate(function () {
      const items = document.querySelectorAll('#reports-list li');
      return { count: items.length, text: items.length ? items[0].textContent : '' };
    });
    t.check('the report appears in Settings', listed.count === 1, 'rows=' + listed.count);
    t.check('the report names who and why',
      listed.text.indexOf(subject) !== -1 && listed.text.indexOf(DETAILS) !== -1,
      'reason=' + reason);

    /* ---- and can be taken back ---- */
    await page.locator('#reports-list li button').first().click();
    await h.clickModalAction(page, 'Retract it');
    await page.waitForFunction(function () {
      return document.querySelectorAll('#reports-list li').length === 0;
    });
    const status = await page.evaluate(function () {
      return document.getElementById('reports-status').textContent.trim();
    });
    t.check('retracting empties the list and says so', /have not reported/i.test(status), status);

    const remaining = await page.evaluate(function () {
      return window.ZC.store.getMyReports(window.ZC.auth.current.uid).then(function (list) { return list.length; });
    });
    t.check('the retraction reaches the store, not just the DOM', remaining === 0, 'stored=' + remaining);
  }
};
