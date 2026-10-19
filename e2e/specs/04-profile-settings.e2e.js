/* Editing your own profile, and the settings that change the app around you. */
'use strict';

const MARKER = ' Edited by the e2e suite.';

/**
 * The unread count the store holds for the signed-in account, beside what the
 * nav's Matches badge says. The count comes from a subscription of the test's
 * own to the store's shared match stream. In demo mode, the only one this spec
 * runs in, the shell subscribes to that stream (or, with the switch off,
 * paints the badge empty) inside the task that dispatches DOMContentLoaded.
 * The page's own setup starts before it in that same task: app.js runs while
 * the document is still loading, so the page's onReady callback is queued
 * first, and the demo store answers on microtasks, so the dashboard has drawn
 * its deck by the time the shell's turn comes. What the order cannot change is
 * that the task is over before the test acts on anything the page drew. The
 * stream hands rows to its subscribers in the order they came, a late one from
 * the rows it already delivered — so when this one's first rows arrive, the
 * shell has had the same rows and painted them, or chosen not to. Call it once
 * the page has drawn something of its own. No wait stands in for that.
 * @param {Object} page a Playwright Page on a signed-in page
 * @returns {Promise<{unread:number, badge:string|null}>}
 */
function unreadAgainstBadge(page) {
  return page.evaluate(function () {
    return new Promise(function (resolve) {
      let stop = null;
      stop = window.ZC.store.listenMatches(window.ZC.auth.current.uid, function (rows) {
        let unread = 0;
        rows.forEach(function (row) { unread += Math.max(0, Number(row && row.unread) || 0); });
        const badge = document.querySelector('[data-badge="matches"]');
        if (stop) stop();
        resolve({ unread: unread, badge: badge ? badge.textContent.trim() : null });
      });
    });
  });
}

