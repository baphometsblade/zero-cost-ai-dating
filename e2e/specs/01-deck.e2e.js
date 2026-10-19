/* Landing -> demo sign-in -> the deck, and the keyboard that drives it. */
'use strict';

/**
 * Wait for `selector` to reach `state`, and answer rather than throw.
 *
 * Three checks in this spec used to record a literal `true` straight after a
 * wait for the thing they name. That shape cannot fail. The wait had no bound
 * of its own, only the session's twenty-second default, and running out of it
 * throws; the runner records the throw as "spec ran to completion", so the
 * check that names the regression never prints at all. Measured with the demo
 * button left hidden, Escape left inert and "?" left inert in turn. Answered
 * here instead, the outcome is something a check can say FAIL about.
 * @param {Object} page a Playwright Page
 * @param {string} selector what to wait for
 * @param {string} state 'visible' or 'detached'
 * @returns {Promise<boolean>} whether it got there within five seconds
 */
function reached(page, selector, state) {
  return page.waitForSelector(selector, { state: state, timeout: 5000 })
    .then(function () { return true; }, function () { return false; });
}

/** The uid and the name on the deck's top card; empty strings when there is none. */
function topCard(page) {
  return page.evaluate(function () {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    const name = card && card.querySelector('.swipe-name');
    return { uid: (card && card.dataset.uid) || '', name: name ? name.textContent.trim() : '' };
  });
}

/**
 * Whether the deck moves off the card `uid` within five seconds: another card
 * on top, or none left. Answered rather than thrown, for the reason `reached`
 * gives.
 * @param {Object} page a Playwright Page
 * @param {string} uid the card that was on top
 * @returns {Promise<boolean>}
 */
function movedOff(page, uid) {
  return page.waitForFunction(function (was) {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    return !card || card.dataset.uid !== was;
  }, uid, { timeout: 5000 }).then(function () { return true; }, function () { return false; });
}

/**
 * Whether `predicate(arg)` comes true in the page within five seconds.
 * Answered rather than thrown, for the reason `reached` gives.
 * @param {Object} page a Playwright Page
 * @param {Function} predicate runs in the page
 * @param {*} [arg] handed to the predicate
 * @returns {Promise<boolean>}
 */
function becomes(page, predicate, arg) {
  return page.waitForFunction(predicate, arg, { timeout: 5000 })
    .then(function () { return true; }, function () { return false; });
}

/** The hint under the deck, and whether the Super button can be pressed. */
function budgetShown(page) {
  return page.evaluate(function () {
    const hint = document.getElementById('usage-hint');
    const button = document.getElementById('btn-super');
    return { hint: hint ? hint.textContent.trim() : '', superDisabled: !!(button && button.disabled) };
  });
}

/**
 * The decision the signed-in account has stored on `uid`, looked for until
 * five seconds have passed; null when there is none by then.
 *
 * The polling happens inside the page because `page.waitForFunction` cannot
 * wait on the store. A predicate that returns a Promise counts as true the
 * first time it is called, so the wait settles on that single read and its
 * timeout never applies. Measured: a value set 800 ms later came back as null
 * after 59 ms, and with the demo store's swipe write delayed by 150 ms — a
 * latency, not a regression — the version of the key checks below that waited
 * that way failed all three.
 * @param {Object} page a Playwright Page
 * @param {string} me the signed-in account
 * @param {string} uid the person swiped on
 * @returns {Promise<string|null>} 'pass', 'like' or 'super', or null
 */
function storedAction(page, me, uid) {
  return page.evaluate(function (args) {
    const deadline = Date.now() + 5000;
    function poll() {
      return window.ZC.store.getSwipes(args.me).then(function (list) {
        const swipe = list.filter(function (item) { return item.to === args.uid; })[0];
        if (swipe) return swipe.action;
        if (Date.now() > deadline) return null;
        return new Promise(function (resolve) { window.setTimeout(resolve, 50); }).then(poll);
      });
    }
    return poll();
  }, { me: me, uid: uid });
}

