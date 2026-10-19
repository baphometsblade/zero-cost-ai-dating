/* The accessibility this project claims in prose.

   The README says the app "respects `prefers-reduced-motion`" and "is fully
   operable from the keyboard"; docs/ARCHITECTURE.md lists focus-trapping among
   the utilities. All of it was true, and none of it was executed — the deck's
   arrow keys were the only keyboard behaviour any test touched. An audit that
   nothing runs is the same kind of claim this repository spent a round making
   enforceable everywhere else, so here it is, run.

   Writing it found the place where the claim had already stopped being true,
   and the shape of it is worth stating exactly, because the first reading was
   wrong. Opening a conversation repaints the left pane and destroys the row
   the click came from, so focus falls to <body> unless something moves it.
   Something did: one line at the end of openMatch() — guarded by isWide().

   So the desktop was fine and the phone was not, which is the wrong way
   round. On a phone the list is *replaced* by the conversation, so a keyboard
   or switch user was returned to the top of a document whose visible half no
   longer contained their focus at all, with only the live region to tell them
   anything had happened. The guard has been replaced by one that asks whether
   a person actually activated a row — which also stops a `?m=` deep link from
   dropping the caret into a text field on a page somebody merely followed a
   link to. The last two checks of the pane-swap section are that fix, and
   they fail on both viewports without it.

   A later audit found a second fault, in what a screen reader is told rather
   than in where focus goes. The daily-limit banner was itself a polite live
   region, and its countdown rewrites it every second, so every tick was a
   change inside a live region — in the last hour before midnight, a
   different sentence each time. The banner section at the end moves the
   clock into that hour, and its three checks fail on both viewports without
   the fix.

   What this spec deliberately does not do is score the pages against a rules
   engine. Every check below is a specific promise made in the documentation or
   a specific way a keyboard or screen-reader user gets stranded — a number
   out of a hundred would be less honest and much harder to act on. */
'use strict';

/** Pages that must each stand on their own for a screen reader. */
const PAGES = ['index.html', 'auth.html', 'dashboard.html', 'profile.html',
  'matches.html', 'settings.html', 'subscription.html'];

/**
 * The live regions: elements whose changes a screen reader reads out without
 * being asked. By the aria-live attribute, by the roles that are live without
 * one, and <output>, whose implicit role is status.
 */
const LIVE_REGIONS = '[aria-live="polite"], [aria-live="assertive"], [role="status"], [role="alert"], [role="log"], output';

/**
 * The roles the browser's own accessibility tree gives an element and its
 * children, rather than the ones the markup suggests. Read over CDP, which is
 * Chromium's, and Chromium is the only browser e2e/run.js launches.
 * @param {Object} page Playwright page
 * @param {string} selector the element to read
 * @returns {Promise<{role:string, children:string[]}|null>} null when nothing
 *   matches the selector, or when the browser's answer holds no node for the
 *   match. Otherwise the match's role in the browser's accessibility tree, and
 *   the roles of that node's children in the same tree, in its order, with '?'
 *   for a child the answer holds no node for. The tree is not the DOM, and this
 *   says nothing about the DOM: the tree can leave a DOM child out or list it
 *   as 'none', and a match hidden from a screen reader can come back as 'none'
 *   and still list children. Callers that rely on more than this say why.
 */
async function axChildRoles(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const doc = await cdp.send('DOM.getDocument', { depth: 0 });
    const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: selector });
    if (!found.nodeId) return null;
    const described = await cdp.send('DOM.describeNode', { nodeId: found.nodeId });
    const tree = await cdp.send('Accessibility.getPartialAXTree', { nodeId: found.nodeId, fetchRelatives: true });
    const byId = function (id) { return tree.nodes.filter(function (node) { return node.nodeId === id; })[0]; };
    const self = tree.nodes.filter(function (node) { return node.backendDOMNodeId === described.node.backendNodeId; })[0];
    if (!self) return null;
    return {
      role: self.role ? self.role.value : '',
      children: (self.childIds || []).map(function (id) {
        const child = byId(id);
        return child && child.role ? child.role.value : '?';
      })
    };
  } finally {
    await cdp.detach();
  }
}

/**
 * Describe whatever currently has focus, in terms a failure message can use.
 * @param {Object} page Playwright page
 * @returns {Promise<Object>} tag, accessible-ish name, and where it sits
 */