module.exports = {
  title: 'Profile editing and settings',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    // The control for the notifications check further down: with the switch
    // in its default place, the badge carries the count the store holds. It is
    // what makes an empty badge there mean the switch, not a badge that was
    // never painted or a demo account with nothing unread.
    const notifyOnBadge = await unreadAgainstBadge(page);
    t.check('with in-app notifications on, the Matches badge carries the unread count',
      notifyOnBadge.unread > 0 && notifyOnBadge.badge === String(notifyOnBadge.unread),
      JSON.stringify(notifyOnBadge));

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

    /* ---- a rename made in Settings survives a profile save from an older tab ---- */

    // The display name is edited in two places, Settings and this editor. The
    // editor used to send every field it had loaded on every save, so with the
    // profile open in one tab and a rename saved from Settings in another, the
    // next profile save of anything at all — a bio edit — wrote the old name
    // back. Both tabs then said saved, and the rename was gone.
    const renamed = 'Renamed In Another Tab';
    await renameInSettings(renamed);
    const nameBeforeSave = await page.inputValue('#input-name');
    await page.fill('#input-bio', (await page.inputValue('#input-bio')) + ' Saved from the older tab.');
    await page.click('#save-btn');
    // Bounded, so a save that never lands is reported by the checks below.
    await page.waitForFunction(function () {
      return !document.getElementById('save-btn').hasAttribute('aria-busy') &&
        /^Saved/.test(document.getElementById('save-status').textContent.trim());
    }, null, { timeout: 5000 }).catch(function () {});
    const afterOlderSave = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      return {
        stored: doc.displayName,
        bioSaved: doc.profile.bio.indexOf('Saved from the older tab.') !== -1,
        box: document.getElementById('input-name').value,
        status: document.getElementById('save-status').textContent.trim(),
        discardEnabled: !document.getElementById('discard-btn').disabled
      };
    });
    // The name box still holding the old name is what makes this a test: a tab
    // that had somehow picked the rename up would pass without the fix.
    t.check('a profile save from a tab opened before a rename in Settings keeps the new name',
      nameBeforeSave !== renamed && afterOlderSave.bioSaved && afterOlderSave.stored === renamed,
      'box before ' + JSON.stringify(nameBeforeSave) + ', ' + JSON.stringify(afterOlderSave));
    // "Saved just now." beside a name box that is not what is stored would be
    // the same untruth the other way round. And measured: a save that takes the
    // stored name as its baseline without putting it in the box leaves the page
    // saying "Unsaved changes." about a form nobody has touched.
    t.check('and the editor takes up the new name, so "Saved just now." is true of the whole form',
      afterOlderSave.box === renamed && afterOlderSave.status === 'Saved just now.' &&
      !afterOlderSave.discardEnabled, JSON.stringify(afterOlderSave));

    /* ---- taking up a rename leaves alone what is being typed meanwhile ---- */

    // That save takes the new name into the form when it comes back. It used
    // to do so by repainting every control and clearing every error, and only
    // the Save button is disabled while a save is out, so whatever the person
    // did in the meantime went with it: a date typed halfway was emptied, and
    // the error under a refused photo link vanished with the link still in its
    // box. The store is held here so that both happen while the save is out,
    // and the check says so if it was not held. The name has to be taken up
    // for this to test anything: a save that moves nothing repaints nothing.
    const renamedAgain = 'Renamed Again Elsewhere';
    const refusedLink = 'http://not-https.example/x.png';
    await renameInSettings(renamedAgain);
    await page.evaluate(function () {
      const store = window.ZC.store;
      const real = store.updateUser;
      const gate = new Promise(function (resolve) { window.__e2eReleaseSave = resolve; });
      store.updateUser = function () {
        const args = arguments;
        store.updateUser = real;
        window.__e2eSaveHeld = true;
        return gate.then(function () { return real.apply(store, args); });
      };
    });
    await page.fill('#input-bio', (await page.inputValue('#input-bio')) + ' Saved while a date was half typed.');
    await page.click('#save-btn');
    await page.waitForFunction(function () { return window.__e2eSaveHeld === true; });
    await page.fill('#input-photo', refusedLink);
    await page.click('#btn-add-photo');
    await page.fill('#input-birthdate', '');
    await page.click('#input-birthdate');
    await page.keyboard.type('1');
    const duringSave = await page.evaluate(function () {
      return {
        held: document.getElementById('save-btn').hasAttribute('aria-busy'),
        photoError: document.getElementById('error-photo').textContent.trim(),
        halfTyped: document.getElementById('input-birthdate').validity.badInput
      };
    });
    await page.evaluate(function () { window.__e2eReleaseSave(); });
    await page.waitForFunction(function () {
      return !document.getElementById('save-btn').hasAttribute('aria-busy');
    });
    const afterTakeUp = await page.evaluate(function () {
      return {
        name: document.getElementById('input-name').value,
        photoError: document.getElementById('error-photo').textContent.trim(),
        photoBox: document.getElementById('input-photo').value,
        halfTyped: document.getElementById('input-birthdate').validity.badInput
      };
    });
    t.check('a save that takes up a rename leaves a date typed halfway and a photo error where they were',
      duringSave.held && duringSave.photoError !== '' && duringSave.halfTyped &&
        afterTakeUp.name === renamedAgain && afterTakeUp.halfTyped &&
        afterTakeUp.photoError === duringSave.photoError && afterTakeUp.photoBox === refusedLink,
      (duringSave.held ? '' : 'the save was not held, so this tested nothing — ') +
        JSON.stringify({ afterTakeUp: afterTakeUp, duringSave: duringSave }));
    // Back to the stored document for what follows: Discard repaints it, and
    // the photo box is the one control it leaves alone.
    await page.click('#discard-btn');
    await h.clickModalAction(page, 'Discard');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    await page.fill('#input-photo', '');

    /* ---- a birthdate corrected in one tab survives an older tab's save ---- */

    // Only the save that completes a profile sends the birthdate unasked. A fix
    // for the profile rebuilt with no birthdate first sent it on every save,
    // and then a profile tab opened before a correction made in another put
    // its own birthdate back on its next save of anything at all. "Saved just
    // now." is already showing from earlier saves, so a save is waited out by
    // the button dropping `aria-busy`, and what counts is read from the store.
    const savedProfile = async function (tab) {
      await tab.click('#save-btn');
      await tab.waitForFunction(function () {
        return !document.getElementById('save-btn').hasAttribute('aria-busy') &&
          /^Saved/.test(document.getElementById('save-status').textContent.trim());
      }, null, { timeout: 10000 });
    };
    const storedProfile = function () {
      return page.evaluate(async function () {
        const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
        return { birthdate: doc.profile.birthdate, bio: doc.profile.bio };
      });
    };
    const olderTab = ctx.session.watch(await ctx.session.context.newPage());
    try {
      await olderTab.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
      await olderTab.waitForSelector('#profile-main:not(.hidden)');
      const bornBefore = await page.inputValue('#input-birthdate');
      const corrected = bornBefore === '1990-04-03' ? '1991-05-06' : '1990-04-03';
      await page.fill('#input-birthdate', corrected);
      await savedProfile(page);
      const olderBio = await olderTab.inputValue('#input-bio');
      await olderTab.fill('#input-bio', olderBio + ' Saved from the older tab.');
      await savedProfile(olderTab);
      const afterOlder = await storedProfile();
      t.check('a birthdate corrected in one tab survives a save of something else from a tab opened before it',
        afterOlder.birthdate === corrected && /Saved from the older tab\.$/.test(afterOlder.bio),
        JSON.stringify({ before: bornBefore, corrected: corrected, stored: afterOlder }));
      // Both put back for what follows: the bio from the older tab, then the
      // birthdate from a fresh load of this one.
      await olderTab.fill('#input-bio', olderBio);
      await savedProfile(olderTab);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#profile-main:not(.hidden)');
      await page.fill('#input-birthdate', bornBefore);
      await savedProfile(page);
    } finally {
      await olderTab.close();
    }

    /* ---- what Back brings back is what is stored, and what Save writes ---- */

    // After Back, Chromium puts the form's controls back the way they were left
    // (all but those marked autocomplete=off), after the `load` event and
    // before `pageshow`, and fires no input event. In demo mode the editor has painted from the stored document by
    // then, so the boxes showed the abandoned edit while the editor still held
    // the stored text: "Everything here is saved.", Discard off, and a Save that
    // wrote the stored text and said "Saved just now." over the one on screen.
    // What the control held at `pageshow`, before any page script's own
    // listener runs, is recorded so the check can tell the browser restored
    // something: without that, a browser that restores nothing passes it.
    await page.addInitScript(function () {
      window.addEventListener('pageshow', function () {
        const value = function (name) {
          const node = document.getElementById(name);
          return node ? node.value : null;
        };
        window.__e2eAtPageshow = { bio: value('input-bio'), ageMin: value('age-min'), distance: value('distance') };
      });
    });
    const leftBehind = ' Typed, then left behind.';
    const bioBeforeLeaving = await page.inputValue('#input-bio');
    await page.fill('#input-bio', bioBeforeLeaving + leftBehind);
    // A real link, the way a person leaves; the session accepts "Leave site?".
    await Promise.all([
      page.waitForURL(h.pageUrl('dashboard')),
      page.locator('a[href*="dashboard"]:visible').first().click()
    ]);
    await page.waitForSelector('#deck-stack .swipe-card');
    await page.goBack();
    await page.waitForFunction(function () {
      return !!window.__e2eAtPageshow &&
        !document.getElementById('profile-main').classList.contains('hidden');
    });
    const afterBack = await page.evaluate(async function (mark) {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      const box = document.getElementById('input-bio').value;
      return {
        restored: (window.__e2eAtPageshow.bio || '').indexOf(mark) !== -1,
        boxHasEdit: box.indexOf(mark) !== -1,
        boxIsStored: box.trim() === doc.profile.bio,
        countAgrees: document.getElementById('bio-count').textContent === box.length + ' / 500',
        status: document.getElementById('save-status').textContent.trim(),
        discardEnabled: !document.getElementById('discard-btn').disabled
      };
    }, leftBehind);
    // Either answer is honest: the box shows what is stored and the page says
    // saved, or it shows something else and the page says unsaved.
    t.check('after Back, the bio box, its counter and the save line agree with one another',
      afterBack.restored && afterBack.countAgrees &&
      afterBack.boxIsStored === !/unsaved/i.test(afterBack.status) &&
      afterBack.boxIsStored === !afterBack.discardEnabled,
      (afterBack.restored ? '' : 'the browser restored nothing, so this tested nothing — ') +
      JSON.stringify(afterBack));
    await page.click('#save-btn');
    // Bounded, so a save that never lands is reported by the check below.
    await page.waitForFunction(function () {
      return !document.getElementById('save-btn').hasAttribute('aria-busy') &&
        /^Saved/.test(document.getElementById('save-status').textContent.trim());
    }, null, { timeout: 5000 }).catch(function () {});
    const savedAfterBack = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      return {
        box: document.getElementById('input-bio').value.trim(),
        stored: doc.profile.bio,
        status: document.getElementById('save-status').textContent.trim()
      };
    });
    t.check('and Save after Back stores exactly what the box shows',
      savedAfterBack.status === 'Saved just now.' && savedAfterBack.stored === savedAfterBack.box,
      'status ' + JSON.stringify(savedAfterBack.status) + ', box ends ' +
      JSON.stringify(savedAfterBack.box.slice(-30)) + ', stored ends ' + JSON.stringify(savedAfterBack.stored.slice(-30)));

    /* ---- an ordinary load leaves alone what is already on screen ---- */

    // `pageshow` ends every load, not only Back, and on this page `load` waits
    // for the person's photos, so the editor can be in use before either fires.
    // Repainting the whole form there wiped what the person had in front of
    // them: the error a Save had just shown, and a date typed halfway. The
    // photo is held until both are in place, and the check says so if the load
    // was not held. A context of its own, so the held photo stays out of the
    // account the rest of this spec uses, and with the service worker kept
    // out, so the photo's request goes straight from the page to the route.
    const held = await h.openSession(ctx.session.context.browser(), ctx.viewport, { serviceWorkers: 'block' });
    try {
      const heldPage = held.page;
      let releasePhoto = null;
      const photoGate = new Promise(function (resolve) { releasePhoto = resolve; });
      await held.context.route('https://photo.e2e.invalid/**', async function (route) {
        await photoGate;
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
        });
      });
      await h.signIn(heldPage, ctx.base);
      await heldPage.evaluate(function () {
        return window.ZC.store.updateUser(window.ZC.auth.current.uid,
          { profile: { photos: ['https://photo.e2e.invalid/held.png'] } });
      });
      await heldPage.addInitScript(function () {
        window.addEventListener('pageshow', function () { window.__e2eShown = true; });
      });
      await heldPage.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
      await heldPage.waitForSelector('#profile-main:not(.hidden)');
      await heldPage.fill('#input-name', '');
      await heldPage.click('#save-btn');
      await heldPage.fill('#input-birthdate', '');
      await heldPage.click('#input-birthdate');
      await heldPage.keyboard.type('1');
      const beforeLoad = await heldPage.evaluate(function () {
        return {
          held: document.readyState !== 'complete' && !window.__e2eShown,
          error: document.getElementById('error-name').textContent.trim(),
          halfTyped: document.getElementById('input-birthdate').validity.badInput
        };
      });
      releasePhoto();
      await heldPage.waitForFunction(function () { return window.__e2eShown === true; });
      const afterLoad = await heldPage.evaluate(function () {
        return {
          error: document.getElementById('error-name').textContent.trim(),
          name: document.getElementById('input-name').value,
          halfTyped: document.getElementById('input-birthdate').validity.badInput
        };
      });
      t.check('a load that ends after the editor is in use keeps the error on screen and a date typed halfway',
        beforeLoad.held && beforeLoad.error !== '' && beforeLoad.halfTyped &&
          afterLoad.error === beforeLoad.error && afterLoad.name === '' && afterLoad.halfTyped &&
          held.errors.length === 0,
        (beforeLoad.held ? '' : 'the photo did not hold the load, so this tested nothing — ') +
          JSON.stringify({ beforeLoad: beforeLoad, afterLoad: afterLoad, errors: held.errors.slice(0, 3) }));
    } finally {
      await held.context.close();
    }

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

    // The same restore on this page: the discovery sliders came back from Back
    // where they had been left, unsaved, while their read-outs had been painted
    // from the stored preferences — "25 to 44" beside a handle at 40, and a
    // Save that wrote the handles. The page-show recorder above is still armed.
    await page.waitForFunction(function () { return document.getElementById('input-name').value !== ''; });
    await page.locator('#age-min').fill('40');
    await page.locator('#distance').fill('20');
    await Promise.all([
      page.waitForURL(h.pageUrl('dashboard')),
      page.locator('a[href*="dashboard"]:visible').first().click()
    ]);
    await page.waitForSelector('#deck-stack .swipe-card');
    await page.goBack();
    await page.waitForFunction(function () {
      return !!window.__e2eAtPageshow && document.getElementById('input-name').value !== '';
    });
    const sliders = await page.evaluate(async function () {
      const doc = await window.ZC.store.getUser(window.ZC.auth.current.uid);
      const prefs = doc.preferences || {};
      const min = Number(document.getElementById('age-min').value);
      const max = Number(document.getElementById('age-max').value);
      const km = Number(document.getElementById('distance').value);
      return {
        restored: window.__e2eAtPageshow.ageMin === '40' && window.__e2eAtPageshow.distance === '20' &&
          prefs.ageMin !== 40 && prefs.maxDistanceKm !== 20,
        handles: min + '-' + max + ', ' + km + ' km',
        stored: prefs.ageMin + '-' + prefs.ageMax + ', ' + prefs.maxDistanceKm + ' km',
        ageAgrees: document.getElementById('age-value').textContent === (min === max ? min + ' only' : min + ' to ' + max),
        distanceAgrees: document.getElementById('distance-value').textContent ===
          (km >= 500 ? 'Anywhere' : 'Up to ' + km + ' km away'),
        ageValue: document.getElementById('age-value').textContent,
        distanceValue: document.getElementById('distance-value').textContent
      };
    });
    t.check('after Back, the discovery read-outs describe the sliders beside them',
      sliders.restored && sliders.ageAgrees && sliders.distanceAgrees,
      (sliders.restored ? '' : 'the browser restored nothing, so this tested nothing — ') + JSON.stringify(sliders));
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

    // The switch flipped above is stored on the profile, and Settings says it
    // puts the number of unread messages on Matches. Nothing read it: with it
    // off, the badge went on counting unread messages exactly as before.
    const notifyOffBadge = await unreadAgainstBadge(page);
    t.check('with in-app notifications off, the Matches badge stays empty while messages are unread',
      notifyStored === false && notifyOffBadge.unread > 0 && notifyOffBadge.badge === '',
      'stored ' + (notifyStored ? 'on' : 'off') + ', ' + JSON.stringify(notifyOffBadge));

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
      landed.indexOf(ctx.base + '/') === 0 && h.pageUrl('subscription').test(landed), landed);

    // Signing in as someone else in another tab moves a signed-in page on as
    // soon as the new account is known, not once its profile has loaded: until
    // then the page is still acting as the account that left. The watching
    // tab's profile read is held so it never loads, and its sign-in page is
    // stubbed so nothing there acts on the made-up account. A context of its
    // own, with the service worker kept out, so the stub is what loads.
    const solo = await h.openSession(ctx.session.context.browser(), ctx.viewport, { serviceWorkers: 'block' });
    try {
      const watcher = solo.page;
      await h.signIn(watcher, ctx.base);
      await watcher.route(function (url) { return h.pageUrl('auth').test(url.href); }, function (route) {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>held</title>' });
      });
      await watcher.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
      await watcher.waitForSelector('#match-list .match-row');
      await watcher.evaluate(function () {
        window.ZC.store.getUser = function () { return new Promise(function () {}); };
      });
      const switcher = solo.watch(await solo.context.newPage());
      await switcher.goto(ctx.base + '/index.html', { waitUntil: 'domcontentloaded' });
      await switcher.evaluate(function () {
        localStorage.setItem('zc.demo.session', JSON.stringify({ uid: 'e2e-someone-else' }));
      });
      await watcher.waitForURL(h.pageUrl('auth'), { timeout: 10000 }).catch(function () {});
      const movedTo = watcher.url();
      const stubbed = (await watcher.title()) === 'held';
      t.check('another tab signing in as someone else moves this one on before the new profile loads',
        stubbed && movedTo.indexOf(ctx.base + '/') === 0 && /[?&]next=/.test(movedTo), movedTo);
      t.check('and the tabs doing it log no errors', solo.errors.length === 0, solo.errors.slice(0, 3).join(' | '));
    } finally {
      await solo.context.close();
    }

    // Signing out in one tab is signing out in all of them. The other tab used
    // to carry on as the account that had just left: its open conversations
    // stayed on screen, the composer live, and a message sent from it was
    // stored under that account. Run last, because it ends the session.
    //
    // One of the other tabs is the profile editor with an edit not saved yet.
    // It asks before it is left, and that question is the person's: the tab
    // leaving because the account has gone is not them leaving. It asked
    // anyway, so the way to the sign-in page waited on a "Leave site?" prompt,
    // and answered "Stay" it kept the signed-out editor on screen. This tab's
    // dialogs are recorded and accepted, so it goes either way and the checks
    // read whether it was asked. The reload is the control: it shows the
    // question is there to be asked at all in this tab.
    const other = ctx.session.watch(await ctx.session.context.newPage());
    await other.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await other.waitForSelector('#match-list .match-row');
    const editing = ctx.session.watch(await ctx.session.context.newPage());
    const editingAsked = [];
    editing.on('dialog', function (dialog) {
      editingAsked.push(dialog.type());
      return dialog.accept();
    });
    await editing.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
    await editing.waitForSelector('#profile-main:not(.hidden)');
    await editing.fill('#input-bio', 'An edit the reload is asked about.');
    await editing.reload({ waitUntil: 'domcontentloaded' });
    await editing.waitForSelector('#profile-main:not(.hidden)');
    const askedOnReload = editingAsked.splice(0);
    // A page the back-forward cache restores is in use again, and so is the
    // question. Here the page hears `zc:leaving`, as it does on its way out, and
    // is then hidden and restored — the same synthetic pair 03 uses, because
    // this Chromium restores nothing from the cache itself. An edit made after
    // that is asked about on reload like any other.
    await editing.evaluate(function () {
      window.dispatchEvent(new Event('zc:leaving'));
      window.dispatchEvent(new Event('pagehide'));
      let show;
      try {
        show = new PageTransitionEvent('pageshow', { persisted: true });
      } catch (err) {
        show = new Event('pageshow');
        Object.defineProperty(show, 'persisted', { value: true });
      }
      window.dispatchEvent(show);
    });
    await editing.fill('#input-bio', 'An edit made on a page restored after it was left.');
    await editing.reload({ waitUntil: 'domcontentloaded' });
    await editing.waitForSelector('#profile-main:not(.hidden)');
    const askedAfterRestore = editingAsked.splice(0);
    await editing.fill('#input-bio', 'An edit nobody saved before another tab signed out.');
    await page.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main [data-signout]');
    await page.click('main [data-signout]');
    await page.waitForURL(h.pageUrl('index'));
    await other.waitForURL(h.pageUrl('auth'), { timeout: 10000 }).catch(function () {});
    await editing.waitForURL(h.pageUrl('auth'), { timeout: 10000 }).catch(function () {});
    const otherTab = other.url();
    const editingTab = editing.url();
    await other.close();
    await editing.close();
    t.check('signing out in one tab takes the other tabs off their signed-in pages',
      otherTab.indexOf(ctx.base + '/') === 0 && h.pageUrl('auth').test(otherTab) && /[?&]next=/.test(otherTab),
      otherTab);
    t.check('the profile editor asks before an unsaved edit is reloaded away',
      askedOnReload.length === 1 && askedOnReload[0] === 'beforeunload', JSON.stringify(askedOnReload));
    t.check('and asks again on a page restored after it was left',
      askedAfterRestore.length === 1 && askedAfterRestore[0] === 'beforeunload', JSON.stringify(askedAfterRestore));
    t.check('but a sign-out in another tab takes it to the sign-in page without asking',
      editingAsked.length === 0 && h.pageUrl('auth').test(editingTab) && /[?&]next=/.test(editingTab),
      JSON.stringify({ asked: editingAsked, at: editingTab.replace(ctx.base, '') }));

    // And with an unsaved edit, the profile page's own Sign out goes without
    // asking: app.js says `zc:leaving` before it leaves for the landing page,
    // for the same reason. Signed in again, because the checks above ended
    // the session; it ends again here. The nav's Sign out is hidden at the
    // mobile width, where Settings carries the control, so the click is
    // dispatched to it: app.js handles it the same way at every width. The
    // session accepts every native dialog (see harness.openSession), so the
    // page goes either way and this records whether it was asked.
    await h.signIn(page, ctx.base);
    await page.goto(ctx.base + '/profile.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#profile-main:not(.hidden)');
    await page.fill('#input-bio', 'An edit nobody saved before Sign out.');
    const ownAsked = [];
    const recordOwn = function (dialog) { ownAsked.push(dialog.type()); };
    page.on('dialog', recordOwn);
    try {
      await page.locator('[data-zc-nav] [data-signout]').dispatchEvent('click');
      await page.waitForURL(h.pageUrl('index'), { timeout: 10000 }).catch(function () {});
    } finally {
      page.off('dialog', recordOwn);
    }
    const signedOutTo = page.url();
    t.check('and the profile page\'s own Sign out, with an edit unsaved, goes to the landing page without asking',
      ownAsked.length === 0 && h.pageUrl('index').test(signedOutTo),
      JSON.stringify({ asked: ownAsked, at: signedOutTo.replace(ctx.base, '') }));

    /**
     * Rename the account from Settings in a tab of its own, as somebody with
     * the profile editor open in another tab would, and close that tab.
     * @param {string} name the new display name
     * @returns {Promise<void>}
     */
    async function renameInSettings(name) {
      // Into the session's own list, so the spec's closing no-errors check covers
      // this tab too.
      const settingsTab = ctx.session.watch(await ctx.session.context.newPage());
      await settingsTab.goto(ctx.base + '/settings.html', { waitUntil: 'domcontentloaded' });
      await settingsTab.waitForFunction(function () {
        return document.getElementById('input-name').value !== '';
      });
      await settingsTab.fill('#input-name', name);
      await settingsTab.click('#save-account');
      await settingsTab.waitForFunction(function () {
        return document.getElementById('account-status').textContent.trim() === 'Saved.';
      });
      await settingsTab.close();
    }
  }
};
