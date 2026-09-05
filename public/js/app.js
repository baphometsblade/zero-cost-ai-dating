/* ==========================================================================
   Zero Cost AI Dating — application shell
   The chrome every page shares: theme application, the top nav and the bottom
   tab bar, the toast host, the sign-out control and the unread badge poll.
   It is also the page script for the landing page, which it enhances once the
   auth state is known (demo CTA, "Open the app", live mode notice).
   Exposes: ZC.app.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // Tolerate being loaded twice — the first copy wins.
  if (ZC.app && typeof ZC.app.init === 'function') return;

  // utils.js is loaded before this file on every page; without it there is no
  // shell to build, and saying so beats throwing halfway through a render.
  if (!ZC.util || typeof ZC.util.el !== 'function') {
    console.error('[zc] app.js needs js/utils.js to be loaded first.');
    return;
  }

  const el = ZC.util.el;
  const $ = ZC.util.$;
  const $$ = ZC.util.$$;

  /* ------------------------------------------------------------------------
     1. Constants and link resolution
     ------------------------------------------------------------------------ */

  const THEME_KEY = 'zc.theme';
  const THEMES = { system: 1, light: 1, dark: 1 };

  const PAGES = {
    index: 1, auth: 1, dashboard: 1, profile: 1,
    matches: 1, settings: 1, subscription: 1, '404': 1
  };

  // The signed-in navigation, shared by the top bar and the bottom tab bar.
  // `badgeLabel` is the noun screen readers hear when a count is present.
  const NAV_ITEMS = [
    { key: 'dashboard', href: 'dashboard.html', label: 'Discover', icon: '🔥', badgeLabel: 'new likes' },
    { key: 'matches', href: 'matches.html', label: 'Matches', icon: '💬', badgeLabel: 'unread' },
    { key: 'profile', href: 'profile.html', label: 'Profile', icon: '🙂', badgeLabel: '' },
    { key: 'settings', href: 'settings.html', label: 'Settings', icon: '⚙️', badgeLabel: '' }
  ];

  // Links are resolved against the folder this script was served from, so the
  // nav keeps working from a sub-directory deploy.
  const SELF_SRC = (document.currentScript && document.currentScript.src) || '';
  const SELF_RE = /js\/app\.js(?:[?#].*)?$/;
  const BASE = SELF_RE.test(SELF_SRC) ? SELF_SRC.replace(SELF_RE, '') : '';

  /**
   * Turn an app-relative path into one that resolves from any URL.
   * @param {string} path e.g. 'dashboard.html'
   * @returns {string}
   */
  function url(path) {
    return BASE + String(path === null || path === undefined ? '' : path);
  }

  /* ------------------------------------------------------------------------
     2. Page identity and auth helpers
     ------------------------------------------------------------------------ */

  /**
   * Which page is being shown, derived from the URL. Works with and without
   * the `.html` extension (Hosting ships `cleanUrls`). Anything unrecognised
   * is the not-found page.
   * @returns {'index'|'auth'|'dashboard'|'profile'|'matches'|'settings'|'subscription'|'404'}
   */
  function currentPage() {
    let name = '';
    try {
      name = (window.location.pathname || '').split('/').pop() || '';
    } catch (err) {
      name = '';
    }
    name = name.replace(/\.html?$/i, '').toLowerCase();
    if (!name) return 'index';
    return PAGES[name] ? name : '404';
  }

  /**
   * The signed-in user document, when auth.js has one.
   * @returns {Object|null} UserDoc-ish object or null
   */
  function signedInDoc() {
    if (!ZC.auth) return null;
    if (ZC.auth.doc && ZC.auth.doc.uid) return ZC.auth.doc;
    if (ZC.auth.current && ZC.auth.current.uid) return ZC.auth.current;
    return null;
  }

  /** True when this user's plan may see who liked them. */
  function planSeesLikes(doc) {
    const plan = doc && doc.plan === 'premium' ? 'premium' : 'free';
    const limits = (ZC.config && ZC.config.limits && ZC.config.limits[plan]) || null;
    return !!(limits && limits.seeLikedYou);
  }

  /* ------------------------------------------------------------------------
     3. Theme
     ------------------------------------------------------------------------ */

  /**
   * Read the last theme the user chose. Storage may be unavailable (private
   * mode, file:// origins) — that is not an error, it just means "system".
   * @returns {'system'|'light'|'dark'|null}
   */
  function readStoredTheme() {
    try {
      const value = window.localStorage.getItem(THEME_KEY);
      return THEMES[value] ? value : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Apply a theme preference to the document and remember it.
   * 'system' removes the attribute so the CSS falls back to
   * `prefers-color-scheme`; 'light'/'dark' always win over it.
   * @param {'system'|'light'|'dark'} pref requested theme
   * @returns {'system'|'light'|'dark'} the theme actually applied
   */
  function applyTheme(pref) {
    const value = THEMES[pref] ? pref : 'system';
    const root = document.documentElement;
    if (value === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', value);
    try {
      window.localStorage.setItem(THEME_KEY, value);
    } catch (err) {
      // Storage off: the theme still applies, it just will not survive a reload.
    }
    return value;
  }

  // Applied as early as a classic script can: the file runs at the end of the
  // body, so this lands before the first paint in practice.
  applyTheme(readStoredTheme() || 'system');

  /* ------------------------------------------------------------------------
     4. Navigation
     ------------------------------------------------------------------------ */

  /**
   * One desktop nav link, with an optional badge slot.
   * @param {Object} item entry from NAV_ITEMS
   * @param {string} active key of the current page
   * @returns {HTMLElement}
   */
  function navLink(item, active) {
    const link = el('a', {
      class: 'nav-link' + (item.key === active ? ' is-active' : ''),
      attrs: { href: url(item.href) },
      dataset: { navLabel: item.label }
    }, [item.label]);
    if (item.key === active) link.setAttribute('aria-current', 'page');
    if (item.badgeLabel) {
      link.appendChild(el('span', {
        class: 'nav-badge',
        dataset: { badge: item.key, badgeLabel: item.badgeLabel },
        attrs: { 'aria-hidden': 'true' }
      }));
    }
    return link;
  }

  /**
   * One bottom tab-bar item: icon, label and an optional badge.
   * @param {Object} item entry from NAV_ITEMS
   * @param {string} active key of the current page
   * @returns {HTMLElement}
   */
  function tabItem(item, active) {
    const tab = el('a', {
      class: 'tabbar-item' + (item.key === active ? ' is-active' : ''),
      attrs: { href: url(item.href) },
      dataset: { navLabel: item.label }
    }, [
      el('span', { class: 'tabbar-icon', text: item.icon, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'tabbar-label', text: item.label })
    ]);
    if (item.key === active) tab.setAttribute('aria-current', 'page');
    if (item.badgeLabel) {
      tab.appendChild(el('span', {
        class: 'nav-badge',
        dataset: { badge: item.key, badgeLabel: item.badgeLabel },
        attrs: { 'aria-hidden': 'true' }
      }));
    }
    return tab;
  }

  /**
   * The sticky top bar. Signed-in visitors get the app links plus sign-out;
   * everyone else gets a single always-visible "Sign in" button (the desktop
   * `.nav-links` row is hidden on phones, so guests must not depend on it).
   * @param {string} active key of the current page
   * @param {boolean} signedIn whether someone is signed in
   * @returns {HTMLElement}
   */
  function buildNav(active, signedIn) {
    const brand = el('a', {
      class: 'nav-brand',
      attrs: { href: url(signedIn ? 'dashboard.html' : 'index.html') }
    }, ['Zero Cost Dating']);

    let right;
    if (signedIn) {
      right = el('nav', { class: 'nav-links', attrs: { 'aria-label': 'Primary' } }, [
        NAV_ITEMS.map(function (item) { return navLink(item, active); }),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          attrs: { type: 'button', 'data-signout': '' },
          text: 'Sign out'
        })
      ]);
    } else {
      right = el('div', { class: 'row' }, [
        el('a', { class: 'btn btn-primary btn-sm', attrs: { href: url('auth.html') } }, ['Sign in'])
      ]);
    }

    return el('header', {
      class: 'nav',
      dataset: { zcNav: '' },
      attrs: { role: 'banner' }
    }, [el('div', { class: 'nav-inner' }, [brand, right])]);
  }

  /**
   * The fixed bottom tab bar — the primary navigation on phones.
   * @param {string} active key of the current page
   * @returns {HTMLElement}
   */
  function buildTabbar(active) {
    return el('nav', {
      class: 'tabbar',
      dataset: { zcTabbar: '' },
      attrs: { 'aria-label': 'Sections' }
    }, NAV_ITEMS.map(function (item) { return tabItem(item, active); }));
  }

  /**
   * Render (or re-render) the shared navigation. The header goes into the
   * page's `[data-nav]` slot when there is one, otherwise at the top of the
   * body; the tab bar is always a direct child of the body because it is
   * position-fixed. Calling this again replaces what was there.
   * @param {string} [activeKey] page key to mark active; defaults to currentPage()
   * @returns {HTMLElement|null} the mounted header, or null before the body exists
   */
  function mountNav(activeKey) {
    if (!document.body) return null;
    const active = activeKey || currentPage();
    const signedIn = !!signedInDoc();

    // Drop anything a previous mount left behind.
    $$('[data-zc-nav], [data-zc-tabbar]').forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });

    const header = buildNav(active, signedIn);
    const slot = $('[data-nav]');
    if (slot) {
      while (slot.firstChild) slot.removeChild(slot.firstChild);
      slot.appendChild(header);
    } else {
      document.body.insertBefore(header, document.body.firstChild);
    }

    // Only signed-in pages need the tab bar — and the room it takes up.
    if (signedIn) {
      document.body.appendChild(buildTabbar(active));
      document.body.classList.add('has-tabbar');
    } else {
      document.body.classList.remove('has-tabbar');
    }

    // Re-paint the counts we already know about onto the fresh markup.
    setBadge('matches', lastCounts.matches);
    setBadge('dashboard', lastCounts.dashboard);
    return header;
  }

  /* ------------------------------------------------------------------------
     5. Badges and the unread poll
     ------------------------------------------------------------------------ */

  const lastCounts = { matches: 0, dashboard: 0 };

  /**
   * Write one count onto every badge slot with that key, keeping the owning
   * link's accessible name in sync (a bare number tells a screen reader
   * nothing).
   * @param {string} key nav key, e.g. 'matches'
   * @param {number} count items to announce
   * @returns {void}
   */
  function setBadge(key, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    lastCounts[key] = n;
    $$('[data-badge="' + key + '"]').forEach(function (node) {
      node.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
      const owner = node.parentNode;
      if (!owner || !owner.dataset || !owner.dataset.navLabel) return;
      if (n > 0) {
        owner.setAttribute('aria-label', owner.dataset.navLabel + ', ' + n + ' ' + (node.dataset.badgeLabel || 'new'));
      } else {
        owner.removeAttribute('aria-label');
      }
    });
  }

  /**
   * Update the nav counters. Unread messages land on Matches; likes waiting
   * for an answer land on Discover, because that is where you act on them.
   * @param {{matches?:number, unread?:number, likes?:number, dashboard?:number}} counts
   * @returns {{matches:number, dashboard:number}} the counts now displayed
   */
  function badge(counts) {
    const c = counts || {};
    if (c.unread !== undefined) setBadge('matches', c.unread);
    if (c.matches !== undefined) setBadge('matches', c.matches);
    if (c.likes !== undefined) setBadge('dashboard', c.likes);
    if (c.dashboard !== undefined) setBadge('dashboard', c.dashboard);
    return { matches: lastCounts.matches, dashboard: lastCounts.dashboard };
  }

  let matchStop = null;
  let likeStop = null;
  let badgeUid = null;
  let badgeWarned = false;

  /**
   * Repaint the badges from a live subscription rather than a timer.
   *
   * This was a 20-second poll that re-read every match *and a profile for each
   * of them* — plus, on the premium plan, every inbound like and a profile for
   * each of those — whether or not anything had changed. Bounded by the size of
   * a social graph, and spent again every twenty seconds for as long as a tab
   * stayed open, against a Spark quota of 50,000 document reads a day.
   *
   * A snapshot listener bills the documents it first delivers and then only the
   * ones that change, so an open tab now costs nothing while nothing happens.
   * The rows carry no profiles either: a badge draws a number, and loading a
   * name to count it was waste on top of waste.
   *
   * Idempotent, and safe to call again — `subscription.js` does exactly that
   * when the plan changes, which is when the likes subscription has to start or
   * stop.
   * @returns {void}
   */
  function syncBadgeListeners() {
    const me = signedInDoc();
    if (!me || !me.uid || !ZC.store || typeof ZC.store.listenMatches !== 'function') return;

    // A subscription belongs to one account. Signing out always tears these
    // down, so a different uid here means something changed the session without
    // that — and a live subscription to the previous account's matches would
    // keep painting their unread count over this one's.
    if (badgeUid && badgeUid !== me.uid) stopBadgePolling();
    badgeUid = me.uid;

    if (!matchStop) {
      matchStop = ZC.store.listenMatches(me.uid, function (rows) {
        try {
          let unread = 0;
          (Array.isArray(rows) ? rows : []).forEach(function (row) {
            unread += Math.max(0, Number(row && row.unread) || 0);
          });
          badge({ matches: unread });
        } catch (err) {
          warnOnce(err);
        }
      });
    }

    const wantsLikes = planSeesLikes(me) && typeof ZC.store.listenLikesReceived === 'function';
    if (wantsLikes && !likeStop) {
      likeStop = ZC.store.listenLikesReceived(me.uid, function (count) {
        try {
          badge({ likes: Math.max(0, Number(count) || 0) });
        } catch (err) {
          warnOnce(err);
        }
      });
    } else if (!wantsLikes && likeStop) {
      // Dropped back to Free: stop paying for the subscription and clear the
      // number, rather than leaving a count the plan no longer entitles them to.
      likeStop();
      likeStop = null;
      badge({ likes: 0 });
    }
  }

  /** One warning per session — a background subscription must not spam a console. */
  function warnOnce(err) {
    if (badgeWarned) return;
    badgeWarned = true;
    console.warn('[zc] A badge could not update:', err);
  }

  /** Start the badge subscriptions (idempotent). */
  function startBadgePolling() {
    syncBadgeListeners();
  }

  /** Drop them — used the moment the session ends. */
  function stopBadgePolling() {
    if (typeof matchStop === 'function') matchStop();
    if (typeof likeStop === 'function') likeStop();
    matchStop = null;
    likeStop = null;
    badgeUid = null;
  }

  /* ------------------------------------------------------------------------
     6. Sign out
     ------------------------------------------------------------------------ */

  /**
   * End the session and go back to the landing page. Any element carrying
   * `data-signout` triggers this, wherever it lives on the page.
   * @param {HTMLElement} [button] control to show a busy state on
   * @returns {Promise<void>}
   */
  async function signOut(button) {
    if (!ZC.auth || typeof ZC.auth.signOut !== 'function') {
      if (ZC.ui) ZC.ui.toast('Sign-out is not available on this page.', 'warn');
      return;
    }
    if (button && ZC.ui) ZC.ui.setBusy(button, true, 'Signing out…');
    try {
      await ZC.auth.signOut();
      stopBadgePolling();
      window.location.href = url('index.html');
    } catch (err) {
      if (button && ZC.ui) ZC.ui.setBusy(button, false);
      if (ZC.ui) ZC.ui.toast('Could not sign out. Please try again.', 'error');
      console.warn('[zc] sign-out failed:', err);
    }
  }

  let signOutWired = false;

  /** Delegate clicks once, so re-mounting the nav never stacks handlers. */
  function wireSignOut() {
    if (signOutWired) return;
    signOutWired = true;
    document.addEventListener('click', function (event) {
      const target = event.target;
      const trigger = target && target.closest ? target.closest('[data-signout]') : null;
      if (!trigger) return;
      event.preventDefault();
      signOut(trigger);
    });
  }

  /* ------------------------------------------------------------------------
     7. Landing page
     ------------------------------------------------------------------------ */

  /**
   * One honest sentence about where this session's data actually lives.
   * @returns {string}
   */
  function modeNote() {
    if (ZC.config && ZC.config.mode === 'firebase') {
      const project = (ZC.config.firebase && ZC.config.firebase.projectId) || 'your project';
      return 'Connected to the Firebase project “' + project + '”. Matching still runs entirely in your browser.';
    }
    return 'Running in demo mode: your swipes, matches and messages stay in this browser, alongside 32 sample profiles.';
  }

  /**
   * Start the bundled demo session and go straight to the deck.
   * @param {Event} event click on the demo CTA
   * @returns {Promise<void>}
   */
  async function startDemo(event) {
    event.preventDefault();
    const button = event.currentTarget;
    if (!ZC.auth || typeof ZC.auth.signInAsDemoUser !== 'function') {
      if (ZC.ui) ZC.ui.toast('The demo account is only available in demo mode.', 'warn');
      return;
    }
    if (ZC.ui) ZC.ui.setBusy(button, true, 'Opening the demo…');
    try {
      const result = await ZC.auth.signInAsDemoUser();
      if (result && result.ok === false) throw new Error(result.error || 'demo sign-in refused');
      window.location.href = url('dashboard.html');
    } catch (err) {
      if (ZC.ui) ZC.ui.setBusy(button, false);
      if (ZC.ui) ZC.ui.toast('Could not start the demo. Please try again.', 'error');
      console.warn('[zc] demo sign-in failed:', err);
    }
  }

  /**
   * Bring the static landing markup to life: swap the primary CTA once you are
   * signed in, reveal the demo button only in demo mode, fill in the score
   * ring and the version, and state the active mode.
   * @param {Object|null} [doc] the signed-in user, when known
   * @returns {void}
   */
  function decorateLanding(doc) {
    const signedIn = !!(doc && doc.uid) || !!signedInDoc();

    // Primary call to action.
    const primary = $('[data-cta="primary"]');
    if (primary) {
      primary.textContent = signedIn ? 'Open the app' : 'Create your free account';
      primary.setAttribute('href', url(signedIn ? 'dashboard.html' : 'auth.html?mode=signup'));
    }

    // "Sign in" is noise once you already are.
    const secondary = $('[data-cta="secondary"]');
    if (secondary) {
      secondary.classList.toggle('hidden', signedIn);
      secondary.setAttribute('href', url('auth.html'));
    }

    // The demo button exists only where a demo session is possible.
    const demo = $('[data-cta="demo"]');
    if (demo) {
      const demoReady = !!(ZC.config && ZC.config.mode === 'demo') &&
        !!(ZC.auth && typeof ZC.auth.signInAsDemoUser === 'function');
      demo.classList.toggle('hidden', !demoReady || signedIn);
      if (demoReady && !demo.dataset.wired) {
        demo.dataset.wired = '1';
        demo.addEventListener('click', startDemo);
      }
    }

    // Honest status line + build version.
    const note = $('[data-mode-note]');
    if (note) note.textContent = modeNote();
    $$('[data-app-version]').forEach(function (node) {
      node.textContent = ZC.config && ZC.config.version ? 'v' + ZC.config.version : '';
    });

    // The illustrative compatibility ring is driven by a custom property,
    // which CSP lets us set from script but not from a style attribute.
    $$('.match-score-ring[data-pct]').forEach(function (ring) {
      ring.style.setProperty('--pct', String(ZC.util.clamp(ring.dataset.pct, 0, 100)));
    });
  }

  /* ------------------------------------------------------------------------
     8. Readiness and boot
     ------------------------------------------------------------------------ */

  /** Resolves once the DOM is parsed. */
  function domReady() {
    return new Promise(function (resolve) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { resolve(); }, { once: true });
      } else {
        resolve();
      }
    });
  }

  // DOM first, then the first auth state. A page without auth.js (404) simply
  // resolves with null.
  const readyPromise = domReady().then(function () {
    if (ZC.auth && ZC.auth.ready && typeof ZC.auth.ready.then === 'function') {
      return ZC.auth.ready.then(function (doc) { return doc || null; }, function () { return null; });
    }
    return null;
  });

  /**
   * Run a callback once the DOM is parsed and the auth state has settled.
   * The callback receives the signed-in UserDoc, or null.
   * @param {Function} fn callback
   * @returns {Promise<void>}
   */
  function onReady(fn) {
    return readyPromise.then(function (doc) {
      if (typeof fn !== 'function') return;
      try {
        return fn(doc);
      } catch (err) {
        console.error('[zc] page setup failed:', err);
        if (ZC.ui) ZC.ui.toast('Something went wrong loading this page.', 'error');
        return undefined;
      }
    });
  }

  /** Record that this account is around, without ever blocking the UI. */
  function touchActive(uid) {
    if (!ZC.store || typeof ZC.store.touchActive !== 'function') return;
    try {
      const result = ZC.store.touchActive(uid);
      if (result && typeof result.catch === 'function') {
        result.catch(function () { /* presence is best-effort */ });
      }
    } catch (err) {
      // Presence is decoration; a failure here must never surface.
    }
  }

  /**
   * Finish any match check this device started and never got an answer to.
   *
   * Same shape as `touchActive` above, and for the same reason: it must never
   * block the UI and must never surface. With nothing owed it costs no reads and
   * no round trips, so running it on every page is free for everyone who has
   * never lost a check — and the page that swipes is not the page that shows the
   * conversation, so there is nowhere better to put it.
   * @param {string} uid the signed-in account
   * @returns {void}
   */
  function reconcileMatches(uid) {
    if (!ZC.store || typeof ZC.store.reconcileMatches !== 'function') return;
    try {
      const result = ZC.store.reconcileMatches(uid);
      if (result && typeof result.catch === 'function') {
        result.catch(function () { /* the note stays; the next load tries again */ });
      }
    } catch (err) {
      // A repair that cannot run is the state this started in, not a new failure.
    }
  }

  /**
   * Apply everything that depends on who is signed in. Safe to call again on
   * every auth change.
   * @param {Object|null} doc UserDoc or null
   * @returns {void}
   */
  function applyAuthState(doc) {
    const page = currentPage();
    mountNav(page);
    const preferred = doc && doc.preferences && doc.preferences.theme;
    applyTheme(preferred || readStoredTheme() || 'system');
    if (page === 'index') decorateLanding(doc);

    if (doc && doc.uid) {
      touchActive(doc.uid);
      reconcileMatches(doc.uid);
      startBadgePolling();
    } else {
      stopBadgePolling();
      badge({ matches: 0, likes: 0 });
    }
  }

  let initialised = false;

  /**
   * Register the service worker (network-first static cache; makes demo mode
   * work offline and the app installable). Best-effort: registration failing —
   * unsupported browser, insecure origin, file:// — is silent and harmless.
   * @returns {void}
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.info('[zc] Service worker not registered:', err && err.message);
      });
    } catch (err) {
      console.info('[zc] Service worker not registered:', err && err.message);
    }
  }

  /**
   * Build the shell. Runs automatically on DOMContentLoaded and is idempotent,
   * so a page script may call it early without side effects.
   * @returns {Promise<Object|null>} resolves with the signed-in UserDoc or null
   */
  function init() {
    if (initialised) return readyPromise;
    initialised = true;

    if (ZC.ui && typeof ZC.ui.mountToastHost === 'function') ZC.ui.mountToastHost();
    wireSignOut();
    registerServiceWorker();

    const page = currentPage();
    mountNav(page);
    // Paint the parts of the landing page that do not depend on auth.
    if (page === 'index') decorateLanding(null);

    readyPromise.then(function (doc) { applyAuthState(doc); });

    // Follow later sign-ins and sign-outs.
    if (ZC.auth && typeof ZC.auth.onChange === 'function') {
      ZC.auth.onChange(function (doc) { applyAuthState(doc || null); });
    }
    return readyPromise;
  }

  /* ------------------------------------------------------------------------
     9. Publish
     ------------------------------------------------------------------------ */

  ZC.app = {
    init: init,
    mountNav: mountNav,
    applyTheme: applyTheme,
    currentPage: currentPage,
    onReady: onReady,
    badge: badge,
    refreshBadges: syncBadgeListeners,
    url: url
  };

  // Boot as soon as the document is usable — this file loads at the end of
  // the body, so on most pages that is immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); }, { once: true });
  } else {
    init();
  }
})();
