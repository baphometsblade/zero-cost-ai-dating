/* ==========================================================================
   Zero Cost AI Dating — utility tests
   Loads the real public/js/utils.js in Node (window aliased to globalThis, the
   same trick the data-store suite uses) and exercises the pure half of ZC.util:
   numbers, timing, dates, geo, hashing, avatars and URL parsing. The DOM half
   ($, el, append) and all of ZC.ui (toasts, modals, busy state, skeletons) need
   a live document and layout, so they belong to the browser suite, not here.
   Timing is driven by a hand-rolled fake clock — no real sleeps, no flakes.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------------
   Harness
   ------------------------------------------------------------------------ */

// utils.js addresses everything through `window.*`; aliasing window to
// globalThis lets the browser IIFE run untouched under Node.
globalThis.window = globalThis;
require('../public/js/utils.js');

const util = window.ZC.util;

/**
 * A deterministic stand-in for setTimeout/clearTimeout/Date.now.
 * utils.js reaches for those globals at call time, so swapping them for the
 * duration of a synchronous test body is enough to control every timer.
 * @returns {{advance:Function, delays:Function, pending:Function, uninstall:Function}}
 */
function installFakeClock() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realNow = Date.now;
  const timers = new Map();
  // Start well past zero: throttle() seeds its `last` stamp at 0 and would
  // otherwise think its cooldown was already running at t=0.
  let now = 1000000000;
  let seq = 0;

  globalThis.setTimeout = function (fn, ms) {
    seq += 1;
    timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn: fn, seq: seq });
    return seq;
  };
  globalThis.clearTimeout = function (id) {
    timers.delete(id);
  };
  Date.now = function () { return now; };

  return {
    /** Run every timer due within `ms`, in scheduled order, then park the clock. */
    advance: function (ms) {
      const target = now + ms;
      for (;;) {
        let next = null;
        timers.forEach(function (timer) {
          if (timer.at > target) return;
          if (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq)) next = timer;
        });
        if (!next) break;
        timers.delete(next.seq);
        now = next.at;
        next.fn();
      }
      now = target;
    },
    /** Remaining delays, in milliseconds from the current instant. */
    delays: function () {
      return Array.from(timers.values()).map(function (timer) { return timer.at - now; }).sort(function (a, b) { return a - b; });
    },
    pending: function () { return timers.size; },
    uninstall: function () {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realNow;
    }
  };
}

/**
 * Run a synchronous body with the fake clock installed, restoring the real
 * timers even when an assertion throws.
 * @param {Function} body receives the clock
 * @returns {void}
 */
function withFakeClock(body) {
  const clock = installFakeClock();
  try {
    body(clock);
  } finally {
    clock.uninstall();
  }
}

/**
 * Run a synchronous body with Date.now() frozen at `instant`.
 * @param {number} instant epoch milliseconds
 * @param {Function} body receives the frozen instant
 * @returns {void}
 */
function withFrozenNow(instant, body) {
  const realNow = Date.now;
  Date.now = function () { return instant; };
  try {
    body(instant);
  } finally {
    Date.now = realNow;
  }
}

const AVATAR_PREFIX = 'data:image/svg+xml,';

/** The SVG source behind an avatar data URI. */
function avatarSvg(uri) {
  return decodeURIComponent(uri.slice(AVATAR_PREFIX.length));
}

/* ------------------------------------------------------------------------
   1. escapeHtml
   ------------------------------------------------------------------------ */

