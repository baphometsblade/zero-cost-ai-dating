/* ==========================================================================
   Zero Cost AI Dating — matches and chat
   Two panes: every match you have on the left, the open conversation on the
   right. On a phone there is only ever one of them on screen, and the URL
   (?m=<matchId>) is what decides which.

   Messages arrive through ZC.store.listenMessages — a Firestore snapshot in
   one mode, a storage event plus a poll in the other — and every one of them
   is written into the DOM with textContent. Nothing on this page ever goes
   near innerHTML.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // This file is the matches page's script; elsewhere there is nothing to do.
  const layoutEl = document.getElementById('matches-layout');
  if (!layoutEl) return;
  if (!ZC.util || typeof ZC.util.el !== 'function') {
    console.error('[zc] matches.js needs js/utils.js to be loaded first.');
    return;
  }
  // Tolerate a duplicated <script> tag.
  if (layoutEl.dataset.zcMatches === '1') return;
  layoutEl.dataset.zcMatches = '1';

  const el = ZC.util.el;
  const $ = ZC.util.$;
  const $$ = ZC.util.$$;

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  const MESSAGE_MAX = 1000;          // matches the store's cap and the rules
  const COUNTER_FROM = 900;          // show the character counter this late
  const COMPOSER_ROWS = 5;           // the composer grows to five rows, then scrolls
  const NEAR_BOTTOM_PX = 80;         // "already at the bottom" tolerance
  const FIRST_DELIVERY_MS = 12000;   // how long a live list may take before we say so
  const STAMP_TICK_MS = 60000;       // keep relative timestamps honest
  const LOCKED_AVATARS = 5;          // placeholder faces behind the Premium blur
  const NEW_MATCH_NAME_MAX = 14;     // the strip is 76px wide; keep labels short

  /* ------------------------------------------------------------------------
     2. Elements and state
     ------------------------------------------------------------------------ */

  const dom = {
    pageHead: document.querySelector('#main .page-head'),
    listPane: document.getElementById('list-pane'),
    chatPane: document.getElementById('chat-pane'),
    newCard: document.getElementById('new-matches-card'),
    newStrip: document.getElementById('new-matches'),
    newCount: document.getElementById('new-matches-count'),
    unreadBadge: document.getElementById('unread-badge'),
    listLoading: document.getElementById('list-loading'),
    list: document.getElementById('match-list'),
    listEmpty: document.getElementById('list-empty'),
    listError: document.getElementById('list-error'),
    listRetry: document.getElementById('list-retry'),
    likesCard: document.getElementById('likes-card'),
    likesBadge: document.getElementById('likes-badge'),
    likesBody: document.getElementById('likes-body'),
    placeholder: document.getElementById('chat-placeholder'),
    chat: document.getElementById('chat'),
    back: document.getElementById('chat-back'),
    peerPhoto: document.getElementById('chat-peer-photo'),
    peerName: document.getElementById('chat-peer-name'),
    peerMeta: document.getElementById('chat-peer-meta'),
    menu: document.getElementById('chat-menu'),
    log: document.getElementById('chat-log'),
    form: document.getElementById('chat-form'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    count: document.getElementById('chat-count'),
    status: document.getElementById('chat-status')
  };

  const state = {
    me: null,            // my UserDoc
    matches: [],         // MatchView[], most recent activity first
    active: null,        // the open MatchView, or null
    rendered: [],        // messages currently in the log, in order
    lastDay: null,       // day key of the last separator drawn
    unsubscribe: null,   // teardown for the open conversation's listener
    corpus: null,        // TF-IDF corpus, built lazily for "view profile"
    draft: null,         // ?draft= text waiting to be placed in the composer
    loading: true,
    error: null,
    sending: false,
    firstPaint: true,    // suppresses "new message" announcements on open
    gotFirst: false,     // whether the live list has delivered at least once
    ended: false,        // the open conversation was ended by the other side
    readRefused: null    // matchId whose unread counter the store last refused to clear
  };

  // Wide enough for both panes at once — the same breakpoint .two-pane uses.
  const wideQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 900px)')
    : null;

  let listStop = null;
  let listDeadline = null;
  let stampTimer = null;

  // Fingerprint of the left pane as it is currently painted. Rebuilding a row
  // the user has already pressed down on cancels their click: mousedown lands
  // on the old node, the rebuild detaches it, and with no common ancestor left
  // for mouseup the browser never fires a click at all. `renderList` runs on
  // every delivery of the live list, and some deliveries change nothing this
  // pane draws: in firebase mode the other person reading what was sent
  // rewrites their own unread counter on the shared match document, and that
  // alone is a delivery; in both modes `markRead`'s own write comes back as one
  // after the row has already been drawn as read. This is what lets those
  // leave the rows alone. Without it, a tap on a conversation silently does
  // nothing whenever one of them lands mid-press. (This comment used to blame
  // a 20-second poll and a refresh on window focus. Both are gone; the reason
  // this exists is not.)
  let listPainted = null;

  /* ------------------------------------------------------------------------
     3. Small helpers
     ------------------------------------------------------------------------ */

  /** Toast that survives ZC.ui being unavailable. */
  function toast(message, kind) {
    if (ZC.ui && typeof ZC.ui.toast === 'function') ZC.ui.toast(message, kind || 'info');
  }

  /**
   * Say something in the page's live region.
   * @param {string} message sentence to announce
   * @returns {void}
   */
  function announce(message) {
    if (dom.status) dom.status.textContent = message || '';
  }

  /** The `profile` sub-document, always an object. */
  function prof(doc) {
    return (doc && doc.profile && typeof doc.profile === 'object') ? doc.profile : {};
  }

  /** Display name, never empty. */
  function nameOf(doc) {
    const name = doc && typeof doc.displayName === 'string' ? doc.displayName.trim() : '';
    return name || 'Someone';
  }

  /** First word of a name, trimmed to fit the new-matches strip. */
  function shortNameOf(doc) {
    const first = nameOf(doc).split(/\s+/)[0] || 'Someone';
    return first.length > NEW_MATCH_NAME_MAX ? first.slice(0, NEW_MATCH_NAME_MAX - 1) + '…' : first;
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
   * 'Active just now' / 'Active 4h ago' / 'Active on 5 Mar', or '' when we have
   * never seen them. timeAgo() switches to a date past a week, and
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

  /** Sort key for a conversation: its last message, else the match itself. */
  function activityAt(match) {
    return Date.parse((match && (match.lastMessageAt || match.createdAt)) || 0) || 0;
  }

  /** Most recent conversation first, ties broken by id so it never jitters. */
  function byActivity(a, b) {
    const delta = activityAt(b) - activityAt(a);
    if (delta !== 0) return delta;
    return String(a.matchId).localeCompare(String(b.matchId));
  }

  /** Total unread messages across every conversation. */
  function totalUnread() {
    return state.matches.reduce(function (sum, match) {
      return sum + Math.max(0, Number(match.unread) || 0);
    }, 0);
  }

  /** Replace every child of a node. */
  function fill(node, children) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    ZC.util.append(node, children);
  }

  /** Show or hide a node with the shared .hidden class. */
  function show(node, visible) {
    if (node) node.classList.toggle('hidden', !visible);
  }

  /* ------------------------------------------------------------------------
     4. URL and pane visibility
     ------------------------------------------------------------------------ */

  /**
   * Point the address bar at the open conversation without adding a history
   * entry, and drop any `draft` that has already been consumed.
   * @param {string|null} matchId the open match, or null for the list
   * @returns {void}
   */
  function syncUrl(matchId) {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    try {
      const url = new URL(window.location.href);
      if (matchId) url.searchParams.set('m', matchId);
      else url.searchParams.delete('m');
      url.searchParams.delete('draft');
      window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (err) {
      // A URL we cannot rewrite (file:// in some browsers) is not a failure —
      // the page works, it just will not be linkable.
    }
  }

  /** True when both panes fit side by side. */
  function isWide() {
    return !!(wideQuery && wideQuery.matches);
  }

  /**
   * Show the panes that belong on this screen: both on desktop, and exactly
   * one — list or chat — on a phone.
   * @returns {void}
   */
  function applyPanes() {
    const wide = isWide();
    const open = !!state.active;
    show(dom.listPane, wide || !open);
    show(dom.chatPane, wide || open);
    show(dom.chat, open);
    show(dom.placeholder, wide && !open);
    // The back button only means something where the list is off screen.
    show(dom.back, !wide);
    // On a phone an open conversation is sized to the screen between the
    // header and the tab bar (components.css, .chat), and the page heading
    // above it pushed it down by its own height: the composer sat below the
    // screen and the newest message under the tab bar. The heading is only
    // hidden from sight — the page keeps its h1 for a screen reader.
    if (dom.pageHead) dom.pageHead.classList.toggle('sr-only', !wide && open);
  }

  /* ------------------------------------------------------------------------
     5. The conversation list
     ------------------------------------------------------------------------ */

  /**
   * Make a link to a conversation swap the panes instead of reloading, but
   * leave its href intact for middle-click, bookmarks and no-JS crawlers.
   * Shared by the rows and the new-matches strip: the strip was a bare link,
   * so a tap on it loaded the whole page again — the boot, the list
   * subscription and the likes panel all over — and the page it loaded took
   * the `?m=` it arrived with for a link somebody followed, so focus was left
   * on <body> instead of being handed to the conversation.
   * @param {HTMLElement} link the <a> to wire
   * @param {string} matchId the match it opens
   * @returns {HTMLElement} the same link
   */
  function opensInPlace(link, matchId) {
    link.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      openMatch(matchId, true);
    });
    return link;
  }

  /**
   * One entry in the horizontally scrolling "new matches" strip.
   * @param {Object} match a MatchView with no messages yet
   * @returns {HTMLElement}
   */
  function buildNewMatch(match) {
    const name = nameOf(match.other);
    return opensInPlace(el('a', {
      class: 'new-match',
      dataset: { matchId: match.matchId },
      attrs: {
        href: 'matches.html?m=' + encodeURIComponent(match.matchId),
        'aria-label': 'Open your new match with ' + name
      }
    }, [
      el('img', {
        class: 'new-match-avatar',
        attrs: { src: ZC.util.photoOf(match.other), alt: '', width: '64', height: '64', decoding: 'async' }
      }),
      el('span', { text: shortNameOf(match.other) })
    ]), match.matchId);
  }

  /**
   * One conversation row: avatar, name, preview, relative time and — when
   * there is something waiting — a bolder row and an unread dot.
   * @param {Object} match a MatchView
   * @returns {HTMLElement} the <li>
   */
  function buildRow(match) {
    const name = nameOf(match.other);
    const unread = Math.max(0, Number(match.unread) || 0);
    const preview = typeof match.lastMessage === 'string' && match.lastMessage.trim()
      ? match.lastMessage.trim()
      : 'You matched — say something first.';
    const stamp = ZC.util.timeAgo(match.lastMessageAt || match.createdAt);

    // The row is named by its own text, not by an aria-label. A label replaced
    // everything visible, so a screen reader heard "Devin A., 1 unread message,
    // last activity 1d" and never the message the row shows. The hidden spans
    // add only what the eye gets from styling — the unread state is a bold row
    // and a dot, the stamp is just "1d" — and the punctuation that keeps the
    // parts apart when they are read as one name. Placement is load-bearing:
    // a browser puts a space at every block boundary, so punctuation leads
    // nothing ("Sam W. : …" when it did); .match-row-name is read back as the
    // person's name and .match-row-time is rewritten by refreshStamps(), so
    // neither holds hidden text; and nothing hidden follows the preview, whose
    // unwrapped text an out-of-flow span at its end would carry past the
    // right edge (measured: the page grew to 688px wide on a 390px phone).
    // Reading the stamp from the DOM also ends a staleness: the label was
    // never refreshed, so its "last activity" outlived the stamp beside it.
    const unreadText = unread ? unread + ' unread ' + (unread === 1 ? 'message' : 'messages') + ': ' : '';

    const row = el('a', {
      class: 'match-row' +
        (unread ? ' is-unread' : '') +
        (state.active && state.active.matchId === match.matchId ? ' is-active' : ''),
      dataset: { matchId: match.matchId },
      attrs: { href: 'matches.html?m=' + encodeURIComponent(match.matchId) }
    }, [
      el('img', {
        class: 'match-row-avatar',
        attrs: { src: ZC.util.photoOf(match.other), alt: '', width: '52', height: '52', decoding: 'async' }
      }),
      el('span', { class: 'match-row-body' }, [
        el('span', { class: 'match-row-name', text: name }),
        el('span', { class: 'match-row-preview' }, [
          unreadText ? el('span', { class: 'sr-only', text: unreadText }) : null,
          preview
        ])
      ]),
      stamp ? el('span', { class: 'sr-only', text: 'last activity' }) : null,
      el('span', { class: 'match-row-time', text: stamp }),
      el('span', { class: 'match-row-dot', attrs: { 'aria-hidden': 'true' } })
    ]);
    if (state.active && state.active.matchId === match.matchId) row.setAttribute('aria-current', 'true');

    return el('li', {}, [opensInPlace(row, match.matchId)]);
  }

  /**
   * Everything the strip and the rows draw, in one comparable string, so a
   * delivery that brings nothing new can leave their nodes alone.
   *
   * Deliberately built from raw timestamps rather than their timeAgo text: a
   * relative stamp changes as the clock advances even when nothing about the
   * conversation has, and a fingerprint that drifted on its own would turn
   * deliveries that change nothing into repaints — exactly what it exists to
   * prevent. The displayed stamps are kept honest separately, in
   * refreshStamps(), by a ticker that runs for as long as the page does.
   * @param {Object[]} fresh matches nobody has written to yet
   * @param {Object[]} rows every match, in the order they are listed
   * @returns {string}
   */
  function listFingerprint(fresh, rows) {
    return JSON.stringify([
      state.active ? state.active.matchId : '',
      fresh.map(function (match) {
        return [match.matchId, shortNameOf(match.other), ZC.util.photoOf(match.other)];
      }),
      rows.map(function (match) {
        return [
          match.matchId,
          nameOf(match.other),
          ZC.util.photoOf(match.other),
          Math.max(0, Number(match.unread) || 0),
          typeof match.lastMessage === 'string' ? match.lastMessage : '',
          match.lastMessageAt || match.createdAt || ''
        ];
      })
    ]);
  }

  /**
   * Repaint the whole left pane from state: the new-matches strip, the
   * conversation rows, the unread badge and whichever empty state applies.
   * @returns {void}
   */
  function renderList() {
    show(dom.listLoading, state.loading);
    show(dom.listError, !state.loading && !!state.error);
    show(dom.list, !state.loading && !state.error && state.matches.length > 0);
    show(dom.listEmpty, !state.loading && !state.error && state.matches.length === 0);

    if (state.loading || state.error) {
      show(dom.newCard, false);
      show(dom.unreadBadge, false);
      listPainted = null;
      return;
    }

    // Matches nobody has written to yet get the strip at the top.
    const fresh = state.matches
      .filter(function (match) { return !match.lastMessageAt; })
      .sort(function (a, b) {
        return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
      });
    show(dom.newCard, fresh.length > 0);
    if (dom.newCount) dom.newCount.textContent = String(fresh.length);

    // Every match appears in the list, newest activity first. Both node sets
    // are replaced together, and only when something they show has changed.
    const rows = state.matches.slice().sort(byActivity);
    const fingerprint = listFingerprint(fresh, rows);
    if (fingerprint !== listPainted) {
      listPainted = fingerprint;
      fill(dom.newStrip, fresh.map(buildNewMatch));
      fill(dom.list, rows.map(buildRow));
    }

    const unread = totalUnread();
    show(dom.unreadBadge, unread > 0);
    if (dom.unreadBadge) {
      dom.unreadBadge.textContent = unread + ' unread';
    }
  }

  /* ------------------------------------------------------------------------
     6. Who liked you
     ------------------------------------------------------------------------ */

  /** True when this plan is allowed to see who liked them. */
  function canSeeLikes() {
    return !!(ZC.config && ZC.config.planAllows(state.me, 'seeLikedYou'));
  }

  /**
   * Whether this account's plan ranks with the adaptive term, asked of the
   * limits table through ZC.config.planAllows, as the deck asks it. The
   * profile card here asked the plan's name instead, so with the table saying
   * otherwise it scored a match with a term the deck that found them did not
   * use.
   * @returns {boolean}
   */
  function adaptiveRanking() {
    return !!(ZC.config && ZC.config.planAllows(state.me, 'adaptiveWeights'));
  }

  /**
   * A copy of a UserDoc with the Discover filters it sets opened up: shown in
   * Discover, open to every gender and every age, and — unless `keepDistance`
   * — with no distance limit. The engine names only the first hard filter that
   * fails, never whose setting it was, so this is how a caller asks: score
   * again with one side's filters opened, and see whether it still fails.
   * @param {Object} doc a UserDoc
   * @param {boolean} [keepDistance] leave the distance limit as it is
   * @returns {Object} a shallow copy with its own `preferences`
   */
  function withoutFilters(doc, keepDistance) {
    const opened = { discoverable: true, interestedIn: [], ageMin: null, ageMax: null };
    if (!keepDistance) opened.maxDistanceKm = null;
    const copy = Object.assign({}, doc);
    copy.preferences = Object.assign({}, doc && doc.preferences, opened);
    return copy;
  }

  /**
   * Where a waiting liker stands with this account's deck: 'deck' when the
   * deck will show them, 'yours' when this account's own filters are all that
   * keep them out, and 'theirs' when they would stay out whatever those
   * filters said — their own filters, a paused Discover, an unfinished profile.
   *
   * The store lists everyone waiting on an answer and applies only block
   * lists; the deck also drops whoever fails one of the engine's hard filters.
   * So this asks the engine the deck ranks with, of the documents the panel
   * already holds: no read is spent finding out.
   * @param {Object} doc a liker's UserDoc
   * @returns {string} 'deck', 'yours' or 'theirs'
   */
  function deckStanding(doc) {
    if (!ZC.matching || typeof ZC.matching.scoreCandidate !== 'function') return 'deck';
    if (!ZC.matching.scoreCandidate(state.me, doc).hardFail) return 'deck';
    return ZC.matching.scoreCandidate(withoutFilters(state.me), doc).hardFail ? 'theirs' : 'yours';
  }

  /**
   * One strip of likers' faces. Each is a link to where answering them
   * happens, or not a link at all when nothing this account can do would.
   * @param {Object[]} likes UserDocs
   * @param {string|null} href where a tap goes, or null for no link
   * @param {string} says what follows the name in each link's accessible name
   * @returns {HTMLElement}
   */
  function likerStrip(likes, href, says) {
    return el('div', { class: 'new-matches' }, likes.map(function (doc) {
      const face = [
        el('img', {
          class: 'new-match-avatar',
          attrs: { src: ZC.util.photoOf(doc), alt: '', width: '64', height: '64', decoding: 'async' }
        }),
        el('span', { text: shortNameOf(doc) })
      ];
      return href
        ? el('a', { class: 'new-match', attrs: { href: href, 'aria-label': nameOf(doc) + says } }, face)
        : el('span', { class: 'new-match' }, face);
    }));
  }

  /**
   * The Premium view: real faces and real names, sorted by what will answer
   * them. The ones the deck will show go to Discover. This used to send every
   * one of them there, beside "liked you and are still in your deck", when the
   * deck had already dropped whoever its filters failed: at a 50 km limit, five
   * of the nine seeded likers, who then sat in this panel and the nav badge
   * with a link to a deck that was never going to show them. The rest are
   * listed apart, with what would bring them back when there is anything, so
   * the panel still counts everyone the badge does.
   * @param {Object[]} likes UserDocs who liked me
   * @returns {Node[]}
   */
  function likesUnlocked(likes) {
    if (!likes.length) {
      return [el('p', { class: 'text-muted', text: 'Nobody is waiting on an answer right now. New likes will show up here.' })];
    }
    const by = { deck: [], yours: [], theirs: [] };
    likes.forEach(function (doc) { by[deckStanding(doc)].push(doc); });
    const out = [];
    if (by.deck.length) {
      out.push(likerStrip(by.deck, 'dashboard.html', ' liked you. Open Discover to answer.'));
      out.push(el('p', { class: 'field-hint', text: by.deck.length === 1
        ? 'One person liked you and is still in your deck. Like them back and the conversation opens straight away.'
        : by.deck.length + ' people liked you and are still in your deck. Like them back and the conversation opens straight away.' }));
    }
    if (by.yours.length) {
      out.push(likerStrip(by.yours, 'settings.html', ' liked you but is outside your current filters. Open Settings to widen them.'));
      out.push(el('p', { class: 'field-hint', text: (by.yours.length === 1
        ? 'One person liked you but is'
        : by.yours.length + ' people liked you but are') +
        ' outside your current filters, so your deck will not show them. Widen your filters in Settings to answer.' }));
    }
    if (by.theirs.length) {
      out.push(likerStrip(by.theirs, null, ''));
      out.push(el('p', { class: 'field-hint', text: (by.theirs.length === 1
        ? 'One person liked you but is'
        : by.theirs.length + ' people liked you but are') +
        ' not in your deck right now, and widening your filters alone would not bring them back.' }));
    }
    return out;
  }

  /**
   * The free view: an honest count, placeholder faces behind a blur, and a
   * link to the plan page. The blurred avatars are generated from a constant
   * seed on purpose — nothing about the real people is sent to the DOM.
   * @param {number} count how many people are waiting
   * @returns {Node[]}
   */
  function likesLocked(count) {
    if (!count) {
      return [
        el('p', { class: 'text-muted', text: 'Nobody is waiting on an answer right now.' }),
        el('p', { class: 'field-hint', text: 'Premium names the people who liked you, including any your deck cannot show. The count above is accurate either way.' })
      ];
    }
    const faces = [];
    for (let i = 0; i < Math.min(count, LOCKED_AVATARS); i += 1) {
      faces.push(el('span', { class: 'new-match' }, [
        el('img', {
          class: 'new-match-avatar',
          attrs: { src: ZC.util.avatarDataUri('zc-locked-' + i, '?'), alt: '', width: '64', height: '64' }
        }),
        el('span', { text: 'Hidden' })
      ]));
    }
    return [
      // The strip scrolls sideways, and a scrollable box with no focusable
      // children becomes a Tab stop in Chrome. This one is decoration hidden
      // from the accessibility tree, so tabindex takes that focusability back.
      el('div', { class: 'new-matches blurred', attrs: { 'aria-hidden': 'true', tabindex: '-1' } }, faces),
      el('div', { class: 'upsell' }, [
        el('p', {
          text: count === 1
            ? 'One person has already liked you.'
            : count + ' people have already liked you.'
        }),
        el('p', {
          class: 'field-hint',
          text: 'Those faces are placeholders, not blurred photos — free accounts never receive the real ones. Premium reveals who they are. Keep swiping and you may meet some of them in the deck, but only the ones your filters, and theirs, still allow.'
        }),
        el('a', { class: 'btn btn-primary', attrs: { href: 'subscription.html' }, text: 'See what Premium changes' })
      ])
    ];
  }

  /**
   * Load and render the "who liked you" panel for the current plan.
   * @returns {Promise<void>}
   */
  async function renderLikes() {
    if (!dom.likesCard || !dom.likesBody || !state.me) return;
    try {
      // The plan is decided BEFORE anything is read. This used to fetch every
      // waiting liker's profile on every plan and then, on free, draw only
      // `likes.length` as placeholders — beside the sentence "free accounts
      // never receive the real ones". They were received: read, billed, and
      // written into the face cache for five minutes. A free account asks for
      // a number now, and gets one.
      const unlocked = canSeeLikes();
      let body;
      if (unlocked) {
        const received = await ZC.store.getLikesReceived(state.me.uid);
        body = likesUnlocked(Array.isArray(received) ? received : []);
      } else {
        body = likesLocked(Math.max(0, Number(await ZC.store.countLikesReceived(state.me.uid)) || 0));
      }
      show(dom.likesCard, true);
      show(dom.likesBadge, !unlocked);
      fill(dom.likesBody, body);
    } catch (err) {
      // A panel that cannot load simply does not appear; it is never the point
      // of the page.
      console.warn('[zc] Who-liked-you could not load:', err);
      show(dom.likesCard, false);
    }
  }

  /* ------------------------------------------------------------------------
     7. Messages
     ------------------------------------------------------------------------ */

  /** Local calendar day of a timestamp, used to place separators. */
  function dayKey(dateLike) {
    return ZC.util.todayKey(dateLike);
  }

  /**
   * 'Today', 'Yesterday' or a plain date, for the separator between days.
   * @param {*} dateLike message timestamp
   * @returns {string}
   */
  function dayLabel(dateLike) {
    const key = dayKey(dateLike);
    if (key === ZC.util.todayKey()) return 'Today';
    // The calendar's yesterday: not the day it was 24 hours ago, and not this
    // time of day one date back. The day clocks go forward is short, so just
    // after it, 24 hours back is two days back. The day they go back is long,
    // so late in it, 24 hours back is still today. Where the hour skipped is
    // the last of its day, as in Nuuk, one date back from 23:30 the next
    // evening is a time that never existed, and it resolves to today. Noon
    // keeps its date through clock changes (only a day skipped whole, as a
    // zone crossed the date line, has no noon), so noon one date back is
    // yesterday.
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    if (key === ZC.util.todayKey(yesterday)) return 'Yesterday';
    return ZC.util.fmtDate(dateLike) || key;
  }

  /**
   * The relative stamp under a bubble, with the exact time as its title — or
   * 'Sending…' for a message the server does not have yet. Only the Firestore
   * adapter delivers those (see `listenMessages` in data-store.js): with no
   * connection the SDK shows its own write at once and holds it in memory, so
   * a time here would say "sent" about a message leaving the page would lose.
   * @param {Object} message a MessageDoc
   * @returns {string}
   */
  function stampText(message) {
    if (message.pending) return 'Sending…';
    return ZC.util.timeAgo(message.createdAt) || '';
  }

  /**
   * One message bubble. `text` is the only user-authored string on this page
   * that a reader ever sees at full length, and it goes in as text content.
   * @param {Object} message a MessageDoc
   * @returns {HTMLElement}
   */
  function buildMessage(message) {
    const mine = message.from === state.me.uid;
    const exact = ZC.util.fmtDate(message.createdAt);
    const clock = ZC.util.fmtTime(message.createdAt);
    return el('div', {
      class: 'msg ' + (mine ? 'msg-me' : 'msg-them'),
      dataset: { id: String(message.id || ''), at: String(message.createdAt || '') }
    }, [
      el('p', { class: 'msg-text', text: String(message.text || '') }),
      el('span', {
        class: 'msg-time',
        text: (mine ? 'You · ' : '') + stampText(message),
        attrs: { title: exact && clock ? exact + ' at ' + clock : '' }
      })
    ]);
  }

  /** A day separator chip. */
  function buildDay(dateLike) {
    return el('p', { class: 'chat-day', text: dayLabel(dateLike) });
  }

  /**
   * The "no messages yet" state, with three openers drawn from what the two of
   * you share. Clicking one loads it into the composer rather than sending it —
   * the first thing you say should still be yours to edit.
   * @param {Object} match the open MatchView
   * @returns {HTMLElement}
   */
  function buildNoMessages(match) {
    const name = nameOf(match.other);
    let lines = [];
    try {
      lines = ZC.matching && typeof ZC.matching.icebreakers === 'function'
        ? (ZC.matching.icebreakers(state.me, match.other, { count: 3 }) || [])
        : [];
    } catch (err) {
      console.warn('[zc] Icebreakers unavailable:', err);
    }

    return el('div', { class: 'empty' }, [
      el('span', { class: 'empty-icon', text: '✨', attrs: { 'aria-hidden': 'true' } }),
      el('h3', { text: 'Say hello to ' + name }),
      el('p', {
        text: lines.length
          ? 'Nobody has written anything yet. These openers were built from what the two of you actually have in common — tap one to drop it in the box, then make it yours.'
          : 'Nobody has written anything yet. A specific first line about something on their profile beats “hey” every time.'
      }),
      lines.length ? el('ul', { class: 'icebreakers' }, lines.map(function (line) {
        return el('li', {}, [
          el('button', {
            class: 'icebreaker',
            attrs: { type: 'button' },
            text: line,
            on: {
              click: function () {
                setComposer(line);
                if (dom.input) dom.input.focus();
                announce('Opener loaded into the message box. Edit it, then press Enter to send.');
              }
            }
          })
        ]);
      })) : null
    ]);
  }

  /** True when the log is scrolled to (or very near) the newest message. */
  function isNearBottom() {
    if (!dom.log) return true;
    return dom.log.scrollHeight - dom.log.scrollTop - dom.log.clientHeight < NEAR_BOTTOM_PX;
  }

  /** Jump the log to the newest message. */
  function scrollToBottom() {
    if (dom.log) dom.log.scrollTop = dom.log.scrollHeight;
  }

  /**
   * Append one message to the log, drawing a day separator first when the
   * calendar day has changed.
   * @param {Object} message a MessageDoc
   * @returns {void}
   */
  function appendMessage(message) {
    const key = dayKey(message.createdAt);
    if (key !== state.lastDay) {
      dom.log.appendChild(buildDay(message.createdAt));
      state.lastDay = key;
    }
    dom.log.appendChild(buildMessage(message));
    state.rendered.push(message);
  }

  /** Paint the "nobody has written yet" state over an empty log. */
  function showNoMessages(match) {
    if (!dom.log) return;
    fill(dom.log, null);
    state.rendered = [];
    state.lastDay = null;
    dom.log.appendChild(buildNoMessages(match));
    scrollToBottom();
  }

  /**
   * A conversation with nothing in it and a conversation that no longer exists
   * both arrive from listenMessages as an empty list, so an empty delivery is
   * checked against a fresh match list before anything is painted. Getting this
   * wrong wipes a visible history and replaces it with an invitation to write
   * into a match the other person has already ended.
   * @param {Object} match the MatchView the empty delivery belongs to
   * @returns {Promise<void>}
   */
  function confirmEmptyThread(match) {
    if (!match || !state.me) return;
    if (!state.active || state.active.matchId !== match.matchId) return;

    // A delivery carrying real messages may have landed in the meantime. That is
    // fresher — and stronger — evidence than the empty snapshot which started
    // the check: messages cannot arrive from a match that no longer exists.
    // Leave the painted conversation alone, or the openers would wipe a message
    // the listener has already delivered and may never send again.
    if (state.rendered.length) return;
    if (state.ended) return;

    // No read. This used to call `getMatches` — one match document and a profile
    // for each of them — every time an empty conversation was opened, to answer
    // a question the live list already knows the answer to. A conversation that
    // has ended leaves the list, and `onViews` is what notices; here, the row
    // still being there means it is simply new.
    const gone = state.gotFirst && !state.matches.some(function (item) {
      return item.matchId === match.matchId;
    });
    if (gone) {
      endActiveConversation();
      return;
    }
    // state.active carries the freshest copy of the same conversation.
    showNoMessages(state.active);
  }

  /**
   * Where a delivery carries on from what is already on screen: the index of
   * its first message not yet drawn, or -1 when it does not carry on at all.
   *
   * "Carries on from", not "starts with". The Firestore adapter delivers the
   * newest LIVE_MESSAGE_WINDOW (200) messages, so past that length every new
   * message slides the window and the delivery starts somewhere INSIDE what is
   * drawn. This used to demand that it start with the first message drawn, so
   * a slid window read as history changing: every bubble was rebuilt, any text
   * the reader had selected went with them, and every message from the other
   * side in the window was announced as new. Measured in firebase mode: one
   * new message in a 205-message conversation was announced as "100 new
   * messages from" its sender. The demo adapter delivers everything, so it
   * never slid.
   * @param {Object[]} messages a delivery, oldest first
   * @returns {number}
   */
  function continuationOf(messages) {
    const shown = state.rendered;
    if (!shown.length || !messages.length) return -1;
    let from = -1;
    for (let i = 0; i < shown.length; i += 1) {
      if (shown[i].id === messages[0].id) {
        from = i;
        break;
      }
    }
    if (from === -1) return -1;
    // Everything drawn from there on has to be where the delivery has it.
    const overlap = shown.length - from;
    if (messages.length < overlap) return -1;
    for (let j = 0; j < overlap; j += 1) {
      if (messages[j].id !== shown[from + j].id) return -1;
    }
    return overlap;
  }

  /**
   * Paint a delivery from ZC.store.listenMessages. Messages only ever arrive
   * at the end, so a delivery that carries on from what is on screen has its
   * tail appended and nothing else touched — not the reader's scroll position,
   * not what they have selected. What a slid window drops off its far end
   * stays drawn: the reader may be in the middle of reading it.
   * @param {Object[]} list ascending messages: all of them in demo mode, the
   *   newest LIVE_MESSAGE_WINDOW in firebase mode
   * @returns {void}
   */
  function renderMessages(list) {
    if (!state.active || !dom.log) return;
    const messages = Array.isArray(list) ? list : [];

    // Nothing to show is the ambiguous case: leave the log exactly as it is
    // until confirmEmptyThread() has established whether this match still
    // exists, then let it paint the openers or close the pane.
    if (!messages.length) {
      state.firstPaint = false;
      confirmEmptyThread(state.active);
      return;
    }

    const stick = state.firstPaint || isNearBottom();

    // Can we extend what is already rendered, or has history changed under us?
    const next = continuationOf(messages);
    let added = [];
    if (next !== -1) {
      // The drawn copies of the overlap are swapped for this delivery's, since
      // the same message can come back changed: sent, where it was sending.
      // `refreshStamps` below redraws every stamp from these.
      state.rendered = state.rendered.slice(0, state.rendered.length - next).concat(messages.slice(0, next));
      added = messages.slice(next);
      added.forEach(appendMessage);
    } else {
      // Even a real rebuild announces only what was not on screen before it.
      const seen = {};
      state.rendered.forEach(function (message) { seen[message.id] = true; });
      fill(dom.log, null);
      state.rendered = [];
      state.lastDay = null;
      messages.forEach(appendMessage);
      added = messages.filter(function (message) { return !seen[message.id]; });
    }

    refreshStamps();
    if (stick) scrollToBottom();

    // Anything that arrived from the other side is worth saying out loud, and
    // worth clearing the unread counter for while the tab is in front.
    const incoming = added.filter(function (message) { return message.from !== state.me.uid; });
    if (!state.firstPaint && incoming.length) {
      const name = nameOf(state.active.other);
      announce(incoming.length === 1
        ? 'New message from ' + name + ': ' + incoming[incoming.length - 1].text
        : incoming.length + ' new messages from ' + name + '.');
      if (document.visibilityState === 'visible') markRead(true);
    }
    state.firstPaint = false;
  }

  /** Re-render the relative stamps so '4m' does not sit there all afternoon. */
  function refreshStamps() {
    // Conversation list rows: their timestamps are deliberately absent from
    // the list fingerprint, so while nothing else about the list changes this
    // is the only thing that keeps them honest.
    if (dom.list) {
      $$('.match-row', dom.list).forEach(function (row) {
        const stamp = $('.match-row-time', row);
        if (!stamp) return;
        const match = state.matches.find(function (item) {
          return item.matchId === row.dataset.matchId;
        });
        if (!match) return;
        stamp.textContent = ZC.util.timeAgo(match.lastMessageAt || match.createdAt) || '';
      });
    }

    if (!dom.log) return;
    $$('.msg', dom.log).forEach(function (node, index) {
      const stamp = $('.msg-time', node);
      const message = state.rendered[index];
      if (!stamp || !message) return;
      stamp.textContent = (message.from === state.me.uid ? 'You · ' : '') + stampText(message);
    });
  }

  /* ------------------------------------------------------------------------
     8. The composer
     ------------------------------------------------------------------------ */

  /**
   * Grow the textarea with its content, up to five rows, then let it scroll.
   * Heights are set through the CSSOM because the shipped CSP forbids inline
   * style attributes.
   * @returns {void}
   */
  function autoGrow() {
    const input = dom.input;
    if (!input) return;
    const styles = window.getComputedStyle(input);
    const lineHeight = parseFloat(styles.lineHeight) || 20;
    const chrome = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0) +
      (parseFloat(styles.borderTopWidth) || 0) + (parseFloat(styles.borderBottomWidth) || 0);
    const max = Math.round(lineHeight * COMPOSER_ROWS + chrome);
    input.style.setProperty('height', 'auto');
    input.style.setProperty('height', Math.min(input.scrollHeight, max) + 'px');
  }

  /** Enable the send button, and warn about the cap only when it is close. */
  function syncComposer() {
    const value = dom.input ? dom.input.value : '';
    const length = value.length;
    if (dom.send) dom.send.disabled = state.sending || !value.trim();
    if (dom.count) {
      dom.count.textContent = length + ' / ' + MESSAGE_MAX;
      show(dom.count, length >= COUNTER_FROM);
    }
  }

  /**
   * Put text in the composer (used by ?draft= and by the icebreakers) and
   * resize it to fit.
   * @param {string} text message body
   * @returns {void}
   */
  function setComposer(text) {
    if (!dom.input) return;
    dom.input.value = String(text === null || text === undefined ? '' : text).slice(0, MESSAGE_MAX);
    autoGrow();
    syncComposer();
    // Put the caret at the end so typing continues the sentence.
    try {
      const end = dom.input.value.length;
      dom.input.setSelectionRange(end, end);
    } catch (err) {
      // Some browsers refuse this on a hidden field; harmless either way.
    }
  }

  /**
   * Ask before leaving while a message is on its way. In firebase mode a send
   * made with no connection does not settle: the SDK holds the write in this
   * page's memory until the server takes it, and the composer has already been
   * cleared, so leaving the page is the one thing that loses the words outright.
   * The bubble says 'Sending…' meanwhile. The question lasts until the whole
   * send has finished, which is a little longer than the message: the
   * conversation's preview and the other side's unread count are written after
   * it, and leaving in between loses those. Browsers show their own wording;
   * all this can do is ask for the prompt.
   *
   * sendMessage adds it for the length of a send and takes it away after,
   * because a page with a `beforeunload` listener is never kept in Firefox's
   * back-forward cache, and this page is built to be restored from it (see the
   * `pageshow` handler).
   * @param {BeforeUnloadEvent} event the page is about to be left
   * @returns {void}
   */
  function askBeforeLeaving(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  /**
   * Send whatever is in the composer. Empty and whitespace-only messages are
   * ignored; anything longer than the cap is trimmed to fit.
   * @returns {Promise<void>}
   */
  async function sendMessage() {
    if (state.sending || !state.active) return;
    const match = state.active;
    const text = (dom.input ? dom.input.value : '').trim().slice(0, MESSAGE_MAX);
    if (!text) return;

    state.sending = true;
    window.addEventListener('beforeunload', askBeforeLeaving);
    setComposer('');
    if (dom.send) {
      dom.send.disabled = true;
      dom.send.setAttribute('aria-busy', 'true');
    }

    try {
      await ZC.store.sendMessage(match.matchId, state.me.uid, text);
      announce('Message sent.');
      // No refresh. The preview and the ordering live on the match document, and
      // the live list is already watching it — this used to spend one read per
      // match plus a profile for each of them on every message sent.
      if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
    } catch (err) {
      console.warn('[zc] Message could not be sent:', err);
      // Give them their words back rather than losing them to a failed write.
      setComposer(text);
      toast('That message could not be sent. Your text is still in the box.', 'error');
      announce('The message could not be sent.');
    } finally {
      state.sending = false;
      window.removeEventListener('beforeunload', askBeforeLeaving);
      if (dom.send) dom.send.removeAttribute('aria-busy');
      syncComposer();
    }
  }

  /* ------------------------------------------------------------------------
     9. Opening and closing a conversation
     ------------------------------------------------------------------------ */

  /** Drop the live subscription for whatever was open. */
  function stopListening() {
    if (typeof state.unsubscribe === 'function') {
      try {
        state.unsubscribe();
      } catch (err) {
        console.warn('[zc] The message listener did not unsubscribe cleanly:', err);
      }
    }
    state.unsubscribe = null;
  }

  /**
   * Clear this conversation's unread counter and repaint what depends on it.
   * The stored counter is only written when there is something to clear, or
   * when `force` says a message just landed in a thread that is already open.
   *
   * A refusal is something this has to hear, and both adapters say it by
   * resolving `false` — neither rejects. Ignoring the answer left the row
   * drawn as read and `#unread-badge` lowered while the stored counter, and
   * the nav badge drawn from it, stayed put; coming back to the tab did not
   * ask again. The next delivery of the list carried the stored count back in
   * only for this to zero the row and write again at once, so the two went on
   * disagreeing. That delivery was the only retry, and in firebase mode the
   * refusal makes one itself — the SDK rolls the write back — so retrying on
   * it was a loop: about sixty refused writes in four seconds against the
   * emulator. Now the count goes back at once, and the conversation is not
   * asked about again until there is a reason to: the reader opening it or
   * coming back to the tab, or a new message landing.
   * @param {boolean} [force=false] write even when the local count is zero
   * @returns {Promise<void>}
   */
  async function markRead(force) {
    const match = state.active;
    if (!match || !state.me) return;
    if (!force && state.readRefused === match.matchId) return;
    const before = Math.max(0, Number(match.unread) || 0);
    const had = before > 0;
    if (had) {
      match.unread = 0;
      renderList();
    }
    if (!had && !force) return;
    let cleared = false;
    try {
      cleared = (await ZC.store.markRead(match.matchId, state.me.uid)) !== false;
    } catch (err) {
      console.warn('[zc] Could not clear the unread counter:', err);
    }
    if (cleared) {
      if (state.readRefused === match.matchId) state.readRefused = null;
      if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
      return;
    }
    state.readRefused = match.matchId;
    // Back to what the store still says, unless a delivery has already put it
    // back with a fresher row — which is what the firebase rollback does.
    if (had && state.active === match && Number(match.unread) === 0) {
      match.unread = before;
      renderList();
    }
  }

  /** Fill the chat header from the open match. */
  function renderHead(match) {
    const other = match.other;
    const name = nameOf(other);
    const age = ageOf(other);
    if (dom.peerPhoto) {
      dom.peerPhoto.setAttribute('src', ZC.util.photoOf(other));
      dom.peerPhoto.setAttribute('alt', '');
    }
    if (dom.peerName) dom.peerName.textContent = name + (age === null ? '' : ', ' + age);

    const bits = [];
    const active = activeText(other);
    if (active) bits.push(active);
    const matched = ZC.util.fmtDate(match.createdAt);
    if (matched) bits.push('matched ' + matched);
    if (dom.peerMeta) dom.peerMeta.textContent = bits.join(' · ');
    if (dom.menu) dom.menu.setAttribute('aria-label', 'Options for your conversation with ' + name);
    if (dom.input) dom.input.setAttribute('placeholder', 'Message ' + nameOf(other) + '…');
  }

  /**
   * Put focus inside the conversation that was just opened, so the pane swap
   * is not a dead end. The composer is the target because it is what somebody
   * opening a conversation came to do, and because the live region has already
   * announced whose conversation it is — the context is not lost by landing on
   * the input rather than the header.
   *
   * This used to be one line at the end of openMatch(), guarded by isWide().
   * Both halves of that guard were the wrong way round. It fired on a phone
   * never — and a phone is where the list is *replaced* by the conversation,
   * so focus was left on a row that is no longer on screen, or on <body> once
   * the repaint removed it. And on a desktop it fired always, including when
   * the page was merely restoring `?m=` from the address bar, which drops the
   * caret into a text field because of a link somebody followed.
   *
   * @param {boolean} [fromUser] true when a person activated a row; a
   *   conversation restored from the URL is left alone deliberately
   * @returns {void}
   */
  function focusConversation(fromUser) {
    if (!fromUser) return;
    if (dom.input && typeof dom.input.focus === 'function') dom.input.focus();
  }

  /**
   * Open a conversation: swap the panes, subscribe to its messages, clear the
   * unread counter and, when a person asked for it, hand focus to the composer.
   *
   * That last part is not decoration. Opening a conversation repaints the left
   * pane, which destroys the row the click came from — so without this, focus
   * falls to <body> and a keyboard user is silently returned to the top of the
   * document, several tab stops from the conversation they just opened. On a
   * phone it is worse: the list is replaced by the conversation, so the pane
   * they are now looking at is the one place their focus is not. closeMatch()
   * has always put focus back on the row it came from; this is the other half
   * of that pair, and the JSDoc here described it long before the code did.
   *
   * Only on a real gesture. The same function restores a conversation named by
   * `?m=` on load, and stealing focus into a text field because of a URL is a
   * different bug: it opens the on-screen keyboard nobody asked for and moves
   * the page out from under whoever followed the link.
   *
   * @param {string} matchId the match to open
   * @param {boolean} [fromUser] true when a person activated a row, rather than
   *   the page restoring a conversation from the address bar
   * @returns {void}
   */
  function openMatch(matchId, fromUser) {
    const match = state.matches.filter(function (item) { return item.matchId === matchId; })[0];
    if (!match) {
      toast('That conversation is not available any more.', 'warn');
      closeMatch();
      return;
    }
    if (state.active && state.active.matchId === matchId) {
      applyPanes();
      focusConversation(fromUser);
      return;
    }

    stopListening();
    // Before anything else: if the previous conversation was ended under the
    // reader, its composer was disabled, and opening ANOTHER one straight from
    // the list — the desktop layout keeps the list beside the thread, so that is
    // one click — never undid it. Only `closeMatch` did, and this path does not
    // go through it. The next conversation opened with a textarea nobody could
    // type into and nothing on screen to say why.
    reopenComposer();
    state.active = match;
    state.rendered = [];
    state.lastDay = null;
    state.firstPaint = true;
    fill(dom.log, null);

    renderHead(match);
    renderList();
    applyPanes();
    syncUrl(matchId);

    // A draft handed over by the match burst goes in before anything else can
    // steal the composer.
    if (state.draft) {
      setComposer(state.draft);
      state.draft = null;
    } else {
      setComposer('');
    }

    // Live messages. The callback runs until this returns unsubscribe().
    state.unsubscribe = ZC.store.listenMessages(matchId, function (list) {
      if (!state.active || state.active.matchId !== matchId) return;
      renderMessages(list);
    });

    // Opening a conversation is a reason to try a refused counter again.
    state.readRefused = null;
    markRead();
    announce('Conversation with ' + nameOf(match.other) + ' opened.');
    focusConversation(fromUser);
  }

  /**
   * The other side ended this conversation while it was open.
   *
   * Not `closeMatch()`, and the difference is three measured harms. `closeMatch`
   * calls `setComposer('')`, which silently destroys a half-written reply for
   * something the person did not do. It then tries to put focus back on the row
   * they came from — a row that by definition no longer exists, so focus falls
   * to `<body>`. And it leaves a live composer aimed at a match whose message
   * write the rules will now refuse.
   *
   * So: keep the header, keep what they typed, stop the listener, say what
   * happened, and disable sending. Back or Escape closes it normally from there,
   * and opening another conversation from the list replaces it; both go through
   * `reopenComposer`.
   * @returns {void}
   */
  function endActiveConversation() {
    if (!state.active || state.ended) return;
    state.ended = true;
    stopListening();
    state.rendered = [];
    state.lastDay = null;
    if (dom.log) {
      fill(dom.log, null);
      // The same `.empty` block the openers use, so it inherits styling that
      // already exists rather than introducing a class the CSS has never heard
      // of — which `tests/static.test.js` would only catch in markup, not here.
      dom.log.appendChild(el('div', { class: 'empty', attrs: { id: 'chat-ended' } }, [
        el('span', { class: 'empty-icon', text: '🚪', attrs: { 'aria-hidden': 'true' } }),
        el('h3', { text: 'This conversation has ended' }),
        el('p', {
          text: shortNameOf(state.active.other) + ' is no longer matched with you, so ' +
            'nothing more can be sent here. What you had typed is still in the box.'
        })
      ]));
    }
    if (dom.send) dom.send.disabled = true;
    if (dom.input) dom.input.disabled = true;
    toast('That conversation has ended.', 'warn');
    announce('That conversation has ended.');
  }

  /**
   * Undo what `endActiveConversation` did to the composer. Every way of leaving
   * an ended conversation goes through here — closing it, or opening another —
   * so there is one place that knows what "not ended" means.
   * @returns {void}
   */
  function reopenComposer() {
    state.ended = false;
    if (dom.input) dom.input.disabled = false;
  }

  /**
   * Close the open conversation and go back to the list.
   * @param {boolean} [keepFocus=false] skip moving focus (used when unmatching)
   * @returns {void}
   */
  function closeMatch(keepFocus) {
    const had = state.active;
    reopenComposer();
    stopListening();
    state.active = null;
    state.rendered = [];
    state.lastDay = null;
    state.firstPaint = true;
    fill(dom.log, null);
    setComposer('');
    renderList();
    applyPanes();
    syncUrl(null);
    if (had && !keepFocus) {
      // Send focus back to the row they came from, so the pane swap is not a
      // dead end for keyboard users. Matched by dataset rather than a selector
      // so no id ever has to be escaped.
      const row = $$('.match-row', dom.list || document).filter(function (node) {
        return node.dataset.matchId === had.matchId;
      })[0];
      if (row && typeof row.focus === 'function') row.focus();
    }
  }

  /**
   * Keep relative stamps fresh for as long as the page is up: the list's rows
   * as much as an open conversation's bubbles. It used to start when a
   * conversation opened and stop when one closed or ended, so a list loaded
   * with no `?m=` — or returned to with Back — had nothing rewriting its stamps
   * at all, and their fingerprint leaves them out on purpose. Started once by
   * `boot`, stopped only by `teardown`, and started again by `pageshow`.
   * @returns {void}
   */
  function startStampTicker() {
    if (stampTimer) return;
    stampTimer = window.setInterval(function () {
      if (document.visibilityState === 'visible') refreshStamps();
    }, STAMP_TICK_MS);
  }

  function stopStampTicker() {
    if (!stampTimer) return;
    window.clearInterval(stampTimer);
    stampTimer = null;
  }

  /* ------------------------------------------------------------------------
     10. The overflow menu
     ------------------------------------------------------------------------ */

  /** Build (once) the TF-IDF corpus the profile view's reasons are scored on. */
  function ensureCorpus() {
    if (state.corpus) return state.corpus;
    if (!ZC.matching || typeof ZC.matching.buildCorpus !== 'function') return null;
    try {
      const docs = state.matches
        .map(function (match) { return match.other; })
        .filter(Boolean)
        .concat([state.me]);
      state.corpus = ZC.matching.buildCorpus(docs);
    } catch (err) {
      console.warn('[zc] Could not build the scoring corpus:', err);
      state.corpus = null;
    }
    return state.corpus;
  }

  /**
   * Their card as it appears in the deck, plus the reasons behind the score.
   * Everything here is user-authored, so everything here is inserted as text.
   * @param {Object} match the open MatchView
   * @returns {HTMLElement}
   */
  function buildProfileCard(match) {
    const other = match.other;
    const p = prof(other);
    const name = nameOf(other);
    const age = ageOf(other);

    // Scored as the deck scores. When one of the deck's hard filters fails,
    // they are matched all the same, so the card is scored again with those
    // filters set aside: the engine stops at the first that fails and returns
    // no score or reasons at all. The distance limits are kept unless distance
    // is what fails, because they also shape the distance term: on the demo
    // seed, with Devin paused, his card keeps the 58.8% it has unpaused, and
    // would read 59% with the limits opened too. The viewer's own filters are
    // named only when they are a cause. This used to print the engine's
    // "Not shown — …" on a card that is being shown, and blame "your current
    // filters" for a change only the other person had made: pausing Discover,
    // which Settings promises leaves existing matches where they are, or
    // narrowing their own age range.
    let result = null;
    let yoursToo = false;
    try {
      if (ZC.matching && typeof ZC.matching.scoreCandidate === 'function') {
        const opts = { corpus: ensureCorpus(), adaptive: adaptiveRanking() };
        result = ZC.matching.scoreCandidate(state.me, other, opts);
        if (result.hardFail) {
          const mine = ZC.matching.scoreCandidate(state.me, withoutFilters(other), opts).hardFail;
          yoursToo = mine === 'gender' || mine === 'age' || mine === 'distance';
          result = ZC.matching.scoreCandidate(withoutFilters(state.me, true), withoutFilters(other, true), opts);
          if (result.hardFail === 'distance') {
            result = ZC.matching.scoreCandidate(withoutFilters(state.me), withoutFilters(other), opts);
          }
        }
      }
    } catch (err) {
      console.warn('[zc] Could not score this profile:', err);
    }

    const card = el('article', { class: 'swipe-card' }, [
      el('img', {
        class: 'swipe-photo',
        attrs: { src: ZC.util.photoOf(other), alt: '', draggable: 'false', decoding: 'async' }
      }),
      el('div', { class: 'swipe-gradient', attrs: { 'aria-hidden': 'true' } })
    ]);

    // The compatibility ring, only when the score is real.
    if (result && !result.hardFail) {
      const score = Math.round(Number(result.score) || 0);
      const band = ZC.matching.compatibilityLabel(result.score);
      const ring = el('span', { class: 'match-score-ring' }, [
        el('span', { class: 'match-score-value', text: String(score) })
      ]);
      ring.style.setProperty('--pct', String(ZC.util.clamp(score, 0, 100)));
      card.appendChild(el('span', {
        class: 'match-score',
        attrs: { title: band.label + ' — ' + score + '% compatible' }
      }, [ring, el('span', { text: 'match' })]));
    }

    const info = el('div', { class: 'swipe-info' }, [
      el('h3', { class: 'swipe-name', text: name }, [
        age === null ? null : el('span', { class: 'swipe-age', text: String(age) })
      ])
    ]);

    const meta = el('div', { class: 'swipe-meta' });
    if (p.location && p.location.label) meta.appendChild(el('span', { class: 'pill', text: String(p.location.label) }));
    if (p.pronouns) meta.appendChild(el('span', { class: 'pill', text: String(p.pronouns) }));
    const active = activeText(other);
    if (active) meta.appendChild(el('span', { class: 'pill', text: '⚡ ' + active }));
    if (meta.childNodes.length) info.appendChild(meta);

    if (typeof p.bio === 'string' && p.bio.trim()) {
      info.appendChild(el('p', { class: 'swipe-bio', text: p.bio.trim() }));
    }

    const interests = Array.isArray(p.interests) ? p.interests : [];
    if (interests.length) {
      info.appendChild(el('div', { class: 'swipe-tags' }, interests.map(function (slug) {
        const tag = tagOf(slug);
        return el('span', { class: 'swipe-tag', text: (tag.emoji ? tag.emoji + ' ' : '') + tag.label });
      })));
    }
    card.appendChild(info);

    const parts = [card];

    // Why the engine put the two of you together, in the same words the deck uses.
    const reasons = result && Array.isArray(result.reasons) ? result.reasons : [];
    if (reasons.length) {
      parts.push(el('div', { class: 'reasons' }, reasons.map(function (reason) {
        return el('p', { class: 'reason' }, [
          el('span', { class: 'reason-icon', text: reason.icon || '•', attrs: { 'aria-hidden': 'true' } }),
          el('span', { text: reason.text || '' })
        ]);
      })));
    }
    if (result && !result.hardFail && typeof ZC.matching.explain === 'function') {
      parts.push(el('p', { class: 'text-muted', text: ZC.matching.explain(result) }));
    }
    if (yoursToo) {
      parts.push(el('p', {
        class: 'field-hint',
        text: 'You are already matched, so this stays open — but your current filters would no longer put them in your deck.'
      }));
    }

    return el('div', { class: 'stack stack-sm' }, parts);
  }

  /**
   * Show their full card in a dialog.
   * @param {Object} match the open MatchView
   * @returns {Promise<void>}
   */
  async function viewProfile(match) {
    if (!ZC.ui || typeof ZC.ui.modal !== 'function') return;
    await ZC.ui.modal({
      title: nameOf(match.other),
      body: buildProfileCard(match),
      actions: [{ id: 'close', label: 'Close', variant: 'primary' }]
    });
  }

  /**
   * Unmatch, optionally blocking them first. Both are confirmed, and both are
   * described honestly before they happen.
   * @param {Object} match the open MatchView
   * @param {boolean} alsoBlock true to add them to `blocked` as well
   * @returns {Promise<void>}
   */
  async function endMatch(match, alsoBlock) {
    const name = nameOf(match.other);
    const question = alsoBlock
      ? 'Blocking ' + name + ' removes this conversation and keeps the two of you out of each other\'s decks from now on. This cannot be undone from here.'
      : 'Unmatching removes this conversation for both of you. You will not see ' + name + ' in your deck again, and this cannot be undone.';

    const ok = ZC.ui && typeof ZC.ui.confirm === 'function'
      ? await ZC.ui.confirm(question, {
        title: alsoBlock ? 'Block ' + name + '?' : 'Unmatch ' + name + '?',
        confirmLabel: alsoBlock ? 'Block and unmatch' : 'Unmatch',
        variant: 'danger'
      })
      : false;
    if (!ok) return;

    // The unmatch goes first even when both were asked for: a block is
    // permanent and has no undo anywhere in the app, so it must never be the
    // half that lands on its own.
    try {
      await ZC.store.unmatch(match.matchId, state.me.uid);
    } catch (err) {
      console.warn('[zc] Could not end the match:', err);
      toast('That did not go through. Please try again.', 'error');
      return;
    }

    state.matches = state.matches.filter(function (item) { return item.matchId !== match.matchId; });
    state.corpus = null;
    closeMatch(true);
    renderList();
    renderLikes();
    if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);

    if (alsoBlock) {
      try {
        // The list is re-read rather than taken from the copy this page booted
        // with: another tab may have blocked someone since, and the store
        // replaces arrays wholesale instead of merging them.
        const fresh = await ZC.store.getUser(state.me.uid);
        if (fresh) state.me = fresh;
        const blocked = Array.isArray(state.me.blocked) ? state.me.blocked.slice() : [];
        if (blocked.indexOf(match.otherUid) === -1) blocked.push(match.otherUid);
        const updated = await ZC.store.updateUser(state.me.uid, { blocked: blocked });
        if (updated) state.me = updated;
      } catch (err) {
        console.warn('[zc] Could not block after unmatching:', err);
        toast('You are no longer matched with ' + name + ', but the block did not save — they can turn up in your deck again.', 'warn');
        announce(name + ' unmatched. The block did not save.');
        return;
      }
    }

    toast(alsoBlock ? name + ' is blocked and the match is gone.' : 'You are no longer matched with ' + name + '.', 'success');
    announce(alsoBlock ? name + ' blocked.' : name + ' unmatched.');
  }

  /**
   * Report the other person: a reason picker, optional detail, and a clear
   * note that the report is kept for review. Offers block-and-unmatch after.
   * @param {Object} match the active MatchView
   * @returns {Promise<void>}
   */
  async function reportUser(match) {
    if (!ZC.ui || typeof ZC.ui.modal !== 'function') return;
    const name = nameOf(match.other);
    const el = ZC.util.el;

    // Reasons and labels come from the store's single closed list, so the
    // dialog can never drift from what the validation (and the rules) accept.
    const reasons = Array.isArray(ZC.store.REPORT_REASONS) ? ZC.store.REPORT_REASONS : [];

    let details = '';
    const select = el('select', {
      class: 'select',
      attrs: { 'aria-label': 'Reason for the report' }
    }, reasons.map(function (reason) {
      return el('option', { text: reason.label || reason.slug, attrs: { value: reason.slug } });
    }));
    const textarea = el('textarea', {
      class: 'textarea',
      attrs: {
        rows: '3',
        maxlength: '500',
        placeholder: 'Anything that helps review this (optional)',
        'aria-label': 'More detail about the report (optional)'
      },
      on: { input: function (event) { details = event.target.value; } }
    });
    const body = el('div', { class: 'stack stack-sm' }, [
      el('p', { text: 'Tell us what is wrong with this profile or conversation. Reports are kept for review and cannot be seen by ' + name + '.' }),
      select,
      textarea
    ]);

    const choice = await ZC.ui.modal({
      title: 'Report ' + name,
      body: body,
      actions: [
        { id: 'cancel', label: 'Cancel', variant: 'ghost' },
        { id: 'send', label: 'Send report', variant: 'danger' }
      ]
    });
    if (choice !== 'send') return;

    try {
      const filed = await ZC.store.reportUser(state.me.uid, match.otherUid, select.value, details);
      toast(filed && filed.duplicate
        ? 'You already reported ' + name + ' — it is in the review queue.'
        : 'Thanks — the report has been filed.', 'success');
      announce('Report filed.');
    } catch (err) {
      // No `return` here, deliberately. A failed filing is the case where the person
      // most needs the other half of this flow: blocking is the protective action they
      // can take themselves, and it does not depend on the report landing. Returning
      // early meant the one person whose report did NOT go through was also the one
      // denied the block — in both storage modes, since the Firestore adapter rejects
      // on a refused write too.
      console.error('[zc] Could not file the report.', err);
      toast('The report could not be filed, but you can still block them.', 'error');
    }

    // Most people who report also want distance; offer it without forcing it.
    const alsoBlock = ZC.ui && typeof ZC.ui.confirm === 'function'
      ? await ZC.ui.confirm('Also block ' + name + ' and remove this conversation?', {
        title: 'Block ' + name + '?',
        confirmLabel: 'Block and unmatch',
        variant: 'danger'
      })
      : false;
    if (alsoBlock) await endMatch(match, true);
  }

  /**
   * The ⋯ menu. It is a dialog rather than a dropdown so it inherits the
   * shared focus trap, Escape handling and mobile sizing for free.
   * @returns {Promise<void>}
   */
  async function openMenu() {
    const match = state.active;
    if (!match || !ZC.ui || typeof ZC.ui.modal !== 'function') return;
    const name = nameOf(match.other);

    const choice = await ZC.ui.modal({
      title: name,
      body: 'Read their full card, report a problem, or end the conversation. Blocking also keeps the two of you out of each other\'s decks.',
      actions: [
        { id: 'close', label: 'Close', variant: 'ghost' },
        { id: 'report', label: 'Report', variant: 'danger' },
        { id: 'block', label: 'Block and unmatch', variant: 'danger' },
        { id: 'unmatch', label: 'Unmatch', variant: 'danger' },
        { id: 'profile', label: 'View profile', variant: 'primary' }
      ]
    });

    if (choice === 'profile') await viewProfile(match);
    else if (choice === 'report') await reportUser(match);
    else if (choice === 'unmatch') await endMatch(match, false);
    else if (choice === 'block') await endMatch(match, true);
  }

  /* ------------------------------------------------------------------------
     11. Loading
     ------------------------------------------------------------------------ */

  /**
   * Silent background refresh of the conversation list: new matches, new
   * previews, new unread counts. Never touches the open chat's messages —
   * the listener owns those.
   * @returns {Promise<void>}
   */
  function onViews(views) {
    if (!state.me) return;
    state.matches = (Array.isArray(views) ? views : []).slice().sort(byActivity);
    state.corpus = null;

    // Keep pointing at the same conversation, with its refreshed preview.
    if (state.active) {
      const still = state.matches.filter(function (item) {
        return item.matchId === state.active.matchId;
      })[0];
      if (still) {
        state.active = still;
        state.ended = false;
        renderHead(still);
        // The open thread is read by definition while it is on screen.
        if (document.visibilityState === 'visible') markRead();
      } else if (!state.ended) {
        endActiveConversation();
      }
    }

    // A delivery is proof the list is live, whichever subscription brought it.
    // The error used to be cleared only in `firstViews`, which runs once per
    // page — so a list that loaded, lost its stream, and came back on focus
    // painted its fresh rows underneath an error panel that never went away:
    // `renderList` hides the list whenever `state.error` is set.
    if (state.gotFirst && state.error) {
      state.error = null;
      announce('Your matches are back.');
    }
    if (!state.gotFirst) firstViews();
    renderList();
  }

  /**
   * The first delivery, which is what `load()` used to be.
   *
   * `?m=` is resolved HERE and nowhere else, and the ordering is the reason: a
   * deep link resolved against a list that has not arrived finds nothing, calls
   * `syncUrl(null)`, and destroys a perfectly good link with nothing left to
   * retry.
   * @returns {void}
   */
  function firstViews() {
    state.gotFirst = true;
    state.loading = false;
    state.error = null;
    stopListDeadline();
    announce(state.matches.length
      ? state.matches.length + (state.matches.length === 1 ? ' match' : ' matches') + ' loaded.'
      : 'You have no matches yet.');

    const wanted = ZC.util.qs('m');
    if (wanted) {
      const known = state.matches.filter(function (item) { return item.matchId === wanted; })[0];
      if (known) openMatch(wanted);
      else {
        toast('That conversation is not available any more.', 'warn');
        syncUrl(null);
        applyPanes();
      }
    } else {
      applyPanes();
    }

    renderLikes();
  }

  /**
   * The stream died. Say so, rather than showing an empty list.
   *
   * The URL is deliberately left alone: `?m=` still names a conversation the
   * retry may well be able to open, and clearing it would throw that away.
   * @param {Error} err whatever the store reported
   * @returns {void}
   */
  function onListError(err) {
    // Release the handle. The store reports this once and the stream is over, so
    // holding a dead subscription makes `subscribeList` a no-op — and with that,
    // coming back to the tab cannot recover, leaving the retry button as the only
    // way out of a failure the browser may already have fixed.
    listStop = null;
    reportListFailure(err || new Error('The conversation list stopped.'));
  }

  /**
   * The first delivery is taking too long — which is NOT the same thing.
   *
   * The subscription here is alive and merely slow, so the handle is kept: a
   * return to the tab must not open a second stream alongside the first, and a
   * delivery that arrives late still clears this and paints.
   * @returns {void}
   */
  function onListDeadline(err) {
    reportListFailure(err);
  }

  /** Paint the failed state and say so, however the list came to fail. */
  function reportListFailure(err) {
    console.error('[zc] The conversation list stopped:', err);
    state.loading = false;
    state.error = err;
    stopListDeadline();
    renderList();
    announce('Your matches could not load. Use the Try again button.');
  }

  /**
   * Subscribe to the live conversation list. Idempotent.
   * @returns {void}
   */
  function subscribeList() {
    if (listStop || !state.me) return;
    listStop = ZC.store.listenMatchViews(state.me.uid, onViews, onListError);
    startListDeadline();
  }

  /** Drop the subscription, if there is one. */
  function unsubscribeList() {
    if (!listStop) return;
    const stop = listStop;
    listStop = null;
    stop();
  }

  /**
   * Say something if the first delivery never arrives.
   *
   * Soft on purpose: a delivery that lands after the deadline is still the first
   * list, so it clears the error, paints, and still opens `?m=`. And when the
   * browser already knows it is offline there is nothing to wait for — with no
   * offline persistence configured, `onSnapshot` simply never delivers, and the
   * page would stare at a skeleton for twelve seconds where the fetch it
   * replaces failed at once.
   * @returns {void}
   */
  function startListDeadline() {
    stopListDeadline();
    if (state.gotFirst) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      onListDeadline(new Error('This browser is offline.'));
      return;
    }
    // The twelve-second path itself is NOT pinned by a check, and saying so is
    // better than implying otherwise: the only way to reach it is to wait twelve
    // seconds, twice, which is a third of the browser suite's runtime for one
    // assertion. What IS pinned is everything it shares with the offline
    // short-circuit above — that a failure is reported, painted, and does not
    // release a subscription that is still alive — plus that the short-circuit
    // exists at all, which is the case a user actually hits.
    listDeadline = window.setTimeout(function () {
      listDeadline = null;
      if (state.gotFirst) return;
      onListDeadline(new Error('The conversation list did not arrive.'));
    }, FIRST_DELIVERY_MS);
  }

  function stopListDeadline() {
    if (!listDeadline) return;
    window.clearTimeout(listDeadline);
    listDeadline = null;
  }

  /**
   * Open the conversation list, or re-open it after a failure.
   *
   * Everything that used to happen here — painting, announcing, opening `?m=` —
   * now happens on the first delivery instead, in `firstViews`. It has to: this
   * function no longer has a list to work from, and resolving a deep link
   * against a list that has not arrived is how a valid `?m=` gets thrown away.
   * @returns {void}
   */
  function load() {
    unsubscribeList();
    state.loading = true;
    state.error = null;
    state.corpus = null;
    state.gotFirst = false;
    renderList();
    applyPanes();
    subscribeList();
  }

  /* ------------------------------------------------------------------------
     12. Wiring and boot
     ------------------------------------------------------------------------ */

  /** Re-read unread state whenever the tab comes back to the foreground. */
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    // Idempotent, and here rather than on a timer: a tab restored from the
    // back-forward cache has run `teardown` and needs its subscription back —
    // and so does a page whose stream died while it was in the background.
    subscribeList();
    if (state.active) {
      // A person looking at the conversation again is the retry a refused
      // counter waits for; see markRead.
      state.readRefused = null;
      markRead();
    }
  }

  /** Release the message listener, the subscription and the timers. */
  function teardown() {
    stopListening();
    stopStampTicker();
    stopListDeadline();
    unsubscribeList();
  }

  /** Wire every control on the page exactly once. */
  function wire() {
    if (dom.listRetry) dom.listRetry.addEventListener('click', function () { load(); });
    if (dom.back) dom.back.addEventListener('click', function () { closeMatch(); });
    if (dom.menu) {
      dom.menu.addEventListener('click', function () { openMenu(); });
      // .chat-head is a plain flex row; push the ⋯ button to its far end.
      // Inline style attributes are CSP-blocked, but CSSOM writes are allowed.
      dom.menu.style.setProperty('margin-left', 'auto');
    }

    if (dom.form) {
      dom.form.addEventListener('submit', function (event) {
        event.preventDefault();
        sendMessage();
      });
    }

    if (dom.input) {
      dom.input.addEventListener('input', function () {
        autoGrow();
        syncComposer();
      });
      dom.input.addEventListener('keydown', function (event) {
        // Enter sends, Shift+Enter starts a line. IME composition is left alone.
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        sendMessage();
      });
    }

    // Escape backs out of a conversation on a phone, where the list is hidden,
    // but not an Escape something else has already acted on. A dialog removes
    // its backdrop as it closes on Escape, before the event bubbles here, so
    // the backdrop check alone let one keypress close the dialog and then the
    // conversation behind it, unsent reply and all. ZC.ui.modal now stops that
    // event; this guard holds for any other handler that consumes an Escape.
    document.addEventListener('keydown', function (event) {
      if (event.defaultPrevented) return;
      if (event.key !== 'Escape' || !state.active || isWide()) return;
      if ($('.modal-backdrop')) return;
      closeMatch();
    });

    // Keep the panes right when the window is resized across the breakpoint.
    if (wideQuery) {
      if (typeof wideQuery.addEventListener === 'function') wideQuery.addEventListener('change', applyPanes);
      else if (typeof wideQuery.addListener === 'function') wideQuery.addListener(applyPanes);
    }

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    window.addEventListener('pagehide', teardown);
    // `pagehide` tears the subscription down and the back-forward cache can
    // restore this document without re-running any of the boot path, so the
    // page needs somewhere to pick it up again. There was no `pageshow` handler
    // anywhere in this app before; the twenty-second poll was covering for it.
    //
    // `teardown` drops FOUR things and this put back ONE. The list came back
    // and the open conversation did not: a restored document still holds
    // `state.active`, but `state.unsubscribe` went with the teardown, so the
    // chat log froze for good — no inbound message, and not even the reader's
    // own — while the list beside it kept updating and `markRead` kept clearing
    // the unread count for messages they could not see. Re-entering the
    // conversation restores the message listener; the stamp ticker is started
    // again below whether or not a conversation is open, since it belongs to
    // the page rather than to any one conversation.
    // `stopListDeadline` is the one that needs nothing: `subscribeList` starts
    // it again, and it returns early once the first delivery has landed.
    window.addEventListener('pageshow', function (event) {
      subscribeList();

      // Everything below runs ONLY for a genuine back-forward restore, and the
      // `persisted` flag is the only thing that says so. `pageshow` also fires
      // on every ordinary load, and `openMatch` resets the thread and the
      // composer — so ungated, this wiped the opener the match burst had just
      // pre-filled and two e2e checks went red. `subscribeList` above stays
      // ungated because it is idempotent, which is why the original handler
      // could get away with no flag at all.
      if (!event || !event.persisted) return;

      // Idempotent, and needed even with no conversation open: the list's own
      // relative stamps go stale without it.
      startStampTicker();
      if (state.active) {
        const id = state.active.matchId;
        // Cleared first, or `openMatch`'s same-conversation short-circuit
        // returns before it re-subscribes.
        state.active = null;
        openMatch(id, false);
      }
    });
  }

  /**
   * Start the page: require a finished profile, then load the matches.
   * @returns {Promise<void>}
   */
  async function boot() {
    if (!ZC.auth || typeof ZC.auth.requireProfile !== 'function' || !ZC.store) {
      state.loading = false;
      state.error = new Error('The app scripts did not all load.');
      renderList();
      return;
    }
    try {
      // Redirects (and never resolves) when signed out or still onboarding.
      const me = await ZC.auth.requireProfile();
      if (!me) return;
      state.me = me;
      // Read the draft before the URL is rewritten by the first openMatch().
      state.draft = ZC.util.qs('draft');
      wire();
      syncComposer();
      startStampTicker();
      await load();
    } catch (err) {
      console.error('[zc] The matches page could not start:', err);
      state.loading = false;
      state.error = err;
      renderList();
    }
  }

  // app.js resolves this once the DOM and the first auth state are settled.
  if (ZC.app && typeof ZC.app.onReady === 'function') {
    ZC.app.onReady(function () { return boot(); });
  } else {
    boot();
  }
})();
