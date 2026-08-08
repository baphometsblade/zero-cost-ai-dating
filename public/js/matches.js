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
  const LIST_POLL_MS = 20000;        // silent refresh of the conversation list
  const STAMP_TICK_MS = 60000;       // keep relative timestamps honest
  const LOCKED_AVATARS = 5;          // placeholder faces behind the Premium blur
  const NEW_MATCH_NAME_MAX = 14;     // the strip is 76px wide; keep labels short
  const DAY_MS = 86400000;

  /* ------------------------------------------------------------------------
     2. Elements and state
     ------------------------------------------------------------------------ */

  const dom = {
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
    refreshing: false,
    refreshWarned: false
  };

  // Wide enough for both panes at once — the same breakpoint .two-pane uses.
  const wideQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(min-width: 900px)')
    : null;

  let listTimer = null;
  let stampTimer = null;

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
  }

  /* ------------------------------------------------------------------------
     5. The conversation list
     ------------------------------------------------------------------------ */

  /**
   * One entry in the horizontally scrolling "new matches" strip.
   * @param {Object} match a MatchView with no messages yet
   * @returns {HTMLElement}
   */
  function buildNewMatch(match) {
    const name = nameOf(match.other);
    return el('a', {
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
    ]);
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

    const label = name +
      (unread ? ', ' + unread + ' unread ' + (unread === 1 ? 'message' : 'messages') : '') +
      (stamp ? ', last activity ' + stamp : '');

    const row = el('a', {
      class: 'match-row' +
        (unread ? ' is-unread' : '') +
        (state.active && state.active.matchId === match.matchId ? ' is-active' : ''),
      dataset: { matchId: match.matchId },
      attrs: {
        href: 'matches.html?m=' + encodeURIComponent(match.matchId),
        'aria-label': label
      }
    }, [
      el('img', {
        class: 'match-row-avatar',
        attrs: { src: ZC.util.photoOf(match.other), alt: '', width: '52', height: '52', decoding: 'async' }
      }),
      el('span', { class: 'match-row-body' }, [
        el('span', { class: 'match-row-name', text: name }),
        el('span', { class: 'match-row-preview', text: preview })
      ]),
      el('span', { class: 'match-row-time', text: stamp }),
      el('span', { class: 'match-row-dot', attrs: { 'aria-hidden': 'true' } })
    ]);
    if (state.active && state.active.matchId === match.matchId) row.setAttribute('aria-current', 'true');

    // Intercept the click so the pane swaps instead of reloading, but leave
    // the href intact for middle-click, bookmarks and no-JS crawlers.
    row.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      openMatch(match.matchId);
    });
    return el('li', {}, [row]);
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
    fill(dom.newStrip, fresh.map(buildNewMatch));

    // Every match appears in the list, newest activity first.
    fill(dom.list, state.matches.slice().sort(byActivity).map(buildRow));

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
    const plan = state.me && state.me.plan === 'premium' ? 'premium' : 'free';
    const limits = (ZC.config && ZC.config.limits && ZC.config.limits[plan]) || null;
    return !!(limits && limits.seeLikedYou);
  }

  /**
   * The Premium view: real faces, real names, and the one action that helps —
   * going back to the deck, where they are waiting.
   * @param {Object[]} likes UserDocs who liked me
   * @returns {Node[]}
   */
  function likesUnlocked(likes) {
    if (!likes.length) {
      return [el('p', { class: 'text-muted', text: 'Nobody is waiting on an answer right now. New likes will show up here.' })];
    }
    const strip = el('div', { class: 'new-matches' }, likes.map(function (doc) {
      return el('a', {
        class: 'new-match',
        attrs: { href: 'dashboard.html', 'aria-label': nameOf(doc) + ' liked you. Open Discover to answer.' }
      }, [
        el('img', {
          class: 'new-match-avatar',
          attrs: { src: ZC.util.photoOf(doc), alt: '', width: '64', height: '64', decoding: 'async' }
        }),
        el('span', { text: shortNameOf(doc) })
      ]);
    }));
    return [
      strip,
      el('p', { class: 'field-hint', text: likes.length === 1
        ? 'One person liked you and is still in your deck. Like them back and the conversation opens straight away.'
        : likes.length + ' people liked you and are still in your deck. Like them back and the conversation opens straight away.' })
    ];
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
        el('p', { class: 'field-hint', text: 'Premium names the people who liked you before you reach them in the deck. The count above is accurate either way.' })
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
      el('div', { class: 'new-matches blurred', attrs: { 'aria-hidden': 'true' } }, faces),
      el('div', { class: 'upsell' }, [
        el('p', {
          text: count === 1
            ? 'One person has already liked you.'
            : count + ' people have already liked you.'
        }),
        el('p', {
          class: 'field-hint',
          text: 'Those faces are placeholders, not blurred photos — free accounts never receive the real ones. Premium reveals who they are; you can also just keep swiping and find them in the deck.'
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
      const received = await ZC.store.getLikesReceived(state.me.uid);
      const likes = Array.isArray(received) ? received : [];
      const unlocked = canSeeLikes();
      show(dom.likesCard, true);
      show(dom.likesBadge, !unlocked);
      fill(dom.likesBody, unlocked ? likesUnlocked(likes) : likesLocked(likes.length));
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
    if (key === ZC.util.todayKey(new Date(Date.now() - DAY_MS))) return 'Yesterday';
    return ZC.util.fmtDate(dateLike) || key;
  }

  /** The relative stamp under a bubble, with the exact time as its title. */
  function stampText(message) {
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

  /**
   * Paint a delivery from ZC.store.listenMessages. Messages only ever arrive
   * at the end, so when the list still starts with what is already on screen
   * we append the tail and leave the reader's scroll position alone.
   * @param {Object[]} list the full ascending message list
   * @returns {void}
   */
  function renderMessages(list) {
    if (!state.active || !dom.log) return;
    const messages = Array.isArray(list) ? list : [];
    const stick = state.firstPaint || isNearBottom();

    // Can we extend what is already rendered, or has history changed under us?
    let canAppend = state.rendered.length > 0 && messages.length >= state.rendered.length;
    if (canAppend) {
      for (let i = 0; i < state.rendered.length; i += 1) {
        if (!messages[i] || messages[i].id !== state.rendered[i].id) {
          canAppend = false;
          break;
        }
      }
    }

    let added = [];
    if (canAppend) {
      added = messages.slice(state.rendered.length);
      added.forEach(appendMessage);
    } else {
      fill(dom.log, null);
      state.rendered = [];
      state.lastDay = null;
      if (!messages.length) {
        dom.log.appendChild(buildNoMessages(state.active));
      } else {
        messages.forEach(appendMessage);
        added = messages;
      }
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
    setComposer('');
    if (dom.send) {
      dom.send.disabled = true;
      dom.send.setAttribute('aria-busy', 'true');
    }

    try {
      await ZC.store.sendMessage(match.matchId, state.me.uid, text);
      announce('Message sent.');
      // The preview and the ordering on the left live on the match document.
      refreshMatches();
      if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
    } catch (err) {
      console.warn('[zc] Message could not be sent:', err);
      // Give them their words back rather than losing them to a failed write.
      setComposer(text);
      toast('That message could not be sent. Your text is still in the box.', 'error');
      announce('The message could not be sent.');
    } finally {
      state.sending = false;
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
   * @param {boolean} [force=false] write even when the local count is zero
   * @returns {Promise<void>}
   */
  async function markRead(force) {
    const match = state.active;
    if (!match || !state.me) return;
    const had = Number(match.unread) > 0;
    if (had) {
      match.unread = 0;
      renderList();
    }
    if (!had && !force) return;
    try {
      await ZC.store.markRead(match.matchId, state.me.uid);
      if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
    } catch (err) {
      // The badge will correct itself on the next poll.
      console.warn('[zc] Could not clear the unread counter:', err);
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
   * Open a conversation: swap the panes, subscribe to its messages, clear the
   * unread counter and hand focus to the composer.
   * @param {string} matchId the match to open
   * @returns {void}
   */
  function openMatch(matchId) {
    const match = state.matches.filter(function (item) { return item.matchId === matchId; })[0];
    if (!match) {
      toast('That conversation is not available any more.', 'warn');
      closeMatch();
      return;
    }
    if (state.active && state.active.matchId === matchId) {
      applyPanes();
      return;
    }

    stopListening();
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

    markRead();
    announce('Conversation with ' + nameOf(match.other) + ' opened.');
    startStampTicker();
    if (dom.input && isWide()) dom.input.focus();
  }

  /**
   * Close the open conversation and go back to the list.
   * @param {boolean} [keepFocus=false] skip moving focus (used when unmatching)
   * @returns {void}
   */
  function closeMatch(keepFocus) {
    const had = state.active;
    stopListening();
    stopStampTicker();
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

  /** Keep relative stamps fresh while a conversation is open. */
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

    let result = null;
    try {
      result = ZC.matching && typeof ZC.matching.scoreCandidate === 'function'
        ? ZC.matching.scoreCandidate(state.me, other, {
          corpus: ensureCorpus(),
          adaptive: state.me.plan === 'premium',
          includeHardFails: true
        })
        : null;
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
    if (result && typeof ZC.matching.explain === 'function') {
      parts.push(el('p', { class: 'text-muted', text: ZC.matching.explain(result) }));
    }
    if (result && result.hardFail) {
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

    try {
      if (alsoBlock) {
        const blocked = Array.isArray(state.me.blocked) ? state.me.blocked.slice() : [];
        if (blocked.indexOf(match.otherUid) === -1) blocked.push(match.otherUid);
        const updated = await ZC.store.updateUser(state.me.uid, { blocked: blocked });
        if (updated) state.me = updated;
      }
      await ZC.store.unmatch(match.matchId, state.me.uid);
      state.matches = state.matches.filter(function (item) { return item.matchId !== match.matchId; });
      state.corpus = null;
      closeMatch(true);
      renderList();
      renderLikes();
      if (ZC.app && typeof ZC.app.refreshBadges === 'function') ZC.app.refreshBadges(true);
      toast(alsoBlock ? name + ' is blocked and the match is gone.' : 'You are no longer matched with ' + name + '.', 'success');
      announce(alsoBlock ? name + ' blocked.' : name + ' unmatched.');
    } catch (err) {
      console.warn('[zc] Could not end the match:', err);
      toast('That did not go through. Please try again.', 'error');
    }
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

    // The human-readable labels for the store's closed reason list.
    const REASON_LABELS = {
      'fake-profile': 'Fake or impersonating profile',
      'inappropriate-content': 'Inappropriate photos or bio',
      'harassment': 'Harassment or threats',
      'underage': 'Appears to be under 18',
      'scam-or-spam': 'Scam, spam or solicitation',
      'other': 'Something else'
    };
    const reasons = (ZC.store.REPORT_REASONS || Object.keys(REASON_LABELS));

    let details = '';
    const select = el('select', {
      class: 'select',
      attrs: { 'aria-label': 'Reason for the report' }
    }, reasons.map(function (slug) {
      return el('option', { text: REASON_LABELS[slug] || slug, attrs: { value: slug } });
    }));
    const textarea = el('textarea', {
      class: 'textarea',
      attrs: { rows: '3', maxlength: '500', placeholder: 'Anything that helps review this (optional)' },
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
      await ZC.store.reportUser(state.me.uid, match.otherUid, select.value, details);
      toast('Thanks — the report has been filed.', 'success');
      announce('Report filed.');
    } catch (err) {
      console.error('[zc] Could not file the report.', err);
      toast('The report could not be filed. Please try again.', 'error');
      return;
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
  async function refreshMatches() {
    if (state.refreshing || !state.me) return;
    state.refreshing = true;
    try {
      const list = await ZC.store.getMatches(state.me.uid);
      state.matches = (Array.isArray(list) ? list : []).slice().sort(byActivity);
      // Keep pointing at the same conversation, with its refreshed preview.
      if (state.active) {
        const still = state.matches.filter(function (item) {
          return item.matchId === state.active.matchId;
        })[0];
        if (still) {
          state.active = still;
          renderHead(still);
          // The open thread is read by definition while it is on screen.
          if (document.visibilityState === 'visible') markRead();
        } else {
          toast('That conversation has ended.', 'warn');
          closeMatch();
        }
      }
      renderList();
    } catch (err) {
      if (!state.refreshWarned) {
        state.refreshWarned = true;
        console.warn('[zc] The match list could not refresh:', err);
      }
    } finally {
      state.refreshing = false;
    }
  }

  /**
   * First load: fetch every match, paint the list, then open whatever `?m=`
   * asks for.
   * @returns {Promise<void>}
   */
  async function load() {
    state.loading = true;
    state.error = null;
    state.corpus = null;
    renderList();
    applyPanes();

    try {
      const list = await ZC.store.getMatches(state.me.uid);
      state.matches = (Array.isArray(list) ? list : []).slice().sort(byActivity);
      state.loading = false;
      renderList();
      announce(state.matches.length
        ? state.matches.length + (state.matches.length === 1 ? ' match' : ' matches') + ' loaded.'
        : 'You have no matches yet.');
    } catch (err) {
      console.error('[zc] The match list failed to load:', err);
      state.loading = false;
      state.error = err;
      renderList();
      announce('Your matches could not load. Use the Try again button.');
      toast('Your matches could not load.', 'error');
      return;
    }

    // ?m= selects a conversation; anything unknown is quietly dropped.
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

  /* ------------------------------------------------------------------------
     12. Wiring and boot
     ------------------------------------------------------------------------ */

  /** Re-read unread state whenever the tab comes back to the foreground. */
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    refreshMatches();
    if (state.active) markRead();
  }

  /** Release the message listener and the timers. */
  function teardown() {
    stopListening();
    stopStampTicker();
    if (listTimer) {
      window.clearInterval(listTimer);
      listTimer = null;
    }
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

    // Escape backs out of a conversation on a phone, where the list is hidden.
    document.addEventListener('keydown', function (event) {
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

    // A quiet poll so matches made in another tab turn up here too.
    listTimer = window.setInterval(function () {
      if (document.visibilityState === 'visible') refreshMatches();
    }, LIST_POLL_MS);
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