test('escapeHtml escapes all five entities, everywhere, and never throws on junk', function () {
  assert.equal(util.escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(util.escapeHtml('a & b'), 'a &amp; b');
  assert.equal(util.escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(util.escapeHtml("it's"), 'it&#39;s');
  assert.equal(util.escapeHtml('<a href="x" title=\'y\'>&</a>'),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');

  // Every occurrence, not just the first.
  assert.equal(util.escapeHtml('<<>>'), '&lt;&lt;&gt;&gt;');

  // Escaping is not idempotent — the ampersand of an existing entity is escaped
  // again, which is correct for a function that assumes raw input.
  assert.equal(util.escapeHtml('&amp;'), '&amp;amp;');

  // Non-strings are stringified; only null/undefined collapse to empty.
  assert.equal(util.escapeHtml(null), '');
  assert.equal(util.escapeHtml(undefined), '');
  assert.equal(util.escapeHtml(0), '0');
  assert.equal(util.escapeHtml(false), 'false');
  assert.equal(util.escapeHtml('plain'), 'plain');
});

/* ------------------------------------------------------------------------
   2. clamp
   ------------------------------------------------------------------------ */

test('clamp bounds numbers and sends everything non-finite to the low bound', function () {
  assert.equal(util.clamp(5, 0, 10), 5);
  assert.equal(util.clamp(-1, 0, 10), 0);
  assert.equal(util.clamp(11, 0, 10), 10);
  assert.equal(util.clamp(0, 0, 10), 0, 'the bounds themselves are inside');
  assert.equal(util.clamp(10, 0, 10), 10);
  assert.equal(util.clamp(2.5, 0, 10), 2.5, 'no rounding');
  assert.equal(util.clamp('7', 0, 10), 7, 'numeric strings coerce');
  assert.equal(util.clamp(-40, -10, -5), -10, 'negative ranges work');

  // Anything that is not a finite number yields `lo`. Note that this catches
  // Infinity too, so clamp(Infinity, 0, 10) is 0 rather than the 10 you might
  // expect from a saturating clamp.
  assert.equal(util.clamp('abc', 3, 9), 3);
  assert.equal(util.clamp(NaN, 3, 9), 3);
  assert.equal(util.clamp(undefined, 3, 9), 3);
  assert.equal(util.clamp(Infinity, 0, 10), 0, 'Infinity is not finite, so it lands on lo');
  assert.equal(util.clamp(-Infinity, 0, 10), 0);
  // null is the exception: Number(null) is a finite 0, so it clamps like a
  // zero rather than falling back to lo.
  assert.equal(util.clamp(null, -5, 5), 0);
  assert.equal(util.clamp(undefined, -5, 5), -5, 'undefined, by contrast, is NaN and lands on lo');
});

/* ------------------------------------------------------------------------
   3. debounce
   ------------------------------------------------------------------------ */

test('debounce fires once, after the quiet period, with the last arguments', function () {
  withFakeClock(function (clock) {
    const calls = [];
    const debounced = util.debounce(function (value) {
      calls.push([value, this === null || this === undefined ? null : this.tag]);
    }, 100);

    const context = { tag: 'ctx' };
    debounced.call(context, 'a');
    debounced.call(context, 'b');
    clock.advance(99);
    assert.deepEqual(calls, [], 'nothing fires while calls keep arriving');

    clock.advance(1);
    assert.deepEqual(calls, [['b', 'ctx']], 'one call, the last arguments, the original `this`');
    assert.equal(clock.pending(), 0, 'the timer is not left behind');

    // A later burst is a fresh window, not a continuation.
    debounced.call(context, 'c');
    clock.advance(60);
    debounced.call(context, 'd');
    clock.advance(60);
    assert.equal(calls.length, 1, 'the second call restarted the quiet period');
    clock.advance(40);
    assert.deepEqual(calls[1], ['d', 'ctx']);
  });
});

test('debounce.cancel drops the pending call and is safe to repeat', function () {
  withFakeClock(function (clock) {
    let fired = 0;
    const debounced = util.debounce(function () { fired += 1; }, 50);

    debounced();
    assert.equal(clock.pending(), 1);
    debounced.cancel();
    assert.equal(clock.pending(), 0, 'cancel clears the timer, it does not just ignore it');
    clock.advance(500);
    assert.equal(fired, 0);

    // Cancelling nothing is a no-op, and the function still works afterwards.
    debounced.cancel();
    debounced();
    clock.advance(50);
    assert.equal(fired, 1);
  });
});

/* ------------------------------------------------------------------------
   4. throttle
   ------------------------------------------------------------------------ */

test('throttle runs on the leading edge, then once more for the last call in the window', function () {
  withFakeClock(function (clock) {
    const seen = [];
    const throttled = util.throttle(function (value) { seen.push(value); }, 100);

    throttled('1');
    assert.deepEqual(seen, ['1'], 'the first call is immediate');

    throttled('2');
    throttled('3');
    clock.advance(99);
    assert.deepEqual(seen, ['1'], 'the cooldown holds the queued calls');

    clock.advance(1);
    assert.deepEqual(seen, ['1', '3'], 'only the last queued call runs — "2" is dropped');
    assert.equal(clock.pending(), 0);

    // Once the cooldown has fully elapsed, the next call is immediate again.
    clock.advance(1000);
    throttled('4');
    assert.deepEqual(seen, ['1', '3', '4']);

    // The trailing invocation restarts the cooldown, so a call right after it
    // is queued rather than run.
    throttled('5');
    assert.deepEqual(seen, ['1', '3', '4'], 'no double-fire inside the new window');
    clock.advance(100);
    assert.deepEqual(seen, ['1', '3', '4', '5']);
  });
});

test('throttle preserves `this` and arguments, and cancel forgets the trailing call', function () {
  withFakeClock(function (clock) {
    const seen = [];
    const throttled = util.throttle(function (a, b) { seen.push([this.tag, a, b]); }, 100);
    const context = { tag: 'ctx' };

    throttled.call(context, 'x', 1);
    assert.deepEqual(seen, [['ctx', 'x', 1]]);

    throttled.call(context, 'y', 2);
    throttled.cancel();
    assert.equal(clock.pending(), 0);
    clock.advance(1000);
    assert.equal(seen.length, 1, 'the queued trailing call was discarded');

    // Cancel does not disable the throttle for good.
    throttled.call(context, 'z', 3);
    assert.deepEqual(seen[1], ['ctx', 'z', 3]);
  });
});

/* ------------------------------------------------------------------------
   5. uid and sleep
   ------------------------------------------------------------------------ */

test('uid returns 20 alphanumeric characters and does not repeat itself', function () {
  const first = util.uid();
  assert.equal(first.length, 20);
  assert.match(first, /^[A-Za-z0-9]{20}$/);

  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const id = util.uid();
    assert.match(id, /^[A-Za-z0-9]{20}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 2000, 'no collisions across 2000 ids');
});

test('uid falls back to Math.random when crypto.getRandomValues is missing', function () {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
  try {
    const id = util.uid();
    assert.match(id, /^[A-Za-z0-9]{20}$/, 'the non-crypto path produces the same shape');
    assert.notEqual(id, util.uid(), 'and still varies');
  } finally {
    Object.defineProperty(globalThis, 'crypto', descriptor);
  }
  assert.equal(typeof globalThis.crypto.getRandomValues, 'function', 'the real crypto global is restored');
});

test('sleep schedules the requested delay and clamps nonsense to zero', async function () {
  withFakeClock(function (clock) {
    util.sleep(50);
    assert.deepEqual(clock.delays(), [50]);
    util.sleep(-5);
    util.sleep('nope');
    util.sleep();
    assert.deepEqual(clock.delays(), [0, 0, 0, 50], 'negative, unparseable and missing all become 0');
  });
  assert.equal(await util.sleep(0), undefined, 'and it really resolves, with no value');
});

/* ------------------------------------------------------------------------
   6. toDate and todayKey
   ------------------------------------------------------------------------ */

test('toDate accepts Dates, epochs, Timestamps and ISO strings, and rejects the rest', function () {
  const date = new Date(2026, 2, 5, 12, 30);
  assert.equal(util.toDate(date), date, 'a valid Date passes straight through');
  assert.equal(util.toDate(new Date('nope')), null, 'an Invalid Date is not a date');

  assert.equal(util.toDate(1772000000000).getTime(), 1772000000000);
  assert.equal(util.toDate(NaN), null);
  // 0 is a number, not one of the empty values, so it parses as the epoch.
  // (todayKey is the one caller that treats a falsy argument as "no argument".)
  assert.equal(util.toDate(0).getTime(), 0);

  // Firestore Timestamps quack via .toDate(), including the ones that throw.
  assert.equal(util.toDate({ toDate: function () { return new Date(2026, 0, 2); } }).getFullYear(), 2026);
  assert.equal(util.toDate({ toDate: function () { throw new Error('detached'); } }), null);
  assert.equal(util.toDate({ toDate: function () { return 'not a date'; } }), null);

  // A bare YYYY-MM-DD is a local calendar day, not a UTC instant — this is the
  // whole reason for the PLAIN_DATE_RE branch.
  const plain = util.toDate('2026-03-05');
  assert.equal(plain.getFullYear(), 2026);
  assert.equal(plain.getMonth(), 2);
  assert.equal(plain.getDate(), 5, 'never slips to the 4th in a negative offset');
  assert.equal(plain.getHours(), 0, 'local midnight');

  // Full ISO strings keep their timezone.
  assert.equal(util.toDate('2026-03-05T09:00:00.000Z').getTime(), Date.parse('2026-03-05T09:00:00.000Z'));

  assert.equal(util.toDate(null), null);
  assert.equal(util.toDate(undefined), null);
  assert.equal(util.toDate(''), null);
  assert.equal(util.toDate('not a date'), null);

  // A date-shaped string with impossible components rolls over instead of
  // failing, because the local-day branch feeds the parts to the Date
  // constructor: month 13 becomes January of the next year.
  const rolled = util.toDate('2026-13-45');
  assert.equal(rolled.getFullYear(), 2027);
  assert.equal(rolled.getMonth(), 1, 'month 13 + day 45 rolls into February 2027');
});

test('todayKey is a local YYYY-MM-DD and falls back to today for anything unusable', function () {
  const key = util.todayKey();
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  const now = new Date();
  assert.equal(key, now.getFullYear() + '-' +
    String(now.getMonth() + 1).padStart(2, '0') + '-' +
    String(now.getDate()).padStart(2, '0'));

  assert.equal(util.todayKey('2026-03-05'), '2026-03-05', 'a given day round-trips');
  assert.equal(util.todayKey(new Date(2026, 0, 9)), '2026-01-09', 'single digits are zero-padded');
  assert.equal(util.todayKey('nonsense'), key, 'unparseable input keys today, never a crash');
  assert.equal(util.todayKey(0), key, 'so does a falsy argument');
});

/* ------------------------------------------------------------------------
   7. ageFromBirthdate
   ------------------------------------------------------------------------ */

/** Format a Date as the local YYYY-MM-DD string profiles actually store. */
function isoDay(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

test('ageFromBirthdate counts whole years and waits for the birthday', function () {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  // The Date constructor normalises the day overflow/underflow for us, so
  // these three cases hold on every calendar day of the year.
  assert.equal(util.ageFromBirthdate(isoDay(new Date(y - 30, m, d))), 30, 'birthday is today');
  assert.equal(util.ageFromBirthdate(isoDay(new Date(y - 30, m, d - 1))), 30, 'birthday was yesterday');
  assert.equal(util.ageFromBirthdate(isoDay(new Date(y - 30, m, d + 1))), 29, 'birthday is tomorrow');
  assert.equal(util.ageFromBirthdate(new Date(y - 30, m, d)), 30, 'Date objects work too');
});

test('ageFromBirthdate handles a leap-day birthday the way a non-leap year forces', function () {
  // Someone born on 29 February: in a non-leap year the comparison
  // `now.getDate() < born.getDate()` only clears on 1 March, so they age a day
  // late rather than on the 28th. Cross-checked against an independently
  // written rule (compare the MMDD of today against the MMDD of the birthday).
  const now = new Date();
  const nowMMDD = (now.getMonth() + 1) * 100 + now.getDate();
  const leapYear = 1996;
  const expected = now.getFullYear() - leapYear - (nowMMDD >= 229 ? 0 : 1);
  assert.equal(util.ageFromBirthdate('1996-02-29'), expected);

  // The same person, one day either side of the (non-existent) birthday.
  assert.equal(util.ageFromBirthdate('1996-02-28'),
    now.getFullYear() - leapYear - (nowMMDD >= 228 ? 0 : 1));
  assert.equal(util.ageFromBirthdate('1996-03-01'),
    now.getFullYear() - leapYear - (nowMMDD >= 301 ? 0 : 1));
});

test('ageFromBirthdate returns null for unparseable, future and absurd dates', function () {
  assert.equal(util.ageFromBirthdate(null), null);
  assert.equal(util.ageFromBirthdate(''), null);
  assert.equal(util.ageFromBirthdate('yesterday'), null);
  assert.equal(util.ageFromBirthdate('1800-01-01'), null, 'over 130 is not a person');

  const now = new Date();
  assert.equal(util.ageFromBirthdate(isoDay(new Date(now.getFullYear() + 1, 0, 1))), null,
    'a birthdate in the future is refused, not negated');
  assert.equal(util.ageFromBirthdate(isoDay(now)), 0, 'a newborn is 0, not null');
});

/* ------------------------------------------------------------------------
   8. timeAgo
   ------------------------------------------------------------------------ */

test('timeAgo walks every boundary it implements', function () {
  const base = Date.UTC(2026, 4, 20, 12, 0, 0);
  withFrozenNow(base, function () {
    function ago(ms) { return util.timeAgo(new Date(base - ms)); }

    // Under 45 seconds is "just now" — including a clock that is running fast.
    assert.equal(ago(0), 'just now');
    assert.equal(ago(44999), 'just now');
    assert.equal(ago(-100000), 'just now', 'a future stamp reads as just now, never "-2m"');

    // Minutes are rounded.
    assert.equal(ago(45000), '1m', 'the very first minute rounds up from 45s');
    assert.equal(ago(60000), '1m');
    assert.equal(ago(89999), '1m');
    assert.equal(ago(90000), '2m', 'exactly 90s rounds to 2m');
    assert.equal(ago(3540000), '59m');
    // Rounding is applied before the hour cutoff, so the last millisecond of
    // the hour renders as "60m" rather than "1h".
    assert.equal(ago(3599999), '60m');

    // Hours and days are floored.
    assert.equal(ago(3600000), '1h');
    assert.equal(ago(7199999), '1h');
    assert.equal(ago(7200000), '2h');
    assert.equal(ago(86399999), '23h');
    assert.equal(ago(86400000), '1d');
    assert.equal(ago(6 * 86400000), '6d');
    assert.equal(ago(7 * 86400000 - 1), '6d', 'the last millisecond inside the week');

    // A week or older switches to an absolute day/month label.
    const old = new Date(base - 7 * 86400000);
    assert.equal(ago(7 * 86400000), old.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    assert.match(ago(400 * 86400000), /\d/, 'ancient stamps still render a date');

    assert.equal(util.timeAgo('gibberish'), '', 'unparseable is empty, never "NaN"');
    assert.equal(util.timeAgo(null), '');
    assert.equal(util.timeAgo(undefined), '');
  });
});

/* ------------------------------------------------------------------------
   9. fmtDate and fmtTime
   ------------------------------------------------------------------------ */

test('fmtDate and fmtTime render the runtime locale and stay empty on junk', function () {
  const day = new Date(2026, 2, 5, 21, 4);

  assert.equal(util.fmtDate(day), day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
  assert.match(util.fmtDate(day), /\b5\b/, 'the day number is present');
  assert.match(util.fmtDate(day), /2026/, 'so is the year');
  assert.equal(util.fmtDate('2026-03-05'), util.fmtDate(day), 'the plain-date string keys the same local day');

  assert.equal(util.fmtTime(day), day.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  assert.match(util.fmtTime(day), /\d{1,2}:04/, 'minutes are two digits');
  assert.equal(util.fmtTime(new Date(2026, 2, 5, 9, 7)).indexOf(':07') > 0, true, 'a leading-zero minute is padded');

  assert.equal(util.fmtDate(''), '');
  assert.equal(util.fmtDate('nope'), '');
  assert.equal(util.fmtTime(null), '');
  assert.equal(util.fmtTime('nope'), '');
});

/* ------------------------------------------------------------------------
   10. haversineKm
   ------------------------------------------------------------------------ */

test('haversineKm matches known city pairs and the degenerate cases', function () {
  const london = { lat: 51.5074, lng: -0.1278 };
  const paris = { lat: 48.8566, lng: 2.3522 };
  const newYork = { lat: 40.7128, lng: -74.0060 };
  const losAngeles = { lat: 34.0522, lng: -118.2437 };

  // Published great-circle distances, to a 1% tolerance.
  assert.ok(Math.abs(util.haversineKm(london, paris) - 343) < 4,
    'London to Paris is about 343 km, got ' + util.haversineKm(london, paris));
  assert.ok(Math.abs(util.haversineKm(newYork, losAngeles) - 3936) < 40,
    'New York to Los Angeles is about 3,936 km, got ' + util.haversineKm(newYork, losAngeles));

  // Symmetric, and zero for a point against itself.
  assert.equal(util.haversineKm(london, paris), util.haversineKm(paris, london));
  assert.equal(util.haversineKm(london, london), 0);
  assert.equal(util.haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);

  // Antipodes are half the circumference, and the Math.min(1, …) guard keeps
  // asin inside its domain at exactly 180 degrees apart.
  const halfway = Math.PI * 6371;
  assert.ok(Math.abs(util.haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 }) - halfway) < 0.001);
  assert.ok(Math.abs(util.haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 }) - halfway) < 0.001);

  // A degree of latitude is about 111 km anywhere.
  assert.ok(Math.abs(util.haversineKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 }) - 111.19) < 0.5);

  // Missing or non-numeric coordinates are null, never NaN.
  assert.equal(util.haversineKm(null, london), null);
  assert.equal(util.haversineKm(london, undefined), null);
  assert.equal(util.haversineKm({ lat: 'x', lng: 0 }, london), null);
  assert.equal(util.haversineKm({ lat: 1 }, london), null, 'a missing lng is not zero');
  assert.equal(util.haversineKm({ lat: '51.5074', lng: '-0.1278' }, paris), util.haversineKm(london, paris),
    'numeric strings coerce');
});

/* ------------------------------------------------------------------------
   11. hashString
   ------------------------------------------------------------------------ */

test('hashString is a deterministic, unsigned, well-spread 32-bit FNV-1a', function () {
  // The FNV-1a offset basis, i.e. the hash of the empty string.
  assert.equal(util.hashString(''), 2166136261);
  assert.equal(util.hashString(null), 2166136261, 'null hashes as empty');
  assert.equal(util.hashString(undefined), 2166136261);

  assert.equal(util.hashString('demo-you'), util.hashString('demo-you'), 'same input, same hash');
  assert.notEqual(util.hashString('a'), util.hashString('b'));
  assert.notEqual(util.hashString('ab'), util.hashString('ba'), 'order matters');
  assert.equal(util.hashString(123), util.hashString('123'), 'values are stringified first');

  // Always in the unsigned 32-bit range, never negative, and integral.
  let distinct = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const h = util.hashString('user-' + i + '-' + 'x'.repeat(i % 40));
    assert.ok(h >= 0 && h <= 4294967295, 'hash out of range: ' + h);
    assert.equal(Number.isInteger(h), true);
    distinct.add(h);
  }
  assert.ok(distinct.size > 4990, 'a 32-bit hash over 5000 short strings should barely collide, got ' + distinct.size);

  // Single-bit input changes move the hash somewhere else entirely.
  assert.notEqual(util.hashString('demo-you'), util.hashString('demo-yov'));
});

