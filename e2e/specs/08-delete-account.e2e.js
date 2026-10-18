/* Deleting the account. It is the one flow that cannot be walked back, so the
   guard in front of it and the emptiness behind it both matter — and so does
   the export beside it, which is the one way to keep what the deletion removes. */
'use strict';

const fs = require('node:fs');

// settings.js's EXPORT_MESSAGE_LIMIT. The conversations below are built around
// it — one holds exactly that many messages, the other one more — so the two
// have to change together.
const EXPORT_CAP = 500;

/**
 * Wait for the settings page to finish wiring its controls. `loadReports` is
 * the last thing boot starts, and it writes its status line first.
 * @param {Object} page a Playwright Page
 * @returns {Promise<void>}
 */
async function settingsReady(page) {
  await page.waitForFunction(function () {
    const status = document.getElementById('reports-status');
    return !!status && status.textContent.trim() !== '';
  });
}

/**
 * Press "Download JSON" and read back the file the browser was handed, and the
 * toast that came with it.
 * @param {Object} page a Playwright Page
 * @returns {Promise<{payload:Object, toast:string}>}
 */
async function exportFile(page) {
  const both = await Promise.all([page.waitForEvent('download'), page.click('#export-data')]);
  const payload = JSON.parse(fs.readFileSync(await both[0].path(), 'utf8'));
  await page.waitForFunction(function () {
    const host = document.querySelector('.toast-host');
    return !!host && /Export downloaded/.test(host.textContent);
  });
  return { payload: payload, toast: (await page.textContent('.toast-host')).trim() };
}