function activeElement(page) {
  return page.evaluate(function () {
    const node = document.activeElement;
    if (!node || node === document.body) return { tag: 'BODY', isBody: true, name: '' };
    return {
      tag: node.tagName,
      isBody: false,
      id: node.id || '',
      name: (node.getAttribute('aria-label') || node.textContent || '').trim().slice(0, 40),
      inModal: !!(node.closest && node.closest('.modal-backdrop')),
      inChat: !!(node.closest && node.closest('#chat-pane'))
    };
  });
}

module.exports = {
  title: 'Accessibility: the promises the docs make, executed',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    await h.signIn(page, ctx.base);

    /* ---- every page stands on its own ---- */

    const structural = [];
    const unnamed = [];
    for (const name of PAGES) {
      await page.goto(ctx.base + '/' + name, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main, [role="main"]', { timeout: 5000 }).catch(function () {});
      const report = await page.evaluate(function () {
        const out = { main: document.querySelectorAll('main, [role="main"]').length, h1: document.querySelectorAll('h1').length, unnamed: [] };

        /* What a screen reader would end up announcing, near enough.
           Deliberately not the full accname algorithm — no generated content,
           no <legend>, no placeholder fallback, no recursion into referenced
           subtrees — and it is worth being plain about that rather than
           implying this spec implements the specification. It is the set of
           sources this app actually uses, in the order the platform tries
           them, and it resolves aria-labelledby instead of merely noticing the
           attribute: a reference to an id that does not exist, or to an empty
           element, names nothing at all, and an earlier version of this check
           accepted exactly that as a name. */
        function accessibleName(node) {
          const ref = node.getAttribute('aria-labelledby');
          if (ref) {
            const text = ref.split(/\s+/).map(function (id) {
              const target = document.getElementById(id);
              return target ? (target.textContent || '').trim() : '';
            }).filter(Boolean).join(' ').trim();
            if (text) return text;
          }
          const label = (node.getAttribute('aria-label') || '').trim();
          if (label) return label;
          if (node.labels && node.labels.length) {
            const own = Array.prototype.map.call(node.labels, function (l) {
              return (l.textContent || '').trim();
            }).filter(Boolean).join(' ').trim();
            if (own) return own;
          }
          const text = (node.textContent || '').trim();
          if (text) return text;
          return (node.getAttribute('title') || '').trim();
        }

        // A control nobody can name is a control a screen reader announces as
        // "button". Only visible ones: the pages keep panels in the DOM.
        document.querySelectorAll('button, a[href]').forEach(function (node) {
          if (node.offsetParent === null) return;
          if (!accessibleName(node)) out.unnamed.push((node.tagName + '.' + node.className).slice(0, 40));
        });
        document.querySelectorAll('input, select, textarea').forEach(function (node) {
          if (node.type === 'hidden' || node.offsetParent === null) return;
          if (!accessibleName(node)) out.unnamed.push((node.tagName + '#' + (node.id || node.name)).slice(0, 40));
        });

        // An <img> with no alt attribute at all is announced by its filename;
        // alt="" is the correct way to say "decorative" and passes.
        //
        // Every image, visible or not — unlike the controls above, and on
        // purpose. An image in a panel that has not been shown yet is not
        // exempt from needing alt text; it is the one most likely to be
        // forgotten, because nobody looking at the page can see it is missing.
        // There are none on any page today, so the strictness costs nothing
        // and holds the line for the panel somebody adds later.
        document.querySelectorAll('img').forEach(function (img) {
          if (img.getAttribute('alt') === null) out.unnamed.push('img[no alt] ' + img.src.slice(-24));
        });
        return out;
      });
      if (report.main !== 1 || report.h1 !== 1) {
        structural.push(name + ' has ' + report.main + ' main / ' + report.h1 + ' h1');
      }
      report.unnamed.forEach(function (item) { unnamed.push(name + ' → ' + item); });
    }

    t.check('every page has exactly one main landmark and one h1',
      structural.length === 0, structural.join('; ') || 'all ' + PAGES.length + ' pages');
    t.check('every visible control and field is named, and every image has alt text',
      unnamed.length === 0, unnamed.slice(0, 4).join('; ') || 'nothing unnamed across ' + PAGES.length + ' pages');

    /* ---- prefers-reduced-motion ---- */

    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const cardTransition = function () {
      return page.evaluate(function () {
        return getComputedStyle(document.querySelector('#deck-stack .swipe-card')).transitionDuration;
      });
    };
    const moving = await cardTransition();
    t.check('the deck animates by default, so the next check is not vacuous',
      /[1-9]/.test(moving), JSON.stringify(moving));

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const stilled = await cardTransition();
    // Not "0s": the stylesheet uses 0.001ms deliberately, because a genuinely
    // zero duration stops transitionend from firing and the code that waits
    // for it would hang. Anything under a frame is the promise being kept.
    const seconds = parseFloat(stilled) || 0;
    t.check('under prefers-reduced-motion the deck stops animating',
      seconds < 0.016, JSON.stringify(stilled));

    const arbitrary = await page.evaluate(function () {
      const probe = document.createElement('div');
      probe.style.transition = 'opacity 400ms';
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return value;
    });
    t.check('and the reduction is global, not just the one component anybody remembered',
      (parseFloat(arbitrary) || 0) < 0.016, JSON.stringify(arbitrary));
    await page.emulateMedia({ reducedMotion: null });

    /* ---- the modal: trapped, labelled, escapable, and returned ---- */

    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#premium-cta');
    await page.focus('#premium-cta');
    await page.click('#premium-cta');
    await page.waitForSelector('.modal-backdrop .modal-body');

    const opened = await activeElement(page);
    t.check('opening a dialog moves focus into it',
      opened.inModal === true, JSON.stringify(opened.name));

    const dialog = await page.evaluate(function () {
      const node = document.querySelector('.modal-backdrop .modal');
      const labelledBy = node.getAttribute('aria-labelledby');
      const label = labelledBy ? document.getElementById(labelledBy) : null;
      return {
        role: node.getAttribute('role'),
        modal: node.getAttribute('aria-modal'),
        label: label ? (label.textContent || '').trim() : ''
      };
    });
    t.check('the dialog announces itself as a modal dialog with a name',
      dialog.role === 'dialog' && dialog.modal === 'true' && dialog.label.length > 0,
      JSON.stringify(dialog));

    // Tab further than there are controls: a trap that only holds for one
    // cycle is not a trap, and this is the loop that proves it wraps.
    const escapes = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await activeElement(page);
      if (!where.inModal) escapes.push(i + ': ' + where.tag + ' ' + where.name);
    }
    t.check('focus cannot leave the dialog, however long you hold Tab',
      escapes.length === 0, escapes.slice(0, 3).join('; ') || '12 presses, all inside');

    const backwards = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Shift+Tab');
      const where = await activeElement(page);
      if (!where.inModal) backwards.push(i + ': ' + where.tag + ' ' + where.name);
    }
    t.check('and it holds going backwards too, which is the half that gets forgotten',
      backwards.length === 0, backwards.slice(0, 3).join('; ') || '6 presses, all inside');

    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    const returned = await activeElement(page);
    t.check('Escape closes it and focus goes back to the control that opened it',
      returned.id === 'premium-cta', JSON.stringify(returned));

    /* ---- the deck, by keyboard alone ---- */

    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');

    // Counting live regions anywhere on the page would pass on the toast host
    // alone, while the deck itself said nothing. This is the deck's own status
    // output, and the check below proves it actually carries the deck's state.
    const status = await page.evaluate(function () {
      const node = document.getElementById('deck-status');
      if (!node) return null;
      return {
        live: node.getAttribute('aria-live'),
        role: node.getAttribute('role'),
        text: (node.textContent || '').trim()
      };
    });
    t.check('the deck has a live status region that says what it is showing',
      !!status && status.role === 'status' && status.live === 'polite' && status.text.length > 0,
      JSON.stringify(status));

    const card = await page.evaluate(function () {
      const node = document.querySelector('#deck-stack .swipe-card');
      return { tabindex: node.getAttribute('tabindex'), label: node.getAttribute('aria-label') || '' };
    });
    t.check('the card is reachable by keyboard and describes who is on it',
      card.tabindex === '0' && /\d/.test(card.label), JSON.stringify(card));

    // The behaviour that makes the deck usable without a pointer: passing a
    // card must not strand you. The card you were on is removed, so focus has
    // to be moved deliberately or it falls to <body>.
    await page.focus('#deck-stack .swipe-card');
    const before = await activeElement(page);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(function (name) {
      const node = document.querySelector('#deck-stack .swipe-card');
      return node && node.getAttribute('aria-label') !== name;
    }, before.name, { timeout: 5000 });
    const after = await activeElement(page);
    t.check('passing a card by keyboard leaves focus on the next one, not on the document',
      after.isBody === false && after.name !== before.name,
      JSON.stringify(before.name) + ' → ' + JSON.stringify(after.name));

    // A region that is live but never written to announces nothing. This is
    // the half that makes the one above worth having: the deck changed under
    // the user with no page load, and the region says so.
    const spoken = await page.evaluate(function () {
      return ((document.getElementById('deck-status') || {}).textContent || '').trim();
    });
    t.check('and the swipe is spoken, so the region is written to and not merely present',
      spoken.length > 0 && spoken !== status.text, JSON.stringify(spoken.slice(0, 60)));

    /* ---- the full explanation is read with the arrow keys ---- */

    // "I" opens "Why this card, in full" and puts the focus in it, and the page
    // is then taller than the screen, so the arrows are how a keyboard reads
    // it. ArrowDown, which the deck does not bind, scrolled. ArrowUp is the
    // deck's super like, and it spent the free plan's one a day on the person
    // being read about. Whether the key was left to the browser is read in the
    // window's own listener, which runs after the deck's: that answer does not
    // depend on how quickly the store would have let a super like through.
    await page.waitForFunction(function () {
      return /likes left today/.test((document.getElementById('usage-hint') || {}).textContent || '');
    }, null, { timeout: 5000 }).catch(function () {});
    await page.focus('#deck-stack .swipe-card');
    const reading = await page.evaluate(function () {
      return document.querySelector('#deck-stack .swipe-card').getAttribute('aria-label');
    });
    await page.keyboard.press('i');
    const panelOpen = await page.waitForSelector('#deck-details:not(.hidden)', { timeout: 5000 })
      .then(function () { return true; }, function () { return false; });
    const hintBefore = await page.textContent('#usage-hint');
    await page.evaluate(function () {
      window.__zcArrowUp = null;
      window.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowUp') window.__zcArrowUp = { prevented: event.defaultPrevented };
      });
    });
    await page.keyboard.press('ArrowUp');
    const readOn = await page.evaluate(function () {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const panel = document.getElementById('deck-details');
      return {
        key: window.__zcArrowUp,
        focusInPanel: !!(panel && panel.contains(document.activeElement)),
        top: card ? card.getAttribute('aria-label') : null,
        hint: (document.getElementById('usage-hint') || {}).textContent || ''
      };
    });
    t.check('ArrowUp inside the full explanation is left to the browser to scroll with, and spends nothing',
      panelOpen && readOn.focusInPanel && !!readOn.key && readOn.key.prevented === false &&
        readOn.top === reading && readOn.hint === hintBefore,
      JSON.stringify({ panelOpen: panelOpen, key: readOn.key, focusInPanel: readOn.focusInPanel }) +
        (readOn.top === reading ? '' : ' top: ' + reading + ' -> ' + readOn.top) +
        (readOn.hint === hintBefore ? '' : ' hint: ' + hintBefore + ' -> ' + readOn.hint));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#deck-details', { state: 'hidden', timeout: 5000 }).catch(function () {});
    await h.closeBurst(page);

    /* ---- a button that its own press disables keeps the keyboard on the deck ---- */

    // Spending the day's last super like disables the Super button, and a
    // disabled button cannot hold the focus: Chromium drops it on <body> the
    // moment the button is disabled, and a screen reader loses its place with
    // it, in the middle of the deck. Somebody who has already liked this
    // account would raise the match overlay, which takes the focus for itself,
    // so this would fail whatever the deck did; the card on top is one of the
    // others first.
    const likers = await page.evaluate(function () {
      return window.ZC.store.getLikesReceived(window.ZC.auth.current.uid).then(function (list) {
        return list.map(function (doc) { return doc.uid; });
      });
    });
    for (let i = 0; i < 10; i += 1) {
      const onTop = await page.evaluate(function () {
        const node = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
        return node ? node.dataset.uid : null;
      });
      if (!onTop || likers.indexOf(onTop) === -1) break;
      await h.pressDeckKey(page, 'ArrowLeft', await h.topCardName(page));
    }
    const superFrom = await h.topCardName(page);
    await page.focus('#btn-super');
    // Pressed from the button itself, with the day's super like still there to
    // spend: a button that was disabled already could not be focused, and
    // would leave this to measure wherever the focus happened to be.
    const superReady = await page.evaluate(function () {
      const button = document.getElementById('btn-super');
      return !button.disabled && document.activeElement === button;
    });
    await page.keyboard.press('Enter');
    const superMoved = await page.waitForFunction(function (name) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const on = card && card.querySelector('.swipe-name');
      return !on || on.textContent.trim() !== name;
    }, superFrom, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
    const afterSuper = await page.evaluate(function () {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const active = document.activeElement;
      return {
        disabled: document.getElementById('btn-super').disabled,
        onTopCard: !!card && active === card,
        active: !active || active === document.body ? 'BODY' : active.tagName + (active.id ? '#' + active.id : ''),
        burst: !!document.querySelector('.match-burst')
      };
    });
    t.check('spending the last super like from its button leaves the focus on the next card, not on the document',
      superReady && superMoved && afterSuper.disabled && afterSuper.onTopCard && !afterSuper.burst,
      JSON.stringify(Object.assign({ pressedFromAnEnabledButton: superReady, deckMoved: superMoved }, afterSuper)));
    await h.closeBurst(page);

    // Retry rebuilds the deck from nothing, and on the way it shows a skeleton
    // with no control in it: the button that had the focus is gone, and the
    // render that brought the cards back did not know anybody had been there.
    // The deck's first read is made to fail once, from before the page script
    // runs and only when the address asks for it, so nothing else here sees it.
    await page.addInitScript(function () {
      if (!/[?&]zcdeckfail=1(&|$)/.test(window.location.search)) return;
      document.addEventListener('DOMContentLoaded', function () {
        const store = window.ZC && window.ZC.store;
        if (!store) return;
        const real = store.listCandidates;
        let failed = false;
        store.listCandidates = function () {
          if (failed) return real.apply(store, arguments);
          failed = true;
          return Promise.reject(new Error('e2e: the first deck read is made to fail'));
        };
      });
    });
    ctx.session.expectConsoleError(/The deck failed to load/);
    await page.goto(ctx.base + '/dashboard.html?zcdeckfail=1', { waitUntil: 'domcontentloaded' });
    const retry = page.locator('#deck-stack button', { hasText: 'Retry' });
    const failedFirst = await retry.waitFor({ timeout: 5000 }).then(function () { return true; }, function () { return false; });
    if (failedFirst) {
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.waitForSelector('#deck-stack .swipe-card', { timeout: 5000 }).catch(function () {});
    }
    ctx.session.expectConsoleError(null);
    const afterRetry = await page.evaluate(function () {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const active = document.activeElement;
      return {
        card: !!card,
        onTopCard: !!card && active === card,
        active: !active || active === document.body ? 'BODY' : active.tagName + (active.id ? '#' + active.id : '')
      };
    });
    t.check('Retry, pressed from the keyboard, leaves the focus on the deck it brought back',
      failedFirst && afterRetry.onTopCard, JSON.stringify(Object.assign({ errorStateShown: failedFirst }, afterRetry)));

    /* ---- the pane swap that was stranding people ---- */

    await page.goto(ctx.base + '/matches.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.match-row, .new-match');
    const row = await page.$('.match-row');
    if (!row) {
      t.check('a conversation row is present to open', false, 'no .match-row rendered');
    } else {
      // The list as the browser exposes it. Links put straight into the <ul>
      // still make a list, but its children are then links, not list items,
      // which leaves a screen reader no items to count or to move between.
      // That is not the case today; this keeps it so.
      const listTree = await axChildRoles(page, '#match-list');
      const rowCount = await page.locator('#match-list .match-row').count();
      t.check('the conversation list reaches a screen reader as a list with one item per conversation',
        !!listTree && listTree.role === 'list' && rowCount > 0 &&
          listTree.children.length === rowCount &&
          listTree.children.every(function (role) { return role === 'listitem'; }),
        JSON.stringify({ tree: listTree, rows: rowCount }));

      // Each row's name, as the accessibility tree has it, must carry what the
      // row shows. An aria-label of name, unread count and stamp replaced the
      // row's content, so a screen reader heard "Devin A., 1 unread message,
      // last activity 1d" and never the message the row displays.
      // Matched by role and accessible name, which is what a screen reader
      // goes by: the preview and the stamp each row shows, in that order.
      const escape = function (text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
      const shownRows = await page.locator('#match-list .match-row').evaluateAll(function (nodes) {
        return nodes.map(function (node) {
          const visible = function (selector) {
            const part = node.querySelector(selector).cloneNode(true);
            Array.prototype.forEach.call(part.querySelectorAll('.sr-only'), function (hidden) { hidden.remove(); });
            return part.textContent.replace(/\s+/g, ' ').trim();
          };
          return { id: node.dataset.matchId, preview: visible('.match-row-preview'), stamp: visible('.match-row-time') };
        });
      });
      const unnamed = [];
      for (const shown of shownRows) {
        const named = page.locator('#match-list').getByRole('link', {
          name: new RegExp(escape(shown.preview) + '.*' + escape(shown.stamp))
        });
        const ids = await named.evaluateAll(function (nodes) { return nodes.map(function (node) { return node.dataset.matchId; }); });
        if (!shown.preview || ids.indexOf(shown.id) === -1) unnamed.push(shown.id + ' shows "' + shown.preview + '"');
      }
      t.check('every conversation row is named by what it shows, the message included',
        shownRows.length > 0 && unnamed.length === 0,
        unnamed.length ? 'not in the name: ' + unnamed.join('; ') : shownRows.length + ' rows');

      await row.focus();
      const fromRow = await activeElement(page);
      t.check('a conversation row takes focus before it is opened',
        fromRow.isBody === false, JSON.stringify(fromRow.name));

      await page.keyboard.press('Enter');
      await page.waitForSelector('#chat-input', { state: 'visible' });
      const inThread = await activeElement(page);
      // The defect this spec was written after: focus fell to <body> here on a
      // phone, because opening repaints the list, destroys the row it came
      // from, and the one line that moved focus onward only ran when both
      // panes were visible.
      t.check('opening a conversation by keyboard puts focus inside the conversation',
        inThread.isBody === false && inThread.inChat === true, JSON.stringify(inThread));

      t.check('and specifically on the composer, which is what you came to do',
        inThread.id === 'chat-input', JSON.stringify(inThread.id));
    }

    /* ---- focus is never scrolled under the header or the tab bar ---- */

    // The header is sticky and the phone's tab bar is fixed, and both are
    // translucent and blurred. When Tab or Shift+Tab moves focus to a control
    // off screen, the browser scrolls it flush to the edge of the viewport —
    // which is where the bar is — unless the page says how much of that edge
    // is taken. Nothing did, and the focused control landed entirely under a
    // bar, a smear behind its icons (WCAG 2.2, 2.4.11 Focus Not Obscured).
    // Measured by this walk: on a phone, 16 of the 184 stops it makes — 7 of
    // them under the tab bar going forwards, 9 under the header going
    // backwards — and on a desktop, 7 of the profile's under the header going
    // backwards.
    //
    // Under reduced motion, so each scroll lands before the press returns and
    // is read without waiting for it: html's smooth scrolling ends where the
    // instant one does, but only later. Both pages are walked both ways,
    // because the header hides what Shift+Tab reaches and the tab bar what
    // Tab reaches.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const buried = [];
    let walked = 0;
    for (const name of ['settings.html', 'profile.html']) {
      for (const key of ['Tab', 'Shift+Tab']) {
        await page.goto(ctx.base + '/' + name, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector(name === 'profile.html' ? '#profile-main:not(.hidden) #interest-groups input' : '#theme-group');
        await page.waitForSelector('[data-zc-nav] .nav-links', { state: 'attached' });
        // Forwards starts from the top of the page; backwards from the last
        // control in <main>, with the page scrolled to its end.
        await page.evaluate(function (backwards) {
          if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
          if (!backwards) {
            window.scrollTo(0, 0);
            return;
          }
          window.scrollTo(0, document.scrollingElement.scrollHeight);
          const controls = Array.prototype.filter.call(
            document.querySelectorAll('main a[href], main button:not([disabled]), main input:not([disabled]), main select, main textarea'),
            function (node) { return node.getClientRects().length > 0; });
          controls[controls.length - 1].focus();
        }, key === 'Shift+Tab');
        let stops = 0;
        for (let i = 0; i < 160; i += 1) {
          await page.keyboard.press(key);
          const stop = await page.evaluate(function () {
            const node = document.activeElement;
            const main = document.querySelector('main');
            if (!node || !main || !main.contains(node)) return null;
            // A chip's or a switch's input is hidden inside its label, and
            // the label is what a person sees take focus.
            const box = (node.tagName === 'INPUT' && node.closest('label')) || node;
            const rect = box.getBoundingClientRect();
            const under = [['header', '[data-zc-nav]'], ['tab bar', '[data-zc-tabbar]']].filter(function (bar) {
              const element = document.querySelector(bar[1]);
              if (!element || getComputedStyle(element).display === 'none') return false;
              const edge = element.getBoundingClientRect();
              return rect.top >= edge.top - 0.5 && rect.bottom <= edge.bottom + 0.5;
            }).map(function (bar) { return bar[0]; });
            return {
              label: (node.getAttribute('aria-label') || (box.textContent || '').trim() || node.name || node.id || node.tagName)
                .replace(/\s+/g, ' ').slice(0, 30),
              top: Math.round(rect.top),
              bottom: Math.round(rect.bottom),
              under: under[0] || ''
            };
          });
          // Out of <main>: through the header or the tab bar on the way in,
          // or past the last control on the way out.
          if (!stop) {
            if (stops > 0) break;
            continue;
          }
          stops += 1;
          if (stop.under) {
            buried.push(name + ' ' + key + ': "' + stop.label + '" at y ' + stop.top + '..' + stop.bottom + ' under the ' + stop.under);
          }
        }
        walked += stops;
      }
    }
    await page.emulateMedia({ reducedMotion: null });
    // Walked both ways, settings and the profile make 184 stops in <main>; a
    // walk that found far fewer stopped early and would pass by looking at
    // nothing.
    t.check('no control the keyboard reaches is scrolled to where the header or the tab bar covers it',
      walked >= 150 && buried.length === 0,
      walked + ' stops walked, ' + buried.length + ' covered' + (buried.length ? ': ' + buried.slice(0, 3).join('; ') : ''));

    /* ---- the daily-limit banner: said once, not once a second ---- */

    // Last, because it moves the clock, and the clock stays moved for the
    // rest of this browser context. Half past eleven is inside the final hour,
    // where the countdown reads minutes and seconds and the banner's sentence
    // is a different sentence every second: the worst case, in which a live
    // region wrapped round the countdown has something new to say once a
    // second.
    const now = new Date();
    await page.clock.install({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 30, 0) });

    // The live regions that are rendered, and what they hold, while there are
    // still likes left and the banner is display:none. Taken once the hint
    // under the deck shows the budget, because the banner is painted in the
    // same call and only after the first card: any earlier, it is hidden
    // whatever the budget says.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    await page.waitForFunction(function () {
      return /likes left today/.test((document.getElementById('usage-hint') || {}).textContent || '');
    }, null, { timeout: 5000 }).catch(function () {});
    const quiet = await page.evaluate(function (selector) {
      const regions = {};
      document.querySelectorAll(selector).forEach(function (node) {
        if (node.id && node.getClientRects().length) regions[node.id] = (node.textContent || '').trim();
      });
      const banner = document.getElementById('limit-banner');
      return {
        regions: regions,
        hint: ((document.getElementById('usage-hint') || {}).textContent || '').trim(),
        bannerShown: !!(banner && banner.getClientRects().length)
      };
    }, LIVE_REGIONS);
    // The snapshot is only worth comparing against if it really was taken with
    // likes left. Taken with them already spent, it would hold what the page
    // says while the banner is up, and a banner that is its own live region
    // would then pass below for an announcement once its countdown moved on.
    const hadLikesLeft = /^[1-9]\d* of \d+ likes left today/.test(quiet.hint) && !quiet.bannerShown;
    // Rendered is not the same as exposed: aria-hidden or visibility:hidden on
    // a region like these, which never takes focus, leaves it on the page but
    // keeps it from a screen reader, and the browser's tree then gives it the
    // role 'none'. (Focus is why that qualifier is there: Chromium's tree
    // keeps a focused button's own role through aria-hidden.) So each region's
    // role is read now, while it is still quiet.
    const quietRoles = {};
    for (const id of Object.keys(quiet.regions)) {
      const node = await axChildRoles(page, '#' + id);
      quietRoles[id] = node ? node.role : 'none';
    }
    const unexposed = Object.keys(quietRoles).filter(function (id) { return quietRoles[id] === 'none'; });

    // Spend what is left of today's likes through the store, as that many
    // right swipes would, and come back to the deck so it paints the banner
    // from them.
    await page.evaluate(function () {
      const uid = window.ZC.auth.current.uid;
      return window.ZC.store.canSpend(uid, 'likes').then(function (budget) {
        return window.ZC.store.bumpUsage(uid, 'likes', budget.remaining);
      });
    });
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    await page.waitForSelector('#limit-banner:not(.hidden)');
    // Allowed to time out: a page that never announces the limit is the
    // failure the next check exists to report, by name, rather than the spec
    // stopping here.
    await page.waitForFunction(function (selector) {
      return Array.prototype.some.call(document.querySelectorAll(selector), function (node) {
        return /midnight/i.test(node.textContent || '');
      });
    }, LIVE_REGIONS, { timeout: 5000 }).catch(function () {});

    // A region that is display:none until the moment it has something to say
    // is not exposed to a screen reader before that moment, so its sentence
    // arrives with it rather than as a change to it. The one that speaks has
    // to have been on the page already, exposed and not yet saying it.
    const speaking = await page.evaluate(function (selector) {
      return Array.prototype.filter.call(document.querySelectorAll(selector), function (node) {
        const text = node.textContent || '';
        return /\blikes\b/i.test(text) && /midnight/i.test(text);
      }).map(function (node) {
        return { id: node.id || node.className || node.tagName, text: (node.textContent || '').trim() };
      });
    }, LIVE_REGIONS);
    const announcer = speaking.filter(function (region) {
      return Object.prototype.hasOwnProperty.call(quiet.regions, region.id) &&
        unexposed.indexOf(region.id) === -1 && quiet.regions[region.id] !== region.text;
    })[0];
    t.check('running out of likes is announced, by a live region that was on the page before there was anything to say',
      hadLikesLeft && !!announcer,
      (hadLikesLeft ? '' : 'no likes left before: ' + JSON.stringify(quiet.hint) +
        ', banner ' + (quiet.bannerShown ? 'up' : 'down') + '; ') +
        (unexposed.length ? 'rendered but not exposed before: ' + unexposed.join(', ') + '; ' : '') +
        JSON.stringify(speaking) + ' rendered before: ' + Object.keys(quiet.regions).join(', '));

    // And then it is left alone. The countdown is watched as well as every
    // live region, so a countdown that had stopped could not pass this by
    // silence.
    const ticking = await page.evaluate(function (selector) {
      return new Promise(function (resolve) {
        const changed = {};
        const observers = Array.prototype.map.call(document.querySelectorAll(selector), function (node) {
          const observer = new MutationObserver(function (records) {
            const key = node.id || node.className || node.tagName;
            changed[key] = (changed[key] || 0) + records.length;
          });
          observer.observe(node, { subtree: true, childList: true, characterData: true });
          return observer;
        });
        const countdown = document.getElementById('limit-text');
        const shown = [countdown ? countdown.textContent : ''];
        const ticks = new MutationObserver(function () { shown.push(countdown.textContent); });
        if (countdown) ticks.observe(countdown, { subtree: true, childList: true, characterData: true });
        window.setTimeout(function () {
          observers.forEach(function (observer) { observer.disconnect(); });
          ticks.disconnect();
          resolve({
            liveChanges: changed,
            ticks: shown.length - 1,
            distinct: shown.filter(function (text, i) { return shown.indexOf(text) === i; }).length,
            last: shown[shown.length - 1]
          });
        }, 3500);
      });
    }, LIVE_REGIONS);
    t.check('and the countdown under it keeps ticking without any live region repeating it',
      ticking.ticks >= 2 && ticking.distinct >= 2 && Object.keys(ticking.liveChanges).length === 0,
      JSON.stringify(ticking));

    // Once means once for as long as the banner is up, and the countdown is
    // not the only thing that comes back to it. A like refused under the
    // banner repaints it on the way to saying why, in the deck's own region;
    // the region that made the announcement must not be written to again.
    // Where no region made it, whichever regions are saying the banner's
    // sentence are held to the same, so a banner that is its own live region
    // is too. The deck's region has to change, or the refusal never ran and
    // the quiet would prove nothing.
    const said = announcer ? [announcer.id] : speaking.map(function (region) { return region.id; });
    await page.evaluate(function (selector) {
      const changed = {};
      const observers = Array.prototype.map.call(document.querySelectorAll(selector), function (node) {
        const observer = new MutationObserver(function (records) {
          const key = node.id || node.className || node.tagName;
          changed[key] = (changed[key] || 0) + records.length;
        });
        observer.observe(node, { subtree: true, childList: true, characterData: true });
        return observer;
      });
      window.__zcLiveWrites = { changed: changed, observers: observers };
    }, LIVE_REGIONS);
    await page.focus('#deck-stack .swipe-card');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(function () {
      return /unavailable/i.test((document.getElementById('deck-status') || {}).textContent || '');
    }, null, { timeout: 5000 }).catch(function () {});
    const refused = await page.evaluate(function () {
      const watch = window.__zcLiveWrites;
      delete window.__zcLiveWrites;
      watch.observers.forEach(function (observer) { observer.disconnect(); });
      return {
        liveChanges: watch.changed,
        deck: ((document.getElementById('deck-status') || {}).textContent || '').trim()
      };
    });
    t.check('and a like refused under it is said by the deck, without the region that announced it being written to again',
      (refused.liveChanges['deck-status'] || 0) > 0 &&
        said.every(function (id) { return !refused.liveChanges[id]; }),
      JSON.stringify({ watched: said, liveChanges: refused.liveChanges, deck: refused.deck }));
  }
};