/* ------------------------------------------------------------------------
   12. initials
   ------------------------------------------------------------------------ */

test('initials takes the first and last word, code-point by code-point', function () {
  assert.equal(util.initials('Ada Lovelace'), 'AL');
  assert.equal(util.initials('Ada'), 'A', 'one word gives one letter');
  assert.equal(util.initials('ada lovelace'), 'AL', 'uppercased');
  assert.equal(util.initials('Ada B C Lovelace'), 'AL', 'the middle names are skipped, not included');
  assert.equal(util.initials('  spaced   out  '), 'SO', 'runs of whitespace collapse');
  assert.equal(util.initials('Anne-Marie Dupont'), 'AD', 'a hyphen is not a word break');

  // Nothing usable falls back to a question mark rather than an empty label.
  assert.equal(util.initials(''), '?');
  assert.equal(util.initials('   '), '?');
  assert.equal(util.initials(null), '?');
  assert.equal(util.initials(undefined), '?');

  // Non-Latin scripts keep their own casing; surrogate pairs stay whole.
  assert.equal(util.initials('中村 由紀'), '中由');
  assert.equal(util.initials('иван петров'), 'ИП');
  assert.equal(util.initials('Ямал'), 'Я');
  assert.equal(util.initials('🎉 party'), '🎉P');
  assert.equal(Array.from(util.initials('🎉 party')).length, 2, 'the emoji is one code point, not half of one');
});