module.exports = {
  title: 'Account deletion',
  viewports: ['mobile'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#delete-account');
    await settingsReady(page);

    /* ---- the export first: complete, or saying where it is not ---- */

    // The export read the newest EXPORT_CAP messages of each conversation and
    // wrote them out with nothing to say a longer one had lost its start, so a
    // file holding 500 messages looked the same whether the conversation held
    // 500 or 501. The demo account's two conversations are rewritten in storage
    // around the cap: one holds exactly that many messages, the other one more.
    const convo = await page.evaluate(function (cap) {
      const store = window.ZC.store;
      const uid = window.ZC.auth.current.uid;
      return store.getMatches(uid).then(function (views) {
        const all = JSON.parse(window.localStorage.getItem(store.KEYS.messages) || '{}');
        const thread = function (view, count) {
          const out = [];
          const start = Date.parse('2026-01-01T00:00:00.000Z');
          for (let i = 0; i < count; i += 1) {
            out.push({
              id: 'e2e-' + view.matchId + '-' + i,
              from: i % 2 ? uid : view.otherUid,
              text: 'Message ' + (i + 1) + ' of ' + count,
              createdAt: new Date(start + i * 60000).toISOString()
            });
          }
          return out;
        };
        if (views.length < 2) return null;
        all[views[0].matchId] = thread(views[0], cap + 1);
        all[views[1].matchId] = thread(views[1], cap);
        window.localStorage.setItem(store.KEYS.messages, JSON.stringify(all));
        return { over: views[0].matchId, exact: views[1].matchId };
      });
    }, EXPORT_CAP);
    if (!t.check('the demo account has two conversations to export', !!convo)) return;

    const whole = await exportFile(page);
    const find = function (file, matchId) {
      return (file.payload.conversations || []).filter(function (c) { return c.matchId === matchId; })[0] || null;
    };
    const over = find(whole, convo.over);
    const exact = find(whole, convo.exact);
    const overLast = over && over.messages.length ? over.messages[over.messages.length - 1].text : '';
    t.check('a conversation one message over the cap is never exported as if it were whole',
      !!over && (over.messages.length === EXPORT_CAP + 1 ||
        (over.complete === false && whole.payload.complete === false &&
          over.messages.length === EXPORT_CAP && overLast === 'Message ' + (EXPORT_CAP + 1) + ' of ' + (EXPORT_CAP + 1))),
      over ? over.messages.length + ' of ' + (EXPORT_CAP + 1) + ' messages, complete=' + over.complete +
        ', file complete=' + whole.payload.complete + ', newest ' + JSON.stringify(overLast) : 'not in the file');
    t.check('and the person is told so, not only the file', /not complete/i.test(whole.toast), whole.toast);
    // The boundary from the other side: a check that a cut conversation is marked
    // would also pass against an export that marks every conversation.
    t.check('a conversation exactly at the cap is exported whole, and says it is',
      !!exact && exact.messages.length === EXPORT_CAP && exact.complete === true,
      exact ? exact.messages.length + ' of ' + EXPORT_CAP + ' messages, complete=' + exact.complete : 'not in the file');

    // A conversation that cannot be read was caught and written out as an empty
    // list, which in a file reads as "no messages". It is failed at the facade,
    // the seam both adapters share, for one conversation only.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settingsReady(page);
    await page.evaluate(function (matchId) {
      const real = window.ZC.store.getMessages;
      window.ZC.store.getMessages = function (id, options) {
        if (id === matchId) return Promise.reject(new Error('e2e: this conversation cannot be read'));
        return real.call(this, id, options);
      };
    }, convo.exact);
    const partial = await exportFile(page);
    const unread = find(partial, convo.exact);
    t.check('a conversation that could not be read is marked as missing, not exported as empty',
      !!unread && unread.complete === false && partial.payload.complete === false &&
      /could not be read/i.test(unread.note || ''),
      unread ? 'complete=' + unread.complete + ', note ' + JSON.stringify(unread.note || '') +
        ', ' + unread.messages.length + ' messages' : 'not in the file');

    // And a history that cannot be read at all. The store read the swipes through
    // its forgiving helper, so an unreadable entry came back as no swipes, and the
    // file went out with an empty history and nothing to say so. This time the
    // storage read underneath the store fails, so the store's own path runs.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settingsReady(page);
    let downloads = 0;
    const countDownload = function () { downloads += 1; };
    page.on('download', countDownload);
    ctx.session.expectConsoleError(/Export failed/);
    await page.evaluate(function () {
      const getItem = window.Storage.prototype.getItem;
      window.Storage.prototype.getItem = function (key) {
        if (key === 'zc.demo.swipes') throw new Error('e2e: the swipes cannot be read');
        return getItem.apply(this, arguments);
      };
    });
    await page.click('#export-data');
    await page.waitForFunction(function () {
      const host = document.querySelector('.toast-host');
      return !!host && /Could not build the export|Export downloaded/.test(host.textContent);
    });
    const noHistory = (await page.textContent('.toast-host')).trim();
    // The download event is not tied to the toast, so give it a moment to land.
    await page.waitForTimeout(500);
    page.off('download', countDownload);
    ctx.session.expectConsoleError(null);
    t.check('an export whose swipes cannot be read fails, rather than downloading an empty history',
      downloads === 0 && /could not build the export/i.test(noHistory),
      downloads + ' download(s); toast ' + JSON.stringify(noHistory));

    // A fresh document drops the injected reads before anything is deleted.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#delete-account');
    await settingsReady(page);

    /* ---- then the deletion ---- */
    t.check('the delete button starts disabled',
      await page.locator('#delete-account').isDisabled());

    // The gate is an exact phrase, and it must actually be exact.
    await page.fill('#delete-confirm', 'delete please');
    t.check('a near-miss phrase leaves the button disabled',
      await page.locator('#delete-account').isDisabled());

    await page.fill('#delete-confirm', 'DELETE');
    t.check('the exact phrase unlocks the button',
      await page.locator('#delete-account').isEnabled());

    // Both waits are bounded and their answers are the checks. Each used to
    // have no bound of its own and be followed by `check(name, true)`: a
    // deletion that stayed put, or a deck that let the deleted account in, ran
    // out the session's twenty-second default, threw, was recorded as "spec
    // ran to completion", and the check that names it never printed.
    const arrived = function (name) {
      return page.waitForURL(h.pageUrl(name), { timeout: 10000 })
        .then(function () { return true; }, function () { return false; });
    };
    await page.click('#delete-account');
    t.check('deleting the account returns you to the landing page', await arrived('index'),
      page.url().split('/').pop());

    // Nothing may survive: the guard on a signed-in page has to turn you away.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    t.check('the deleted account can no longer reach the deck', await arrived('auth'),
      page.url().split('/').pop());
  }
};
