/* The premium simulation, which is the one page in this app that makes an
   ethical claim rather than a technical one: that it is honest about taking
   no money. The README calls it "an honest, non-deceptive plan comparison",
   Limitations says "no payment is processed", and until now nothing checked
   either sentence. subscription.js was the only page script in the project
   with no test of any kind.

   That mattered twice over. The disclosure is a promise to whoever runs this,
   and it is exactly the kind of copy that gets softened later by someone
   making the page "convert better". And the same page is the entitlement
   switch: `plan` gates rewind, the who-liked-you list, the adaptive term in
   the ranking engine and the daily limits, so a bug here is not cosmetic.

   So this checks the words AND the behaviour, and in particular that
   declining the confirmation changes nothing — a dialog you cannot say no to
   is not consent. The behaviour is read at the gates rather than off the plan
   field: what the deck's budget hint says and what it asked the ranking
   engine for, with the limits table changed underneath it once to show the
   deck follows the table the page prints. */
'use strict';

/** Phrases the disclosure must actually contain, not merely gesture at. */
const DISCLOSURE = ['no payment', 'no card', 'simulation'];

/* The same three promises as they appear in the confirmation dialog, which says
   "a simulated upgrade" rather than "a simulation" — so the last one is matched
   on its stem. All three are required: a dialog that keeps one of them and
   quietly drops the others is exactly the softening this spec exists to catch. */
const DIALOG_DISCLOSURE = ['no payment', 'no card', 'simulat'];

/**
 * Instruments every page this spec opens. Each page here is its own document,
 * so this is an init script, and it runs again on every navigation before any
 * page script does. Everything it does is inert unless a URL asks for it:
 *
 *   - it records the `adaptive` option the deck hands the ranking engine, and
 *     the one the matches page's profile card hands it to score one person.
 *     That is the gate's decision itself; its effect on a score is invisible
 *     for an account that has not swiped enough to have learned anything;
 *   - `?zcfixedweights=1` turns premium's `adaptiveWeights` off in the limits
 *     table as firebase-config.js publishes it. It has to happen then:
 *     subscription.js builds its comparison from the table as it loads;
 *   - it counts the store calls that read `users/{uid}`, and `?zcusagefail=1`
 *     makes the usage read fail, the way it does offline.
 * @returns {void}
 */
function instrument() {
  const params = new URLSearchParams(window.location.search);
  const fixedWeights = params.get('zcfixedweights') === '1';
  const usageFails = params.get('zcusagefail') === '1';
  window.__zcAdaptive = [];
  window.__zcScored = [];
  window.__zcReads = { getUser: 0, getUsage: 0, updateUser: 0 };

  const ZC = window.ZC = window.ZC || {};
  let config;
  Object.defineProperty(ZC, 'config', {
    configurable: true,
    enumerable: true,
    get: function () { return config; },
    set: function (value) {
      if (fixedWeights && value && value.limits && value.limits.premium) {
        value.limits.premium.adaptiveWeights = false;
      }
      config = value;
    }
  });

  // Same deferred-wrap shape as 03-matches: the engine and the store exist by
  // DOMContentLoaded, and every call this records comes later — the deck
  // ranks, and the plans page reads its counters, only once the first auth
  // state has settled, and a switch only on a click.
  document.addEventListener('DOMContentLoaded', function () {
    if (!ZC.matching || !ZC.store) return;
    const engine = ZC.matching;
    const rank = engine.rankCandidates;
    engine.rankCandidates = function (me, list, opts) {
      window.__zcAdaptive.push(!!opts && opts.adaptive === true);
      return rank.apply(engine, arguments);
    };
    const score = engine.scoreCandidate;
    engine.scoreCandidate = function (me, other, opts) {
      window.__zcScored.push(!!opts && opts.adaptive === true);
      return score.apply(engine, arguments);
    };
    const store = ZC.store;
    Object.keys(window.__zcReads).forEach(function (name) {
      const real = store[name];
      store[name] = function () {
        window.__zcReads[name] += 1;
        if (name === 'getUsage' && usageFails) {
          return Promise.reject(new Error('Failed to get document because the client is offline.'));
        }
        return real.apply(store, arguments);
      };
    });
  });
}

