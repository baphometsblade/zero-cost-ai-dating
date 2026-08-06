/* ==========================================================================
   Zero Cost AI Dating — plans
   An honest plan comparison. Premium is a local simulation: switching it on
   writes plan: 'premium' to your own user document and nothing else happens —
   no payment, no request, no third party. It exists so the daily limits and
   the premium-only paths can actually be exercised.

   Every number on this page is read from ZC.config.limits, the same table the
   swipe deck enforces, so the page can never advertise something the app does
   not do.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // This file is the plans page script; every other page has no such root.
  const root = document.getElementById('subscription-page');
  if (!root) return;
  if (!ZC.util || typeof ZC.util.el !== 'function') {
    console.error('[zc] subscription.js needs js/utils.js to be loaded first.');
    return;
  }
  // Tolerate being loaded twice.
  if (root.dataset.zcSubscription === '1') return;
  root.dataset.zcSubscription = '1';

  const util = ZC.util;
  const ui = ZC.ui || {};
  const el = util.el;

  /* ------------------------------------------------------------------------
     1. Limits and copy
     ------------------------------------------------------------------------ */

  /** Fallbacks only matter if firebase-config.js failed to load. */
  const LIMITS = (ZC.config && ZC.config.limits) || {
    free: { likesPerDay: 25, superLikesPerDay: 1, rewinds: 0, seeLikedYou: false, adaptiveWeights: false },
    premium: { likesPerDay: Infinity, superLikesPerDay: 5, rewinds: Infinity, seeLikedYou: true, adaptiveWeights: true }
  };

  /**
   * Render a numeric limit for a table cell.
   * @param {number} value a limit from ZC.config.limits
   * @returns {string}
   */
  function limitText(value) {
    if (value === Infinity) return 'Unlimited';
    if (!value) return 'Not included';
    return String(value);
  }

  /** The comparison table, built from the live limits table. */
  const FEATURES = [
    {
      label: 'Likes a day',
      free: limitText(LIMITS.free.likesPerDay),
      premium: limitText(LIMITS.premium.likesPerDay)
    },
    {
      label: 'Super likes a day',
      free: limitText(LIMITS.free.superLikesPerDay),
      premium: limitText(LIMITS.premium.superLikesPerDay)
    },
    {
      label: 'Rewinds a day',
      free: limitText(LIMITS.free.rewinds),
      premium: limitText(LIMITS.premium.rewinds)
    },
    {
      label: 'See who liked you',
      free: LIMITS.free.seeLikedYou ? 'Shown' : 'Hidden behind a blur',
      premium: LIMITS.premium.seeLikedYou ? 'Shown in full' : 'Hidden behind a blur'
    },
    {
      label: 'Ranking adapts to your swipes',
      free: LIMITS.free.adaptiveWeights ? 'On' : 'Off — fixed weights',
      premium: LIMITS.premium.adaptiveWeights ? 'On' : 'Off — fixed weights'
    },
    { label: 'Reasons behind every match score', free: 'Always', premium: 'Always' },
    { label: 'Messages with your matches', free: 'Unlimited', premium: 'Unlimited' },
    { label: 'Ads, trackers and data sales', free: 'None', premium: 'None' },
    { label: 'What it costs you', free: '$0', premium: '$0 — the upgrade is simulated' }
  ];

  /**
   * Render a daily allowance as a plan bullet.
   * @param {number} value a limit from ZC.config.limits
   * @param {string} singular e.g. 'like'
   * @param {string} plural e.g. 'likes'
   * @returns {string}
   */
  function countText(value, singular, plural) {
    if (value === Infinity) return 'Unlimited ' + plural;
    if (!value) return 'No ' + plural;
    return value + ' ' + (value === 1 ? singular : plural) + ' a day';
  }

  /** Bullet lists on the two plan cards. `on: false` renders as a crossed-out row. */
  const FREE_BULLETS = [
    { text: countText(LIMITS.free.likesPerDay, 'like', 'likes'), on: true },
    { text: countText(LIMITS.free.superLikesPerDay, 'super like', 'super likes'), on: true },
    { text: 'Every score explained, in plain language', on: true },
    { text: 'Unlimited messages with your matches', on: true },
    { text: 'No ads, no trackers, no data sales', on: true },
    // Crossed-out rows name the feature, so the ✕ is never a double negative.
    { text: countText(LIMITS.free.rewinds, 'rewind', 'rewinds'), on: !!LIMITS.free.rewinds },
    { text: 'See who liked you', on: !!LIMITS.free.seeLikedYou },
    { text: 'Ranking that learns from your swipes', on: !!LIMITS.free.adaptiveWeights }
  ];

  const PREMIUM_BULLETS = [
    { text: countText(LIMITS.premium.likesPerDay, 'like', 'likes'), on: true },
    { text: countText(LIMITS.premium.superLikesPerDay, 'super like', 'super likes'), on: true },
    { text: countText(LIMITS.premium.rewinds, 'rewind', 'rewinds'), on: !!LIMITS.premium.rewinds },
    { text: 'See everyone who liked you', on: !!LIMITS.premium.seeLikedYou },
    { text: 'Ranking learns from what you swipe on', on: !!LIMITS.premium.adaptiveWeights },
    { text: 'Everything on the Free plan', on: true },
    { text: 'Costs nothing, because nothing is charged', on: true }
  ];

  /** Which usage counter belongs to which limit, in display order. */
  const USAGE_ROWS = [
    { field: 'likes', limitKey: 'likesPerDay', label: 'Likes' },
    { field: 'superLikes', limitKey: 'superLikesPerDay', label: 'Super likes' },
    { field: 'rewinds', limitKey: 'rewinds', label: 'Rewinds' }
  ];

  /* ------------------------------------------------------------------------
     2. DOM handles
     ------------------------------------------------------------------------ */

  const dom = {
    planBadge: document.getElementById('plan-badge'),
    planSummary: document.getElementById('plan-summary'),
    usageList: document.getElementById('usage-list'),
    usageReset: document.getElementById('usage-reset'),
    planFree: document.getElementById('plan-free'),
    planPremium: document.getElementById('plan-premium'),
    freeFeatures: document.getElementById('free-features'),
    premiumFeatures: document.getElementById('premium-features'),
    freeCta: document.getElementById('free-cta'),
    premiumCta: document.getElementById('premium-cta'),
    featureRows: document.getElementById('feature-rows')
  };

  /** The signed-in user document. */
  let me = null;

  /**
   * Fire a toast when the overlay layer is present.
   * @param {string} message text to show
   * @param {'info'|'success'|'warn'|'error'} [kind='info'] tone
   * @returns {void}
   */
  function toast(message, kind) {
    if (typeof ui.toast === 'function') ui.toast(message, kind || 'info');
  }

  /**
   * Put a button into or out of its loading state.
   * @param {HTMLElement} button the control
   * @param {boolean} on whether work is running
   * @param {string} [label] text while busy
   * @returns {void}
   */
  function busy(button, on, label) {
    if (!button) return;
    if (typeof ui.setBusy === 'function') {
      ui.setBusy(button, on, label);
      return;
    }
    button.disabled = !!on;
  }

  /**
   * Empty a node.
   * @param {HTMLElement} node container to clear
   * @returns {HTMLElement} the same node
   */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /* ------------------------------------------------------------------------
     3. Static sections
     ------------------------------------------------------------------------ */

  /**
   * Fill one plan card's bullet list.
   * @param {HTMLElement} list the .plan-features element
   * @param {Array<{text:string, on:boolean}>} bullets what the plan does and does not do
   * @returns {void}
   */
  function renderBullets(list, bullets) {
    clear(list);
    bullets.forEach(function (bullet) {
      list.appendChild(el('li', {
        class: 'plan-feature' + (bullet.on ? '' : ' is-off'),
        text: bullet.text
      }));
    });
  }

  /**
   * Fill the feature comparison table.
   * @returns {void}
   */
  function renderTable() {
    clear(dom.featureRows);
    FEATURES.forEach(function (feature) {
      dom.featureRows.appendChild(el('tr', {}, [
        el('th', { text: feature.label, attrs: { scope: 'row' } }),
        el('td', { text: feature.free }),
        el('td', { text: feature.premium })
      ]));
    });
  }

  /* ------------------------------------------------------------------------
     4. Current plan and today's usage
     ------------------------------------------------------------------------ */

  /**
   * How long until the daily counters reset, in words.
   * @returns {string} e.g. 'in about 5 hours'
   */
  function timeToMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const minutes = Math.max(1, Math.round((midnight.getTime() - now.getTime()) / 60000));
    if (minutes < 60) return 'in ' + minutes + (minutes === 1 ? ' minute' : ' minutes');
    const hours = Math.round(minutes / 60);
    return 'in about ' + hours + (hours === 1 ? ' hour' : ' hours');
  }

  /**
   * One usage row: the counter, its limit and a meter when the limit is finite.
   * @param {Object} row entry from USAGE_ROWS
   * @param {Object} usage today's counters
   * @param {Object} limits the active plan's limits
   * @returns {HTMLElement}
   */
  function usageRow(row, usage, limits) {
    const used = Math.max(0, Number(usage[row.field]) || 0);
    const limit = limits[row.limitKey];
    const wrap = el('div', { class: 'stack stack-sm' });

    if (limit === Infinity) {
      wrap.appendChild(el('div', { class: 'spread' }, [
        el('span', { text: row.label }),
        el('span', { class: 'pill', text: used + ' today · no daily limit' })
      ]));
      return wrap;
    }

    const remaining = Math.max(0, limit - used);
    wrap.appendChild(el('div', { class: 'spread' }, [
      el('span', { text: row.label }),
      el('span', {
        class: 'text-muted',
        text: limit === 0
          ? 'Not on this plan'
          : used + ' of ' + limit + ' used · ' + remaining + ' left'
      })
    ]));

    // The meter is decoration for a number that is already written out, so it
    // is hidden from assistive tech rather than repeated.
    const pct = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
    const fill = el('div', { class: 'meter-fill' + (pct >= 100 ? ' is-weak' : '') });
    fill.style.setProperty('width', pct + '%');
    wrap.appendChild(el('div', { class: 'meter', attrs: { 'aria-hidden': 'true' } }, [fill]));
    return wrap;
  }

  /**
   * Repaint the "your plan" card from the user document and today's counters.
   * @param {Object} usage today's counters from ZC.store.getUsage
   * @returns {void}
   */
  function renderCurrent(usage) {
    const premium = me.plan === 'premium';
    const limits = premium ? LIMITS.premium : LIMITS.free;

    dom.planBadge.textContent = premium ? 'Premium (simulated)' : 'Free';
    dom.planBadge.classList.toggle('badge-premium', premium);

    dom.planSummary.textContent = premium
      ? 'You are on the simulated Premium plan' +
        (me.planSince ? ', switched on ' + util.fmtDate(me.planSince) + '.' : '.') +
        ' Nothing was charged and nothing is owed — it is a flag on your own profile, and you can switch back below.'
      : 'You are on the Free plan, which is the real one. Premium below is a simulation you can switch on to see how the limits and the premium-only features behave.';

    clear(dom.usageList);
    dom.usageList.setAttribute('aria-busy', 'false');
    USAGE_ROWS.forEach(function (row) {
      dom.usageList.appendChild(usageRow(row, usage, limits));
    });
    dom.usageReset.textContent = 'Counters reset at midnight, ' + timeToMidnight() + '. Passing on someone never costs anything.';
  }

  /**
   * Mark which plan card is the current one and set both button labels.
   * @returns {void}
   */
  function renderPlanCards() {
    const premium = me.plan === 'premium';

    dom.planFree.classList.toggle('is-current', !premium);
    dom.planPremium.classList.toggle('is-current', premium);

    dom.freeCta.textContent = premium ? 'Switch back to Free' : 'Your current plan';
    dom.freeCta.disabled = !premium;
    dom.freeCta.setAttribute('aria-disabled', String(!premium));

    dom.premiumCta.textContent = premium ? 'Your current plan' : 'Switch to Premium (no payment)';
    dom.premiumCta.disabled = premium;
    dom.premiumCta.setAttribute('aria-disabled', String(premium));
  }

  /**
   * Re-read today's counters and repaint everything that depends on the plan.
   * @returns {Promise<void>}
   */
  async function refresh() {
    let usage = { date: util.todayKey(), likes: 0, superLikes: 0, rewinds: 0 };
    try {
      usage = await ZC.store.getUsage(me.uid);
    } catch (err) {
      console.warn('[zc] Could not read today\'s usage.', err);
    }
    renderCurrent(usage);
    renderPlanCards();
  }

  /* ------------------------------------------------------------------------
     5. Switching plans
     ------------------------------------------------------------------------ */

  /**
   * Write the new plan to the user document and repaint.
   * @param {'free'|'premium'} plan the plan to move to
   * @returns {Promise<void>}
   */
  async function setPlan(plan) {
    const updated = await ZC.store.updateUser(me.uid, {
      plan: plan,
      planSince: plan === 'premium' ? new Date().toISOString() : null
    });
    me = updated || me;
    // Keep the cached doc (nav badges, the deck's adaptive flag) in step.
    if (ZC.auth && typeof ZC.auth.refresh === 'function') {
      try {
        await ZC.auth.refresh();
      } catch (err) {
        console.warn('[zc] Plan saved but the cached profile did not refresh.', err);
      }
    }
    await refresh();
    // The "who liked you" badge only exists on the premium plan.
    if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
  }

  /**
   * Turn the simulated Premium plan on, after a confirmation that repeats the
   * no-payment notice in full.
   * @returns {Promise<void>}
   */
  async function onUpgrade() {
    const confirmed = typeof ui.confirm === 'function'
      ? await ui.confirm(
        'This is a simulated upgrade. No payment is processed, no card details are asked for and no money changes hands.\nIt sets plan: "premium" on your own profile so the daily limits, the rewind button, the who-liked-you list and the adaptive ranking can be tried out.\nYou can switch back to Free at any time, from this page.',
        {
          title: 'Switch on the simulated Premium plan?',
          confirmLabel: 'Switch it on (no payment)',
          cancelLabel: 'Not now',
          variant: 'primary'
        }
      )
      : true;
    if (!confirmed) return;

    busy(dom.premiumCta, true, 'Switching…');
    try {
      await setPlan('premium');
      toast('Premium simulation on. Nothing was charged.', 'success');
    } catch (err) {
      console.error('[zc] Could not switch the plan:', err);
      toast('Could not change the plan. Please try again.', 'error');
    } finally {
      busy(dom.premiumCta, false);
      renderPlanCards();
    }
  }

  /**
   * Turn the simulation back off.
   * @returns {Promise<void>}
   */
  async function onDowngrade() {
    const confirmed = typeof ui.confirm === 'function'
      ? await ui.confirm(
        'This puts you back on the Free plan straight away.\nThe daily limits come back, rewinds stop working, the who-liked-you list blurs again and ranking returns to the default weights. Your matches, messages and swipe history are untouched.\nAs there was never a payment, there is nothing to refund and nothing to cancel.',
        {
          title: 'Switch back to Free?',
          confirmLabel: 'Switch back to Free',
          cancelLabel: 'Stay on Premium',
          variant: 'danger'
        }
      )
      : true;
    if (!confirmed) return;

    busy(dom.freeCta, true, 'Switching…');
    try {
      await setPlan('free');
      toast('Back on the Free plan.', 'success');
    } catch (err) {
      console.error('[zc] Could not switch the plan:', err);
      toast('Could not change the plan. Please try again.', 'error');
    } finally {
      busy(dom.freeCta, false);
      renderPlanCards();
    }
  }

  /* ------------------------------------------------------------------------
     6. Boot
     ------------------------------------------------------------------------ */

  /**
   * Start the page: require an account, then paint the plans and the usage.
   * @returns {Promise<void>}
   */
  async function boot() {
    // The comparison is true whether or not anyone is signed in, so it is
    // painted before the guard runs.
    renderBullets(dom.freeFeatures, FREE_BULLETS);
    renderBullets(dom.premiumFeatures, PREMIUM_BULLETS);
    renderTable();

    if (!ZC.auth || typeof ZC.auth.requireAuth !== 'function' || !ZC.store) {
      console.error('[zc] subscription.js needs auth.js and data-store.js.');
      toast('The app scripts did not all load. Try reloading the page.', 'error');
      return;
    }

    try {
      // Redirects (and never resolves) when signed out.
      const doc = await ZC.auth.requireAuth();
      if (!doc) return;
      me = doc;
      await refresh();
      dom.premiumCta.addEventListener('click', onUpgrade);
      dom.freeCta.addEventListener('click', onDowngrade);
    } catch (err) {
      console.error('[zc] The plans page could not start:', err);
      dom.planSummary.textContent = 'Your plan could not be loaded. Reload the page to try again.';
      dom.usageList.setAttribute('aria-busy', 'false');
      toast('Could not load your plan.', 'error');
    }
  }

  // app.js resolves this once the DOM and the first auth state are settled.
  if (ZC.app && typeof ZC.app.onReady === 'function') {
    ZC.app.onReady(function () { return boot(); });
  } else {
    boot();
  }
})();
