/* ==========================================================================
   Zero Cost AI Dating — utilities and the overlay layer
   Small, dependency-free helpers used by every page: DOM building, formatting,
   geo math, the deterministic SVG avatar generator, plus toasts and modals.
   Nothing here touches the network or storage.
   Exposes: ZC.util, ZC.ui.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  /* ------------------------------------------------------------------------
     1. DOM helpers
     ------------------------------------------------------------------------ */

  /**
   * querySelector shorthand.
   * @param {string} sel CSS selector
   * @param {ParentNode} [root=document] search root
   * @returns {Element|null}
   */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  /**
   * querySelectorAll shorthand, returned as a real array.
   * @param {string} sel CSS selector
   * @param {ParentNode} [root=document] search root
   * @returns {Element[]}
   */
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  const DOM_PROP_KEYS = { class: 1, className: 1, text: 1, html: 1, attrs: 1, on: 1, style: 1, dataset: 1 };

  /**
   * Build an element.
   * Supported props: `class` (string|string[]), `text` (safe text content),
   * `html` (TRUSTED markup only — never pass user or seed strings here),
   * `attrs` ({name: value}), `on` ({event: handler}), `style` ({prop: value},
   * applied via CSSOM so the shipped CSP stays happy), `dataset` ({key: value}).
   * Any other scalar prop is set as an attribute, so el('input', {type:'email'})
   * does the obvious thing.
   * @param {string} tag tag name
   * @param {Object} [props={}] see above
   * @param {(Node|string|number|Array)} [children=[]] appended in order
   * @returns {HTMLElement}
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    const p = props || {};

    if (p.class) node.className = Array.isArray(p.class) ? p.class.filter(Boolean).join(' ') : String(p.class);
    if (p.className) node.className = String(p.className);
    if (p.text !== undefined && p.text !== null) node.textContent = String(p.text);
    // Trusted markup only. Every user-authored string must come in via `text`.
    if (p.html !== undefined && p.html !== null) node.innerHTML = String(p.html);

    if (p.attrs) {
      Object.keys(p.attrs).forEach(function (name) {
        const value = p.attrs[name];
        if (value === null || value === undefined || value === false) return;
        node.setAttribute(name, value === true ? '' : String(value));
      });
    }

    if (p.style) {
      Object.keys(p.style).forEach(function (prop) {
        const value = p.style[prop];
        if (value === null || value === undefined) return;
        node.style.setProperty(prop, String(value));
      });
    }

    if (p.dataset) {
      Object.keys(p.dataset).forEach(function (key) {
        const value = p.dataset[key];
        if (value === null || value === undefined) return;
        node.dataset[key] = String(value);
      });
    }

    if (p.on) {
      Object.keys(p.on).forEach(function (evt) {
        if (typeof p.on[evt] === 'function') node.addEventListener(evt, p.on[evt]);
      });
    }

    // Leftover scalar props become plain attributes.
    Object.keys(p).forEach(function (key) {
      if (DOM_PROP_KEYS[key]) return;
      const value = p[key];
      const t = typeof value;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') return;
      if (value === false) return;
      node.setAttribute(key, value === true ? '' : String(value));
    });

    appendChildren(node, children);
    return node;
  }

  /**
   * Append children, flattening arrays and turning primitives into text nodes.
   * @param {Node} parent target node
   * @param {*} children node, string, number or (nested) array of those
   * @returns {Node} the parent
   */
  function appendChildren(parent, children) {
    if (children === null || children === undefined || children === false) return parent;
    if (Array.isArray(children)) {
      children.forEach(function (child) { appendChildren(parent, child); });
      return parent;
    }
    if (children instanceof Node) {
      parent.appendChild(children);
      return parent;
    }
    parent.appendChild(document.createTextNode(String(children)));
    return parent;
  }

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  /**
   * Escape a string for safe inclusion in markup. Prefer `text:`/textContent;
   * this exists for the rare case where a string is composed into trusted HTML.
   * @param {*} str value to escape
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str).replace(/[&<>"']/g, function (ch) {
      return HTML_ESCAPES[ch];
    });
  }

  /* ------------------------------------------------------------------------
     2. Numbers, timing and ids
     ------------------------------------------------------------------------ */

  /**
   * Constrain a number to a range. Non-numeric input yields `lo`.
   * @param {number} n value
   * @param {number} lo lower bound
   * @param {number} hi upper bound
   * @returns {number}
   */
  function clamp(n, lo, hi) {
    const value = Number(n);
    if (!isFinite(value)) return lo;
    return value < lo ? lo : value > hi ? hi : value;
  }

  /**
   * Delay a call until `ms` have passed without another call.
   * The returned function exposes `.cancel()`.
   * @param {Function} fn function to debounce
   * @param {number} ms quiet period in milliseconds
   * @returns {Function}
   */
  function debounce(fn, ms) {
    let timer = null;
    function debounced() {
      const args = arguments;
      const self = this;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        fn.apply(self, args);
      }, ms);
    }
    debounced.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return debounced;
  }

  /**
   * Run at most once per `ms`, leading edge, with a trailing call for the last
   * invocation that arrived during the cooldown.
   * @param {Function} fn function to throttle
   * @param {number} ms cooldown in milliseconds
   * @returns {Function}
   */
  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let pending = null;
    function invoke(self, args) {
      last = Date.now();
      fn.apply(self, args);
    }
    function throttled() {
      const args = arguments;
      const self = this;
      const elapsed = Date.now() - last;
      if (elapsed >= ms) {
        if (timer) { clearTimeout(timer); timer = null; }
        invoke(self, args);
        return;
      }
      pending = { self: self, args: args };
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        if (pending) {
          const call = pending;
          pending = null;
          invoke(call.self, call.args);
        }
      }, ms - elapsed);
    }
    throttled.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    };
    return throttled;
  }

  const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  /**
   * A random 20-character id (crypto-backed where available).
   * @returns {string}
   */
  function uid() {
    let out = '';
    let i;
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.getRandomValues === 'function') {
      const bytes = new Uint8Array(20);
      c.getRandomValues(bytes);
      for (i = 0; i < 20; i += 1) out += UID_ALPHABET[bytes[i] % UID_ALPHABET.length];
      return out;
    }
    for (i = 0; i < 20; i += 1) out += UID_ALPHABET[Math.floor(Math.random() * UID_ALPHABET.length)];
    return out;
  }

  /**
   * Sleep for `ms` milliseconds.
   * @param {number} ms delay
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, Math.max(0, Number(ms) || 0)); });
  }

  /* ------------------------------------------------------------------------
     3. Dates
     ------------------------------------------------------------------------ */

  const PLAIN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * Coerce anything date-ish (Date, ISO string, epoch ms, Firestore Timestamp)
   * into a Date, or null when it cannot be parsed.
   * @param {*} value date-like value
   * @returns {Date|null}
   */
  function toDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'object' && typeof value.toDate === 'function') {
      try {
        const converted = value.toDate();
        return converted instanceof Date && !isNaN(converted.getTime()) ? converted : null;
      } catch (err) {
        return null;
      }
    }
    if (typeof value === 'number') {
      const fromNumber = new Date(value);
      return isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    const str = String(value);
    const plain = PLAIN_DATE_RE.exec(str);
    // Bare YYYY-MM-DD is parsed as UTC by the spec; treat it as a local calendar day.
    if (plain) {
      const local = new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
      return isNaN(local.getTime()) ? null : local;
    }
    const parsed = new Date(str);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * Today's local calendar day as 'YYYY-MM-DD' — the key daily usage resets on.
   * @param {*} [dateLike] optional date to key instead of now
   * @returns {string}
   */
  function todayKey(dateLike) {
    const d = dateLike ? toDate(dateLike) || new Date() : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * Whole years between a birthdate and today.
   * @param {string} iso 'YYYY-MM-DD' (other date-like values also accepted)
   * @returns {number|null} age in years, or null when unparseable/absurd
   */
  function ageFromBirthdate(iso) {
    const born = toDate(iso);
    if (!born) return null;
    const now = new Date();
    let age = now.getFullYear() - born.getFullYear();
    const monthDelta = now.getMonth() - born.getMonth();
    if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < born.getDate())) age -= 1;
    return age >= 0 && age <= 130 ? age : null;
  }

  const MINUTE = 60000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  /**
   * Compact relative time: 'just now', '4m', '3h', '2d', then '5 Mar'.
   * @param {*} dateLike date-like value
   * @returns {string} empty string when unparseable
   */
  function timeAgo(dateLike) {
    const d = toDate(dateLike);
    if (!d) return '';
    const diff = Date.now() - d.getTime();
    if (diff < 45000) return 'just now';
    if (diff < HOUR) return Math.max(1, Math.round(diff / MINUTE)) + 'm';
    if (diff < DAY) return Math.max(1, Math.floor(diff / HOUR)) + 'h';
    if (diff < 7 * DAY) return Math.max(1, Math.floor(diff / DAY)) + 'd';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  /**
   * Locale date, e.g. '5 Mar 2026'.
   * @param {*} dateLike date-like value
   * @returns {string}
   */
  function fmtDate(dateLike) {
    const d = toDate(dateLike);
    if (!d) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /**
   * Locale clock time, e.g. '9:04 PM'.
   * @param {*} dateLike date-like value
   * @returns {string}
   */
  function fmtTime(dateLike) {
    const d = toDate(dateLike);
    if (!d) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /* ------------------------------------------------------------------------
     4. Geo + hashing
     ------------------------------------------------------------------------ */

  const EARTH_RADIUS_KM = 6371;

  function toRad(deg) {
    return (deg * Math.PI) / 180;
  }

  /**
   * Great-circle distance between two {lat, lng} points.
   * @param {{lat:number,lng:number}} a first point
   * @param {{lat:number,lng:number}} b second point
   * @returns {number|null} kilometres, or null when either point is missing
   */
  function haversineKm(a, b) {
    if (!a || !b) return null;
    const lat1 = Number(a.lat);
    const lng1 = Number(a.lng);
    const lat2 = Number(b.lat);
    const lng2 = Number(b.lng);
    if (!isFinite(lat1) || !isFinite(lng1) || !isFinite(lat2) || !isFinite(lng2)) return null;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /**
   * Stable 32-bit unsigned hash (FNV-1a). Used for avatars and any place that
   * needs "random but the same every time".
   * @param {*} str value to hash
   * @returns {number} 0..4294967295
   */
  function hashString(str) {
    const s = String(str === null || str === undefined ? '' : str);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /* ------------------------------------------------------------------------
     5. Avatars
     ------------------------------------------------------------------------ */

  /**
   * Up to two uppercase initials from a name. Code-point aware so emoji and
   * non-Latin names do not get sliced in half.
   * @param {string} name display name
   * @returns {string} e.g. 'AR', or '?' when nothing usable
   */
  function initials(name) {
    const words = String(name === null || name === undefined ? '' : name)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return '?';
    const first = Array.from(words[0])[0] || '';
    const last = words.length > 1 ? (Array.from(words[words.length - 1])[0] || '') : '';
    const out = (first + last).toUpperCase();
    return out || '?';
  }

  function escapeXml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Deterministic 400x400 gradient avatar as an SVG data URI. The same seed
   * always produces the same picture — this is how the app ships "photos"
   * without Cloud Storage. URI-encoded (never base64) so non-Latin initials work.
   * @param {string} seedString stable seed, usually a uid
   * @param {string} [name] name the initials are drawn from
   * @returns {string} data:image/svg+xml,... URI
   */
  function avatarDataUri(seedString, name) {
    const h = hashString(seedString);
    const hueA = h % 360;
    const hueB = (hueA + 35 + ((h >>> 9) % 90)) % 360;
    const sat = 58 + ((h >>> 17) % 22);
    const lightA = 46 + ((h >>> 23) % 12);
    const lightB = 30 + ((h >>> 5) % 14);
    const text = escapeXml(initials(name || seedString));
    const gradId = 'g' + h.toString(36);

    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">' +
      '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + hueA + ',' + sat + '%,' + lightA + '%)"/>' +
      '<stop offset="1" stop-color="hsl(' + hueB + ',' + sat + '%,' + lightB + '%)"/>' +
      '</linearGradient></defs>' +
      '<rect width="400" height="400" fill="url(#' + gradId + ')"/>' +
      '<circle cx="320" cy="86" r="150" fill="#ffffff" opacity="0.10"/>' +
      '<circle cx="70" cy="350" r="120" fill="#000000" opacity="0.08"/>' +
      '<text x="200" y="200" text-anchor="middle" dominant-baseline="central" ' +
      'font-family="ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif" ' +
      'font-size="150" font-weight="600" fill="#ffffff" fill-opacity="0.94">' + text + '</text>' +
      '</svg>';

    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  /**
   * The image to show for a profile: their first https photo, else a generated
   * avatar. Accepts a whole UserDoc or a bare `profile` object.
   * @param {Object} profile UserDoc or UserDoc.profile
   * @returns {string} image URL or data URI
   */
  function photoOf(profile) {
    if (!profile) return avatarDataUri('anonymous', '');
    const inner = (profile.profile && typeof profile.profile === 'object') ? profile.profile : profile;
    const photos = Array.isArray(inner.photos) ? inner.photos : [];
    for (let i = 0; i < photos.length; i += 1) {
      const url = typeof photos[i] === 'string' ? photos[i].trim() : '';
      // https only — http images would be blocked and are a privacy leak anyway.
      if (/^https:\/\//i.test(url)) return url;
    }
    const seed = profile.uid || inner.uid || profile.displayName || 'zc';
    return avatarDataUri(seed, profile.displayName || inner.displayName || '');
  }

  /* ------------------------------------------------------------------------
     6. URL
     ------------------------------------------------------------------------ */

  /**
   * Read a query-string parameter from the current URL.
   * @param {string} name parameter name
   * @param {string} [search] optional search string to read instead
   * @returns {string|null}
   */
  function qs(name, search) {
    try {
      return new URLSearchParams(search === undefined ? window.location.search : search).get(name);
    } catch (err) {
      return null;
    }
  }

  ZC.util = {
    $: $,
    $$: $$,
    el: el,
    append: appendChildren,
    escapeHtml: escapeHtml,
    clamp: clamp,
    debounce: debounce,
    throttle: throttle,
    uid: uid,
    sleep: sleep,
    toDate: toDate,
    todayKey: todayKey,
    ageFromBirthdate: ageFromBirthdate,
    timeAgo: timeAgo,
    fmtDate: fmtDate,
    fmtTime: fmtTime,
    haversineKm: haversineKm,
    hashString: hashString,
    initials: initials,
    avatarDataUri: avatarDataUri,
    photoOf: photoOf,
    qs: qs
  };

  /* ========================================================================
     7. ZC.ui — toasts
     ======================================================================== */

  const TOAST_KINDS = { info: 1, success: 1, warn: 1, error: 1 };

  /**
   * Create (once) and return the live region every toast is appended to.
   * @returns {HTMLElement} the .toast-host element
   */
  function mountToastHost() {
    let host = document.querySelector('.toast-host');
    if (host) return host;
    host = el('div', {
      class: 'toast-host',
      attrs: { role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifications' }
    });
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  /**
   * Show a transient message. Click dismisses it early.
   * @param {string} message text to show (inserted as text, never markup)
   * @param {'info'|'success'|'warn'|'error'} [kind='info'] visual tone
   * @param {number} [ms=3200] lifetime in milliseconds
   * @returns {Function} dismiss the toast immediately
   */
  function toast(message, kind, ms) {
    const tone = TOAST_KINDS[kind] ? kind : 'info';
    const life = typeof ms === 'number' && isFinite(ms) ? ms : 3200;
    const host = mountToastHost();
    const node = el('div', {
      class: 'toast toast-' + tone,
      text: message === null || message === undefined ? '' : String(message),
      attrs: { role: tone === 'error' ? 'alert' : 'status' }
    });
    host.appendChild(node);

    let done = false;
    function dismiss() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Fade out via CSSOM (inline style attributes are forbidden by the CSP,
      // but setting properties from script is fine).
      node.style.setProperty('opacity', '0');
      node.style.setProperty('transform', 'translateY(8px)');
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }

    const timer = setTimeout(dismiss, Math.max(600, life));
    node.addEventListener('click', dismiss);
    return dismiss;
  }

  /* ------------------------------------------------------------------------
     8. ZC.ui — modals (focus-trapped, Escape/backdrop dismissable)
     ------------------------------------------------------------------------ */

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let openModals = 0;
  let savedOverflow = '';

  function lockScroll() {
    openModals += 1;
    if (openModals === 1 && document.body) {
      savedOverflow = document.body.style.getPropertyValue('overflow');
      document.body.style.setProperty('overflow', 'hidden');
    }
  }

  function unlockScroll() {
    openModals = Math.max(0, openModals - 1);
    if (openModals === 0 && document.body) {
      if (savedOverflow) document.body.style.setProperty('overflow', savedOverflow);
      else document.body.style.removeProperty('overflow');
    }
  }

  /**
   * Turn a body option into nodes. Strings become paragraphs of plain text, so
   * user-authored copy can never smuggle markup in.
   * @param {string|Node} body modal body
   * @returns {Node[]}
   */
  function bodyNodes(body) {
    if (body === null || body === undefined || body === '') return [];
    if (body instanceof Node) return [body];
    if (Array.isArray(body)) {
      return body.reduce(function (acc, part) { return acc.concat(bodyNodes(part)); }, []);
    }
    return String(body).split('\n').filter(function (line) {
      return line.trim() !== '';
    }).map(function (line) {
      return el('p', { text: line });
    });
  }

  /**
   * Open a modal dialog and resolve with the id of the action the user chose,
   * or null when they dismissed it (Escape, backdrop, close button).
   * Traps focus while open and restores focus to the opener on close.
   * @param {Object} options dialog options
   * @param {string} [options.title] heading text
   * @param {string|Node} [options.body] body content (strings are inserted as text)
   * @param {Array<{id:string,label:string,variant?:string}>} [options.actions] footer buttons
   * @param {boolean} [options.dismissible=true] allow Escape / backdrop / close button
   * @returns {Promise<string|null>}
   */
  function modal(options) {
    const opts = options || {};
    const dismissible = opts.dismissible !== false;
    const actions = Array.isArray(opts.actions) && opts.actions.length
      ? opts.actions
      : [{ id: 'ok', label: 'OK', variant: 'primary' }];

    return new Promise(function (resolve) {
      const opener = document.activeElement;
      const titleId = 'zc-modal-' + uid();
      let settled = false;

      const dialog = el('div', {
        class: 'modal',
        attrs: { role: 'dialog', 'aria-modal': 'true', tabindex: '-1' }
      });
      if (opts.title) dialog.setAttribute('aria-labelledby', titleId);

      // Head: title + close affordance.
      const head = el('div', { class: 'modal-head' }, [
        el('h2', { class: 'modal-title', text: opts.title || '', attrs: { id: titleId } })
      ]);
      if (dismissible) {
        head.appendChild(el('button', {
          class: 'modal-close',
          attrs: { type: 'button', 'aria-label': 'Close' },
          text: '×',
          on: { click: function () { close(null); } }
        }));
      }
      dialog.appendChild(head);

      // Body.
      const bodyEl = el('div', { class: 'modal-body' }, bodyNodes(opts.body));
      dialog.appendChild(bodyEl);

      // Footer actions.
      const foot = el('div', { class: 'modal-foot' });
      actions.forEach(function (action) {
        foot.appendChild(el('button', {
          class: 'btn btn-' + (action.variant || 'secondary'),
          attrs: { type: 'button' },
          text: action.label === undefined ? action.id : action.label,
          on: { click: function () { close(action.id); } }
        }));
      });
      dialog.appendChild(foot);

      const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);

      // Backdrop click (but not a click that started inside the dialog).
      backdrop.addEventListener('mousedown', function (event) {
        if (!dismissible) return;
        if (event.target === backdrop) close(null);
      });

      // Escape to dismiss, Tab to cycle inside the dialog.
      backdrop.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && dismissible) {
          event.preventDefault();
          close(null);
          return;
        }
        if (event.key !== 'Tab') return;
        const candidates = $$(FOCUSABLE, dialog);
        const visible = candidates.filter(function (node) {
          return node.offsetParent !== null || node === document.activeElement;
        });
        // Never trap the user in a dialog they cannot tab through.
        const focusables = visible.length ? visible : candidates;
        if (!focusables.length) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      });

      function close(result) {
        if (settled) return;
        settled = true;
        document.removeEventListener('focus', enforceFocus, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        unlockScroll();
        // Give focus back to whatever opened the dialog.
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
        resolve(result);
      }

      // Belt-and-braces trap: pull focus back if it escapes the dialog.
      function enforceFocus(event) {
        if (settled) return;
        if (backdrop.contains(event.target)) return;
        event.stopPropagation();
        dialog.focus();
      }

      (document.body || document.documentElement).appendChild(backdrop);
      lockScroll();
      document.addEventListener('focus', enforceFocus, true);

      // Focus the primary action when there is one, otherwise the dialog itself.
      const primary = $('.btn-primary', foot) || $('.btn-danger', foot) || $(FOCUSABLE, bodyEl);
      if (primary && typeof primary.focus === 'function') primary.focus();
      else dialog.focus();
    });
  }

  /**
   * Yes/no dialog built on modal().
   * @param {string} message question to ask
   * @param {Object} [options] labels and tone
   * @param {string} [options.title='Are you sure?'] heading
   * @param {string} [options.confirmLabel='Confirm'] confirm button label
   * @param {string} [options.cancelLabel='Cancel'] cancel button label
   * @param {string} [options.variant='primary'] confirm button variant
   * @returns {Promise<boolean>}
   */
  function confirm(message, options) {
    const opts = options || {};
    return modal({
      title: opts.title || 'Are you sure?',
      body: message,
      actions: [
        { id: 'cancel', label: opts.cancelLabel || 'Cancel', variant: 'ghost' },
        { id: 'confirm', label: opts.confirmLabel || 'Confirm', variant: opts.variant || 'primary' }
      ]
    }).then(function (choice) {
      return choice === 'confirm';
    });
  }

  /* ------------------------------------------------------------------------
     9. ZC.ui — button busy state and skeletons
     ------------------------------------------------------------------------ */

  // Original button children are parked here so labels with icons survive.
  const busyContents = new WeakMap();

  /**
   * Put a button into (or out of) its loading state: disabled, spinner shown,
   * original label restored afterwards.
   * @param {HTMLElement} buttonEl the button
   * @param {boolean} busy true to start, false to finish
   * @param {string} [busyLabel] text shown while busy
   * @returns {void}
   */
  function setBusy(buttonEl, busy, busyLabel) {
    if (!buttonEl) return;
    if (busy) {
      if (busyContents.has(buttonEl)) return;
      busyContents.set(buttonEl, Array.prototype.slice.call(buttonEl.childNodes));
      const label = busyLabel || buttonEl.textContent.trim() || 'Working…';
      while (buttonEl.firstChild) buttonEl.removeChild(buttonEl.firstChild);
      buttonEl.appendChild(el('span', { class: 'btn-spinner', attrs: { 'aria-hidden': 'true' } }));
      buttonEl.appendChild(document.createTextNode(label));
      buttonEl.classList.add('is-loading');
      buttonEl.setAttribute('aria-busy', 'true');
      buttonEl.disabled = true;
      return;
    }
    const original = busyContents.get(buttonEl);
    if (!original) return;
    busyContents.delete(buttonEl);
    while (buttonEl.firstChild) buttonEl.removeChild(buttonEl.firstChild);
    original.forEach(function (node) { buttonEl.appendChild(node); });
    buttonEl.classList.remove('is-loading');
    buttonEl.removeAttribute('aria-busy');
    buttonEl.disabled = false;
  }

  /**
   * A fragment of placeholder blocks to show while data loads.
   * @param {number} [count=1] how many blocks
   * @param {string} [className] extra class per block, e.g. 'skeleton-card'
   * @returns {DocumentFragment}
   */
  function skeleton(count, className) {
    const frag = document.createDocumentFragment();
    const n = Math.max(0, Math.floor(count === undefined || count === null ? 1 : Number(count) || 0));
    for (let i = 0; i < n; i += 1) {
      frag.appendChild(el('div', {
        class: 'skeleton' + (className ? ' ' + className : ''),
        attrs: { 'aria-hidden': 'true' }
      }));
    }
    return frag;
  }

  ZC.ui = {
    toast: toast,
    modal: modal,
    confirm: confirm,
    setBusy: setBusy,
    skeleton: skeleton,
    mountToastHost: mountToastHost
  };
})();
