/* Reporting someone from a conversation, seeing the report in Settings, and
   taking it back — the whole loop, because a report you cannot retract is a
   different product from the one the docs describe. Then the other branch the
   report dialog offers: accepting the block, which has to unmatch first and
   only then block, so a failed unmatch can never leave someone blocked behind
   a UI that said nothing went through. */
'use strict';

const DETAILS = 'Filed by the e2e suite; safe to ignore.';

/**
 * Wait for the confirm dialog whose body contains `needle`, then take it.
 * Accepting the block raises two dialogs with the same title and the same
 * button — the report's follow-up and endMatch's own confirmation — so they
 * are told apart by their wording rather than by waiting for a gap between
 * them that the DOM never actually shows.
 * @param {Object} page a Playwright Page
 * @param {Object} h the harness
 * @param {string} needle a phrase unique to the dialog being answered
 * @returns {Promise<void>}
 */
async function confirmBlock(page, h, needle) {
  await page.waitForFunction(function (text) {
    const body = document.querySelector('.modal-backdrop .modal-body');
    return !!body && body.textContent.indexOf(text) !== -1;
  }, needle);
  await h.clickModalAction(page, 'Block and unmatch');
}

module.exports = {
  title: 'Reporting a user, retracting it, and blocking',
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

    /* ---- a filing that fails must not also take away the block ---- */

    // The catch used to `return`, so the one person whose report did not go through
    // was also the one denied the protective action they could still take. Nothing in
    // the suite reached this branch, because the store's report write does not fail on
    // its own — so the failure is injected at the facade, which is the seam both
    // adapters share.
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await page.locator('#match-list .match-row').first().click();
    await page.waitForSelector('#chat:not(.hidden)');
    // matches.js logs the rejection, which is the correct behaviour and would
    // otherwise fail this spec's own zero-console-error check. Declared narrowly and
    // closed again below, so nothing else can hide inside the window.
    ctx.session.expectConsoleError(/Could not file the report/);
    await page.evaluate(function () {
      window.ZC.store.reportUser = function () {
        return Promise.reject(new Error('That report could not be filed.'));
      };
    });
    await page.click('#chat-menu');
    await h.clickModalAction(page, 'Report');
    await page.waitForSelector('.modal-backdrop select.select');
    await page.selectOption('.modal-backdrop select.select', { index: 1 });
    await page.fill('.modal-backdrop textarea.textarea', DETAILS);
    await h.clickModalAction(page, 'Send report');

    // The toast is read BEFORE the dialog wait, not after: toasts fade, and with the
    // early `return` restored the dialog wait burns five seconds first, so a check that
    // read it afterwards would fail for the wrong reason and say nothing useful.
    await page.waitForSelector('.toast-host .toast');
    const failToast = await page.evaluate(function () {
      const host = document.querySelector('.toast-host');
      return host ? host.textContent.trim() : '';
    });
    t.check('a failed filing says so rather than claiming the report went through',
      /could not be filed/i.test(failToast), failToast);

    // Bounded, and the absence is the finding: with the early `return` back in place
    // the dialog never opens, and an unbounded wait would report that as a 20-second
    // timeout on "spec ran to completion" rather than as the check that names it.
    const offered = await page.waitForSelector('.modal-backdrop .modal-title', { timeout: 5000 })
      .then(function () { return true; }, function () { return false; });
    const offerTitle = offered ? (await page.textContent('.modal-backdrop .modal-title')).trim() : '';
    t.check('a report that could not be filed still offers the block',
      offered && /^Block /.test(offerTitle),
      offered ? offerTitle : 'no dialog opened — the failure branch returned early, so the ' +
        'one person whose report did not go through is also the one denied the block');
    if (offered) {
      await h.clickModalAction(page, 'Cancel');
      await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    }
    ctx.session.expectConsoleError(null);
    // No reload here: the block below navigates to matches.html itself, and a fresh
    // document is what drops the injected `reportUser` along with everything else.

    /* ---- the other branch: report, then accept the block ---- */
    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');

    // The seed ships two conversations; this one takes the other, so the
    // subject above keeps the state the checks above described. The uid comes
    // from the store because the row markup carries a match id, not a person.
    const target = await page.evaluate(function (avoid) {
      return window.ZC.store.getMatches(window.ZC.auth.current.uid).then(function (list) {
        const pick = list.filter(function (match) {
          return ((match.other && match.other.displayName) || '').trim() !== avoid;
        })[0];
        return pick ? { uid: pick.otherUid, name: (pick.other.displayName || '').trim() } : null;
      });
    }, subject);
    if (!t.check('a second seeded conversation is there to block', !!target, 'subject=' + subject)) return;

    await page.locator('#match-list .match-row', { hasText: target.name }).first().click();
    await page.waitForSelector('#chat:not(.hidden)');
    await page.click('#chat-menu');
    await h.clickModalAction(page, 'Report');
    await page.waitForSelector('.modal-backdrop select.select');
    await page.selectOption('.modal-backdrop select.select', { index: 1 });
    await page.fill('.modal-backdrop textarea.textarea', DETAILS);
    await h.clickModalAction(page, 'Send report');

    // Two confirmations, in this order: the report's "also block?" follow-up,
    // and then the one endMatch asks before it touches anything.
    await confirmBlock(page, h, 'Also block ' + target.name);
    await confirmBlock(page, h, 'Blocking ' + target.name);
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });

    // endMatch redraws the list as soon as the unmatch lands and only then
    // writes the block, so the success toast — the one sentence that claims
    // both halves went through — is what the store reads below must wait for.
    // A failure gets its own wording instead, and the checks report it.
    const settled = await page.waitForFunction(function () {
      const host = document.querySelector('.toast-host');
      return !!host && /is blocked and the match is gone/.test(host.textContent);
    }, null, { timeout: 10000 }).then(function () { return true; }, function () { return false; });
    t.check('the app says the block and the unmatch both went through', settled);

    const rowsLeft = await page.locator('#match-list .match-row').count();
    t.check('the blocked conversation leaves the list', rowsLeft === 1, 'rows=' + rowsLeft);

    const after = await page.evaluate(function () {
      const uid = window.ZC.auth.current.uid;
      return Promise.all([
        window.ZC.store.getUser(uid),
        window.ZC.store.getMatches(uid),
        window.ZC.store.listCandidates(uid, { limit: 60 }),
        window.ZC.store.getMyReports(uid)
      ]).then(function (out) {
        return {
          blocked: (out[0] && out[0].blocked) || [],
          matched: out[1].map(function (match) { return match.otherUid; }),
          candidates: out[2].map(function (user) { return user.uid; }),
          reports: out[3].length
        };
      });
    });

    t.check('the block is recorded on the user document',
      after.blocked.indexOf(target.uid) !== -1, 'blocked=' + after.blocked.join(','));
    // Both halves, in the order the code does them: had the block landed first
    // and the unmatch failed, this is the check that would have caught it.
    t.check('the unmatch went through with it',
      after.matched.length === 1 && after.matched.indexOf(target.uid) === -1,
      'matches=' + after.matched.join(','));
    t.check('the blocked person is out of the deck',
      after.candidates.indexOf(target.uid) === -1, 'candidates=' + after.candidates.length);
    t.check('blocking leaves the report on file', after.reports === 1, 'stored=' + after.reports);
  }
};