module.exports = {
  title: 'Deck, scoring and keyboard',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;

    await page.goto(ctx.base + '/index.html', { waitUntil: 'domcontentloaded' });
    // The button ships with .hidden, and decorateLanding takes it off only
    // where a demo session is possible.
    const offered = await reached(page, '[data-cta="demo"]:not(.hidden)', 'visible');
    const cta = await page.evaluate(function () {
      const button = document.querySelector('[data-cta="demo"]');
      if (!button) return 'no demo button on the page';
      return '"' + button.textContent.trim() + '"' + (button.classList.contains('hidden') ? ', still hidden' : '');
    });
    // Everything after this starts from that button.
    if (!t.check('landing offers the demo sign-in', offered, cta)) return;

    await page.click('[data-cta="demo"]');
    await page.waitForURL(h.pageUrl('dashboard'));
    await page.waitForSelector('#deck-stack .swipe-card');

    const card = await page.evaluate(function () {
      const top = document.querySelector('#deck-stack .swipe-card');
      const score = top.querySelector('.match-score-value');
      return {
        name: (top.querySelector('.swipe-name') || {}).textContent || '',
        score: score ? score.textContent.trim() : null,
        reasons: top.querySelectorAll('.reason').length,
        usage: (document.getElementById('usage-hint') || {}).textContent || ''
      };
    });
    t.check('demo sign-in reaches the dashboard with a card', card.name.trim().length > 0, card.name.trim());
    t.check('the card carries a match score', /^\d{1,3}$/.test(String(card.score)), 'score=' + card.score);
    t.check('the card explains itself with reasons', card.reasons > 0, 'reasons=' + card.reasons);
    t.check('the usage hint names the daily like budget', /likes/i.test(card.usage), card.usage.trim());

    /* ---- the like count drops as the card leaves, not when the write lands ---- */

    // `remainingOf` subtracts a `reserved` counter that `commit` bumps the moment
    // a swipe is committed, so the hint can drop before the write has landed —
    // which is what `updateUsageHint`'s comment claims. Nothing on the committed
    // path repainted it, so the number sat at its old value until `persistSwipe`
    // finished and `refreshBudgets` came back. Read synchronously right after the
    // key, with no wait: a check that polled would be satisfied by the late
    // repaint this exists to stop relying on.
    // The write is slowed to two seconds first, and that is what makes this a
    // check rather than decoration. The counter is read once the deck has
    // advanced, and in demo mode the write lands before that — so the late
    // repaint through `refreshBudgets` produced the same number, and a first
    // version of this check passed against a build with the fix removed.
    // With `recordSwipe` held open, the only thing that can have moved the
    // counter is the reservation.
    await page.evaluate(function () {
      const store = window.ZC.store;
      const real = store.recordSwipe.bind(store);
      window.__zcRealRecordSwipe = store.recordSwipe;
      store.recordSwipe = function () {
        const args = arguments;
        return new Promise(function (resolve) { window.setTimeout(resolve, 2000); })
          .then(function () { return real.apply(null, args); });
      };
    });

    const readLikes = function () {
      return page.evaluate(function () {
        const m = /(\d+) of (\d+) likes left/.exec(document.getElementById('usage-hint').textContent || '');
        return m ? Number(m[1]) : null;
      });
    };
    const likesBefore = await readLikes();
    const liked = await topCard(page);
    // Pressed directly rather than through `pressDeckKey`, whose wait throws
    // when the deck does not move. That throw came before every check that
    // names a key, so an ArrowRight that did nothing, or a keyboard handler
    // that ignored every key, was reported only as "spec ran to completion".
    // Measured, both.
    await page.keyboard.press('ArrowRight');
    const moved = await movedOff(page, liked.uid);
    const likesAfter = await readLikes();
    await h.closeBurst(page);

    t.check('a like drops the counter under the deck immediately, not when the write lands',
      moved && likesBefore !== null && likesAfter === likesBefore - 1,
      moved
        ? likesBefore + ' -> ' + likesAfter + ' likes left, with the swipe write still in ' +
          'flight — only the reservation can have moved it'
        : 'ArrowRight left ' + (liked.name || 'no card') + ' on top; ' +
          likesBefore + ' -> ' + likesAfter + ' likes left');

    // Put it back, and let the held write finish: everything after this drives the
    // deck at its ordinary speed, and a store left wrapped times the rest out.
    await page.evaluate(function () {
      window.ZC.store.recordSwipe = window.__zcRealRecordSwipe;
    });
    await page.waitForTimeout(2200);

    /* ---- keyboard swipes advance the deck ---- */
    // A right or up swipe onto someone who already liked you raises the match
    // overlay, which then owns the keyboard — so each step clears it first,
    // BEFORE its key. The held like above is one of those on this seed: its
    // overlay goes up during the wait just before this loop, and a key pressed
    // under it does nothing.
    //
    // Not pressed through `pressDeckKey`, whose wait — "a match overlay is up,
    // or the top card changed" — was this check's entire condition, so the
    // check could only print PASS, and that leftover overlay satisfied it before
    // the key had done anything. Measured: "ArrowLeft advances the deck" passed,
    // as "Theo L.25 -> match overlay", against a build whose ArrowLeft did
    // nothing, and the whole spec stayed green with ArrowLeft liking instead of
    // passing. So each key is checked by what it leaves behind: its own
    // decision stored against the card that was on top, and another card there.
    const me = await page.evaluate(function () { return window.ZC.auth.current.uid; });
    const decisions = { ArrowLeft: 'pass', ArrowUp: 'super', ArrowRight: 'like' };
    const words = { pass: 'a pass', super: 'a super like', like: 'a like' };
    for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowRight']) {
      await h.closeBurst(page);
      const before = await topCard(page);
      await page.keyboard.press(key);
      // A swipe is written after its card has gone, so the store is looked at
      // until the deadline, and "nothing stored" is an answer the check
      // reports rather than a throw.
      const stored = await storedAction(page, me, before.uid);
      const after = await topCard(page);
      const burst = (await page.locator('.match-burst').count()) > 0;
      t.check(key + ' advances the deck with ' + words[decisions[key]],
        before.uid !== '' && stored === decisions[key] && after.uid !== before.uid,
        (before.name || 'no card') + ' -> ' + (after.name || 'no card') + (burst ? ' and a match overlay' : '') +
        ', stored for ' + (before.name || 'nobody') + ': ' + (stored || 'nothing'));
    }
    await h.closeBurst(page);

    /* ---- one press, one swipe ---- */

    // Holding a key down makes the operating system send its keydown again,
    // many times a second, each time with `repeat` set; Playwright's
    // keyboard.down on a key that is already down sends exactly that. The deck
    // used to take each repeat as a fresh swipe whenever it was free to: a
    // held ← passed one profile per repeat, faster than anybody could see
    // them, and a held → went on spending likes, neither of which the free
    // plan can rewind. A held Enter on one of the deck's buttons did the same
    // by another road, because Chromium clicks a focused button again on
    // every repeated Enter. A pass is what is held here because it never
    // waits on the store, so every repeat the deck acted on is a card gone by
    // the time the key comes up. The repeats the page saw are counted, so that a
    // Playwright that stopped sending them could not pass this by sending
    // nothing.
    const liveUids = function () {
      return page.evaluate(function () {
        return Array.prototype.map.call(
          document.querySelectorAll('#deck-stack .swipe-card:not([data-exiting])'),
          function (node) { return node.dataset.uid || ''; });
      });
    };
    const holdKey = async function (key) {
      await page.evaluate(function () {
        window.__zcRepeats = 0;
        if (window.__zcRepeatCounter) return;
        window.__zcRepeatCounter = function (event) { if (event.repeat) window.__zcRepeats += 1; };
        window.addEventListener('keydown', window.__zcRepeatCounter, true);
      });
      await page.keyboard.down(key);
      for (let i = 0; i < 10; i += 1) await page.keyboard.down(key);
      await page.keyboard.up(key);
      return page.evaluate(function () { return window.__zcRepeats; });
    };

    for (const held of [{ key: 'ArrowLeft', on: null, name: 'holding ←' },
      { key: 'Enter', on: '#btn-pass', name: 'holding Enter on the Pass button' }]) {
      if (held.on) await page.focus(held.on);
      const stackBefore = await liveUids();
      const repeats = await holdKey(held.key);
      const stackAfter = await liveUids();
      const decided = stackBefore[0] ? await storedAction(page, me, stackBefore[0]) : null;
      const gone = stackBefore.indexOf(stackAfter[0]);
      t.check(held.name + ' passes one profile, not one for every auto-repeat',
        repeats === 10 && stackBefore.length > 1 && stackAfter[0] === stackBefore[1] && decided === 'pass',
        repeats + ' repeats seen; ' + (gone === -1 ? 'every card in view left' : gone + ' card(s) left') +
          ', stored for the first: ' + (decided || 'nothing'));
    }

    /* ---- a swipe that lands but cannot finish ---- */

    // recordSwipe writes the swipe and then goes looking for a match, so a
    // failure can arrive after the decision is already stored. The deck used to
    // read every failure as "the swipe is not stored" and put the card back —
    // which invites a second, contradictory decision that the store will not
    // record, because a recorded swipe stands.
    await page.evaluate(function () {
      const real = window.ZC.store.recordSwipe;
      window.__zcRealRecordSwipe = real;
      window.ZC.store.recordSwipe = async function () {
        await real.apply(window.ZC.store, arguments);
        const err = new Error('Failed to get document because the client is offline.');
        err.code = 'unavailable';
        err.swipeStored = true;
        throw err;
      };
    });

    const stranded = await h.topCardName(page);

    // Pressed directly rather than through pressDeckKey, which waits for the top
    // card to change: the failure path being tested *puts the card back*, and on
    // the demo store it does so fast enough to win that race — so the helper
    // would time out before any check ran, reporting a regression as "spec ran
    // to completion" rather than as the thing that regressed. It did exactly
    // that the first two times this was written.
    await page.keyboard.press('ArrowLeft');

    // Wait for whichever answer the deck gives — the two differ only in their
    // words, and waiting for one of them turns a regression into a twenty-second
    // selector timeout reported as "spec ran to completion" instead of as the
    // check that means something. Which is what it did, the first time.
    const said = await page.waitForFunction(function () {
      const toasts = Array.prototype.map.call(document.querySelectorAll('.toast'), function (node) {
        return (node.textContent || '').trim();
      }).filter(function (text) { return /saved|did not save/i.test(text); });
      return toasts.length ? toasts[toasts.length - 1] : null;
    }).then(function (handle) { return handle.jsonValue(); });

    t.check('a swipe that saved is not reported as lost',
      !/did not save/i.test(said) && /saved/i.test(said), said);

    t.check('and the card it was aimed at does not come back',
      (await h.topCardName(page)) !== stranded, stranded + ' -> ' + (await h.topCardName(page)));

    // The deck renders a stack, not one card, so a card put back into the queue
    // would sit behind the top one and resurface on the next advance. The
    // exiting card is excluded rather than waited out: it is still in the DOM
    // while its animation runs, and counting it made this check red for the
    // wrong reason the first time it was written.
    const requeued = await page.evaluate(function (name) {
      return Array.prototype.map.call(
        document.querySelectorAll('#deck-stack .swipe-card:not([data-exiting]) .swipe-name'),
        function (node) { return node.textContent.trim(); }
      );
    }, stranded);
    t.check('nor anywhere else in the stack',
      requeued.indexOf(stranded) === -1, 'stack: ' + JSON.stringify(requeued));

    await page.evaluate(function () {
      window.ZC.store.recordSwipe = window.__zcRealRecordSwipe;
      delete window.__zcRealRecordSwipe;
    });
    await h.closeBurst(page);

    /* ---- a swipe that fails while the next one waits for its budget ---- */

    // A like reads its budget before it takes the card; a pass waits for
    // nothing. So a pass whose write fails can put its card back on top while
    // the like after it is still waiting, and `commit` used to take whatever
    // was on top when the read came back: the card just put back, under the
    // like's name, leaving the liked one on top. Both are held here and let go
    // in that order, so the overlap is the one thing that can happen rather
    // than a race the check usually wins. The failure is shaped like Firestore's
    // offline read at the top of `recordSwipe`: no `swipeStored` mark, so the
    // swipe never landed.
    const putBack = await topCard(page);
    await page.evaluate(function () {
      const store = window.ZC.store;
      const held = { recordSwipe: store.recordSwipe, canSpend: store.canSpend, fail: null, budget: null };
      window.__zcHeld = held;
      store.recordSwipe = function () {
        if (held.fail) return held.recordSwipe.apply(store, arguments);
        return new Promise(function (resolve, reject) {
          held.fail = function () {
            const err = new Error('Failed to get document because the client is offline.');
            err.code = 'unavailable';
            reject(err);
          };
        });
      };
      store.canSpend = function () {
        const args = arguments;
        return new Promise(function (resolve) { held.budget = resolve; })
          .then(function () { return held.canSpend.apply(store, args); });
      };
    });
    await page.keyboard.press('ArrowLeft');
    const passWaiting = await becomes(page, function (was) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      return !!window.__zcHeld.fail && !!card && card.dataset.uid !== was;
    }, putBack.uid);
    const takenNext = await topCard(page);
    await page.keyboard.press('ArrowRight');
    const likeWaiting = passWaiting && await becomes(page, function () { return !!window.__zcHeld.budget; });
    if (likeWaiting) await page.evaluate(function () { window.__zcHeld.fail(); });
    const backOnTop = likeWaiting && await becomes(page, function (uid) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      return !!card && card.dataset.uid === uid;
    }, putBack.uid);
    if (likeWaiting) await page.evaluate(function () { window.__zcHeld.budget(); });
    const likedNext = backOnTop ? await storedAction(page, me, takenNext.uid) : null;
    const raced = await page.evaluate(function () {
      const store = window.ZC.store;
      store.recordSwipe = window.__zcHeld.recordSwipe;
      store.canSpend = window.__zcHeld.canSpend;
      delete window.__zcHeld;
      return {
        stack: Array.prototype.map.call(
          document.querySelectorAll('#deck-stack .swipe-card:not([data-exiting])'),
          function (card) { return card.dataset.uid; }),
        said: (document.getElementById('deck-status').textContent || '').trim()
      };
    });
    t.check('a swipe that fails while the next one waits for its budget gets its own card back, and the next one takes its own',
      backOnTop && likedNext === 'like' && raced.stack[0] === putBack.uid &&
        raced.stack.indexOf(takenNext.uid) === -1,
      (passWaiting ? '' : 'the pass never reached its write; ') + (likeWaiting ? '' : 'the like never asked for its budget; ') +
      putBack.name + ' failed, ' + takenNext.name + ' stored as ' + (likedNext || 'nothing') +
      '; on top now: ' + raced.stack[0] + ', stack ' + JSON.stringify(raced.stack) + '; said ' + JSON.stringify(raced.said));
    await h.closeBurst(page);

    /* ---- a card decided somewhere else ---- */

    // A recorded decision stands, so `recordSwipe` writes no swipe when the
    // pair already has one: two tabs on one deck, or two devices. The deck has
    // already said "Liked …" by then, and it used to go on to count the like
    // and teach the learning map a like that was never recorded. The pass is
    // stored the way the other tab's deck would store it, through the store,
    // and a pass moves no counter there.
    const elsewhere = await topCard(page);
    const untouched = await page.evaluate(function (args) {
      const store = window.ZC.store;
      return store.recordSwipe(args.me, args.uid, 'pass').then(function () {
        return Promise.all([store.getUsage(args.me), store.getUser(args.me)]);
      }).then(function (got) {
        return {
          likes: got[0].likes,
          learning: JSON.stringify(got[1].learning || null),
          hint: (document.getElementById('usage-hint').textContent || '').trim()
        };
      });
    }, { me: me, uid: elsewhere.uid });
    await page.keyboard.press('ArrowRight');
    const told = await page.waitForFunction(function () {
      const toasts = Array.prototype.map.call(document.querySelectorAll('.toast'), function (node) {
        return (node.textContent || '').trim();
      }).filter(function (text) { return /already/i.test(text); });
      return toasts.length ? toasts[toasts.length - 1] : null;
    }, null, { timeout: 5000 }).then(function (handle) { return handle.jsonValue(); }, function () { return null; });
    // The like is reserved the moment it is pressed, so the counter drops; it
    // has to come back once the store has answered, or the like was spent.
    const restored = await becomes(page, function (hint) {
      return (document.getElementById('usage-hint').textContent || '').trim() === hint;
    }, untouched.hint);
    const afterwards = await page.evaluate(function (args) {
      const store = window.ZC.store;
      return Promise.all([store.getUsage(args.me), store.getUser(args.me), store.getSwipes(args.me)]).then(function (got) {
        return {
          likes: got[0].likes,
          learning: JSON.stringify(got[1].learning || null),
          stored: got[2].filter(function (swipe) { return swipe.to === args.uid; }).map(function (swipe) { return swipe.action; }),
          hint: (document.getElementById('usage-hint').textContent || '').trim(),
          said: (document.getElementById('deck-status').textContent || '').trim()
        };
      });
    }, { me: me, uid: elsewhere.uid });
    t.check('a like on a card already passed elsewhere says the pass stands, and spends no like and teaches nothing',
      !!told && /passed/i.test(told) && restored && afterwards.likes === untouched.likes &&
        afterwards.learning === untouched.learning && afterwards.stored.join() === 'pass',
      elsewhere.name + ': toast ' + JSON.stringify(told) + ', said ' + JSON.stringify(afterwards.said) +
      ', likes ' + untouched.likes + ' -> ' + afterwards.likes + ', hint ' + JSON.stringify(afterwards.hint) +
      ', learning ' + (afterwards.learning === untouched.learning ? 'unchanged' : 'changed') +
      ', stored ' + JSON.stringify(afterwards.stored));
    await h.closeBurst(page);

    /* ---- a write that landed although the deck was told it had not ---- */

    // Then the deck puts the card back itself, and a retry of the same
    // decision finds that first write on record. Nobody counted it, because
    // the failure came back before anything was counted, so the retry is
    // counted once and taught, and nothing is said about an earlier decision:
    // the earlier decision is this one. The stub makes the real write and
    // then rejects with no `swipeStored` mark, as a failure before the write
    // would, and puts the real `recordSwipe` back as it does, so the retry
    // goes through the store untouched.
    const retried = await topCard(page);
    const beforeRetry = await page.evaluate(function (me) {
      const store = window.ZC.store;
      const real = store.recordSwipe;
      store.recordSwipe = function () {
        store.recordSwipe = real;
        return real.apply(store, arguments).then(function () {
          const err = new Error('The swipe was not confirmed.');
          err.code = 'unavailable';
          throw err;
        });
      };
      // Every toast already up is marked, so only the ones raised from here on
      // are read: the "already" toast of the check above may still be showing.
      Array.prototype.forEach.call(document.querySelectorAll('.toast'), function (node) {
        node.dataset.zcSeen = '1';
      });
      return Promise.all([store.getUsage(me), store.getUser(me)]).then(function (got) {
        return { likes: got[0].likes, learning: JSON.stringify(got[1].learning || null) };
      });
    }, me);
    await page.keyboard.press('ArrowRight');
    // `persistSwipe` raises its toast straight after putting the card back.
    const cameBack = await becomes(page, function (uid) {
      const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
      const said = Array.prototype.some.call(document.querySelectorAll('.toast:not([data-zc-seen])'), function (node) {
        return /did not save/.test(node.textContent || '');
      });
      return said && !!card && card.dataset.uid === uid;
    }, retried.uid);
    if (cameBack) await page.keyboard.press('ArrowRight');
    // Polled in the page, for the reason `storedAction` gives.
    const counted = await page.evaluate(function (args) {
      const store = window.ZC.store;
      const deadline = Date.now() + 5000;
      function poll() {
        return Promise.all([store.getUsage(args.me), store.getUser(args.me), store.getSwipes(args.me)]).then(function (got) {
          const now = {
            likes: got[0].likes,
            learning: JSON.stringify(got[1].learning || null),
            stored: got[2].filter(function (swipe) { return swipe.to === args.uid; }).map(function (swipe) { return swipe.action; }),
            toasts: Array.prototype.map.call(document.querySelectorAll('.toast:not([data-zc-seen])'), function (node) {
              return (node.textContent || '').trim();
            })
          };
          if ((now.likes === args.likes + 1 && now.learning !== args.learning) || Date.now() > deadline) return now;
          return new Promise(function (resolve) { window.setTimeout(resolve, 50); }).then(poll);
        });
      }
      return poll();
    }, { me: me, uid: retried.uid, likes: beforeRetry.likes, learning: beforeRetry.learning });
    t.check('a retry that finds its own first write on record is counted once and taught, and told of no earlier decision',
      cameBack && counted.likes === beforeRetry.likes + 1 && counted.learning !== beforeRetry.learning &&
        counted.stored.join() === 'like' &&
        !counted.toasts.some(function (text) { return /already/i.test(text); }),
      retried.name + ': ' + (cameBack ? '' : 'the card never came back; ') +
      'likes ' + beforeRetry.likes + ' -> ' + counted.likes +
      ', learning ' + (counted.learning === beforeRetry.learning ? 'unchanged' : 'changed') +
      ', stored ' + JSON.stringify(counted.stored) + ', toasts ' + JSON.stringify(counted.toasts));
    await h.closeBurst(page);

    /* ---- a card decided somewhere else, whose match check then fails ---- */

    // The store answers a pair that already has a decision by running the
    // match check on the decision on record, and when that check failed, its
    // rejection said only that the swipe was stored. So the deck counted the
    // like and taught it, for a swipe that was never recorded, and said
    // "Saved". The like on record is made through the store, as another tab's
    // deck would make it, after a like from the other side, so it is mutual and
    // the check has a match to write; and the match write is refused, the way
    // a full browser storage refuses it, for that like and for the deck's.
    // The deck's toasts are recorded as they are raised rather than read off
    // the page afterwards, because a toast removes itself after a few seconds.
    const decidedThere = await topCard(page);
    const beforeFailed = await page.evaluate(function (args) {
      const store = window.ZC.store;
      const realSetItem = window.Storage.prototype.setItem;
      window.__zcRealSetItem = realSetItem;
      window.Storage.prototype.setItem = function (key, value) {
        if (this === window.localStorage && key === store.KEYS.matches) {
          throw new window.DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return realSetItem.call(this, key, value);
      };
      return store.recordSwipe(args.uid, args.me, 'like').then(function () {
        return store.recordSwipe(args.me, args.uid, 'like').then(function () {
          return 'resolved';
        }, function (err) {
          return err && err.swipeStored ? 'stored, unchecked' : 'rejected: ' + (err && err.message);
        });
      }).then(function (made) {
        window.__zcToasts = [];
        window.__zcToastWatch = new window.MutationObserver(function (records) {
          records.forEach(function (record) {
            Array.prototype.forEach.call(record.addedNodes, function (node) {
              if (node.classList && node.classList.contains('toast')) {
                window.__zcToasts.push((node.textContent || '').trim());
              }
            });
          });
        });
        window.__zcToastWatch.observe(document.body, { childList: true, subtree: true });
        return Promise.all([store.getUsage(args.me), store.getUser(args.me)]).then(function (got) {
          return {
            made: made,
            likes: got[0].likes,
            learning: JSON.stringify(got[1].learning || null),
            hint: (document.getElementById('usage-hint').textContent || '').trim()
          };
        });
      });
    }, { me: me, uid: decidedThere.uid });
    await page.keyboard.press('ArrowRight');
    // The like is reserved the moment it is pressed, so the hint drops; it
    // comes back once the deck's bookkeeping for this swipe has finished.
    const toldThere = await becomes(page, function () {
      return window.__zcToasts.some(function (text) { return /already|saved/i.test(text); });
    });
    const settledThere = await becomes(page, function (hint) {
      return (document.getElementById('usage-hint').textContent || '').trim() === hint;
    }, beforeFailed.hint);
    const afterFailed = await page.evaluate(function (args) {
      const store = window.ZC.store;
      const toasts = window.__zcToasts;
      window.__zcToastWatch.disconnect();
      window.Storage.prototype.setItem = window.__zcRealSetItem;
      delete window.__zcRealSetItem;
      delete window.__zcToastWatch;
      delete window.__zcToasts;
      return Promise.all([store.getUsage(args.me), store.getUser(args.me), store.getSwipes(args.me)]).then(function (got) {
        return {
          toasts: toasts,
          likes: got[0].likes,
          learning: JSON.stringify(got[1].learning || null),
          stored: got[2].filter(function (swipe) { return swipe.to === args.uid; }).map(function (swipe) { return swipe.action; }),
          stack: Array.prototype.map.call(
            document.querySelectorAll('#deck-stack .swipe-card:not([data-exiting])'),
            function (card) { return card.dataset.uid; })
        };
      });
    }, { me: me, uid: decidedThere.uid });
    t.check('a like on a card liked elsewhere, whose match check fails, says the like stands, and spends no like and teaches nothing',
      beforeFailed.made === 'stored, unchecked' && toldThere && settledThere &&
        afterFailed.likes === beforeFailed.likes && afterFailed.learning === beforeFailed.learning &&
        afterFailed.stored.join() === 'like' && afterFailed.stack.indexOf(decidedThere.uid) === -1 &&
        afterFailed.toasts.some(function (text) { return /^You had already liked .* that decision stands/.test(text); }) &&
        afterFailed.toasts.some(function (text) { return /^We could not check for a match/.test(text); }) &&
        !afterFailed.toasts.some(function (text) { return /^Saved/.test(text); }),
      'likes ' + beforeFailed.likes + ' -> ' + afterFailed.likes +
      ', learning ' + (afterFailed.learning === beforeFailed.learning ? 'unchanged' : 'changed') +
      ', stored ' + JSON.stringify(afterFailed.stored) +
      (afterFailed.stack.indexOf(decidedThere.uid) === -1 ? '' : ', the card is back in the stack') +
      '; ' + decidedThere.name + ': the like elsewhere ' + beforeFailed.made + '; toasts ' + JSON.stringify(afterFailed.toasts));
    await h.closeBurst(page);

    /* ---- the shortcuts modal ---- */
    await page.click('#btn-shortcuts');
    await page.waitForSelector('.modal[role="dialog"]');
    const opened = await page.evaluate(function () {
      const dialog = document.querySelector('.modal[role="dialog"]');
      const title = dialog.querySelector('.modal-title');
      return {
        modal: dialog.getAttribute('aria-modal') === 'true',
        labelled: !!(title && title.id && dialog.getAttribute('aria-labelledby') === title.id),
        focusInside: dialog.contains(document.activeElement)
      };
    });
    t.check('the shortcuts modal is a labelled dialog', opened.modal && opened.labelled, JSON.stringify(opened));
    t.check('focus moves into the shortcuts modal', opened.focusInside);
    const shortcutsTitle = (await page.textContent('.modal[role="dialog"] .modal-title')).trim();

    await page.keyboard.press('Escape');
    const closed = await reached(page, '.modal[role="dialog"]', 'detached');
    const focusAfter = await page.evaluate(function () {
      return document.activeElement ? document.activeElement.id : null;
    });
    const escaped = t.check('Escape closes the shortcuts modal', closed, closed ? '' : 'still open after Escape');
    t.check('Escape returns focus to the opener', focusAfter === 'btn-shortcuts', 'activeElement=#' + focusAfter);
    // With the dialog still up, the one below would be found before "?" did anything.
    if (!escaped) return;

    // The "?" key is the documented way in, and it is a separate code path.
    // Told apart by its title, because any dialog at all satisfied the wait
    // this check used to follow.
    await page.keyboard.press('Shift+Slash');
    const asked = await reached(page, '.modal[role="dialog"]', 'visible');
    const askedTitle = asked ? (await page.textContent('.modal[role="dialog"] .modal-title')).trim() : '';
    t.check('"?" opens the shortcuts modal', asked && askedTitle === shortcutsTitle,
      asked ? 'title=' + askedTitle : 'no dialog opened');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[role="dialog"]', { state: 'detached' });

    /* ---- left open across midnight ---- */

    // Last, because it moves the clock, and the clock stays moved for the rest
    // of this browser context. The free super like spent and likes left is the
    // ordinary evening, and the one the deck used to get wrong: a swipe re-reads
    // the budgets, but the only thing that re-read them because the day had
    // turned was the limit banner's countdown, which runs only while the LIKES
    // are used up. So a deck nobody touched went on giving yesterday's numbers,
    // with the Super button disabled, into the new day until the next swipe.
    const now = new Date();
    await page.clock.install({ time: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 58, 0) });
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const spendToday = function () {
      return page.evaluate(function () {
        return window.ZC.store.updateUser(window.ZC.auth.current.uid, {
          usage: { date: window.ZC.util.todayKey(), likes: 3, superLikes: 1, rewinds: 0 }
        });
      });
    };
    const superSpent = function () {
      return becomes(page, function () {
        const button = document.getElementById('btn-super');
        return /\b0 super likes left/.test(document.getElementById('usage-hint').textContent || '') &&
          !!button && button.disabled;
      });
    };
    const superBack = function () {
      return becomes(page, function () {
        const button = document.getElementById('btn-super');
        const text = document.getElementById('usage-hint').textContent || '';
        const likes = /^(\d+) of (\d+) likes left today/.exec(text);
        return !!likes && likes[1] === likes[2] && /\b1 super like left/.test(text) && !!button && !button.disabled;
      });
    };
    await spendToday();
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const evening = await superSpent();
    const beforeMidnight = await budgetShown(page);
    // Three minutes on: past midnight, with every timer the page set run on the
    // way, which is what an open tab gets.
    await page.clock.runFor(3 * 60 * 1000);
    const morning = evening && await superBack();
    const afterMidnight = await budgetShown(page);
    t.check('left open across midnight, the deck re-reads its budgets: the new day\'s likes, its super like and the Super button',
      evening && morning,
      JSON.stringify(beforeMidnight) + ' -> ' + JSON.stringify(afterMidnight));

    // A machine asleep across midnight runs no timers while it sleeps, and a
    // timer that was due during the sleep is not something to count on
    // afterwards. `setSystemTime` is that case: it moves `Date` a day on and
    // leaves every timer the page set exactly where it was. What the person
    // does next is come back to the tab.
    await spendToday();
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const asleep = await superSpent();
    const beforeSleep = await budgetShown(page);
    const nextDay = await page.evaluate(function () { return Date.now() + 24 * 60 * 60 * 1000; });
    await page.clock.setSystemTime(nextDay);
    await page.evaluate(function () { document.dispatchEvent(new Event('visibilitychange')); });
    const awake = asleep && await superBack();
    const afterSleep = await budgetShown(page);
    t.check('and a tab come back to on a later day re-reads them too, with no timer having run',
      asleep && awake,
      JSON.stringify(beforeSleep) + ' -> ' + JSON.stringify(afterSleep) + ' on ' + new Date(nextDay).toDateString());

    // A page the browser kept whole in its back/forward cache comes back with
    // `pageshow` rather than a load. The event is dispatched by hand, as
    // `visibilitychange` is above: what is checked is that the deck listens
    // for it, with the day moved on the same way.
    await spendToday();
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck-stack .swipe-card');
    const kept = await superSpent();
    const beforeKept = await budgetShown(page);
    const dayAfter = await page.evaluate(function () { return Date.now() + 24 * 60 * 60 * 1000; });
    await page.clock.setSystemTime(dayAfter);
    await page.evaluate(function () {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    const shownAgain = kept && await superBack();
    const afterKept = await budgetShown(page);
    t.check('and so does a page given back by the back/forward cache on a later day',
      kept && shownAgain,
      JSON.stringify(beforeKept) + ' -> ' + JSON.stringify(afterKept) + ' on ' + new Date(dayAfter).toDateString());
  }
};
