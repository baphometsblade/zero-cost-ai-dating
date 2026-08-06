/* ==========================================================================
   Zero Cost AI Dating — the Discover deck
   The core screen: rank everyone locally with ZC.matching, stack the top three
   results, and let people act on them by drag, by button or by keyboard —
   all three paths run through the same commit function, so they can never
   drift apart.

   Nothing here talks to Firebase directly: candidates, swipes, daily limits
   and the learning write-back all go through ZC.store.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // This file is the dashboard's page script; on any other page there is no
  // deck to build. utils.js is always loaded first per the shared script block.
  const stackEl = document.getElementById('deck-stack');
  if (!stackEl) return;
  if (!ZC.util || typeof ZC.util.el !== 'function') {
    console.error('[zc] dashboard.js needs js/utils.js to be loaded first.');
    return;
  }
  // Tolerate being loaded twice.
  if (stackEl.dataset.zcDeck === '1') return;
  stackEl.dataset.zcDeck = '1';

  const el = ZC.util.el;
  const $ = ZC.util.$;
  const $$ = ZC.util.$$;

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  const CANDIDATE_LIMIT = 60;      // how many profiles to pull per load
  const STACK_SIZE = 3;            // cards rendered at once (one live, two behind)
  const CARD_REASONS = 3;          // explanations printed on the card itself
  const CARD_TAGS = 6;             // interest chips printed on the card
  const STAMP_PX = 60;             // drag distance before a stamp appears
  const COMMIT_PX = 110;           // drag distance that commits the swipe
  const COMMIT_VELOCITY = 0.5;     // px/ms flick that commits regardless of distance
  const MAX_ROTATION_DEG = 18;     // cap on the card's tilt
  const ROTATION_PER_PX = 0.06;
  const EXIT_MS = 420;             // fallback timer for the fly-out animation
  const DRAG_SLOP_PX = 4;          // movement before a press becomes a drag

  // Human labels for the score breakdown, in the order they are shown.
  const COMPONENT_LABELS = [
    { key: 'interests', label: 'Shared interests' },
    { key: 'personality', label: 'Personality fit' },
    { key: 'bio', label: 'Bio overlap' },
    { key: 'distance', label: 'Distance' },
    { key: 'age', label: 'Age' },
    { key: 'activity', label: 'Recently active' },
    { key: 'affinity', label: 'Learned taste' }
  ];

  // Which usage counter each action spends. A pass is always free.
  const SPEND_FIELD = { like: 'likes', super: 'superLikes', pass: null };

  // Exit class and stamp for each action.
  const EXIT_CLASS = { pass: 'is-gone-left', like: 'is-gone-right', super: 'is-gone-up' };
  const STAMP_CLASS = { pass: 'stamp-nope', like: 'stamp-like', super: 'stamp-super' };
  const ACTION_VERB = { pass: 'Passed on', like: 'Liked', super: 'Super liked' };

  /* ------------------------------------------------------------------------
     2. Page furniture and state
     ------------------------------------------------------------------------ */

  const statusEl = document.getElementById('deck-status');
  const usageEl = document.getElementById('usage-hint');
  const bannerEl = document.getElementById('limit-banner');
  const bannerTextEl = document.getElementById('limit-text');
  const detailsEl = document.getElementById('deck-details');
  const detailsBodyEl = document.getElementById('details-body');
  const buttons = {
    rewind: document.getElementById('btn-rewind'),
    pass: document.getElementById('btn-pass'),
    super: document.getElementById('btn-super'),
    like: document.getElementById('btn-like'),
    info: document.getElementById('btn-info'),
    shortcuts: document.getElementById('btn-shortcuts')
  };

  const state = {
    me: null,            // my UserDoc
    queue: [],           // ranked Result[] — queue[0] is the live card
    history: [],         // committed swipes, newest last (drives rewind)
    budget: {},          // cached canSpend() answers per usage field
    loading: true,
    error: null,
    busy: false,         // a commit or rewind is mid-flight
    detailsOpen: false,
    burst: null,         // the open .match-burst overlay, if any
    modalOpen: false,    // a ZC.ui modal owned by this page is open
    countdown: null      // interval id for the limit countdown
  };

  /** Whether the visitor asked for less movement. Checked live, not cached. */
  function reduceMotion() {
    return typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /**
   * Say something in the deck's live region. Screen-reader users get the same
   * feedback the animation gives everyone else.
   * @param {string} message sentence to announce
   * @returns {void}
   */
  function announce(message) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
  }

  /** Toast helper that survives utils.js being absent. */
  function toast(message, kind) {
    if (ZC.ui && typeof ZC.ui.toast === 'function') ZC.ui.toast(message, kind || 'info');
  }

  /* ------------------------------------------------------------------------
     3. Profile helpers
     ------------------------------------------------------------------------ */

  /** The `profile` sub-document, always an object. */
  function prof(doc) {
    return (doc && doc.profile && typeof doc.profile === 'object') ? doc.profile : {};
  }

  /** Display name, never empty. */
  function nameOf(doc) {
    const name = doc && typeof doc.displayName === 'string' ? doc.displayName.trim() : '';
    return name || 'Someone';
  }

  /** Age to display, or null when there is none or they hid it. */
  function ageOf(doc) {
    const p = prof(doc);
    if (p.showAge === false) return null;
    const age = Number(p.age);
    if (isFinite(age) && age > 0) return Math.round(age);
    const derived = ZC.util.ageFromBirthdate(p.birthdate);
    return derived === null ? null : derived;
  }

  /** Tag metadata for an interest slug, falling back to the raw slug. */
  function tagOf(slug) {
    const table = ZC.INTEREST_BY_SLUG || {};
    const tag = table[slug];
    if (tag) return { label: tag.label || slug, emoji: tag.emoji || '' };
    return { label: String(slug || ''), emoji: '' };
  }

  /**
   * A profile's interests, the ones we have in common first so the most
   * relevant chips survive the cap.
   * @param {Object} result a ZC.matching result
   * @returns {string[]} interest slugs
   */
  function orderedInterests(result) {
    const own = Array.isArray(prof(result.profile).interests) ? prof(result.profile).interests : [];
    const shared = (result.shared && Array.isArray(result.shared.interests)) ? result.shared.interests : [];
    const seen = Object.create(null);
    const out = [];
    shared.concat(own).forEach(function (slug) {
      if (typeof slug !== 'string' || !slug || seen[slug]) return;
      seen[slug] = true;
      out.push(slug);
    });
    return out;
  }

  /**
   * 'Active just now' / 'Active 4h ago' / 'Active on 5 Mar', or '' when the
   * profile has never been seen. timeAgo() switches to a date past a week, and
   * "Active 5 Mar ago" is not a sentence.
   * @param {Object} doc a UserDoc
   * @returns {string}
   */
  function activeText(doc) {
    const ago = ZC.util.timeAgo(doc && doc.lastActiveAt);
    if (!ago) return '';
    if (ago === 'just now') return 'Active just now';
    return /^\d+[mhd]$/.test(ago) ? 'Active ' + ago + ' ago' : 'Active on ' + ago;
  }

  /** 'Less than a km away' / '4 km away', or '' when there is no distance. */
  function distanceText(result) {
    if (typeof result.distanceKm !== 'number' || !isFinite(result.distanceKm)) return '';
    if (prof(result.profile).showDistance === false) return '';
    if (result.distanceKm < 1) return 'Less than a km away';
    return Math.round(result.distanceKm) + ' km away';
  }

  /* ------------------------------------------------------------------------
     4. Card rendering
     ------------------------------------------------------------------------ */

  /**
   * Build one swipe card. Every string that came from a profile is inserted as
   * text — the card is entirely user-authored content.
   * @param {Object} result a ZC.matching result
   * @param {number} index position in the stack (0 is the live card)
   * @returns {HTMLElement} the .swipe-card element
   */
  function buildCard(result, index) {
    const doc = result.profile;
    const name = nameOf(doc);
    const age = ageOf(doc);
    const p = prof(doc);
    const score = Math.round(Number(result.score) || 0);
    const band = ZC.matching && typeof ZC.matching.compatibilityLabel === 'function'
      ? ZC.matching.compatibilityLabel(result.score)
      : { label: 'Match', tone: 'good' };

    const card = el('article', {
      class: 'swipe-card',
      dataset: { uid: result.uid || '' },
      attrs: {
        role: 'group',
        'aria-label': name + (age === null ? '' : ', ' + age) + '. ' + score + '% match — ' + band.label + '.',
        tabindex: index === 0 ? '0' : '-1'
      }
    });
    if (index > 0) card.setAttribute('aria-hidden', 'true');

    // Photo (a generated avatar when they have not linked one) and the scrim
    // that keeps the text on top of it readable.
    card.appendChild(el('img', {
      class: 'swipe-photo',
      attrs: { src: ZC.util.photoOf(doc), alt: '', draggable: 'false', decoding: 'async' }
    }));
    card.appendChild(el('div', { class: 'swipe-gradient', attrs: { 'aria-hidden': 'true' } }));

    // Compatibility ring. --pct drives the conic gradient; CSP allows setting
    // custom properties from script but not a style attribute.
    const ring = el('span', { class: 'match-score-ring' }, [
      el('span', { class: 'match-score-value', text: String(score) })
    ]);
    ring.style.setProperty('--pct', String(ZC.util.clamp(score, 0, 100)));
    card.appendChild(el('span', {
      class: 'match-score',
      attrs: { title: band.label + ' — ' + score + '% compatible' }
    }, [ring, el('span', { text: 'match' })]));

    // Drag stamps. The pointer handler reveals the one matching the gesture.
    card.appendChild(el('span', { class: 'swipe-stamp stamp-like', text: 'Like', attrs: { 'aria-hidden': 'true' } }));
    card.appendChild(el('span', { class: 'swipe-stamp stamp-nope', text: 'Nope', attrs: { 'aria-hidden': 'true' } }));
    card.appendChild(el('span', { class: 'swipe-stamp stamp-super', text: 'Super', attrs: { 'aria-hidden': 'true' } }));

    // Name, age and the quick facts.
    const info = el('div', { class: 'swipe-info' });
    info.appendChild(el('h3', { class: 'swipe-name', text: name }, [
      age === null ? null : el('span', { class: 'swipe-age', text: String(age) })
    ]));

    const meta = el('div', { class: 'swipe-meta' });
    const where = distanceText(result);
    if (where) meta.appendChild(el('span', { class: 'pill', text: '📍 ' + where }));
    if (p.location && p.location.label) meta.appendChild(el('span', { class: 'pill', text: String(p.location.label) }));
    const active = activeText(doc);
    if (active) meta.appendChild(el('span', { class: 'pill', text: '⚡ ' + active }));
    if (p.pronouns) meta.appendChild(el('span', { class: 'pill', text: String(p.pronouns) }));
    if (meta.childNodes.length) info.appendChild(meta);

    if (typeof p.bio === 'string' && p.bio.trim()) {
      info.appendChild(el('p', { class: 'swipe-bio', text: p.bio.trim() }));
    }

    // Interest chips, shared ones first.
    const interests = orderedInterests(result).slice(0, CARD_TAGS);
    if (interests.length) {
      info.appendChild(el('div', { class: 'swipe-tags' }, interests.map(function (slug) {
        const tag = tagOf(slug);
        return el('span', { class: 'swipe-tag', text: (tag.emoji ? tag.emoji + ' ' : '') + tag.label });
      })));
    }

    // The point of the whole app: why this person, in plain English.
    const reasons = Array.isArray(result.reasons) ? result.reasons.slice(0, CARD_REASONS) : [];
    if (reasons.length) {
      info.appendChild(el('div', { class: 'reasons' }, reasons.map(function (reason) {
        return el('p', { class: 'reason' }, [
          el('span', { class: 'reason-icon', text: reason.icon || '•', attrs: { 'aria-hidden': 'true' } }),
          el('span', { text: reason.text || '' })
        ]);
      })));
    }

    card.appendChild(info);
    if (index === 0) attachDrag(card);
    return card;
  }

  /** The live card element, or null when the deck is showing another state. */
  function topCard() {
    return $('.swipe-card:not([data-exiting])', stackEl);
  }

  /** Remove everything from the stack except cards that are still flying out. */
  function clearStack() {
    $$('#deck-stack > *').forEach(function (node) {
      if (node.hasAttribute && node.hasAttribute('data-exiting')) return;
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  /** Put a node into the stack, ahead of any card that is still animating. */
  function placeInStack(node) {
    const exiting = $('[data-exiting]', stackEl);
    if (exiting) stackEl.insertBefore(node, exiting);
    else stackEl.appendChild(node);
  }

  /** Placeholder card shown while the deck is being ranked. */
  function renderSkeleton() {
    const frag = ZC.ui && typeof ZC.ui.skeleton === 'function'
      ? ZC.ui.skeleton(1, 'skeleton-card')
      : document.createDocumentFragment();
    const wrap = el('div', { class: 'stack stack-sm' }, [frag]);
    wrap.style.setProperty('height', '100%');
    // The bundled .skeleton-card is a fixed 320px; fill the deck instead.
    $$('.skeleton-card', wrap).forEach(function (node) {
      node.style.setProperty('height', '100%');
      node.style.setProperty('min-height', '320px');
    });
    placeInStack(wrap);
  }

  /** Nothing left to swipe: say so, and offer the two useful next steps. */
  function renderEmpty() {
    placeInStack(el('div', { class: 'empty' }, [
      el('span', { class: 'empty-icon', text: '🌤️', attrs: { 'aria-hidden': 'true' } }),
      el('h3', { text: 'That is everyone for now' }),
      el('p', {
        text: 'You have seen every profile that fits your filters. Widen your age range or distance ' +
          'to bring more people in, or check back later — the deck refills as people join and become active.'
      }),
      el('div', { class: 'row' }, [
        el('a', { class: 'btn btn-secondary', attrs: { href: 'settings.html' }, text: 'Widen my filters' }),
        el('button', {
          class: 'btn btn-ghost',
          attrs: { type: 'button' },
          text: 'Check again',
          on: { click: function () { load(); } }
        })
      ])
    ]));
  }

  /** Something failed. Say what, and give them one button that fixes it. */
  function renderError() {
    placeInStack(el('div', { class: 'empty' }, [
      el('span', { class: 'empty-icon', text: '⚠️', attrs: { 'aria-hidden': 'true' } }),
      el('h3', { text: 'Your deck could not load' }),
      el('p', {
        text: 'The profiles could not be read just now. Nothing has been lost — your swipes and matches ' +
          'are exactly where you left them.'
      }),
      el('button', {
        class: 'btn btn-primary',
        attrs: { type: 'button' },
        text: 'Retry',
        on: { click: function () { load(); } }
      })
    ]));
  }

  /**
   * Repaint the stack from state: skeletons, the error state, the empty state
   * or up to three cards. Cards that are mid-animation are left alone.
   * @returns {void}
   */
  function renderStack() {
    clearStack();
    if (state.error) renderError();
    else if (state.loading) renderSkeleton();
    else if (!state.queue.length) renderEmpty();
    else {
      state.queue.slice(0, STACK_SIZE).forEach(function (result, index) {
        placeInStack(buildCard(result, index));
      });
    }
    updateControls();
    if (state.detailsOpen) renderDetails();
  }

  /* ------------------------------------------------------------------------
     5. Controls, usage hint and the daily-limit banner
     ------------------------------------------------------------------------ */

  /** True when the field has a known, exhausted budget. */
  function exhausted(field) {
    const budget = state.budget[field];
    return !!(budget && budget.allowed === false);
  }

  /** Enable exactly the buttons that can do something right now. */
  function updateControls() {
    const live = !state.loading && !state.error && state.queue.length > 0;
    if (buttons.pass) buttons.pass.disabled = !live;
    if (buttons.info) buttons.info.disabled = !live;
    if (buttons.like) buttons.like.disabled = !live || exhausted('likes');
    if (buttons.super) buttons.super.disabled = !live || exhausted('superLikes');
    if (buttons.rewind) buttons.rewind.disabled = !state.history.length;
  }

  /** Render "n of m likes left today" under the deck. */
  function updateUsageHint() {
    if (!usageEl) return;
    const likes = state.budget.likes;
    const supers = state.budget.superLikes;
    if (!likes || likes.estimated) {
      usageEl.textContent = 'Drag a card, tap a button, or use the arrow keys.';
      return;
    }
    const parts = [];
    parts.push(likes.limit === Infinity
      ? 'Unlimited likes'
      : likes.remaining + ' of ' + likes.limit + ' likes left today');
    if (supers) {
      parts.push(supers.limit === Infinity
        ? 'unlimited super likes'
        : supers.remaining + ' super ' + (supers.remaining === 1 ? 'like' : 'likes') + ' left');
    }
    parts.push(likes.plan === 'premium' ? 'Premium' : 'Free plan');
    usageEl.textContent = parts.join(' · ');
  }

  /** Milliseconds until the next local midnight, when the counters reset. */
  function msToMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    return Math.max(0, midnight.getTime() - now.getTime());
  }

  /** '6h 21m' / '21m 07s' / '38s' — precise where precision is interesting. */
  function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = function (n) { return n < 10 ? '0' + n : String(n); };
    if (hours > 0) return hours + 'h ' + pad(minutes) + 'm';
    if (minutes > 0) return minutes + 'm ' + pad(seconds) + 's';
    return seconds + 's';
  }

  /** One tick of the countdown inside the limit banner. */
  function tickCountdown() {
    const budget = state.budget.likes;
    if (!bannerTextEl || !budget) return;
    const remaining = msToMidnight();
    if (remaining <= 0) {
      // Midnight passed while the page was open: the counters have rolled over.
      refreshBudgets();
      return;
    }
    const limit = budget.limit === Infinity ? 'your' : 'all ' + budget.limit;
    bannerTextEl.textContent = 'You have used ' + limit + ' likes for today. They come back in ' +
      formatCountdown(remaining) + ', at midnight.';
  }

  /** Show or hide the daily-limit banner, and run its countdown while shown. */
  function updateLimitBanner() {
    if (!bannerEl) return;
    const out = exhausted('likes');
    bannerEl.classList.toggle('hidden', !out);
    if (out) {
      tickCountdown();
      if (!state.countdown) state.countdown = window.setInterval(tickCountdown, 1000);
      return;
    }
    if (state.countdown) {
      window.clearInterval(state.countdown);
      state.countdown = null;
    }
  }

  /**
   * Ask the store whether an action is still affordable today.
   * A read failure fails open: a transient storage error must not lock someone
   * out of their own deck.
   * @param {'likes'|'superLikes'|'rewinds'} field usage counter
   * @returns {Promise<{allowed:boolean, remaining:number, limit:number, plan:string}>}
   */
  async function checkBudget(field) {
    try {
      const answer = await ZC.store.canSpend(state.me.uid, field);
      if (answer && typeof answer.allowed === 'boolean') return answer;
    } catch (err) {
      console.warn('[zc] Could not read the daily limit for ' + field + ':', err);
    }
    // `estimated` marks a guess, so the hint under the deck does not claim a
    // budget nobody has actually confirmed.
    return { allowed: true, remaining: Infinity, limit: Infinity, plan: state.me.plan || 'free', estimated: true };
  }

  /**
   * Re-read every counter and repaint the hint, the banner and the buttons.
   * @returns {Promise<void>}
   */
  async function refreshBudgets() {
    const fields = ['likes', 'superLikes', 'rewinds'];
    const answers = await Promise.all(fields.map(function (field) { return checkBudget(field); }));
    fields.forEach(function (field, i) { state.budget[field] = answers[i]; });
    updateUsageHint();
    updateLimitBanner();
    updateControls();
  }

  /* ------------------------------------------------------------------------
     6. Dragging the top card
     ------------------------------------------------------------------------ */

  /** Which action a drag currently reads as, or null for "not yet". */
  function intentOf(dx, dy) {
    if (dy < -STAMP_PX && Math.abs(dy) > Math.abs(dx)) return 'super';
    if (dx > STAMP_PX) return 'like';
    if (dx < -STAMP_PX) return 'pass';
    return null;
  }

  /** Reveal the stamp for an action (or hide all of them for null). */
  function showStamp(card, action) {
    const wanted = action ? STAMP_CLASS[action] : null;
    $$('.swipe-stamp', card).forEach(function (stamp) {
      stamp.classList.toggle('is-visible', !!wanted && stamp.classList.contains(wanted));
    });
  }

  /** Follow the pointer: translate, tilt, and stamp once past the threshold. */
  function paintDrag(card, dx, dy) {
    const rotation = ZC.util.clamp(dx * ROTATION_PER_PX, -MAX_ROTATION_DEG, MAX_ROTATION_DEG);
    const tilt = reduceMotion() ? 0 : rotation;
    card.style.setProperty('transform',
      'translate3d(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px, 0) rotate(' + tilt.toFixed(2) + 'deg)');
    showStamp(card, intentOf(dx, dy));
  }

  /** Drop the drag transform so the CSS transition springs the card back. */
  function resetCard(card) {
    if (!card) return;
    card.style.removeProperty('transform');
    showStamp(card, null);
  }

  /**
   * Decide what a finished drag meant: distance past the commit threshold, or
   * a fast enough flick in a direction it had already started to travel.
   * @param {number} dx horizontal travel
   * @param {number} dy vertical travel
   * @param {number} vx horizontal velocity in px/ms
   * @param {number} vy vertical velocity in px/ms
   * @returns {'like'|'pass'|'super'|null}
   */
  function decideDrag(dx, dy, vx, vy) {
    const upward = Math.abs(dy) > Math.abs(dx);
    if (upward && (dy < -COMMIT_PX || (vy < -COMMIT_VELOCITY && dy < -STAMP_PX))) return 'super';
    if (dx > COMMIT_PX || (vx > COMMIT_VELOCITY && dx > STAMP_PX)) return 'like';
    if (dx < -COMMIT_PX || (vx < -COMMIT_VELOCITY && dx < -STAMP_PX)) return 'pass';
    return null;
  }

  /**
   * Wire Pointer Events onto a card. One pointer at a time, captured so the
   * gesture survives leaving the element.
   * @param {HTMLElement} card the live .swipe-card
   * @returns {void}
   */
  function attachDrag(card) {
    let activeId = null;
    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let dx = 0;
    let dy = 0;
    let dragging = false;

    card.addEventListener('pointerdown', function (event) {
      if (activeId !== null || state.busy || state.burst) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      activeId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      startTime = event.timeStamp || Date.now();
      dx = 0;
      dy = 0;
      dragging = false;
      try {
        card.setPointerCapture(activeId);
      } catch (err) {
        // Capture is an optimisation; the move handler still works without it.
      }
    });

    card.addEventListener('pointermove', function (event) {
      if (event.pointerId !== activeId) return;
      dx = event.clientX - startX;
      dy = event.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_SLOP_PX && Math.abs(dy) < DRAG_SLOP_PX) return;
        dragging = true;
        card.classList.add('is-dragging');
      }
      paintDrag(card, dx, dy);
    });

    /** Finish the gesture: commit it, or let the card spring home. */
    function finish(event, cancelled) {
      if (event.pointerId !== activeId) return;
      try {
        if (card.hasPointerCapture && card.hasPointerCapture(activeId)) card.releasePointerCapture(activeId);
      } catch (err) {
        // Already released — nothing to do.
      }
      const elapsed = Math.max(1, (event.timeStamp || Date.now()) - startTime);
      const wasDragging = dragging;
      const travelX = dx;
      const travelY = dy;
      activeId = null;
      dragging = false;
      card.classList.remove('is-dragging');

      if (!wasDragging || cancelled) {
        resetCard(card);
        return;
      }
      const action = decideDrag(travelX, travelY, travelX / elapsed, travelY / elapsed);
      if (!action) {
        resetCard(card);
        return;
      }
      commit(action);
    }

    card.addEventListener('pointerup', function (event) { finish(event, false); });
    card.addEventListener('pointercancel', function (event) { finish(event, true); });
  }

  /* ------------------------------------------------------------------------
     7. Committing a swipe
     ------------------------------------------------------------------------ */

  /**
   * Send the card away. It is moved to the end of the stack and pinned on top
   * with inline styles so the depth rules for the cards behind it stay right.
   * @param {HTMLElement} card the card leaving
   * @param {'like'|'pass'|'super'} action which way it goes
   * @returns {void}
   */
  function animateOut(card, action) {
    showStamp(card, action);
    card.setAttribute('data-exiting', '1');
    card.setAttribute('aria-hidden', 'true');
    card.setAttribute('tabindex', '-1');
    card.style.setProperty('pointer-events', 'none');
    stackEl.appendChild(card);
    card.style.setProperty('display', 'block');
    card.style.setProperty('z-index', '6');
    card.classList.add(EXIT_CLASS[action] || 'is-gone-right');

    let removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      card.removeEventListener('transitionend', onEnd);
      if (card.parentNode) card.parentNode.removeChild(card);
    }
    function onEnd(event) {
      if (event.target === card) remove();
    }

    // Reduced motion: the card simply disappears, no flight.
    if (reduceMotion()) {
      window.setTimeout(remove, 20);
      return;
    }
    card.addEventListener('transitionend', onEnd);
    window.setTimeout(remove, EXIT_MS);
  }

  /**
   * The one path every swipe takes, whatever triggered it.
   * @param {'like'|'pass'|'super'} action what the user chose
   * @returns {Promise<void>}
   */
  async function commit(action) {
    if (state.busy || state.burst) return;
    const result = state.queue[0];
    if (!result || state.loading || state.error) return;
    state.busy = true;

    const card = topCard();
    const field = SPEND_FIELD[action];

    // Daily limits are checked before anything is spent or animated.
    if (field) {
      const budget = await checkBudget(field);
      state.budget[field] = budget;
      if (!budget.allowed) {
        state.busy = false;
        resetCard(card);
        updateUsageHint();
        updateLimitBanner();
        updateControls();
        refuse(field, budget);
        return;
      }
    }

    const entry = {
      result: result,
      action: action,
      field: field,
      matched: false,
      matchId: null,
      pending: true
    };
    state.queue.shift();
    state.history.push(entry);
    if (card) animateOut(card, action);
    renderStack();
    state.busy = false;

    const next = state.queue[0];
    announce(ACTION_VERB[action] + ' ' + nameOf(result.profile) + '. ' + (next
      ? 'Next: ' + nameOf(next.profile) + ', ' + Math.round(next.score) + '% match.'
      : 'That was the last profile in your deck.'));

    // Storage, usage and learning happen behind the animation. The deck is
    // already usable again by the time any of this resolves.
    persistSwipe(entry);
  }

  /** Explain a refused action without ever blaming the user's browser. */
  function refuse(field, budget) {
    if (field === 'superLikes') {
      toast(budget.plan === 'premium'
        ? 'That is all your super likes for today. They reset at midnight.'
        : 'Free accounts get one super like a day. Yours resets at midnight.', 'warn');
      announce('Super like unavailable: your daily limit is used up.');
      return;
    }
    toast('You have used today\'s likes. They reset at midnight — or go Premium for unlimited.', 'warn');
    announce('Like unavailable: your daily limit is used up. It resets at midnight.');
  }

  /**
   * Write the swipe, spend the budget, fold the swipe into the learning model
   * and celebrate a match. Never blocks the deck; a failure puts the card back.
   * @param {Object} entry the history entry created by commit()
   * @returns {Promise<void>}
   */
  async function persistSwipe(entry) {
    try {
      const outcome = await ZC.store.recordSwipe(state.me.uid, entry.result.uid, entry.action);
      entry.matched = !!(outcome && outcome.matched);
      entry.matchId = (outcome && outcome.matchId) || null;
      entry.pending = false;

      if (entry.field) {
        await ZC.store.bumpUsage(state.me.uid, entry.field, 1);
      }
      persistLearning(entry.result.profile, entry.action);
      refreshBudgets();

      if (entry.matched) {
        showMatchBurst(entry.result, entry.matchId);
        if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
      }
    } catch (err) {
      console.warn('[zc] The swipe could not be saved:', err);
      entry.pending = false;
      restoreEntry(entry);
      toast('That swipe did not save. The card is back on top — try again.', 'error');
    }
  }

  /** Undo a failed swipe locally so the deck matches what was actually stored. */
  function restoreEntry(entry) {
    const index = state.history.lastIndexOf(entry);
    if (index !== -1) state.history.splice(index, 1);
    const already = state.queue.some(function (item) { return item.uid === entry.result.uid; });
    if (!already) state.queue.unshift(entry.result);
    renderStack();
  }

  /**
   * Fold a swipe into the adaptive model and save it in the background.
   * The UI never waits on this — the affinity map only changes future ranking.
   * @param {Object} candidateDoc the swiped UserDoc
   * @param {'like'|'pass'|'super'} action what happened
   * @returns {void}
   */
  function persistLearning(candidateDoc, action) {
    if (!ZC.matching || typeof ZC.matching.updateLearning !== 'function') return;
    let learning;
    try {
      learning = ZC.matching.updateLearning(state.me.learning, candidateDoc, action);
    } catch (err) {
      console.warn('[zc] Learning update skipped:', err);
      return;
    }
    state.me.learning = learning;
    Promise.resolve()
      .then(function () { return ZC.store.updateUser(state.me.uid, { learning: learning }); })
      .catch(function (err) {
        // Losing one swipe's worth of personalisation is not worth a dialog.
        console.warn('[zc] Learning could not be saved:', err);
      });
  }

  /* ------------------------------------------------------------------------
     8. Rewind (Premium, and never across a match)
     ------------------------------------------------------------------------ */

  /**
   * Put the last swipe back on top of the deck.
   * @returns {Promise<void>}
   */
  async function rewind() {
    if (state.busy || state.burst) return;
    const entry = state.history[state.history.length - 1];
    if (!entry) {
      toast('There is nothing to rewind yet.', 'info');
      return;
    }
    if (entry.pending) {
      toast('That swipe is still saving — try the rewind again in a moment.', 'info');
      return;
    }
    // A match is a two-sided event: undoing it would delete a conversation the
    // other person can already see.
    if (entry.matched) {
      toast('Rewind cannot undo a match — you two already have a conversation.', 'warn');
      announce('Rewind refused: the last swipe created a match.');
      return;
    }

    state.busy = true;
    try {
      const budget = await checkBudget('rewinds');
      state.budget.rewinds = budget;
      if (!budget.allowed) {
        state.busy = false;
        await offerPremiumRewind(budget);
        return;
      }

      await ZC.store.undoSwipe(state.me.uid, entry.result.uid);
      state.history.pop();
      state.queue.unshift(entry.result);
      await ZC.store.bumpUsage(state.me.uid, 'rewinds', 1);
      renderStack();
      announce('Rewound. ' + nameOf(entry.result.profile) + ' is back on top of your deck.');
      toast(nameOf(entry.result.profile) + ' is back.', 'success');
      refreshBudgets();
    } catch (err) {
      console.warn('[zc] Rewind failed:', err);
      toast('Could not rewind that swipe. Nothing has changed.', 'error');
    } finally {
      state.busy = false;
    }
  }

  /**
   * Explain why a rewind was refused, and offer the upgrade page when the
   * reason is the plan rather than the daily count.
   * @param {{limit:number, plan:string}} budget the canSpend answer
   * @returns {Promise<void>}
   */
  async function offerPremiumRewind(budget) {
    if (budget.limit !== 0) {
      toast('That is all your rewinds for today. They reset at midnight.', 'warn');
      announce('Rewind unavailable: your daily rewinds are used up.');
      return;
    }
    announce('Rewind is a Premium feature.');
    if (!ZC.ui || typeof ZC.ui.modal !== 'function') {
      toast('Rewind is a Premium feature.', 'warn');
      return;
    }
    state.modalOpen = true;
    const choice = await ZC.ui.modal({
      title: 'Rewind is a Premium feature',
      body: 'Free accounts get one pass at each profile. Premium adds unlimited rewinds, unlimited ' +
        'likes and five super likes a day.\nPremium here is a local simulation — no payment is taken ' +
        'and no card details are collected. It exists so the limits can be tried out honestly.',
      actions: [
        { id: 'close', label: 'Not now', variant: 'ghost' },
        { id: 'plans', label: 'Compare plans', variant: 'primary' }
      ]
    });
    state.modalOpen = false;
    if (choice === 'plans') window.location.href = 'subscription.html';
  }

  /* ------------------------------------------------------------------------
     9. The details panel — the whole explanation, not just the headline
     ------------------------------------------------------------------------ */

  /** One "Shared interests … 74%" row of the score breakdown. */
  function breakdownRow(label, value, weight) {
    const pct = Math.round(ZC.util.clamp(value, 0, 1) * 100);
    return el('div', { class: 'spread' }, [
      el('span', { text: label }),
      el('span', { class: 'text-muted', text: pct + '% · weight ' + Math.round(weight * 100) + '%' })
    ]);
  }

  /** Fill the details panel from the live card. */
  function renderDetails() {
    if (!detailsBodyEl) return;
    while (detailsBodyEl.firstChild) detailsBodyEl.removeChild(detailsBodyEl.firstChild);

    const result = state.queue[0];
    if (!result) {
      detailsBodyEl.appendChild(el('p', { class: 'text-muted', text: 'There is no card to explain right now.' }));
      return;
    }

    const doc = result.profile;
    const p = prof(doc);
    const score = Math.round(Number(result.score) || 0);
    const band = ZC.matching.compatibilityLabel(result.score);

    // Headline: who, how compatible, and the engine's one-sentence summary.
    const ring = el('span', { class: 'match-score-ring' }, [
      el('span', { class: 'match-score-value', text: String(score) })
    ]);
    ring.style.setProperty('--pct', String(ZC.util.clamp(score, 0, 100)));
    detailsBodyEl.appendChild(el('div', { class: 'spread' }, [
      el('div', {}, [
        el('strong', { text: nameOf(doc) }),
        el('p', { class: 'text-muted', text: band.label })
      ]),
      el('span', { class: 'match-score' }, [ring, el('span', { text: 'match' })])
    ]));

    if (typeof ZC.matching.explain === 'function') {
      detailsBodyEl.appendChild(el('p', { text: ZC.matching.explain(result) }));
    }

    // Every reason, not just the three that fit on the card.
    const reasons = Array.isArray(result.reasons) ? result.reasons : [];
    if (reasons.length) {
      detailsBodyEl.appendChild(el('div', { class: 'reasons' }, reasons.map(function (reason) {
        return el('p', { class: 'reason' }, [
          el('span', { class: 'reason-icon', text: reason.icon || '•', attrs: { 'aria-hidden': 'true' } }),
          el('span', { text: reason.text || '' })
        ]);
      })));
    }

    if (typeof p.bio === 'string' && p.bio.trim()) {
      detailsBodyEl.appendChild(el('p', { text: p.bio.trim() }));
    }

    // Interests, with the shared ones marked rather than merely coloured.
    const shared = (result.shared && Array.isArray(result.shared.interests)) ? result.shared.interests : [];
    const interests = orderedInterests(result);
    if (interests.length) {
      detailsBodyEl.appendChild(el('p', { class: 'text-muted', text: 'Their interests — ticked ones you picked too:' }));
      detailsBodyEl.appendChild(el('div', { class: 'chip-group' }, interests.map(function (slug) {
        const tag = tagOf(slug);
        const isShared = shared.indexOf(slug) !== -1;
        return el('span', {
          class: 'chip' + (isShared ? ' is-selected' : ''),
          text: (tag.emoji ? tag.emoji + ' ' : '') + tag.label
        }, [
          // The CSS tick is decoration; this is what a screen reader hears.
          isShared ? el('span', { class: 'sr-only', text: ' — you both like this' }) : null
        ]);
      })));
    }

    // The numbers behind the score.
    const weights = (ZC.matching && ZC.matching.DEFAULT_WEIGHTS) || {};
    const breakdown = result.breakdown || {};
    const rows = COMPONENT_LABELS.filter(function (item) {
      return typeof breakdown[item.key] === 'number';
    }).map(function (item) {
      return breakdownRow(item.label, breakdown[item.key], Number(weights[item.key]) || 0);
    });
    if (rows.length) {
      detailsBodyEl.appendChild(el('hr', { class: 'divider' }));
      detailsBodyEl.appendChild(el('p', { class: 'text-muted', text: 'How the ' + score + '% was built:' }));
      detailsBodyEl.appendChild(el('div', { class: 'stack stack-sm' }, rows));
    }

    // Context that is not part of the score but is worth knowing.
    const facts = [];
    const where = distanceText(result);
    if (where) facts.push(where);
    if (p.location && p.location.label) facts.push('Based in ' + p.location.label);
    const seen = activeText(doc);
    if (seen) facts.push(seen);
    if (facts.length) detailsBodyEl.appendChild(el('p', { class: 'text-muted', text: facts.join(' · ') }));
  }

  /**
   * Show or hide the full explanation for the live card.
   * @param {boolean} [force] true to open, false to close, omitted to toggle
   * @returns {void}
   */
  function toggleDetails(force) {
    if (!detailsEl) return;
    const open = force === undefined ? !state.detailsOpen : !!force;
    if (open === state.detailsOpen) return;
    if (open && !state.queue.length) return;
    state.detailsOpen = open;
    detailsEl.classList.toggle('hidden', !open);
    if (buttons.info) buttons.info.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderDetails();
      detailsEl.focus();
      announce('Full explanation shown.');
    } else {
      const card = topCard();
      if (card && typeof card.focus === 'function') card.focus();
      announce('Full explanation hidden.');
    }
  }

  /* ------------------------------------------------------------------------
     10. The match burst
     ------------------------------------------------------------------------ */

  /**
   * Celebrate a mutual like and hand over three openers built from what the
   * two of you actually share. Focus is trapped until it closes.
   * @param {Object} result the matched candidate's ranking result
   * @param {string|null} matchId the id of the conversation just created
   * @returns {void}
   */
  function showMatchBurst(result, matchId) {
    const other = result.profile;
    // A second match while the first overlay is still up: say it rather than
    // stacking two dialogs on top of each other.
    if (state.burst) {
      toast('It is also a match with ' + nameOf(other) + '. Both are waiting in Matches.', 'success');
      return;
    }
    const otherName = nameOf(other);
    const titleId = 'zc-match-' + ZC.util.uid();
    const opener = document.activeElement;

    let lines = [];
    try {
      lines = ZC.matching.icebreakers(state.me, other, { count: 3 }) || [];
    } catch (err) {
      console.warn('[zc] Icebreakers unavailable:', err);
    }

    const conversationHref = matchId ? 'matches.html?m=' + encodeURIComponent(matchId) : 'matches.html';

    const inner = el('div', { class: 'match-burst-inner' }, [
      el('div', { class: 'match-avatars' }, [
        el('img', { class: 'match-avatar', attrs: { src: ZC.util.photoOf(state.me), alt: '', 'aria-hidden': 'true' } }),
        el('img', { class: 'match-avatar', attrs: { src: ZC.util.photoOf(other), alt: '', 'aria-hidden': 'true' } })
      ]),
      el('div', { class: 'match-copy' }, [
        el('h2', { text: 'It\'s a match!', attrs: { id: titleId } }),
        el('p', { text: 'You and ' + otherName + ' both said yes. Here are openers built from what the two of you actually have in common.' })
      ]),
      lines.length ? el('ul', { class: 'icebreakers' }, lines.map(function (line) {
        return el('li', {}, [
          el('a', {
            class: 'icebreaker',
            text: line,
            attrs: {
              href: matchId
                ? 'matches.html?m=' + encodeURIComponent(matchId) + '&draft=' + encodeURIComponent(line)
                : 'matches.html'
            }
          })
        ]);
      })) : null,
      el('a', { class: 'btn btn-secondary btn-block', attrs: { href: conversationHref }, text: 'Open the conversation' }),
      el('button', {
        class: 'btn btn-ghost btn-block',
        attrs: { type: 'button' },
        text: 'Keep swiping',
        on: { click: function () { closeBurst(); } }
      })
    ]);

    const overlay = el('div', {
      class: 'match-burst',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }
    }, [inner]);

    // Escape closes; Tab cycles inside the overlay.
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeBurst();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = $$('a[href], button:not([disabled])', overlay);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });

    // Clicking the surround dismisses it, the same as "Keep swiping".
    overlay.addEventListener('mousedown', function (event) {
      if (event.target === overlay) closeBurst();
    });

    /** Tear the overlay down and give focus back to whatever opened it. */
    function closeBurst() {
      if (state.burst !== overlay) return;
      state.burst = null;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      const card = topCard();
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
      else if (card && typeof card.focus === 'function') card.focus();
    }

    document.body.appendChild(overlay);
    state.burst = overlay;
    announce('It is a match with ' + otherName + '. Three openers are ready.');

    const firstFocusable = $('a[href], button:not([disabled])', overlay);
    if (firstFocusable && typeof firstFocusable.focus === 'function') firstFocusable.focus();
  }

  /* ------------------------------------------------------------------------
     11. Keyboard
     ------------------------------------------------------------------------ */

  /** True when the keystroke belongs to a text field rather than the deck. */
  function isTyping(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName.toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  /** Every shortcut, in the order the modal lists them. */
  const SHORTCUTS = [
    { keys: '←', what: 'Pass on this profile' },
    { keys: '→', what: 'Like this profile' },
    { keys: '↑', what: 'Super like this profile' },
    { keys: 'Z', what: 'Rewind the last swipe (Premium, and never across a match)' },
    { keys: 'I', what: 'Show or hide the full explanation' },
    { keys: 'Enter', what: 'Show or hide the full explanation' },
    { keys: 'Esc', what: 'Close the explanation, a dialog or the match overlay' },
    { keys: 'Tab', what: 'Move between the action buttons and the card' },
    { keys: '?', what: 'Open this list' }
  ];

  /** The shortcuts dialog — and the promise that this deck needs no pointer. */
  async function showShortcuts() {
    if (!ZC.ui || typeof ZC.ui.modal !== 'function' || state.modalOpen) return;
    const body = el('div', { class: 'stack stack-sm' }, [
      el('p', {
        text: 'The deck is fully operable from the keyboard alone: every drag gesture and every button ' +
          'below the cards has a key, and the card itself is focusable.'
      }),
      el('div', { class: 'stack stack-sm' }, SHORTCUTS.map(function (row) {
        return el('div', { class: 'spread' }, [
          el('kbd', { text: row.keys }),
          el('span', { text: row.what })
        ]);
      }))
    ]);
    state.modalOpen = true;
    try {
      await ZC.ui.modal({
        title: 'Keyboard shortcuts',
        body: body,
        actions: [{ id: 'ok', label: 'Got it', variant: 'primary' }]
      });
    } finally {
      state.modalOpen = false;
    }
  }

  /**
   * Global shortcut handler. It stands down whenever something else owns the
   * keyboard: a text field, a modal, or the match overlay.
   * @param {KeyboardEvent} event the keydown
   * @returns {void}
   */
  function onKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTyping(event.target)) return;
    if (state.burst || state.modalOpen || $('.modal-backdrop')) return;

    const key = event.key;

    if (key === 'Escape' && state.detailsOpen) {
      event.preventDefault();
      toggleDetails(false);
      return;
    }
    if (key === '?') {
      event.preventDefault();
      showShortcuts();
      return;
    }
    if (key === 'z' || key === 'Z') {
      event.preventDefault();
      rewind();
      return;
    }
    if (key === 'i' || key === 'I') {
      event.preventDefault();
      toggleDetails();
      return;
    }
    // Enter is left alone on buttons and links, where the browser already
    // means something sensible by it.
    if (key === 'Enter') {
      if (event.target && event.target.closest && event.target.closest('a[href], button')) return;
      event.preventDefault();
      toggleDetails();
      return;
    }
    if (key === 'ArrowLeft') {
      event.preventDefault();
      commit('pass');
      return;
    }
    if (key === 'ArrowRight') {
      event.preventDefault();
      commit('like');
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      commit('super');
    }
  }

  /* ------------------------------------------------------------------------
     12. Loading and boot
     ------------------------------------------------------------------------ */

  /**
   * Fetch the candidate pool, build the TF-IDF corpus from it and rank it.
   * Adaptive weighting is a Premium feature, so free accounts are scored on
   * the fixed weights only.
   * @returns {Promise<void>}
   */
  async function load() {
    state.loading = true;
    state.error = null;
    state.queue = [];
    state.history = [];
    toggleDetails(false);
    renderStack();
    announce('Loading your deck…');

    try {
      const candidates = await ZC.store.listCandidates(state.me.uid, { limit: CANDIDATE_LIMIT });
      const list = Array.isArray(candidates) ? candidates : [];
      // The corpus includes me: my own bio is one more document for the IDF
      // table, which is what makes rare words count for more.
      const corpus = ZC.matching.buildCorpus(list.concat([state.me]));
      const ranked = ZC.matching.rankCandidates(state.me, list, {
        corpus: corpus,
        now: new Date().toISOString(),
        adaptive: state.me.plan === 'premium'
      });
      state.queue = Array.isArray(ranked) ? ranked : [];
      state.loading = false;
      renderStack();
      announce(state.queue.length
        ? state.queue.length + ' profiles ranked. ' + nameOf(state.queue[0].profile) + ' is on top at ' +
          Math.round(state.queue[0].score) + '% match.'
        : 'No profiles match your filters right now.');
    } catch (err) {
      console.error('[zc] The deck failed to load:', err);
      state.loading = false;
      state.error = err;
      renderStack();
      announce('Your deck could not load. Use the Retry button to try again.');
      toast('Your deck could not load.', 'error');
    }

    refreshBudgets();
  }

  /** Wire the buttons and the global keyboard handler exactly once. */
  function wireControls() {
    if (buttons.pass) buttons.pass.addEventListener('click', function () { commit('pass'); });
    if (buttons.like) buttons.like.addEventListener('click', function () { commit('like'); });
    if (buttons.super) buttons.super.addEventListener('click', function () { commit('super'); });
    if (buttons.rewind) buttons.rewind.addEventListener('click', function () { rewind(); });
    if (buttons.info) buttons.info.addEventListener('click', function () { toggleDetails(); });
    if (buttons.shortcuts) buttons.shortcuts.addEventListener('click', function () { showShortcuts(); });
    document.addEventListener('keydown', onKeydown);
  }

  /**
   * Start the page: require a finished profile, then rank and render.
   * @returns {Promise<void>}
   */
  async function boot() {
    renderStack();
    if (!ZC.auth || typeof ZC.auth.requireProfile !== 'function' || !ZC.store || !ZC.matching) {
      state.loading = false;
      state.error = new Error('The app scripts did not all load.');
      renderStack();
      return;
    }
    try {
      // Redirects (and never resolves) when signed out or still onboarding.
      const me = await ZC.auth.requireProfile();
      if (!me) return;
      state.me = me;
      wireControls();
      await load();
    } catch (err) {
      // A failure this early leaves the retry button as the only useful thing
      // on screen, which is exactly what should be here.
      console.error('[zc] The dashboard could not start:', err);
      state.loading = false;
      state.error = err;
      renderStack();
    }
  }

  // app.js resolves this once the DOM and the first auth state are settled.
  if (ZC.app && typeof ZC.app.onReady === 'function') {
    ZC.app.onReady(function () { return boot(); });
  } else {
    boot();
  }
})();