module.exports = {
  title: 'The premium simulation: honest about it, and correct about it',
  viewports: ['mobile', 'desktop'],

  async run(t, page, ctx) {
    const h = ctx.harness;

    /**
     * The deck's own account of today's budget and how it ranked, once the
     * budget read has landed. The hint under the cards is painted after the
     * first card, so reading it as soon as a card shows can catch it early.
     * @returns {Promise<{hint:string, adaptive:boolean[]}>}
     */
    async function deckState() {
      await page.waitForSelector('#deck-stack .swipe-card');
      await page.waitForFunction(function () {
        const hint = document.getElementById('usage-hint');
        return !!hint && /likes/i.test(hint.textContent || '');
      });
      return page.evaluate(function () {
        return {
          hint: (document.getElementById('usage-hint').textContent || '').trim().toLowerCase(),
          adaptive: window.__zcAdaptive.slice()
        };
      });
    }

    /** True when every ranking so far was asked for with `adaptive` set to `on`. */
    function rankedWith(deck, on) {
      return deck.adaptive.length > 0 && deck.adaptive.every(function (value) { return value === on; });
    }

    await page.addInitScript(instrument);
    await h.signIn(page, ctx.base);

    /* ---- the free plan, as the deck applies it, before anything changes ---- */

    // The contrast the premium checks below need: without it, a deck that gave
    // everyone the premium limits would pass them.
    const freeDeck = await deckState();
    const freeLimit = await page.evaluate(function () { return window.ZC.config.limits.free.likesPerDay; });
    t.check('on Free, the deck counts likes against the free daily limit in the table',
      freeDeck.hint.indexOf(' of ' + freeLimit + ' likes left today') !== -1,
      JSON.stringify(freeDeck.hint.slice(0, 60)));
    t.check('and ranks on the fixed weights, as the plans page says Free does',
      rankedWith(freeDeck, false), JSON.stringify(freeDeck.adaptive));

    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#subscription-page');

    /* ---- the disclosure itself ---- */

    const notice = ((await page.locator('#simulation-notice').textContent()) || '').toLowerCase();
    const missing = DISCLOSURE.filter(function (phrase) { return notice.indexOf(phrase) === -1; });
    t.check('the page says plainly that nothing is charged',
      missing.length === 0,
      missing.length ? 'missing from the notice: ' + missing.join(', ') : 'all present');

    // A page that takes no money has no business asking for any. This is the
    // check that would fail first if the simulation ever grew a real checkout
    // without the docs catching up.
    const paymentFields = await page.evaluate(function () {
      const suspect = /card|cvv|cvc|expiry|billing|iban|account.?number|payment|\bcc[-_ ]?(?:name|number|exp|csc)\b/i;
      return Array.prototype.filter.call(
        document.querySelectorAll('input, select, textarea'),
        function (el) {
          // The visible label counts too: a checkout field is just as much a
          // checkout field when its name is `field3` and only the text beside
          // it says "Card number".
          const labels = Array.prototype.map.call(el.labels || [], function (label) {
            return label.textContent || '';
          }).join(' ');
          return suspect.test((el.type || '') + ' ' + (el.name || '') + ' ' +
            (el.id || '') + ' ' + (el.placeholder || '') + ' ' +
            (el.getAttribute('autocomplete') || '') + ' ' + labels);
        }
      ).length;
    });
    t.check('and collects no payment details anywhere on it',
      paymentFields === 0, paymentFields + ' payment-ish field(s)');

    const cta = ((await page.locator('#premium-cta').textContent()) || '').toLowerCase();
    t.check('the upgrade button itself says there is no payment',
      cta.indexOf('no payment') !== -1, JSON.stringify(cta.trim()));

    // The tick and the cross are the only thing separating an included feature
    // from a missing one, so they have to reach a screen reader as words. Read
    // as the accessibility tree has them: a crossed-out row used to be a bare
    // "✕" in front of its name, and the rewinds row "✕ No rewinds".
    await page.waitForSelector('#free-features .plan-feature');
    const rows = (await page.locator('#free-features').ariaSnapshot())
      .split('\n')
      .map(function (line) { return /listitem: "?(.*?)"?$/.exec(line.trim()); })
      .filter(Boolean)
      .map(function (match) { return match[1]; });
    const offCount = await page.locator('#free-features .plan-feature.is-off').count();
    const unspoken = rows.filter(function (name) {
      return !/^(Included|Not included): \S/.test(name) || /^Not included: No /.test(name);
    });
    t.check('every free-plan row says whether it is included, and a missing one names the feature',
      rows.length > 0 && offCount > 0 && unspoken.length === 0 &&
        rows.filter(function (name) { return name.indexOf('Not included: ') === 0; }).length === offCount,
      unspoken.length ? 'read as: ' + JSON.stringify(unspoken) : rows.length + ' rows, ' + offCount + ' not included');

    /* ---- declining has to mean declining ---- */

    const planOf = function () {
      return page.evaluate(function () {
        return window.ZC.auth.doc ? window.ZC.auth.doc.plan : null;
      });
    };
    t.check('the account starts on the free plan', (await planOf()) === 'free', String(await planOf()));

    await page.click('#premium-cta');
    await page.waitForSelector('.modal-backdrop .modal-body');
    const dialog = ((await page.locator('.modal-backdrop .modal-body').textContent()) || '').toLowerCase();
    const dropped = DIALOG_DISCLOSURE.filter(function (phrase) { return dialog.indexOf(phrase) === -1; });
    t.check('the confirmation repeats the disclosure rather than assuming it was read',
      dropped.length === 0,
      dropped.length ? 'missing from the dialog: ' + dropped.join(', ')
        : JSON.stringify(dialog.trim().slice(0, 80)));

    await h.clickModalAction(page, 'Not now');
    await page.waitForSelector('.modal-backdrop', { state: 'detached' });
    t.check('declining the confirmation leaves the plan alone',
      (await planOf()) === 'free', String(await planOf()));

    /* ---- accepting it, and the entitlement that follows ---- */

    await page.click('#premium-cta');
    // Counted from the confirmation on, so the page's own boot is not in it.
    await page.evaluate(function () { window.__zcReads = { getUser: 0, getUsage: 0, updateUser: 0 }; });
    await h.clickModalAction(page, 'Switch it on (no payment)');
    await page.waitForFunction(function () {
      return window.ZC.auth.doc && window.ZC.auth.doc.plan === 'premium';
    });
    t.check('accepting it switches the plan on', (await planOf()) === 'premium', 'premium');

    // The toast is raised once the switch has finished repainting, so every read
    // it was going to make has been made. In firebase mode each of these calls
    // is one billed read of users/{uid}: updateUser's is the transaction's own,
    // and getUser's is auth.js refreshing the cached profile. The counters need
    // no third: the write hands back the document it committed, usage and all.
    await page.locator('.toast', { hasText: 'Premium simulation on' }).waitFor();
    const reads = await page.evaluate(function () { return window.__zcReads; });
    t.check('switching reads the account twice, not a third time for the counters the write returned',
      reads.updateUser === 1 && reads.getUser === 1 && reads.getUsage === 0,
      JSON.stringify(reads));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#subscription-page');
    await page.waitForFunction(function () { return !!window.ZC.auth.doc; });
    t.check('and it survives a reload, so it was stored rather than shown',
      (await planOf()) === 'premium', String(await planOf()));

    // The point of the switch: the deck has to actually treat the account
    // differently. The word "Premium" in the hint is no evidence of that — it
    // is the plan field, printed back. "Unlimited likes" is: it is drawn only
    // when the store's answer carries the premium limit from the table.
    await page.goto(ctx.base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
    const premiumDeck = await deckState();
    t.check('the deck applies the premium limits, not just the premium label',
      premiumDeck.hint.indexOf('unlimited likes') !== -1, JSON.stringify(premiumDeck.hint.slice(0, 60)));
    t.check('and ranks with the adaptive term the plans page promises Premium',
      rankedWith(premiumDeck, true), JSON.stringify(premiumDeck.adaptive));

    /* ---- the limits table is the one source, for the deck and the page alike ---- */

    // The same account, with the table saying premium ranks on fixed weights.
    // A gate that asks the plan's name instead of the table still turns the
    // term on here, and the plans page — which does read the table — then
    // advertises the opposite of what the deck does.
    await page.goto(ctx.base + '/dashboard.html?zcfixedweights=1', { waitUntil: 'domcontentloaded' });
    const fixedDeck = await deckState();
    t.check('the deck takes the adaptive term from the limits table, not from the plan name',
      rankedWith(fixedDeck, false), JSON.stringify(fixedDeck.adaptive));

    await page.goto(ctx.base + '/subscription.html?zcfixedweights=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#feature-rows tr');
    const rankingRow = await page.evaluate(function () {
      const row = Array.prototype.filter.call(document.querySelectorAll('#feature-rows tr'), function (tr) {
        return /adapts to your swipes/i.test(tr.querySelector('th').textContent || '');
      })[0];
      return row ? row.querySelectorAll('td')[1].textContent.trim() : null;
    });
    t.check('and the plans page, reading the same table, says what that deck does',
      rankingRow === 'Off — fixed weights', JSON.stringify(rankingRow));

    // And the third reader: a match's full card on the matches page scores
    // them again. It asked the plan's name, so under this table it scored with
    // the adaptive term the deck had just ranked them without.
    await page.goto(ctx.base + '/matches.html?zcfixedweights=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#match-list .match-row');
    await page.locator('#match-list .match-row').first().click();
    await page.waitForSelector('#chat:not(.hidden)');
    await page.click('#chat-menu');
    await h.clickModalAction(page, 'View profile');
    await page.waitForSelector('.modal-backdrop .swipe-card');
    const scored = await page.evaluate(function () { return window.__zcScored.slice(); });
    t.check('and so does a match\'s card on the matches page',
      scored.length > 0 && scored.every(function (adaptive) { return adaptive === false; }), JSON.stringify(scored));
    await h.clickModalAction(page, 'Close');

    /* ---- a usage read that fails is not a day with nothing used ---- */

    // Offline, or on any Firestore error, the counters are unknown. Painting
    // zeros tells someone who has used every like today that they have all of
    // them left.
    await page.goto(ctx.base + '/subscription.html?zcusagefail=1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#usage-list[aria-busy="false"]');
    const unread = await page.evaluate(function () {
      return {
        asked: window.__zcReads.getUsage,
        list: (document.getElementById('usage-list').textContent || '').replace(/\s+/g, ' ').trim()
      };
    });
    t.check('a usage read that fails says so, rather than showing a full allowance',
      unread.asked > 0 && /could not be read/i.test(unread.list) &&
      !/\bleft\b|\bused\b|no daily limit/i.test(unread.list),
      JSON.stringify(unread));

    /* ---- and back, because a simulation you cannot leave is worse ---- */

    await page.goto(ctx.base + '/subscription.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#free-cta');
    await page.waitForSelector('#usage-list[aria-busy="false"]');
    // The counters a switch gets back can belong to a day that has ended: a page
    // left open across midnight. Stored here as yesterday at the ceiling, so
    // showing them as today's would be loud. The store has to be asked instead,
    // and its roll-over is what answers.
    await page.evaluate(function () {
      const yesterday = window.ZC.util.todayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
      return window.ZC.store.updateUser(window.ZC.auth.current.uid, {
        usage: { date: yesterday, likes: 25, superLikes: 1, rewinds: 3 }
      }).then(function () {
        window.__zcReads = { getUser: 0, getUsage: 0, updateUser: 0 };
      });
    });
    await page.click('#free-cta');
    await h.clickModalAction(page, 'Switch back to Free');
    await page.waitForFunction(function () {
      return window.ZC.auth.doc && window.ZC.auth.doc.plan === 'free';
    });
    const after = await page.evaluate(function () {
      return { plan: window.ZC.auth.doc.plan, since: window.ZC.auth.doc.planSince };
    });
    t.check('switching back to Free clears the premium stamp as well as the plan',
      after.plan === 'free' && !after.since, JSON.stringify(after));

    await page.locator('.toast', { hasText: 'Back on the Free plan' }).waitFor();
    const rolled = await page.evaluate(function () {
      return {
        asked: window.__zcReads.getUsage,
        list: (document.getElementById('usage-list').textContent || '').replace(/\s+/g, ' ').trim()
      };
    });
    t.check('counters the switch returned from an earlier day go to the store, not onto the page',
      rolled.asked === 1 && new RegExp('Likes ?0 of ' + freeLimit + ' used').test(rolled.list),
      JSON.stringify(rolled));
  }
};