/* ------------------------------------------------------------------------
   13. avatarDataUri
   ------------------------------------------------------------------------ */

test('avatarDataUri is deterministic per seed and never base64', function () {
  const a = util.avatarDataUri('demo-you', 'Ada Lovelace');
  assert.equal(a, util.avatarDataUri('demo-you', 'Ada Lovelace'), 'the same seed always draws the same picture');
  assert.notEqual(a, util.avatarDataUri('demo-them', 'Ada Lovelace'), 'a different seed repaints');
  assert.notEqual(a, util.avatarDataUri('demo-you', 'Bea Lovelace'), 'a different name relabels');
  assert.ok(a.startsWith(AVATAR_PREFIX), 'it is a URI-encoded SVG, not a base64 payload');

  const svg = avatarSvg(a);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.indexOf('width="400" height="400"') > 0);
  assert.ok(svg.indexOf('>AL</text>') > 0, 'the initials are drawn');

  // The gradient id is derived from the hash and is referenced by the rect.
  const gradId = 'g' + util.hashString('demo-you').toString(36);
  assert.ok(svg.indexOf('id="' + gradId + '"') > 0);
  assert.ok(svg.indexOf('fill="url(#' + gradId + ')"') > 0, 'the reference matches the definition');

  // Omitting the name draws initials from the seed itself.
  assert.equal(avatarSvg(util.avatarDataUri('Ada Lovelace')).indexOf('>AL</text>') > 0, true);

  // Distinct seeds produce distinct pictures.
  const uris = new Set();
  for (let i = 0; i < 60; i += 1) uris.add(util.avatarDataUri('seed-' + i, 'N' + i));
  assert.equal(uris.size, 60);
});

