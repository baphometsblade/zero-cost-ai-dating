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
    // Anchored, because the edited form reads "Unsaved changes." and /saved/i
    // matched that too: the wait was over before the save had done anything,
    // and the check after it was `true`. Bounded, so a save that never reports
    // success is reported by this check rather than as a timeout.
    const saved = await page.waitForFunction(function () {
      return /^Saved/.test(document.getElementById('save-status').textContent.trim());
    }, null, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    t.check('saving the profile reports success', saved, (await page.textContent('#save-status')).trim());

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    const reloadedBio = await page.inputValue('#input-bio');
    t.check('the edit survives a reload', reloadedBio.indexOf(MARKER) !== -1);

    /* ---- a location label emptied by hand stays empty ---- */

    // The label box and the coordinates are separate things: emptying the box
    // keeps the city's coordinates, which is all distance scoring uses. The save
    // used to put a label back — the nearest bundled city — while the form, the
    // live preview and the unsaved-changes baseline all went on recording the
    // empty box. So the deleted label returned on the next visit, and Discard
    // after that save repainted from a stored document the baseline had never
    // seen, which left "Unsaved changes." with nothing to save.
    await page.selectOption('#select-city', { label: 'Denver, CO' });
    await page.fill('#input-location', '');
    await page.click('#save-btn');
    // The submit handler marks the button busy before its first await, so this
    // cannot pass before the save has begun — and it waits for the whole save,
    // where the status line changes part-way through it.
    await page.waitForFunction(function () {
      return !document.getElementById('save-btn').hasAttribute('aria-busy');
    });
    const labelSaved = (await page.textContent('#save-status')).trim();
    // Discard comes before the reload on purpose: a reload takes a fresh baseline
    // from whatever was stored, which is exactly the mismatch it would hide.
    await page.fill('#input-bio', (await page.inputValue('#input-bio')) + ' Typed, then thrown away.');
    await page.click('#discard-btn');
    await h.clickModalAction(page, 'Discard');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const afterDiscard = {
      status: (await page.textContent('#save-status')).trim(),
      discardEnabled: await page.locator('#discard-btn').isEnabled()
    };
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    const storedPlace = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      return (doc && doc.profile && doc.profile.location) || null;
    });
    const reloadedLabel = await page.inputValue('#input-location');

    t.check('a location label emptied before saving is still empty after a reload',
      labelSaved === 'Saved just now.' && reloadedLabel === '' &&
      !!storedPlace && storedPlace.label === '' && storedPlace.lat === 39.7392,
      'status ' + JSON.stringify(labelSaved) + ', box ' + JSON.stringify(reloadedLabel) +
      ', stored ' + JSON.stringify(storedPlace));
    t.check('and Discard after that save gets back to saved, not to "Unsaved changes."',
      !/unsaved/i.test(afterDiscard.status) && !afterDiscard.discardEnabled, JSON.stringify(afterDiscard));

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

    /* ---- the city picker's placeholder ---- */

    // "Choose a city…" carries the value '', and `Number('')` is 0 — the index
    // of Portland, OR. Choosing it moved the account to Portland. The field's own
    // hint tells people to "leave this blank" if their city is not listed, which
    // was an instruction to trigger exactly that. Seattle first, so the bug has
    // something to overwrite: starting from Portland would hide it.
    await page.selectOption('#select-city', { label: 'Seattle, WA' });
    const picked = await page.inputValue('#input-location');
    await page.selectOption('#select-city', '');
    const afterBlank = {
      label: await page.inputValue('#input-location'),
      picker: await page.evaluate(function () {
        const select = document.getElementById('select-city');
        return select.options[select.selectedIndex] ? select.options[select.selectedIndex].text : '';
      }),
      status: (await page.textContent('#location-status')).trim()
    };
    t.check('picking a city fills the location', picked === 'Seattle, WA', picked);
    t.check('choosing "Choose a city…" afterwards leaves the location alone — it does not become Portland',
      afterBlank.label === 'Seattle, WA' && !/45\.5/.test(afterBlank.status), JSON.stringify(afterBlank));
    t.check('and the picker goes back to naming the city the location still is',
      afterBlank.picker === 'Seattle, WA', afterBlank.picker);

    /* ---- a save while the interest list is missing ---- */

    // Loading filters the stored interests through the list seed-data.js
    // publishes, so when that one file does not arrive `state.interests` comes
    // out empty — not because the person has none, but because nothing could
    // recognise them. The page says so ("interests cannot be edited right now")
    // and then wrote the empty list back on any save: change a bio, lose every
    // interest. Blocked for exactly one page load, then read back from the store.
    const storedBefore = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      return (doc && doc.profile && doc.profile.interests) || [];
    });
    // The page is controlled by the service worker, and a worker's own fetches
    // never reach Playwright's routing — measured: zero hits, with the real
    // file served. So the worker is unregistered first, which leaves the NEXT
    // navigation uncontrolled (app.js registers again on it, but a page is only
    // controlled from the one after). Fulfilled rather than aborted, so nothing
    // has to be excused as a network error: a script that loads and publishes
    // nothing is the state under test.
    await page.evaluate(function () {
      return navigator.serviceWorker.getRegistrations().then(function (regs) {
        return Promise.all(regs.map(function (reg) { return reg.unregister(); }));
      });
    });
    let seedRequests = 0;
    const missingSeed = function (route) {
      seedRequests += 1;
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* the interest list did not arrive */' });
    };
    await page.context().route('**/js/seed-data.js', missingSeed);
    await page.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    const missingNotice = /could not be loaded/i.test(await page.textContent('#interest-groups'));
    await page.fill('#input-bio', (await page.inputValue('#input-bio')) + ' And one more line.');
    await page.click('#save-btn');
    await page.waitForFunction(function () {
      return /saved|could not/i.test(document.getElementById('save-status').textContent);
    });
    await page.context().unroute('**/js/seed-data.js', missingSeed);
    const storedAfter = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      return (doc && doc.profile && doc.profile.interests) || [];
    });
    t.check('a save made while the interest list is missing leaves the stored interests alone',
      missingNotice && seedRequests > 0 && storedBefore.length > 0 &&
      JSON.stringify(storedAfter) === JSON.stringify(storedBefore),
      (missingNotice ? '' : 'the missing-list notice never showed (' + seedRequests +
        ' routed request(s)), so this tested nothing — ') +
      storedBefore.length + ' interest(s) before, ' + storedAfter.length + ' after');

    /* ---- settings ---- */
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#theme-group');
    // Each wait is bounded and its answer is the check. With no bound of its
    // own, a theme that never applied ran out the session's twenty-second
    // default and threw, recorded as "spec ran to completion", and the check
    // after it was `true`.
    const themed = function (want) {
      return page.waitForFunction(function (value) {
        return document.documentElement.getAttribute('data-theme') === value;
      }, want, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    };
    // The radio itself is visually hidden inside its chip, so click the label
    // the way a person does.
    await page.click('label.chip[for="theme-dark"]');
    t.check('choosing dark applies the theme immediately', await themed('dark'),
      'data-theme=' + (await page.getAttribute('html', 'data-theme')));

    await page.click('label.chip[for="theme-light"]');
    t.check('choosing light applies the theme immediately', await themed('light'),
      'data-theme=' + (await page.getAttribute('html', 'data-theme')));

    /* ---- a notifications change that did not save is not announced as made ---- */

    // `#appearance-status` is a live region, and unlike the toast it stays on the
    // page. A failed save put the switch back and raised a toast that is gone
    // after 3.2 seconds, and left the status line announcing the change that had
    // just failed — beside a switch showing the opposite. The write is failed at the
    // facade, the seam both adapters share, because the demo store's own write
    // does not fail by itself.
    const notifyBefore = await page.isChecked('#switch-notifications');
    ctx.session.expectConsoleError(/Could not save the notification preference/);
    await page.evaluate(function () {
      window.__zcRealUpdateUser = window.ZC.store.updateUser;
      window.ZC.store.updateUser = function () {
        return Promise.reject(new Error('That preference could not be saved.'));
      };
    });
    await page.click('label.switch:has(#switch-notifications)');
    await page.waitForSelector('.toast-host .toast-error');
    const notifyFailed = await page.evaluate(function () {
      return {
        checked: document.getElementById('switch-notifications').checked,
        status: document.getElementById('appearance-status').textContent.trim()
      };
    });
    await page.evaluate(function () { window.ZC.store.updateUser = window.__zcRealUpdateUser; });
    ctx.session.expectConsoleError(null);
    // The switch going back is what proves the failure branch ran at all; the
    // sentence is what this is about.
    t.check('a notifications change that failed to save says so, and names the state it left',
      notifyFailed.checked === notifyBefore && /could not/i.test(notifyFailed.status) &&
      notifyFailed.status.indexOf('still ' + (notifyBefore ? 'on' : 'off')) !== -1,
      'switch ' + (notifyFailed.checked ? 'on' : 'off') + ', status ' + JSON.stringify(notifyFailed.status));

    // The control: the same click with the store back saves and is announced as
    // made — a handler that only ever said "could not" would pass the check above.
    await page.click('label.switch:has(#switch-notifications)');
    const notifyStored = await page.evaluate(async function (want) {
      const uid = window.ZC.auth.current.uid;
      for (let i = 0; i < 50; i += 1) {
        const doc = await window.ZC.store.getUser(uid);
        const prefs = (doc && doc.preferences) || {};
        if ((prefs.notifications !== false) === want) return want;
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
      }
      return !want;
    }, !notifyBefore);
    const notifySaved = (await page.textContent('#appearance-status')).trim();
    t.check('and with the store back, the same change is saved and announced as made',
      notifyStored === !notifyBefore &&
      notifySaved === 'In-app notifications ' + (notifyBefore ? 'off' : 'on') + '.',
      'stored ' + (notifyStored ? 'on' : 'off') + ', status ' + JSON.stringify(notifySaved));

    /* ---- a reports list that could not be read is not an empty one ---- */

    // The store answered every failed read of the reports with `[]`, and the page
    // drew `[]` as "You have not reported anyone." — a statement of fact, on the
    // one panel that is also the only way to retract a report, while the report
    // sat in the queue. The page's own "Could not load your reports" was out of
    // reach for a read that failed. Here the reports cannot be read for one page
    // load: the storage read underneath the store fails, so the store's own
    // failure path is the one that runs.
    const reportsFiled = await page.evaluate(async function () {
      const uid = window.ZC.auth.current.uid;
      await window.ZC.store.reportUser(uid, 'maya-okonkwo', 'harassment', 'Filed by the e2e suite.');
      return (await window.ZC.store.getMyReports(uid)).length;
    });
    await page.addInitScript(function () {
      if (window.sessionStorage.getItem('e2e.unreadableReports') !== '1') return;
      const getItem = window.Storage.prototype.getItem;
      window.Storage.prototype.getItem = function (key) {
        if (key === 'zc.demo.reports') throw new Error('e2e: the reports store cannot be read');
        return getItem.apply(this, arguments);
      };
    });
    await page.evaluate(function () { window.sessionStorage.setItem('e2e.unreadableReports', '1'); });
    ctx.session.expectConsoleError(/Could not load your reports/);
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(function () {
      const status = document.getElementById('reports-status').textContent.trim();
      return status !== '' && status !== 'Loading your reports…';
    });
    const unreadable = (await page.textContent('#reports-status')).trim();
    ctx.session.expectConsoleError(null);
    await page.evaluate(function () { window.sessionStorage.removeItem('e2e.unreadableReports'); });

    t.check('reports that could not be read are reported as unread, not as none filed',
      reportsFiled === 1 && /could not load/i.test(unreadable) && !/have not reported/i.test(unreadable),
      reportsFiled + ' filed; status ' + JSON.stringify(unreadable));

    // And the control that makes the check above mean something: the report was
    // there all along, and the same panel lists it once it can be read.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#reports-list li');
    const readable = await page.locator('#reports-list li').count();
    t.check('and once the store can be read again, the same panel lists the report', readable === 1,
      'rows=' + readable);

    // The theme is a stored preference, not a per-page toggle.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    t.check('the chosen theme carries to the next page',
      (await page.getAttribute('html', 'data-theme')) === 'light');

    // Onboarding hands people back to the page they were headed for. A guard
    // or the sign-up form sends someone to profile.html?onboarding=1 with the
    // page they asked for as ?next=, and "Start matching" used to go to the
    // deck regardless: a link to a conversation or the plans page was lost the
    // moment someone made an account to see it.
    await page.goto(ctx.base + '/profile.html?onboarding=1&next=' + encodeURIComponent('/subscription.html'),
      { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    await page.click('#start-btn');
    await page.waitForURL(function (url) { return !h.pageUrl('profile').test(url.href); });
    const landed = page.url();
    t.check('finishing onboarding goes on to the page it was asked for',
      h.pageUrl('subscription').test(landed), landed);

    // Signing out in one tab is signing out in all of them. The other tab used
    // to carry on as the account that had just left: its open conversations
    // stayed on screen, the composer live, and a message sent from it was
    // stored under that account. Run last, because it ends the session.
    const other = await ctx.session.context.newPage();
    await other.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await other.waitForSelector('#match-list .match-row');
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main [data-signout]');
    await page.click('main [data-signout]');
    await page.waitForURL(h.pageUrl('index'));
    await other.waitForURL(h.pageUrl('auth'), { timeout: 10000 }).catch(function () {});
    const otherTab = other.url();
    await other.close();
    t.check('signing out in one tab takes the other tabs off their signed-in pages',
      h.pageUrl('auth').test(otherTab) && /[?&]next=/.test(otherTab), otherTab);
  }
};