test('avatarDataUri URI-encodes everything, so #, & and non-Latin names survive', function () {
  // A name whose initials are the two characters that would break a data URI.
  const hostile = util.avatarDataUri('seed-1', '& #');
  assert.equal(hostile.indexOf('#', AVATAR_PREFIX.length), -1,
    'a raw # would truncate the URI at the fragment');
  assert.equal(hostile.indexOf('&', AVATAR_PREFIX.length), -1);
  assert.equal(hostile.indexOf('<', AVATAR_PREFIX.length), -1);
  assert.equal(hostile.indexOf('>', AVATAR_PREFIX.length), -1);
  assert.equal(hostile.indexOf('"', AVATAR_PREFIX.length), -1);
  // The characters are XML-escaped first, then percent-encoded.
  assert.ok(avatarSvg(hostile).indexOf('>&amp;#</text>') > 0);

  // Cyrillic initials: encodeURIComponent handles them, btoa would have thrown.
  const cyrillic = util.avatarDataUri('s', 'Ямал Ненец');
  assert.ok(cyrillic.indexOf('%D0%AF') > 0, 'the non-ASCII initial is percent-encoded');
  assert.ok(avatarSvg(cyrillic).indexOf('>ЯН</text>') > 0);

  // An apostrophe or quote in the name cannot escape the attribute either.
  const quoted = util.avatarDataUri('s', '"Q\' Z');
  assert.ok(avatarSvg(quoted).indexOf('&quot;Z') > 0);
});

test('avatarDataUri keeps its generated colours inside their documented ranges', function () {
  const hslRe = /hsl\((\d+),(\d+)%,(\d+)%\)/g;
  for (let i = 0; i < 200; i += 1) {
    const svg = avatarSvg(util.avatarDataUri('palette-' + i, 'X Y'));
    const stops = [];
    let match = hslRe.exec(svg);
    while (match) {
      stops.push([Number(match[1]), Number(match[2]), Number(match[3])]);
      match = hslRe.exec(svg);
    }
    assert.equal(stops.length, 2, 'two gradient stops per avatar');
    stops.forEach(function (stop) {
      assert.ok(stop[0] >= 0 && stop[0] < 360, 'hue in range: ' + stop[0]);
      assert.ok(stop[1] >= 58 && stop[1] <= 79, 'saturation in range: ' + stop[1]);
    });
    assert.ok(stops[0][2] >= 46 && stops[0][2] <= 57, 'the first stop stays mid-light: ' + stops[0][2]);
    assert.ok(stops[1][2] >= 30 && stops[1][2] <= 43, 'the second stop stays darker: ' + stops[1][2]);
    assert.notEqual(stops[0][0], stops[1][0], 'the two hues are always at least 35 degrees apart');
  }
});

/* ------------------------------------------------------------------------
   14. photoOf
   ------------------------------------------------------------------------ */

test('photoOf prefers the first https photo and refuses every other scheme', function () {
  assert.equal(util.photoOf({ profile: { photos: ['https://cdn.example/a.png'] } }), 'https://cdn.example/a.png');
  assert.equal(util.photoOf({ photos: ['https://cdn.example/a.png'] }), 'https://cdn.example/a.png',
    'a bare profile object works as well as a whole UserDoc');
  assert.equal(util.photoOf({ profile: { photos: ['  https://cdn.example/a.png  '] } }), 'https://cdn.example/a.png',
    'surrounding whitespace is trimmed');
  assert.equal(util.photoOf({ profile: { photos: ['HTTPS://CDN.example/a.png'] } }), 'HTTPS://CDN.example/a.png',
    'the scheme test is case-insensitive');

  // The first *acceptable* photo wins, not simply the first entry.
  assert.equal(util.photoOf({ profile: { photos: ['http://cdn.example/a.png', 'https://cdn.example/b.png'] } }),
    'https://cdn.example/b.png');
  assert.equal(util.photoOf({ profile: { photos: [null, 42, 'https://cdn.example/c.png'] } }),
    'https://cdn.example/c.png', 'non-string entries are skipped, not stringified');

  // Anything not https falls through to a generated avatar.
  ['http://cdn.example/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//cdn.example/a.png', ''].forEach(
    function (bad) {
      assert.ok(util.photoOf({ uid: 'u1', profile: { photos: [bad] } }).startsWith(AVATAR_PREFIX),
        bad + ' must never be used as an image source');
    });
});

test('photoOf falls back to a stable generated avatar seeded by uid, then displayName', function () {
  assert.equal(util.photoOf({ uid: 'u1', displayName: 'Ada Lovelace', profile: { photos: [] } }),
    util.avatarDataUri('u1', 'Ada Lovelace'), 'the uid seeds the picture and the name labels it');
  assert.equal(util.photoOf({ profile: { uid: 'u2', displayName: 'Bea Nash', photos: [] } }),
    util.avatarDataUri('u2', 'Bea Nash'), 'an inner uid/displayName is found too');
  assert.equal(util.photoOf({ displayName: 'Cai Ren' }), util.avatarDataUri('Cai Ren', 'Cai Ren'),
    'with no uid the name is its own seed');
  assert.equal(util.photoOf({}), util.avatarDataUri('zc', ''), 'an empty object still yields a picture');
  assert.equal(util.photoOf(null), util.avatarDataUri('anonymous', ''), 'so does no profile at all');

  // A photos field of the wrong type is ignored rather than thrown over.
  assert.equal(util.photoOf({ uid: 'u3', profile: { photos: 'https://cdn.example/a.png' } }),
    util.avatarDataUri('u3', ''), 'a string is not a photo array');
  assert.equal(util.photoOf({ uid: 'u3', profile: { photos: null } }), util.avatarDataUri('u3', ''));

  // Same input, same output — deck cards must not flicker between renders.
  assert.equal(util.photoOf({ uid: 'u1', profile: {} }), util.photoOf({ uid: 'u1', profile: {} }));
});

/* ------------------------------------------------------------------------
   15. qs
   ------------------------------------------------------------------------ */

test('qs reads a parameter from an explicit search string', function () {
  assert.equal(util.qs('next', '?next=/deck.html'), '/deck.html');
  assert.equal(util.qs('next', 'next=/deck.html'), '/deck.html', 'the leading ? is optional');
  assert.equal(util.qs('missing', '?next=/deck.html'), null);
  assert.equal(util.qs('a', '?a=1&b=two&a=3'), '1', 'the first of a repeated key wins');
  assert.equal(util.qs('e', '?e=%20sp%20'), ' sp ', 'values are percent-decoded');
  assert.equal(util.qs('flag', '?flag'), '', 'a valueless key reads as empty, not null');
  assert.equal(util.qs('a', ''), null, 'an empty search has nothing in it');
  assert.equal(util.qs('a', '?'), null);
});

test('qs reads window.location.search by default and survives its absence', function () {
  const had = Object.prototype.hasOwnProperty.call(window, 'location');
  const previous = window.location;
  try {
    window.location = { search: '?next=%2Fmatches.html&uid=demo-you' };
    assert.equal(util.qs('next'), '/matches.html');
    assert.equal(util.qs('uid'), 'demo-you');
    assert.equal(util.qs('nope'), null);

    window.location = { search: '' };
    assert.equal(util.qs('next'), null);

    // A page with no location at all (or a cross-origin one that throws on
    // access) must degrade to null rather than break the caller.
    delete window.location;
    assert.equal(util.qs('next'), null);
    window.location = { get search() { throw new Error('cross-origin'); } };
    assert.equal(util.qs('next'), null);
  } finally {
    if (had) window.location = previous;
    else delete window.location;
  }
});
