/* ==========================================================================
   Zero Cost AI Dating — data store
   One promise-based facade over two interchangeable adapters:

     • firestore — a real Firebase project (Spark plan, client-side only)
     • demo      — localStorage, seeded from the bundled profiles

   Pages never touch `firebase` or `localStorage` directly; they call ZC.store
   and get the same shapes either way. Every method is async, every read is
   defensive, and no write is allowed to take the UI down with it.
   Exposes: ZC.store.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;
  const util = ZC.util || {};

  // Tolerate a duplicated <script> tag.
  if (ZC.store && ZC.store.ready) {
    return;
  }

  /* ------------------------------------------------------------------------
     1. Constants and the canonical user shape
     ------------------------------------------------------------------------ */

  /** Every demo-mode key lives under the zc.demo.* prefix. */
  const KEYS = {
    users: 'zc.demo.users',
    swipes: 'zc.demo.swipes',
    matches: 'zc.demo.matches',
    messages: 'zc.demo.messages',
    reports: 'zc.demo.reports',
    session: 'zc.demo.session',
    seeded: 'zc.demo.seeded'
  };

  const SEED_VERSION = 1;
  const MESSAGE_MAX = 1000;
  const REPORT_DETAILS_MAX = 500;

  /**
   * The closed list of report reasons with their UI labels — the single place
   * both the validation and the report dialog draw from. firestore.rules
   * repeats the slug list literally (rules cannot import), so a change here
   * must land there in the same commit.
   */
  const REPORT_REASONS = [
    { slug: 'fake-profile', label: 'Fake or impersonating profile' },
    { slug: 'inappropriate-content', label: 'Inappropriate photos or bio' },
    { slug: 'harassment', label: 'Harassment or threats' },
    { slug: 'underage', label: 'Appears to be under 18' },
    { slug: 'scam-or-spam', label: 'Scam, spam or solicitation' },
    { slug: 'other', label: 'Something else' }
  ];
  const REPORT_REASON_SLUGS = REPORT_REASONS.map(function (r) { return r.slug; });
  const DEFAULT_CANDIDATE_LIMIT = 60;
  const DEFAULT_MESSAGE_LIMIT = 200;
  // How much of a conversation the live listener keeps in view. Bounded because
  // every snapshot re-reads the window and this app lives inside a free tier's
  // daily read quota; it tracks the newest end, so the bound is a cost ceiling
  // rather than a point past which the chat stops working.
  const LIVE_MESSAGE_WINDOW = 200;
  const TOUCH_THROTTLE_MS = 5 * 60 * 1000;
  const POLL_MS = 1500;
  const GENDERS = ['woman', 'man', 'nonbinary', 'other'];
  /** The bundled demo account every seeded relationship hangs off. */
  const DEMO_UID = 'demo-you';

  /**
   * The three daily counters, each mapped onto the plan limit it spends
   * against. This is the only list of usage fields there is: nextUsage tests
   * membership against it and canSpend reads the limit key out of it.
   */
  const LIMIT_FIELDS = { likes: 'likesPerDay', superLikes: 'superLikesPerDay', rewinds: 'rewinds' };

  /**
   * The canonical UserDoc with sane defaults. Treat it as read-only — every
   * writer merges a copy of it so all agents agree on the shape.
   */
  const DEFAULT_USER = {
    uid: '',
    email: '',
    displayName: '',
    createdAt: null,
    updatedAt: null,
    lastActiveAt: null,
    profileComplete: false,
    plan: 'free',
    planSince: null,
    profile: {
      birthdate: null,
      age: null,
      gender: 'other',
      pronouns: '',
      bio: '',
      photos: [],
      interests: [],
      personality: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, stability: 50 },
      location: null,
      showAge: true,
      showDistance: true
    },
    preferences: {
      interestedIn: GENDERS.slice(),
      ageMin: 18,
      ageMax: 100,
      maxDistanceKm: 500,
      notifications: true,
      theme: 'system',
      discoverable: true
    },
    learning: { interestAffinity: {}, likeCount: 0, passCount: 0 },
    usage: { date: null, likes: 0, superLikes: 0, rewinds: 0 },
    blocked: []
  };

  /* ------------------------------------------------------------------------
     2. Plain-object helpers
     ------------------------------------------------------------------------ */

  function nowIso() {
    return new Date().toISOString();
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** A finite number, or null. */
  function num(value) {
    const n = Number(value);
    return value === null || value === undefined || !isFinite(n) ? null : n;
  }

  /**
   * Structural deep copy of JSON-ish data.
   * @param {*} value value to copy
   * @returns {*} copy
   */
  function cloneDeep(value) {
    if (Array.isArray(value)) return value.map(cloneDeep);
    if (isPlainObject(value)) {
      const out = {};
      Object.keys(value).forEach(function (key) { out[key] = cloneDeep(value[key]); });
      return out;
    }
    return value;
  }

  /**
   * Dot-paths whose object values are atomic: the patch replaces them whole
   * instead of merging key by key. The list exists because some maps are
   * pruned by their writer, and a merge would silently undo the pruning —
   * ZC.matching.updateLearning drops interest affinities that have decayed
   * below 0.01 and caps the map at 60 entries, so merging would restore every
   * dropped tag from the stored document on the very next write and the map
   * could only ever grow. Omitting an atomic path from a patch still leaves
   * the stored value untouched; only a supplied value replaces it.
   */
  const ATOMIC_PATHS = ['learning.interestAffinity'];

  /**
   * Recursive merge; nested objects merge, arrays and scalars replace,
   * `undefined` values in the patch are ignored (Firestore rejects them).
   * Objects at an ATOMIC_PATHS path replace rather than merge.
   * @param {Object} base starting object
   * @param {Object} patch changes to apply
   * @param {string} [path] dot-path of `base` within the document root
   * @returns {Object} a new object
   */
  function deepMerge(base, patch, path) {
    const out = isPlainObject(base) ? cloneDeep(base) : {};
    if (!isPlainObject(patch)) return out;
    const prefix = path ? path + '.' : '';
    Object.keys(patch).forEach(function (key) {
      const value = patch[key];
      if (value === undefined) return;
      const here = prefix + key;
      if (isPlainObject(value) && isPlainObject(out[key]) && ATOMIC_PATHS.indexOf(here) === -1) {
        out[key] = deepMerge(out[key], value, here);
      } else {
        out[key] = cloneDeep(value);
      }
    });
    return out;
  }

  function toIso(value) {
    const d = util.toDate ? util.toDate(value) : (value ? new Date(value) : null);
    return d ? d.toISOString() : null;
  }

  function todayKey() {
    return util.todayKey ? util.todayKey() : new Date().toISOString().slice(0, 10);
  }

  /**
   * Fill a raw record out to the full UserDoc shape.
   * @param {Object} doc partial user document
   * @returns {Object} complete UserDoc
   */
  function normalizeUser(doc) {
    const user = deepMerge(DEFAULT_USER, isPlainObject(doc) ? doc : {});
    user.uid = String(user.uid || '');
    user.plan = user.plan === 'premium' ? 'premium' : 'free';
    user.profileComplete = !!user.profileComplete;
    if (!Array.isArray(user.profile.photos)) user.profile.photos = [];
    if (!Array.isArray(user.profile.interests)) user.profile.interests = [];
    if (!Array.isArray(user.preferences.interestedIn)) user.preferences.interestedIn = GENDERS.slice();
    if (!Array.isArray(user.blocked)) user.blocked = [];
    if (!isPlainObject(user.learning.interestAffinity)) user.learning.interestAffinity = {};
    // Age is denormalised for filtering — keep it consistent with the birthdate.
    if (user.profile.birthdate && util.ageFromBirthdate) {
      const derived = util.ageFromBirthdate(user.profile.birthdate);
      if (derived !== null) user.profile.age = derived;
    }
    user.usage = normalizeUsage(user.usage);
    return user;
  }

  /**
   * Coerce a usage record into `{ date, likes, superLikes, rewinds }`.
   * @param {Object} usage raw usage record
   * @param {string} [today] the day a record with no usable `date` is taken to
   *   belong to. Callers that already know the day pass it; only the ones that
   *   are genuinely reading "now" (normalizeUser, getUsage) may leave it out
   *   and take the clock, because a record with no date has to be called
   *   something and today is the only honest guess a reader can make.
   * @returns {Object} usage record
   */
  function normalizeUsage(usage, today) {
    const u = isPlainObject(usage) ? usage : {};
    const day = typeof today === 'string' && today ? today : todayKey();
    return {
      date: typeof u.date === 'string' && u.date ? u.date : day,
      likes: Math.max(0, Number(u.likes) || 0),
      superLikes: Math.max(0, Number(u.superLikes) || 0),
      rewinds: Math.max(0, Number(u.rewinds) || 0)
    };
  }

  /**
   * Decide what a usage record becomes after one bump. Pure and deterministic
   * — no storage and no clock — so the Firestore transaction and the demo
   * adapter can replay the same decision and always agree. `today` is the
   * only day this function knows about, including for a record whose own
   * `date` is missing or unusable: that record is taken to belong to `today`
   * rather than to whatever the clock says, or the same arguments would give
   * different answers on different days and a retried transaction could
   * disagree with its first attempt.
   *
   * A stale `date` rolls over to today's zeros *before* the amount lands.
   * That ordering is the whole reason a bare FieldValue.increment cannot do
   * this job: increment can add 1 atomically, but it cannot also decide that
   * yesterday's 25 should have been a 0 first.
   *
   * @param {Object} current the stored usage record (missing or corrupt is fine)
   * @param {string} field counter to move: 'likes', 'superLikes' or 'rewinds';
   *   anything else leaves the counters alone (the roll-over still applies)
   * @param {number} [amount=1] how far to move it — a negative amount is
   *   allowed but the counter clamps at 0
   * @param {string} today the YYYY-MM-DD day the result belongs to
   * @returns {{date:string, likes:number, superLikes:number, rewinds:number}} a new record
   */
  function nextUsage(current, field, amount, today) {
    // Callers always know the day; the fallback only stops a careless one from
    // writing a record dated `undefined`.
    const day = typeof today === 'string' && today ? today : todayKey();
    const base = normalizeUsage(current, day);
    const usage = base.date === day
      ? { date: day, likes: base.likes, superLikes: base.superLikes, rewinds: base.rewinds }
      : { date: day, likes: 0, superLikes: 0, rewinds: 0 };
    if (!Object.prototype.hasOwnProperty.call(LIMIT_FIELDS, field)) return usage;
    const by = amount === undefined ? 1 : Number(amount) || 0;
    usage[field] = Math.max(0, usage[field] + by);
    return usage;
  }

  /** A stand-in doc for a match whose other half is missing from storage. */
  function placeholderUser(uid) {
    return normalizeUser({ uid: uid, displayName: 'Someone' });
  }

  function swipeId(from, to) {
    return String(from) + '_' + String(to);
  }

  function pairId(a, b) {
    return [String(a), String(b)].sort().join('_');
  }

  function isPositive(action) {
    return action === 'like' || action === 'super';
  }

  function normalizeAction(action) {
    if (action === 'pass') return 'pass';
    if (action === 'super') return 'super';
    return 'like';
  }

  /**
   * Trim and cap outgoing message text.
   * @param {string} text raw input
   * @returns {string} sanitised text (may be empty)
   */
  function normalizeText(text) {
    return String(text === null || text === undefined ? '' : text).trim().slice(0, MESSAGE_MAX);
  }

  /**
   * A fresh message id. `seq` only matters on the clock-based fallback, where
   * a batch written in the same millisecond would otherwise collide.
   * @param {number} [seq=0] position within the batch being written
   * @returns {string} message id
   */
  function newMessageId(seq) {
    return util.uid ? util.uid() : String(Date.now()) + '-' + (Number(seq) || 0);
  }

  /**
   * Turn the durable "this many hours before seed time" convention the bundled
   * data uses into a real timestamp, so nothing in the demo ever rots.
   * @param {number} stamp epoch ms used as "now"
   * @param {*} offsetHours hours before `stamp` (non-numeric counts as 0)
   * @returns {string} ISO timestamp
   */
  function offsetIso(stamp, offsetHours) {
    const hours = Number(offsetHours);
    return new Date(stamp - (isFinite(hours) ? hours : 0) * 3600000).toISOString();
  }

  /**
   * The uid we should render "the other side" relative to, when a caller does
   * not pass one: the signed-in user, else the demo session.
   * @returns {string|null}
   */
  function currentUid() {
    if (ZC.auth && ZC.auth.current && ZC.auth.current.uid) return ZC.auth.current.uid;
    const session = readJson(KEYS.session, null);
    if (typeof session === 'string' && session) return session;
    if (isPlainObject(session) && typeof session.uid === 'string') return session.uid;
    return null;
  }

  /**
   * Sort helper: most recent conversation first.
   * @param {Object} a match view
   * @param {Object} b match view
   * @returns {number}
   */
  function byRecency(a, b) {
    const ta = Date.parse(a.lastMessageAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.lastMessageAt || b.createdAt || 0) || 0;
    if (tb !== ta) return tb - ta;
    return String(a.matchId || a.id).localeCompare(String(b.matchId || b.id));
  }

  /**
   * One match document reduced to what a badge needs, from this account's point
   * of view. Deliberately no profile: fetching a name per match on a timer is
   * what made the badge refresh expensive, and a badge draws a number.
   * @param {Object} data a stored match document
   * @param {string} id the document id
   * @param {string} uid the viewer
   * @returns {Object} a match row
   */
  function matchRow(data, id, uid) {
    const users = Array.isArray(data.users) ? data.users : [];
    const unread = isPlainObject(data.unread) ? Number(data.unread[uid]) : 0;
    return {
      id: id,
      users: users.slice(),
      unread: Math.max(0, unread || 0),
      lastMessage: data.lastMessage === undefined ? null : data.lastMessage,
      lastMessageAt: data.lastMessageAt || null,
      createdAt: data.createdAt || null
    };
  }

  /**
   * A cheap fingerprint of a match-row list, so a poll that changed nothing
   * delivers nothing.
   * @param {Object[]} rows match rows
   * @returns {string}
   */
  function rowsSignature(rows) {
    return rows.map(function (row) {
      return row.id + ':' + row.unread + ':' + (row.lastMessageAt || '');
    }).join('|');
  }

  /* ------------------------------------------------------------------------
     3. Guarded localStorage access
     ------------------------------------------------------------------------ */

  let storageWarned = false;

  /**
   * Warn once per session when storage misbehaves, without spamming toasts.
   * @param {string} message human-readable explanation
   * @returns {void}
   */
  function warnStorageOnce(message) {
    if (storageWarned) return;
    storageWarned = true;
    try {
      // Best effort only — a failed storage write must never become a crash.
      if (ZC.ui && typeof ZC.ui.toast === 'function') ZC.ui.toast(message, 'warn', 6000);
    } catch (err) {
      console.warn('[zc.store] ' + message);
    }
  }

  /**
   * Read and parse a JSON entry. Missing, unreadable or corrupt values fall
   * back to a copy of `fallback` (and the corrupt entry is dropped).
   * @param {string} key localStorage key
   * @param {*} fallback value to return when the entry is unusable
   * @returns {*} parsed value or fallback
   */
  function readJson(key, fallback) {
    let raw = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch (err) {
      return cloneDeep(fallback);
    }
    if (raw === null || raw === undefined || raw === '') return cloneDeep(fallback);
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || parsed === undefined) return cloneDeep(fallback);
      return parsed;
    } catch (err) {
      console.warn('[zc.store] Corrupt JSON in ' + key + ' — resetting that entry.', err);
      try { window.localStorage.removeItem(key); } catch (ignored) { /* nothing else to do */ }
      return cloneDeep(fallback);
    }
  }

  /**
   * Serialise and store a value, surviving quota and privacy-mode failures.
   * @param {string} key localStorage key
   * @param {*} value JSON-serialisable value
   * @returns {boolean} true when the write landed
   */
  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      const quota = !!err && (
        err.name === 'QuotaExceededError' ||
        err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        err.code === 22 || err.code === 1014
      );
      console.warn('[zc.store] Could not write ' + key + (quota ? ' — storage is full.' : ' — storage is unavailable.'), err);
      warnStorageOnce(quota
        ? 'Your browser storage is full, so recent changes were not saved.'
        : 'Browser storage is unavailable, so changes will not be saved.');
      return false;
    }
  }

  function removeKey(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      console.warn('[zc.store] Could not clear ' + key, err);
    }
  }

  function readUsers() { return readJson(KEYS.users, {}); }
  function writeUsers(map) { return writeJson(KEYS.users, map); }
  function readSwipes() { return readJson(KEYS.swipes, {}); }
  function writeSwipes(map) { return writeJson(KEYS.swipes, map); }
  function readMatches() { return readJson(KEYS.matches, {}); }
  function writeMatches(map) { return writeJson(KEYS.matches, map); }
  function readMessages() { return readJson(KEYS.messages, {}); }
  function writeMessages(map) { return writeJson(KEYS.messages, map); }
  function readReports() { return readJson(KEYS.reports, {}); }
  function writeReports(map) { return writeJson(KEYS.reports, map); }

  /* ------------------------------------------------------------------------
     4. Demo message listeners (storage event + poll)
     ------------------------------------------------------------------------ */

  const listeners = [];
  let pollTimer = null;

  function messagesSignature(list) {
    if (!list.length) return '0:';
    const last = list[list.length - 1] || {};
    return list.length + ':' + (last.id || '') + ':' + (last.createdAt || '');
  }

  /**
   * Push a listener's current value if it changed since the last delivery.
   *
   * The record carries its own `snapshot()` and `signature()` rather than this
   * reading messages directly, because there are three kinds of listener now
   * and only the storage-event plumbing is common to them.
   * @param {Object} rec listener record
   * @param {boolean} force deliver even when unchanged
   * @returns {void}
   */
  function deliver(rec, force) {
    const value = rec.snapshot();
    const sig = rec.signature(value);
    if (!force && sig === rec.sig) return;
    rec.sig = sig;
    try {
      rec.cb(value);
    } catch (err) {
      console.warn('[zc.store] A live listener threw.', err);
    }
  }

  /**
   * Register a listener record and hand back its unsubscribe.
   * @param {Object} rec a record with cb, snapshot and signature
   * @returns {Function} unsubscribe
   */
  function listen(rec) {
    rec.sig = null;
    listeners.push(rec);
    ensurePlumbing();
    // First delivery is async so callers can finish wiring up first.
    Promise.resolve().then(function () {
      if (listeners.indexOf(rec) !== -1) deliver(rec, true);
    });
    return function unsubscribe() {
      const index = listeners.indexOf(rec);
      if (index !== -1) listeners.splice(index, 1);
      teardownPlumbing();
    };
  }

  function pollAll() {
    listeners.slice().forEach(function (rec) { deliver(rec, false); });
  }

  // Other tabs announce their writes through the storage event; our own tab
  // never fires it, so local writes call pollAll() directly. Every key is worth
  // a poll now rather than only messages and matches: an inbound like lands in
  // `swipes` and a block lands in `users`, and both move a badge. The signature
  // check makes a poll that changes nothing free.
  function onStorageEvent() {
    pollAll();
  }

  // `window` is aliased to globalThis when this file is loaded under Node, and
  // Node's global is not an EventTarget — so the cross-tab half is wired only
  // where it exists. The poll carries the rest, which is all a single process
  // has anyway: there is no second tab to hear from.
  function canHearOtherTabs() {
    return typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function';
  }

  function ensurePlumbing() {
    if (pollTimer) return;
    if (canHearOtherTabs()) window.addEventListener('storage', onStorageEvent);
    pollTimer = setInterval(pollAll, POLL_MS);
  }

  function teardownPlumbing() {
    if (listeners.length || !pollTimer) return;
    if (canHearOtherTabs()) window.removeEventListener('storage', onStorageEvent);
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * People who have liked this account and are still waiting for an answer, as
   * whole user documents. Shared by `getLikesReceived` and the live count, so
   * the badge and the list can never disagree about who is waiting.
   * @param {string} uid the viewer
   * @returns {Object[]} UserDocs
   */
  function pendingLikers(uid) {
    const swipes = readSwipes();
    const users = readUsers();
    const me = users[uid] ? normalizeUser(users[uid]) : null;
    const myBlocks = me ? me.blocked : [];
    const out = [];
    Object.keys(swipes).forEach(function (key) {
      const swipe = swipes[key];
      if (!isPlainObject(swipe) || swipe.to !== uid || !isPositive(swipe.action)) return;
      // Only the ones I have not answered yet.
      if (swipes[swipeId(uid, swipe.from)]) return;
      if (myBlocks.indexOf(swipe.from) !== -1) return;
      const candidate = users[swipe.from];
      if (!candidate) return;
      const doc = normalizeUser(candidate);
      if (doc.blocked.indexOf(uid) !== -1) return;
      out.push(doc);
    });
    return out;
  }

  /**
   * The match rows this account is in, newest conversation first.
   * @param {Object} matches the stored matches map
   * @param {string} uid the viewer
   * @returns {Object[]} match rows
   */
  function matchRows(matches, uid) {
    return Object.keys(matches)
      .map(function (key) { return matches[key]; })
      .filter(function (m) {
        return isPlainObject(m) && Array.isArray(m.users) && m.users.indexOf(uid) !== -1;
      })
      .map(function (m) { return matchRow(m, m.id || pairId(m.users[0], m.users[1]), uid); })
      .sort(byRecency);
  }

  /* ------------------------------------------------------------------------
     5. Demo adapter — localStorage
     ------------------------------------------------------------------------ */

  /**
   * Turn a bundled seed profile into a stored UserDoc: the durable
   * `lastActiveOffsetHours` becomes a real timestamp relative to seed time.
   * @param {Object} seed seed profile
   * @param {number} stamp epoch ms used as "now"
   * @returns {Object|null} UserDoc, or null when the seed is unusable
   */
  function seedToUser(seed, stamp) {
    if (!isPlainObject(seed) || !seed.uid) return null;
    const raw = cloneDeep(seed);
    const offsetHours = raw.lastActiveOffsetHours;
    delete raw.lastActiveOffsetHours;
    const user = normalizeUser(raw);
    user.lastActiveAt = offsetIso(stamp, offsetHours);
    if (!user.createdAt) user.createdAt = new Date(stamp - 45 * 86400000).toISOString();
    if (!user.updatedAt) user.updatedAt = user.lastActiveAt;
    user.usage = normalizeUsage({ date: todayKey() });
    return user;
  }

  /**
   * How many messages at the tail of a conversation the viewer did not send —
   * everything after their own last message. That is the unread count a
   * seeded conversation should open with.
   * @param {Object[]} docs messages ascending by createdAt
   * @param {string} uid the viewer
   * @returns {number} trailing messages from the other side
   */
  function trailingUnread(docs, uid) {
    let count = 0;
    for (let i = docs.length - 1; i >= 0; i -= 1) {
      if (docs[i].from === uid) break;
      count += 1;
    }
    return count;
  }

  /**
   * Seed the relationships the demo account starts life with: inbound likes it
   * can match with in one right swipe, one live conversation, and one match
   * with no messages yet. Without these, matches, chat and "Who liked you" are
   * all unreachable from a fresh demo database.
   *
   * Doc shapes and ids are exactly the ones recordSwipe/sendMessage write, so
   * seeded history is indistinguishable from history the user made.
   * @param {Object} users the user map just written, keyed by uid
   * @param {number} stamp epoch ms used as "now"
   * @param {boolean} force overwrite relationships that are already stored
   * @returns {void}
   */
  function seedRelationships(users, stamp, force) {
    // Only meaningful when the bundled demo account is actually present.
    if (!isPlainObject(users) || !users[DEMO_UID]) return;
    const likes = Array.isArray(ZC.SEED_INBOUND_LIKES) ? ZC.SEED_INBOUND_LIKES : [];
    const conversations = Array.isArray(ZC.SEED_CONVERSATIONS) ? ZC.SEED_CONVERSATIONS : [];
    if (!likes.length && !conversations.length) return;

    const swipes = readSwipes();
    const matches = readMatches();
    const messages = readMessages();
    let touchedSwipes = false;
    let touchedMatches = false;
    let touchedMessages = false;

    /** Write one swipe unless it is already there (a re-seed never clobbers). */
    function putSwipe(from, to, action, createdAt) {
      const id = swipeId(from, to);
      if (!force && swipes[id]) return;
      swipes[id] = { id: id, from: String(from), to: String(to), action: normalizeAction(action), createdAt: createdAt };
      touchedSwipes = true;
    }

    // People who liked the demo account and are waiting on an answer: they
    // still sit in the deck, so any of them is one right swipe from a match.
    likes.forEach(function (like) {
      if (!isPlainObject(like) || !like.from || like.from === DEMO_UID) return;
      if (!users[like.from]) return;
      putSwipe(like.from, DEMO_UID, like.action, offsetIso(stamp, like.offsetHours));
    });

    conversations.forEach(function (convo) {
      if (!isPlainObject(convo)) return;
      const other = String(convo.with || '');
      if (!other || other === DEMO_UID || !users[other]) return;
      const matchedAt = offsetIso(stamp, convo.matchedOffsetHours);

      // A match only exists because both sides swiped right, so write both.
      putSwipe(DEMO_UID, other, 'like', matchedAt);
      putSwipe(other, DEMO_UID, 'like', matchedAt);

      const raw = Array.isArray(convo.messages) ? convo.messages : [];
      const docs = [];
      raw.forEach(function (message, index) {
        if (!isPlainObject(message)) return;
        const body = normalizeText(message.text);
        if (!body) return;
        docs.push({
          id: newMessageId(index),
          from: message.from === DEMO_UID ? DEMO_UID : other,
          text: body,
          createdAt: offsetIso(stamp, message.offsetHours)
        });
      });
      // The bundled list is oldest first; sort anyway so a stray offset cannot
      // hand the chat view a backwards conversation.
      docs.sort(function (a, b) { return (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0); });
      const last = docs.length ? docs[docs.length - 1] : null;

      const matchId = pairId(DEMO_UID, other);
      if (force || !matches[matchId]) {
        const unread = {};
        unread[other] = 0;
        unread[DEMO_UID] = trailingUnread(docs, DEMO_UID);
        matches[matchId] = {
          id: matchId,
          users: [DEMO_UID, other].sort(),
          createdAt: matchedAt,
          lastMessage: last ? last.text : null,
          lastMessageAt: last ? last.createdAt : null,
          unread: unread
        };
        touchedMatches = true;
      }

      const stored = messages[matchId];
      if (docs.length && (force || !Array.isArray(stored) || !stored.length)) {
        messages[matchId] = docs;
        touchedMessages = true;
      }
    });

    if (touchedSwipes) writeSwipes(swipes);
    if (touchedMatches) writeMatches(matches);
    if (touchedMessages) writeMessages(messages);
  }

  /**
   * Seed the demo database from ZC.SEED_PROFILES, plus the relationships in
   * ZC.SEED_INBOUND_LIKES and ZC.SEED_CONVERSATIONS.
   * @param {boolean} [force=false] wipe and re-seed even if already seeded
   * @returns {Promise<boolean>} true when seeding ran
   */
  async function demoSeed(force) {
    const flag = readJson(KEYS.seeded, null);
    const alreadySeeded = isPlainObject(flag) && flag.version === SEED_VERSION;
    if (alreadySeeded && !force) return false;

    const seeds = Array.isArray(ZC.SEED_PROFILES) ? ZC.SEED_PROFILES : [];
    if (!seeds.length && !force) {
      // seed-data.js missing or empty: keep going with an empty database.
      console.warn('[zc.store] No ZC.SEED_PROFILES found — demo mode starts empty.');
    }

    const stamp = Date.now();
    const users = force ? {} : readUsers();
    seeds.forEach(function (seed) {
      const doc = seedToUser(seed, stamp);
      if (!doc) return;
      // Never clobber a real account that happens to share a uid.
      if (!force && users[doc.uid]) return;
      users[doc.uid] = doc;
    });

    writeUsers(users);
    // Same pass, same timestamp: the demo account gets its history immediately.
    seedRelationships(users, stamp, !!force);
    writeJson(KEYS.seeded, { version: SEED_VERSION, at: new Date(stamp).toISOString(), count: seeds.length });
    return true;
  }

  const demoAdapter = {
    mode: 'demo',

    async init() {
      await demoSeed(false);
      return true;
    },

    async getUser(uid) {
      if (!uid) return null;
      const users = readUsers();
      return users[uid] ? normalizeUser(users[uid]) : null;
    },

    async createUser(uid, partial) {
      const users = readUsers();
      const existing = users[uid];
      const stamp = nowIso();
      const user = normalizeUser(deepMerge(existing || {}, partial || {}));
      user.uid = String(uid);
      user.createdAt = (existing && existing.createdAt) || stamp;
      user.updatedAt = stamp;
      user.lastActiveAt = stamp;
      user.usage = normalizeUsage({ date: todayKey() });
      users[user.uid] = user;
      writeUsers(users);
      return cloneDeep(user);
    },

    async updateUser(uid, patch) {
      const users = readUsers();
      const base = users[uid] || { uid: uid };
      const user = normalizeUser(deepMerge(base, patch || {}));
      user.uid = String(uid);
      user.updatedAt = nowIso();
      users[user.uid] = user;
      writeUsers(users);
      return cloneDeep(user);
    },

    async setLastActive(uid, iso) {
      const users = readUsers();
      if (!users[uid]) return false;
      users[uid].lastActiveAt = iso;
      return writeUsers(users);
    },

    async setLearning(uid, learning) {
      const users = readUsers();
      if (!users[uid]) return false;
      // Replaced, never merged: pruning a slug out of the affinity map is a
      // real edit, and a merge would put it straight back.
      users[uid].learning = cloneDeep(learning || {});
      return writeUsers(users);
    },

    async listCandidates(uid, options) {
      const limit = Math.max(1, Number((options || {}).limit) || DEFAULT_CANDIDATE_LIMIT);
      const users = readUsers();
      const swipes = readSwipes();
      const me = users[uid] ? normalizeUser(users[uid]) : null;
      const swiped = swipedSet(Object.keys(swipes).map(function (key) { return swipes[key]; }), uid);
      const myBlocks = me ? me.blocked : [];
      const out = [];
      Object.keys(users).forEach(function (key) {
        if (key === uid) return;
        if (swiped[key]) return;
        const candidate = normalizeUser(users[key]);
        if (myBlocks.indexOf(key) !== -1) return;
        if (candidate.blocked.indexOf(uid) !== -1) return;
        out.push(candidate);
      });
      out.sort(function (a, b) {
        return (Date.parse(b.lastActiveAt || 0) || 0) - (Date.parse(a.lastActiveAt || 0) || 0);
      });
      return out.slice(0, limit);
    },

    async getSwipes(uid) {
      const swipes = readSwipes();
      return Object.keys(swipes)
        .map(function (key) { return swipes[key]; })
        .filter(function (swipe) { return isPlainObject(swipe) && swipe.from === uid; })
        .sort(function (a, b) {
          return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
        })
        .map(cloneDeep);
    },

    async recordSwipe(fromUid, toUid, action) {
      const act = normalizeAction(action);
      const swipes = readSwipes();
      const id = swipeId(fromUid, toUid);
      const existing = isPlainObject(swipes[id]) ? swipes[id] : null;

      // Mirror the Firestore adapter, where the rules make swipes create-or-delete only:
      // an already-recorded decision stands and re-recording it writes nothing.
      let effective = act;
      if (existing) {
        effective = normalizeAction(existing.action);
      } else {
        swipes[id] = {
          id: id,
          from: fromUid,
          to: toUid,
          action: act,
          createdAt: nowIso()
        };
        writeSwipes(swipes);
        // Before the early returns below, because a one-sided like is exactly
        // the write the who-liked-you badge is watching for and most swipes
        // never reach the match-creation path at the bottom.
        pollAll();
      }

      if (!isPositive(effective)) return { matched: false, matchId: null, created: false };
      const reverse = swipes[swipeId(toUid, fromUid)];
      if (!reverse || !isPositive(reverse.action)) return { matched: false, matchId: null, created: false };

      // A block outranks a mutual like, and the answer is a plain "no match" rather than
      // an error: the person who was blocked must not be told that they were. The
      // Firestore adapter cannot make this decision — the block list is private, so its
      // client never sees it — and relies on `firestore.rules` refusing the write. Same
      // outcome, reached from opposite ends, which is the agreement worth having.
      const users = readUsers();
      const target = isPlainObject(users[toUid]) ? normalizeUser(users[toUid]) : null;
      if (target && target.blocked.indexOf(fromUid) !== -1) {
        return { matched: false, matchId: null, created: false };
      }

      // Mutual like — create the match once and only once.
      const matches = readMatches();
      const matchId = pairId(fromUid, toUid);
      let created = false;
      if (!matches[matchId]) {
        const unread = {};
        unread[fromUid] = 0;
        unread[toUid] = 0;
        matches[matchId] = {
          id: matchId,
          users: [String(fromUid), String(toUid)].sort(),
          createdAt: nowIso(),
          lastMessage: null,
          lastMessageAt: null,
          unread: unread
        };
        writeMatches(matches);
        created = true;
      }
      pollAll();
      return { matched: true, matchId: matchId, created: created };
    },

    async undoSwipe(fromUid, toUid) {
      // The same refusal the Firebase adapter makes, for the same reason, and
      // stated here rather than shared because the two adapters diverging
      // quietly is the failure this project keeps finding in itself.
      //
      // localStorage has no compare-and-swap, so this is a check followed by a
      // write and cannot be anything else. The match is therefore read last,
      // immediately before the write, leaving the smallest window a second tab
      // could land a reciprocal like in — and the check stays unconditional:
      // moving it inside `if (swipes[id])` would narrow the window by one more
      // read at the cost of answering `ok: true` for a matched pair whose
      // swipe row is already gone, which would put their card back on the deck.
      // What survives the window is bounded and destroys nothing: the match and
      // its messages are no longer deleted by this function at all, so the
      // worst outcome is a swipe row removed a moment late. README's
      // Limitations section says so out loud.
      const swipes = readSwipes();
      const id = swipeId(fromUid, toUid);
      const matches = readMatches();
      if (matches[pairId(fromUid, toUid)]) return { ok: false, reason: 'matched' };
      if (swipes[id]) {
        delete swipes[id];
        writeSwipes(swipes);
        // An answered like becomes unanswered again, which the badge counts.
        pollAll();
      }
      return { ok: true };
    },

    async getLikesReceived(uid) {
      return pendingLikers(uid);
    },

    async getMatches(uid) {
      const users = readUsers();
      const matches = readMatches();
      return Object.keys(matches)
        .map(function (key) { return matches[key]; })
        .filter(function (match) { return isPlainObject(match) && Array.isArray(match.users) && match.users.indexOf(uid) !== -1; })
        .map(function (match) { return toMatchView(match, uid, users[otherOf(match, uid)]); })
        .sort(byRecency);
    },

    async getMatch(matchId, uid) {
      const matches = readMatches();
      const match = matches[matchId];
      if (!isPlainObject(match)) return null;
      const viewer = uid || currentUid() || (Array.isArray(match.users) ? match.users[0] : null);
      const users = readUsers();
      return toMatchView(match, viewer, users[otherOf(match, viewer)]);
    },

    async unmatch(matchId, uid) {
      const matches = readMatches();
      const match = matches[matchId];
      if (!match) return { ok: true, removed: false };
      if (uid && Array.isArray(match.users) && match.users.indexOf(uid) === -1) {
        throw new Error('You are not part of that match.');
      }
      delete matches[matchId];
      writeMatches(matches);
      const messages = readMessages();
      if (messages[matchId]) {
        delete messages[matchId];
        writeMessages(messages);
      }
      pollAll();
      return { ok: true, removed: true };
    },

    async getMessages(matchId, options) {
      const limit = Math.max(1, Number((options || {}).limit) || DEFAULT_MESSAGE_LIMIT);
      const all = readMessages();
      const list = Array.isArray(all[matchId]) ? all[matchId] : [];
      return cloneDeep(list.slice(Math.max(0, list.length - limit)));
    },

    async sendMessage(matchId, fromUid, text) {
      const body = normalizeText(text);
      if (!body) throw new Error('Message cannot be empty.');
      const matches = readMatches();
      const match = matches[matchId];
      if (!isPlainObject(match)) throw new Error('That conversation no longer exists.');

      const message = { id: newMessageId(0), from: fromUid, text: body, createdAt: nowIso() };
      const all = readMessages();
      if (!Array.isArray(all[matchId])) all[matchId] = [];
      all[matchId].push(message);
      writeMessages(all);

      // Denormalise the preview + unread counter onto the match.
      const other = otherOf(match, fromUid);
      match.lastMessage = body;
      match.lastMessageAt = message.createdAt;
      if (!isPlainObject(match.unread)) match.unread = {};
      match.unread[other] = (Number(match.unread[other]) || 0) + 1;
      match.unread[fromUid] = Number(match.unread[fromUid]) || 0;
      writeMatches(matches);

      // Our own tab gets no storage event, so nudge listeners directly.
      pollAll();
      return cloneDeep(message);
    },

    listenMessages(matchId, cb) {
      return listen({
        cb: cb,
        snapshot: function () {
          const all = readMessages();
          return cloneDeep(Array.isArray(all[matchId]) ? all[matchId] : []);
        },
        signature: messagesSignature
      });
    },

    listenMatches(uid, cb) {
      return listen({
        cb: cb,
        snapshot: function () { return matchRows(readMatches(), uid); },
        signature: rowsSignature
      });
    },

    listenLikesReceived(uid, cb) {
      return listen({
        cb: cb,
        snapshot: function () { return pendingLikers(uid).length; },
        signature: function (count) { return String(count); }
      });
    },

    async markRead(matchId, uid) {
      const matches = readMatches();
      const match = matches[matchId];
      if (!isPlainObject(match)) return false;
      if (!isPlainObject(match.unread)) match.unread = {};
      if (!match.unread[uid]) {
        match.unread[uid] = 0;
        return true;
      }
      match.unread[uid] = 0;
      writeMatches(matches);
      // Our own tab gets no storage event, so nudge listeners directly — the
      // badge is watching this number and should not wait for the next tick.
      pollAll();
      return true;
    },

    async bumpUsage(uid, field, by) {
      // One tab, one thread, one storage entry — the correctness worth having
      // here is agreeing with the Firestore adapter, so the decision comes
      // from the same pure function and only the `usage` field is touched.
      const users = readUsers();
      const stored = isPlainObject(users[uid]) ? users[uid] : null;
      const usage = nextUsage(stored && stored.usage, field, by, todayKey());
      // No account, nothing to write — the caller still gets today's view.
      if (!stored) return usage;
      stored.usage = usage;
      writeUsers(users);
      return usage;
    },

    async reportUser(fromUid, aboutUid, reason, details) {
      const report = shapeReport(fromUid, aboutUid, reason, details);
      // Same deterministic id convention as the Firestore adapter: one report
      // per (reporter, subject) pair, first filing wins.
      report.id = swipeId(fromUid, aboutUid);
      const reports = readReports();
      if (reports[report.id]) return { ok: true, id: report.id, duplicate: true };
      reports[report.id] = report;
      writeReports(reports);
      return { ok: true, id: report.id, duplicate: false };
    },

    async getMyReports(uid) {
      const reports = readReports();
      return Object.keys(reports)
        .map(function (key) { return reports[key]; })
        .filter(function (report) { return isPlainObject(report) && report.from === uid; })
        .sort(function (a, b) {
          return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
        })
        .map(cloneDeep);
    },

    async retractReport(fromUid, aboutUid) {
      const reports = readReports();
      const id = swipeId(fromUid, aboutUid);
      if (!reports[id]) return { ok: true, removed: false };
      delete reports[id];
      writeReports(reports);
      return { ok: true, removed: true };
    },

    async getPublicProfile(uid) {
      // Demo mode has no separate projection — the stored doc is the profile.
      return demoAdapter.getUser(uid);
    },

    async deleteAccountData(uid) {
      // Swipes in both directions, matches (and their messages) either way,
      // then the account document itself — mirroring the Firestore adapter.
      const swipes = readSwipes();
      Object.keys(swipes).forEach(function (id) {
        const swipe = swipes[id];
        if (swipe && (swipe.from === uid || swipe.to === uid)) delete swipes[id];
      });
      writeSwipes(swipes);

      const matches = readMatches();
      const messages = readMessages();
      Object.keys(matches).forEach(function (id) {
        const match = matches[id];
        if (match && Array.isArray(match.users) && match.users.indexOf(uid) !== -1) {
          delete matches[id];
          delete messages[id];
        }
      });
      writeMatches(matches);
      writeMessages(messages);

      // Reports the account filed carry its uid; reports about it stay, the
      // same way the Firestore queue retains them for review.
      const reports = readReports();
      Object.keys(reports).forEach(function (id) {
        if (reports[id] && reports[id].from === uid) delete reports[id];
      });
      writeReports(reports);

      const users = readUsers();
      delete users[uid];
      writeUsers(users);
      pollAll();
      return true;
    },

    async seedDemo(force) {
      return demoSeed(!!force);
    },

    async resetDemo() {
      [KEYS.users, KEYS.swipes, KEYS.matches, KEYS.messages, KEYS.reports, KEYS.seeded].forEach(removeKey);
      await demoSeed(true);
      pollAll();
      return true;
    },

    async exportDemo() {
      return {
        version: SEED_VERSION,
        exportedAt: nowIso(),
        mode: 'demo',
        users: readUsers(),
        swipes: readSwipes(),
        matches: readMatches(),
        messages: readMessages(),
        reports: readReports()
      };
    },

    async importDemo(json) {
      let data = json;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (err) {
          throw new Error('That file is not valid JSON.');
        }
      }
      if (!isPlainObject(data) || !isPlainObject(data.users)) {
        throw new Error('That export does not contain any users.');
      }
      writeUsers(data.users);
      writeSwipes(isPlainObject(data.swipes) ? data.swipes : {});
      writeMatches(isPlainObject(data.matches) ? data.matches : {});
      writeMessages(isPlainObject(data.messages) ? data.messages : {});
      writeReports(isPlainObject(data.reports) ? data.reports : {});
      writeJson(KEYS.seeded, { version: SEED_VERSION, at: nowIso(), count: Object.keys(data.users).length });
      pollAll();
      return true;
    }
  };

  /**
   * Build the `{ [uid]: true }` set of everyone `uid` has already swiped.
   * @param {Array} swipes swipe docs
   * @param {string} uid the swiper
   * @returns {Object}
   */
  function swipedSet(swipes, uid) {
    const set = {};
    (swipes || []).forEach(function (swipe) {
      if (isPlainObject(swipe) && swipe.from === uid && swipe.to) set[swipe.to] = true;
    });
    return set;
  }

  function otherOf(match, uid) {
    const users = Array.isArray(match.users) ? match.users : [];
    for (let i = 0; i < users.length; i += 1) {
      if (users[i] !== uid) return users[i];
    }
    return users[0] || null;
  }

  /**
   * Mutual gender and age eligibility, mirroring the matching engine's hard
   * filters (an empty `interestedIn` means open to all; a missing age on the
   * viewer never excludes anyone). Used only to keep pagination from spending
   * its budget on profiles the engine would reject anyway.
   * @param {Object} a one user
   * @param {Object} b the other
   * @returns {boolean} true when neither side's gender/age filters exclude the other
   */
  function mutuallyEligible(a, b) {
    function open(user, candidate) {
      const wants = user.preferences && Array.isArray(user.preferences.interestedIn)
        ? user.preferences.interestedIn : [];
      const gender = candidate.profile && candidate.profile.gender;
      if (wants.length && gender && wants.indexOf(gender) === -1) return false;
      const age = candidate.profile ? num(candidate.profile.age) : null;
      if (age !== null && user.preferences) {
        const lo = num(user.preferences.ageMin);
        const hi = num(user.preferences.ageMax);
        if (lo !== null && age < lo) return false;
        if (hi !== null && age > hi) return false;
      }
      return true;
    }
    return open(a, b) && open(b, a);
  }

  /**
   * Validate and shape a user report. Throws on anything malformed so a bad
   * report never reaches storage in either adapter.
   * @param {string} fromUid the reporter
   * @param {string} aboutUid the account being reported
   * @param {string} reason one of REPORT_REASONS
   * @param {string} [details] optional free text, capped at 500 chars
   * @returns {Object} the report document (without an id)
   */
  function shapeReport(fromUid, aboutUid, reason, details) {
    if (!fromUid || !aboutUid) throw new Error('A report needs both accounts.');
    if (fromUid === aboutUid) throw new Error('You cannot report yourself.');
    if (REPORT_REASON_SLUGS.indexOf(reason) === -1) throw new Error('Pick a reason for the report.');
    const text = String(details || '').trim().slice(0, REPORT_DETAILS_MAX);
    return {
      from: String(fromUid),
      about: String(aboutUid),
      reason: reason,
      details: text,
      createdAt: nowIso()
    };
  }

  /**
   * Shape a stored match into the MatchView pages render.
   * @param {Object} match MatchDoc
   * @param {string} uid the viewer
   * @param {Object} otherDoc the other participant's UserDoc (may be missing)
   * @returns {Object} MatchView
   */
  function toMatchView(match, uid, otherDoc) {
    const otherUid = otherOf(match, uid);
    const unread = isPlainObject(match.unread) ? Number(match.unread[uid]) || 0 : 0;
    return {
      matchId: match.id || pairId(uid, otherUid),
      otherUid: otherUid,
      other: otherDoc ? normalizeUser(otherDoc) : placeholderUser(otherUid),
      createdAt: match.createdAt || null,
      lastMessage: match.lastMessage || null,
      lastMessageAt: match.lastMessageAt || null,
      unread: unread
    };
  }

  /* ------------------------------------------------------------------------
     6. Firestore adapter
     ------------------------------------------------------------------------ */

  function db() {
    if (!ZC.firebase || !ZC.firebase.db) throw new Error('Firestore is not available.');
    return ZC.firebase.db;
  }

  /** FieldValue.increment when the SDK exposes it, else null. */
  function fieldValue() {
    if (typeof firebase === 'undefined' || !firebase.firestore || !firebase.firestore.FieldValue) return null;
    return firebase.firestore.FieldValue;
  }

  function docToUser(snap) {
    if (!snap || !snap.exists) return null;
    const data = snap.data() || {};
    data.uid = data.uid || snap.id;
    return normalizeUser(data);
  }

  /**
   * Delete a list of document refs in write batches (Firestore caps a batch
   * at 500 operations).
   * @param {Array} refs document references
   * @returns {Promise<void>}
   */
  async function batchDelete(refs) {
    for (let i = 0; i < refs.length; i += 400) {
      const batch = db().batch();
      refs.slice(i, i + 400).forEach(function (ref) { batch.delete(ref); });
      await batch.commit();
    }
  }

  /**
   * Remove every message under a match. Runs before the match document is
   * deleted, because the message-delete rule proves membership via the parent.
   * @param {Object} matchRef the match document reference
   * @returns {Promise<void>}
   */
  /**
   * Whether a Firestore rejection is the rules refusing the write.
   *
   * The code, and only the code. This also matched the *message* at first —
   * belt and braces for a rejection that arrived wrapped or from some future
   * SDK — and that is a guess dressed as a fallback: any error text may contain
   * those two words, and a wrapped outage that quoted them would have been
   * swallowed and answered as "no match", which is the one thing the caller
   * must not be told when the write's outcome is unknown.
   *
   * The trade is deliberate and it is not free. If an SDK ever stops setting
   * `code`, a refusal will surface as a failed swipe rather than a quiet
   * no-match. That is the safer direction — a visible wrong answer beats a
   * silent one — and unlike a message change it is a specific, detectable
   * break that the emulator suite would show.
   * @param {*} err a rejection from a Firestore write
   * @returns {boolean}
   */
  function isPermissionDenied(err) {
    if (!err) return false;
    const code = String(err.code || '');
    return code === 'permission-denied' || code === 'firestore/permission-denied';
  }

  async function deleteMatchMessages(matchRef) {
    for (;;) {
      const snap = await matchRef.collection('messages').limit(200).get();
      if (snap.empty) return;
      await batchDelete(snap.docs.map(function (doc) { return doc.ref; }));
      if (snap.size < 200) return;
    }
  }

  /** Round a coordinate to ~1 km precision for the public projection. */
  function roundCoord(value) {
    const n = Number(value);
    return isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  /**
   * The public projection of a UserDoc — the only shape other signed-in users
   * can read. `users/{uid}` itself is owner-only: email, birthdate, block
   * lists, usage counters and learned affinities never leave the account.
   * Coordinates are rounded to ~1 km so exact positions are never published.
   * @param {Object} user full UserDoc
   * @returns {Object} discovery document
   */
  function projectDiscovery(user) {
    const p = isPlainObject(user.profile) ? user.profile : {};
    const f = isPlainObject(user.preferences) ? user.preferences : {};
    const location = isPlainObject(p.location) ? {
      label: String(p.location.label || ''),
      lat: roundCoord(p.location.lat),
      lng: roundCoord(p.location.lng)
    } : null;
    return {
      uid: String(user.uid),
      displayName: String(user.displayName || ''),
      profileComplete: !!user.profileComplete,
      lastActiveAt: user.lastActiveAt || nowIso(),
      profile: {
        age: num(p.age),
        gender: p.gender || 'other',
        pronouns: String(p.pronouns || ''),
        bio: String(p.bio || ''),
        photos: Array.isArray(p.photos) ? p.photos.slice(0, 6) : [],
        interests: Array.isArray(p.interests) ? p.interests.slice(0, 12) : [],
        personality: isPlainObject(p.personality) ? p.personality : null,
        location: location,
        showAge: p.showAge !== false,
        showDistance: p.showDistance !== false
      },
      preferences: {
        interestedIn: Array.isArray(f.interestedIn) ? f.interestedIn.slice(0, 4) : [],
        ageMin: num(f.ageMin) === null ? 18 : num(f.ageMin),
        ageMax: num(f.ageMax) === null ? 100 : num(f.ageMax),
        maxDistanceKm: num(f.maxDistanceKm) === null ? 500 : num(f.maxDistanceKm),
        discoverable: f.discoverable !== false
      }
    };
  }

  /**
   * Keep the discovery projection in step with the private doc. Best-effort:
   * a failed projection write must never fail the profile save that caused it.
   * @param {Object} user full UserDoc
   * @returns {Promise<void>}
   */
  async function writeDiscovery(user) {
    try {
      await db().collection('discovery').doc(String(user.uid)).set(projectDiscovery(user));
    } catch (err) {
      console.warn('[zc.store] Could not update the discovery profile.', err);
    }
  }

  /**
   * The last `usage` the SDK already holds for a user, without touching the
   * network. Only reached when a bump's transaction failed before its read
   * landed — offline, in practice. Without it the optimistic answer would
   * restart the day at 1 for someone who had already spent twelve likes,
   * which is a worse lie than "the last count we saw, plus this swipe".
   * @param {Object} ref the users/{uid} document reference
   * @returns {Promise<Object|null>} the cached usage record, or null when the
   *   SDK has never seen this document
   */
  async function cachedUsage(ref) {
    try {
      const snap = await ref.get({ source: 'cache' });
      return snap.exists ? (snap.data() || {}).usage || null : null;
    } catch (err) {
      // Nothing cached. The caller then answers for a fresh day, which is
      // genuinely all it knows.
      return null;
    }
  }

  /**
   * Fetch several public discovery profiles at once, tolerating individual
   * failures. Other people are only ever read through this projection.
   * @param {string[]} uids ids to fetch
   * @returns {Promise<Object>} map of uid -> UserDoc-shaped public profile
   */
  async function fetchProfiles(uids) {
    const unique = [];
    (uids || []).forEach(function (uid) {
      if (uid && unique.indexOf(uid) === -1) unique.push(uid);
    });
    const results = await Promise.all(unique.map(function (uid) {
      return db().collection('discovery').doc(uid).get().then(docToUser, function (err) {
        console.warn('[zc.store] Could not load profile ' + uid, err);
        return null;
      });
    }));
    const map = {};
    unique.forEach(function (uid, index) {
      if (results[index]) map[uid] = results[index];
    });
    return map;
  }

  /**
   * Of the people who liked this account, the ones it has not answered.
   *
   * One point read per liker, rather than the whole swipe history. That used to
   * be `getSwipes(uid)` — one line, looks like one read, and is a read for every
   * card the account has ever swiped. app.js asked for this on a timer, so the
   * cost of a background refresh grew with how long somebody had used the app:
   * measured at 437 reads for a month's use and 837 once that history doubled,
   * against a Spark quota of 50,000 a day. Swipe ids are derived from the pair,
   * so "have I answered them" is a document lookup needing no query and no
   * index.
   *
   * `listCandidates` still reads the whole history and should: it excludes
   * everyone already swiped from an unbounded walk of `discovery`, it cannot do
   * that one id at a time, and it runs when a deck loads rather than on a timer.
   * @param {string} uid the viewer
   * @param {string[]} senders everyone who has liked them
   * @returns {Promise<string[]>} the uids still waiting for an answer
   */
  async function pendingOf(uid, senders) {
    if (!senders.length) return [];
    const me = await firestoreAdapter.getUser(uid);
    const myBlocks = me ? me.blocked : [];
    const unblocked = senders.filter(function (from) { return myBlocks.indexOf(from) === -1; });
    const already = await Promise.all(unblocked.map(function (from) {
      return db().collection('swipes').doc(swipeId(uid, from)).get();
    }));
    return unblocked.filter(function (from, index) { return !already[index].exists; });
  }

  /** The `from` uids of a snapshot of inbound swipes, positives only, deduped. */
  function positiveSenders(snap) {
    const senders = [];
    snap.forEach(function (doc) {
      const data = doc.data() || {};
      if (!isPositive(data.action) || !data.from) return;
      if (senders.indexOf(data.from) === -1) senders.push(data.from);
    });
    return senders;
  }

  const firestoreAdapter = {
    mode: 'firebase',

    async init() {
      return true;
    },

    async getUser(uid) {
      if (!uid) return null;
      return docToUser(await db().collection('users').doc(uid).get());
    },

    async createUser(uid, partial) {
      // Not a transaction, unlike updateUser: this only ever runs after
      // getUser came back empty (see auth.js loadOrCreateDoc), and every field
      // it writes is a fresh default — there is no earlier value for a racing
      // write to revert. Two tabs signing in at the same instant would both
      // write the same defaults, which is the one read-modify-write in this
      // file that genuinely has nothing to lose.
      const stamp = nowIso();
      const user = normalizeUser(partial || {});
      user.uid = String(uid);
      user.createdAt = stamp;
      user.updatedAt = stamp;
      user.lastActiveAt = stamp;
      user.usage = normalizeUsage({ date: todayKey() });
      await db().collection('users').doc(user.uid).set(user);
      await writeDiscovery(user);
      return user;
    },

    async updateUser(uid, patch) {
      // Still a read-modify-write with a whole-document set, so nested maps
      // behave exactly like the demo adapter (a merged set would resurrect
      // keys that learning pruning removed) — but the read and the set are one
      // atomic unit now. They have to be: a set writes back every field it
      // read, so anything that landed in between is silently reverted, and
      // dashboard.js makes that the ordinary case rather than an exotic one.
      // Every swipe leaves this write in flight across the usage transaction,
      // and a plain get-then-set put `usage` back the way it read it and threw
      // the increment away. Firestore replays the callback when the document
      // moved under it, so whichever write loses the race re-reads and both
      // survive.
      // The projection goes in the same transaction, which is why this is not
      // writeDiscovery(): two concurrent saves commit their user documents in
      // one order, but two independent follow-up writes can land in the other,
      // leaving discovery/{uid} holding the older profile while users/{uid}
      // holds the newer one. A transaction writes both or neither, and
      // whichever save commits second has read the first. (Transaction writes
      // are buffered until commit, so a replayed attempt does not republish
      // anything — the reason this used to sit outside does not hold.)
      // The cost is that a rejected projection now fails the whole save
      // instead of warning: both documents are validated by the same rules
      // from the same values, so that means a real bug, and stopping is better
      // than a public profile that silently drifts from the private one.
      const ref = db().collection('users').doc(uid);
      const shadow = db().collection('discovery').doc(String(uid));
      return db().runTransaction(async function (tx) {
        const snap = await tx.get(ref);
        const base = snap.exists ? snap.data() || {} : { uid: uid };
        const merged = normalizeUser(deepMerge(base, patch || {}));
        merged.uid = String(uid);
        if (!merged.createdAt) merged.createdAt = nowIso();
        merged.updatedAt = nowIso();
        tx.set(ref, merged);
        tx.set(shadow, projectDiscovery(merged));
        return merged;
      });
    },

    async setLastActive(uid, iso) {
      try {
        await db().collection('users').doc(uid).update({ lastActiveAt: iso });
        // The projection carries lastActiveAt too — it drives ranking's
        // activity signal, so it has to stay as fresh as the private doc.
        // Its own failure is tolerated for the same reason the outer one is,
        // but it says so: this write failing is the half nobody would notice.
        // The private document is still correct, so nothing here looks wrong
        // to the person themselves — meanwhile every other deck keeps scoring
        // them on a stale timestamp and quietly ranking them lower. An empty
        // catch made that indistinguishable from success.
        await db().collection('discovery').doc(uid).update({ lastActiveAt: iso })
          .catch(function (err) {
            console.warn('[zc.store] Could not refresh lastActiveAt on the public projection.', err);
          });
        return true;
      } catch (err) {
        // Missing doc or offline — activity is a nicety, never an error path.
        console.warn('[zc.store] Could not update lastActiveAt', err);
        return false;
      }
    },

    async setLearning(uid, learning) {
      // A field write, deliberately not updateUser. The caller arrives holding
      // the finished map — ZC.matching.updateLearning built it from the copy
      // in memory — so there is nothing to read back and therefore no
      // read-modify-write to protect. Sending it through updateUser cost a
      // transaction, and a swipe already runs one: bumpUsage. Two transactions
      // on one users/{uid} in the same tick cannot both commit against the
      // version they read, and the loser came back FAILED_PRECONDITION — a
      // rejected commit and a browser console error on every single like,
      // measured on two swipes out of two. The SDK replayed it and the data
      // was always right, which is why this went unnoticed for so long; it was
      // never free. One write, no read, no precondition, nothing to lose.
      //
      // `learning` is not part of projectDiscovery, so unlike a profile save
      // this has no public half to keep in step.
      await db().collection('users').doc(uid).update({ learning: learning || {} });
      return true;
    },

    async listCandidates(uid, options) {
      const limit = Math.max(1, Number((options || {}).limit) || DEFAULT_CANDIDATE_LIMIT);
      const pageSize = Math.min(200, Math.max(60, limit * 2));
      const discovery = db().collection('discovery');

      const [me, mySwipes] = await Promise.all([
        firestoreAdapter.getUser(uid),
        firestoreAdapter.getSwipes(uid)
      ]);
      const swiped = swipedSet(mySwipes, uid);
      const myBlocks = me ? me.blocked : [];

      // Everyone recently active can be ineligible (already swiped, or failing
      // the mutual filters), so a single newest-first slice would eventually
      // report an empty deck while older eligible profiles still exist. Walk
      // the collection with a cursor until the deck is full, the collection is
      // exhausted, or a hard scan cap is hit.
      const out = [];
      let cursor = null;
      let scanned = 0;
      let ordered = true;
      while (out.length < limit && scanned < 1500) {
        let snap;
        try {
          // Matches the composite index shipped in firestore.indexes.json.
          let query = discovery
            .where('profileComplete', '==', true)
            .where('preferences.discoverable', '==', true)
            .orderBy('lastActiveAt', 'desc')
            .limit(pageSize);
          if (cursor) query = query.startAfter(cursor);
          snap = await query.get();
        } catch (err) {
          console.warn('[zc.store] Indexed candidate query unavailable, falling back.', err);
          try {
            let query = discovery.orderBy('lastActiveAt', 'desc').limit(pageSize);
            if (cursor) query = query.startAfter(cursor);
            snap = await query.get();
          } catch (innerErr) {
            console.warn('[zc.store] Ordered candidate query unavailable, falling back again.', innerErr);
            snap = await discovery.limit(pageSize).get();
            ordered = false;
          }
        }
        if (snap.empty) break;
        cursor = snap.docs[snap.docs.length - 1];
        scanned += snap.size;

        snap.forEach(function (doc) {
          if (out.length >= limit) return;
          if (doc.id === uid) return;
          if (swiped[doc.id]) return;
          if (myBlocks.indexOf(doc.id) !== -1) return;
          // People I blocked are filtered above, from my own private document. People
          // who blocked *me* are not, and cannot be: their block list is private, and
          // any signal this client could read to filter on would tell its user they had
          // been blocked — which is the one thing a block is supposed not to announce.
          // The deck therefore still shows them; the rules stop the contact.
          const candidate = docToUser(doc);
          if (!candidate) return;
          // Cheap mutual gender/age pre-filters (same semantics as the
          // engine's hard filters) so ineligible profiles do not use up the
          // page budget; distance and the rest stay with the engine.
          if (me && !mutuallyEligible(me, candidate)) return;
          out.push(candidate);
        });

        // The unordered fallback cannot paginate; take the one page it gives.
        if (!ordered || snap.size < pageSize) break;
      }
      return out;
    },

    async getSwipes(uid) {
      let snap;
      try {
        snap = await db().collection('swipes').where('from', '==', uid).orderBy('createdAt', 'desc').get();
      } catch (err) {
        console.warn('[zc.store] Ordered swipe query unavailable, falling back.', err);
        snap = await db().collection('swipes').where('from', '==', uid).get();
      }
      const out = [];
      snap.forEach(function (doc) {
        const data = doc.data() || {};
        out.push({
          id: doc.id,
          from: data.from,
          to: data.to,
          action: normalizeAction(data.action),
          createdAt: toIso(data.createdAt)
        });
      });
      out.sort(function (a, b) {
        return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
      });
      return out;
    },

    async recordSwipe(fromUid, toUid, action) {
      const act = normalizeAction(action);
      const id = swipeId(fromUid, toUid);
      const ref = db().collection('swipes').doc(id);
      const existing = await ref.get();

      // Swipes are immutable: the rules allow create and delete but never update, and a
      // set() over an existing document counts as an update. Re-recording the same pair
      // (two tabs on one deck, or a retry whose first write actually landed) therefore
      // writes nothing and simply re-reports the outcome. Changing your mind goes through
      // undoSwipe, which deletes the document so the next record creates it afresh.
      let effective = act;
      if (existing.exists) {
        effective = normalizeAction((existing.data() || {}).action);
      } else {
        await ref.set({
          id: id,
          from: fromUid,
          to: toUid,
          action: act,
          createdAt: nowIso()
        });
      }

      if (!isPositive(effective)) return { matched: false, matchId: null, created: false };

      const reverseSnap = await db().collection('swipes').doc(swipeId(toUid, fromUid)).get();
      if (!reverseSnap.exists || !isPositive((reverseSnap.data() || {}).action)) {
        return { matched: false, matchId: null, created: false };
      }

      // Mutual like — create the match doc only when it is not already there.
      const matchId = pairId(fromUid, toUid);
      const matchRef = db().collection('matches').doc(matchId);
      const matchSnap = await matchRef.get();
      let created = false;
      if (!matchSnap.exists) {
        const unread = {};
        unread[fromUid] = 0;
        unread[toUid] = 0;
        try {
          await matchRef.set({
            id: matchId,
            users: [String(fromUid), String(toUid)].sort(),
            createdAt: nowIso(),
            lastMessage: null,
            lastMessageAt: null,
            unread: unread
          });
        } catch (err) {
          // Only a rules refusal becomes a quiet no-match, and the expected reason for
          // one is the block rule: the other person has blocked this account, and the
          // rule refuses the write because the client cannot — their block list is
          // private and this client never sees it. The answer has to be a plain "no
          // match" rather than an error, because the swipe itself is already stored and
          // the deck must not take the card back.
          //
          // Everything else propagates. A first version caught every rejection here,
          // which turned an offline write, an exhausted quota or a transient failure
          // into a confident "you did not match" — a claim this function cannot make,
          // since the pair may well be mutual and the document may land on a retry.
          // Those are the caller's to see, exactly as they were before any of this.
          if (!isPermissionDenied(err)) throw err;

          // The rejection is deliberately *not* logged with it. The whole point of this
          // path is not telling a blocked account that it was blocked, and a console
          // line carrying `permission-denied` does precisely that. This is not a seal —
          // a refused write is a 403 in the network tab whatever this line does, and
          // anyone driving the SDK directly sees the denial — it removes the casual
          // tell, not the determined one. What is left is a breadcrumb naming the
          // document that was not written, which is what the UI shows anyway.
          console.warn('[zc.store] No match document was created for ' + matchId + '.');
          return { matched: false, matchId: null, created: false };
        }
        created = true;
      }
      return { matched: true, matchId: matchId, created: created };
    },

    async undoSwipe(fromUid, toUid) {
      const swipeRef = db().collection('swipes').doc(swipeId(fromUid, toUid));
      const matchRef = db().collection('matches').doc(pairId(fromUid, toUid));

      // Read the match and delete the swipe in one transaction, and refuse if
      // the match is there. Both halves matter.
      //
      // The refusal, because the caller cannot make this decision. dashboard.js
      // does check — "Rewind cannot undo a match" — but against `entry.matched`,
      // which is stamped when the swipe is written and never looked at again.
      // It is true only for the swipe that completed the pair. Like somebody
      // who has not liked you back and it is false, correctly; when they like
      // you back a minute later the match exists, messages can already be in
      // it, and the flag still says there is nothing to protect. Undoing then
      // is not undoing your own action — it deletes a conversation from
      // somebody who never touched the rewind button, and they are not told.
      //
      // The transaction, because the whole failure is a race. A get() followed
      // by a delete() leaves exactly the window being closed here: a match
      // created in between would be missed the same way, for the same reason.
      // Firestore replays a transaction whose read has moved, so the retry
      // sees the match that appeared.
      return db().runTransaction(async function (tx) {
        const snap = await tx.get(matchRef);
        if (snap.exists) return { ok: false, reason: 'matched' };
        tx.delete(swipeRef);
        return { ok: true };
      });
    },

    async getLikesReceived(uid) {
      let snap;
      try {
        snap = await db().collection('swipes').where('to', '==', uid).where('action', 'in', ['like', 'super']).get();
      } catch (err) {
        console.warn('[zc.store] "in" query unavailable, filtering client-side.', err);
        snap = await db().collection('swipes').where('to', '==', uid).get();
      }
      const senders = positiveSenders(snap);
      if (!senders.length) return [];

      const pending = await pendingOf(uid, senders);
      const users = await fetchProfiles(pending);
      // No "and they have not blocked me" filter, because there cannot be one here.
      // These profiles come from `discovery/{uid}`, and projectDiscovery deliberately
      // leaves `blocked` out — publishing who somebody has blocked is its own
      // disclosure. This line used to read `user.blocked.indexOf(uid) === -1`, which
      // normalizeUser makes a filter over an always-empty array: it excluded nobody and
      // looked like it did. The demo adapter reads whole private documents, so its copy
      // of the check works, and the two quietly disagreed about a safety feature.
      // Where a block is actually enforced is `firestore.rules`, on match creation,
      // where a rule can read a private document no client may.
      return pending
        .map(function (from) { return users[from]; })
        .filter(function (user) { return !!user; });
    },

    async getMatches(uid) {
      const collection = db().collection('matches');
      let snap;
      try {
        snap = await collection.where('users', 'array-contains', uid).orderBy('lastMessageAt', 'desc').get();
      } catch (err) {
        console.warn('[zc.store] Ordered match query unavailable, sorting client-side.', err);
        snap = await collection.where('users', 'array-contains', uid).get();
      }
      const docs = [];
      snap.forEach(function (doc) {
        const data = doc.data() || {};
        data.id = data.id || doc.id;
        docs.push(data);
      });
      const users = await fetchProfiles(docs.map(function (match) { return otherOf(match, uid); }));
      return docs
        .map(function (match) { return toMatchView(match, uid, users[otherOf(match, uid)]); })
        .sort(byRecency);
    },

    async getMatch(matchId, uid) {
      const snap = await db().collection('matches').doc(matchId).get();
      if (!snap.exists) return null;
      const data = snap.data() || {};
      data.id = data.id || snap.id;
      const viewer = uid || currentUid() || (Array.isArray(data.users) ? data.users[0] : null);
      const otherUid = otherOf(data, viewer);
      const users = await fetchProfiles([otherUid]);
      return toMatchView(data, viewer, users[otherUid]);
    },

    async unmatch(matchId, uid) {
      const ref = db().collection('matches').doc(matchId);
      const snap = await ref.get();
      if (!snap.exists) return { ok: true, removed: false };
      const data = snap.data() || {};
      if (uid && Array.isArray(data.users) && data.users.indexOf(uid) === -1) {
        throw new Error('You are not part of that match.');
      }
      // Messages first: the delete rule checks membership of the parent match,
      // which stops being checkable the moment the match document is gone.
      await deleteMatchMessages(ref);
      await ref.delete();
      return { ok: true, removed: true };
    },

    async getMessages(matchId, options) {
      const limit = Math.max(1, Number((options || {}).limit) || DEFAULT_MESSAGE_LIMIT);
      const snap = await db().collection('matches').doc(matchId).collection('messages')
        .orderBy('createdAt', 'desc').limit(limit).get();
      const out = [];
      snap.forEach(function (doc) {
        const data = doc.data() || {};
        out.push({ id: doc.id, from: data.from, text: String(data.text || ''), createdAt: toIso(data.createdAt) });
      });
      return out.reverse();
    },

    async sendMessage(matchId, fromUid, text) {
      const body = normalizeText(text);
      if (!body) throw new Error('Message cannot be empty.');
      const matchRef = db().collection('matches').doc(matchId);
      const ref = matchRef.collection('messages').doc();
      const message = { id: ref.id, from: fromUid, text: body, createdAt: nowIso() };
      await ref.set(message);

      // Update the conversation preview + the other side's unread counter.
      try {
        const snap = await matchRef.get();
        const other = otherOf(snap.data() || {}, fromUid);
        const patch = { lastMessage: body, lastMessageAt: message.createdAt };
        const FV = fieldValue();
        if (other) {
          patch['unread.' + other] = FV ? FV.increment(1) : (Number(((snap.data() || {}).unread || {})[other]) || 0) + 1;
        }
        await matchRef.update(patch);
      } catch (err) {
        console.warn('[zc.store] Message sent but the conversation preview did not update.', err);
      }
      return message;
    },

    listenMatches(uid, cb) {
      try {
        // No `orderBy`, deliberately. An ordered query here would want a
        // composite index that `getMatches` has a documented fallback for, and
        // a listener has no good place to fall back from; the list is one row
        // per conversation, so sorting it in the browser costs nothing.
        //
        // A snapshot listener is what makes this affordable at all. It bills
        // the documents it first delivers and then only the ones that change,
        // so a tab left open costs nothing while nothing happens — where the
        // twenty-second poll it replaces spent two reads per match every time,
        // forever, whether or not anything had moved.
        return db().collection('matches').where('users', 'array-contains', uid)
          .onSnapshot(function (snap) {
            const rows = [];
            snap.forEach(function (doc) { rows.push(matchRow(doc.data() || {}, doc.id, uid)); });
            cb(rows.sort(byRecency));
          }, function (err) {
            console.warn('[zc.store] Live match stream failed.', err);
          });
      } catch (err) {
        console.warn('[zc.store] Could not open the live match stream.', err);
        return function () { /* nothing to unsubscribe */ };
      }
    },

    listenLikesReceived(uid, cb) {
      let stopped = false;
      let stop = function () { /* nothing to unsubscribe */ };
      try {
        stop = db().collection('swipes')
          .where('to', '==', uid)
          .where('action', 'in', ['like', 'super'])
          .onSnapshot(function (snap) {
            // The point reads happen per delivery rather than per tick, and a
            // delivery only happens when somebody's swipe on this account
            // actually changes. `getLikesReceived` also fetches a profile for
            // each pending liker; this does not, because a badge is a number.
            pendingOf(uid, positiveSenders(snap)).then(function (pending) {
              if (!stopped) cb(pending.length);
            }, function (err) {
              console.warn('[zc.store] Live like count failed.', err);
            });
          }, function (err) {
            // No client-side fallback for the `in` query, unlike getLikesReceived:
            // a listener's error arrives asynchronously, so "try the other query"
            // would mean holding two subscriptions and reconciling them. The
            // emulator and production both support `in`; a failure here means the
            // badge stops updating, not that anything is lost.
            console.warn('[zc.store] Live like stream failed.', err);
          });
      } catch (err) {
        console.warn('[zc.store] Could not open the live like stream.', err);
      }
      return function () { stopped = true; stop(); };
    },

    listenMessages(matchId, cb) {
      try {
        // Descending, then reversed for display — the same shape getMessages
        // uses twenty lines above, and for the same reason.
        //
        // This used to ask for the 500 *oldest* messages instead. Under 500
        // that is indistinguishable; at 500 the window fills with the start of
        // the conversation and never moves again, so every later message is
        // written, stored, counted as unread by the other side, and never
        // delivered to this listener. The chat simply stops updating, with no
        // error anywhere, for as long as the conversation lives. The demo
        // adapter delivers every message and so never had the ceiling.
        return db().collection('matches').doc(matchId).collection('messages')
          .orderBy('createdAt', 'desc')
          .limit(LIVE_MESSAGE_WINDOW)
          .onSnapshot(function (snap) {
            const out = [];
            snap.forEach(function (doc) {
              const data = doc.data() || {};
              out.push({ id: doc.id, from: data.from, text: String(data.text || ''), createdAt: toIso(data.createdAt) });
            });
            cb(out.reverse());
          }, function (err) {
            console.warn('[zc.store] Live message stream failed.', err);
          });
      } catch (err) {
        console.warn('[zc.store] Could not open the live message stream.', err);
        return function () { /* nothing to unsubscribe */ };
      }
    },

    async markRead(matchId, uid) {
      const patch = {};
      patch['unread.' + uid] = 0;
      try {
        await db().collection('matches').doc(matchId).update(patch);
        return true;
      } catch (err) {
        console.warn('[zc.store] Could not clear the unread counter.', err);
        return false;
      }
    },

    async bumpUsage(uid, field, by) {
      // Two tabs swiping at once used to collapse into one increment: both
      // read N, both wrote N+1. A transaction closes that — Firestore replays
      // the whole read-decide-write on contention, so the second attempt sees
      // the first one's number. It writes `usage` and nothing else, which also
      // keeps a swipe from rewriting the doc and re-projecting `discovery`
      // (usage is deliberately absent from that projection).
      const today = todayKey();
      const ref = db().collection('users').doc(uid);
      // Whatever the last attempt managed to read, kept for the offline answer
      // below. `read` is tracked apart from `seen` because the two ways of
      // having no record mean opposite things: a read that landed on a
      // document with no usage really is a fresh day, while a read that never
      // landed knows nothing — and answering 1 there would tell someone who
      // had spent twelve likes today that their budget was untouched.
      let seen = null;
      let read = false;
      try {
        return await db().runTransaction(async function (tx) {
          const snap = await tx.get(ref);
          seen = snap.exists ? (snap.data() || {}).usage : null;
          read = true;
          const usage = nextUsage(seen, field, by, today);
          tx.update(ref, { usage: usage });
          return usage;
        });
      } catch (err) {
        // Transactions need a server round-trip, so they fail offline. A
        // counter that did not persist must never take the deck down: warn,
        // hand back the optimistic figure, carry on.
        console.warn('[zc.store] Could not persist usage.', err);
        if (!read) seen = await cachedUsage(ref);
        return nextUsage(seen, field, by, today);
      }
    },

    async reportUser(fromUid, aboutUid, reason, details) {
      const report = shapeReport(fromUid, aboutUid, reason, details);
      // Deterministic id: one report per (reporter, subject) pair, which is
      // what bounds the queue — the rules enforce the same convention and deny
      // updates, so re-reporting the same person cannot rewrite the original.
      report.id = swipeId(fromUid, aboutUid);
      const ref = db().collection('reports').doc(report.id);
      try {
        await ref.set(report);
        return { ok: true, id: report.id, duplicate: false };
      } catch (err) {
        // A denied write is either "already reported" (set over an existing
        // doc counts as an update) or a genuinely invalid report. Our own
        // existing report is readable, so one get tells the two apart.
        const mine = await ref.get().catch(function () { return null; });
        if (mine && mine.exists) return { ok: true, id: report.id, duplicate: true };
        throw err;
      }
    },

    async getMyReports(uid) {
      // The rules permit exactly this query (author-only read). Anything that
      // still goes wrong degrades to an empty list so the settings page keeps
      // rendering — a permissions hiccup must never take the page down.
      let snap;
      try {
        snap = await db().collection('reports').where('from', '==', uid).get();
      } catch (err) {
        console.warn('[zc.store] Could not load the filed reports.', err);
        return [];
      }
      const out = [];
      snap.forEach(function (doc) {
        const data = doc.data() || {};
        out.push({
          id: doc.id,
          from: data.from,
          about: data.about,
          reason: data.reason,
          // Same normalisation the demo adapter stores: trimmed and capped,
          // so both adapters hand the UI presentation-ready text even for a
          // document written outside the app (e.g. by an admin script).
          details: String(data.details || '').trim().slice(0, REPORT_DETAILS_MAX),
          createdAt: toIso(data.createdAt)
        });
      });
      out.sort(function (a, b) {
        return (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0);
      });
      return out;
    },

    async retractReport(fromUid, aboutUid) {
      const ref = db().collection('reports').doc(swipeId(fromUid, aboutUid));
      // Firestore deletes a missing document "successfully", so probe first.
      // The rules deny author reads of missing reports, so PERMISSION_DENIED
      // here is the expected "nothing left to retract" signal. Any other
      // failure (offline, quota, …) must propagate — reporting a report as
      // already-removed while it still sits in the queue would be a lie.
      let snap = null;
      try {
        snap = await ref.get();
      } catch (err) {
        if (err && err.code === 'permission-denied') return { ok: true, removed: false };
        throw err;
      }
      if (!snap.exists) return { ok: true, removed: false };
      await ref.delete();
      return { ok: true, removed: true };
    },

    async getPublicProfile(uid) {
      if (!uid) return null;
      // One-profile read through the same discovery projection every list
      // fetch uses, so the shape and the failure handling stay identical.
      const map = await fetchProfiles([uid]);
      return map[uid] || null;
    },

    async deleteAccountData(uid) {
      // Swipes in both directions: the ones this account made, and the ones
      // aimed at it — an inbound like is data about this account and must not
      // outlive it.
      const swipes = db().collection('swipes');
      const directions = ['from', 'to'];
      for (let d = 0; d < directions.length; d += 1) {
        const snap = await swipes.where(directions[d], '==', uid).get();
        await batchDelete(snap.docs.map(function (doc) { return doc.ref; }));
      }

      // Every match this account is in, messages first (see unmatch).
      const matches = await db().collection('matches').where('users', 'array-contains', uid).get();
      for (let i = 0; i < matches.docs.length; i += 1) {
        await deleteMatchMessages(matches.docs[i].ref);
        await matches.docs[i].ref.delete();
      }

      // Reports this account filed — readable and deletable only by their
      // author, which is exactly what makes this purge possible. Reports about
      // the account are someone else's documents and stay in the queue.
      try {
        const reports = await db().collection('reports').where('from', '==', uid).get();
        await batchDelete(reports.docs.map(function (doc) { return doc.ref; }));
      } catch (err) {
        console.warn('[zc.store] Could not purge filed reports.', err);
      }

      // The public projection, then the private document — and in that order,
      // with nothing swallowed between them.
      //
      // discovery/{uid} is the world-readable half of an account: display
      // name, photo, the profile fields the deck needs. It used to be deleted
      // inside a .catch that warned and carried on, so a rejected delete still
      // reached the line below, removed the private document, and returned
      // true. That is the worst outcome this function has: the person is told
      // their account is gone, the document they could have retried from is
      // the one that went, and what survives is the copy every signed-in user
      // can read.
      //
      // Failing here instead leaves the account whole and the error visible,
      // which is a state somebody can act on. store-tests/specs/07-deletion
      // proves the purge reaches everything; this makes a purge that could not
      // say so.
      await db().collection('discovery').doc(uid).delete();
      await db().collection('users').doc(uid).delete();
      return true;
    },

    // Demo-only helpers: inert against a real project.
    async seedDemo() {
      return false;
    },

    async resetDemo() {
      throw new Error('Demo data can only be reset in demo mode.');
    },

    async exportDemo() {
      return null;
    },

    async importDemo() {
      return false;
    }
  };

  /* ------------------------------------------------------------------------
     7. Facade
     ------------------------------------------------------------------------ */

  const mode = (ZC.config && ZC.config.mode === 'firebase' && ZC.firebase && ZC.firebase.db) ? 'firebase' : 'demo';
  const adapter = mode === 'firebase' ? firestoreAdapter : demoAdapter;

  // Resolves once the adapter can serve reads (demo mode seeds itself first).
  const ready = (async function initStore() {
    try {
      await adapter.init();
      return true;
    } catch (err) {
      console.warn('[zc.store] Adapter initialisation problem — continuing anyway.', err);
      return false;
    }
  })();

  const lastTouch = {};

  function planLimits(plan) {
    const limits = (ZC.config && ZC.config.limits) || {};
    return limits[plan === 'premium' ? 'premium' : 'free'] || { likesPerDay: 25, superLikesPerDay: 1, rewinds: 0 };
  }

  const store = {
    /** 'firebase' or 'demo' — which adapter is live. */
    mode: mode,

    /** Promise that resolves when the adapter is usable. */
    ready: ready,

    /** Canonical UserDoc defaults. Copy it, do not mutate it. */
    DEFAULT_USER: DEFAULT_USER,

    /** Demo-mode storage keys, exposed for the Settings data tools. */
    KEYS: KEYS,

    /**
     * Load a user document.
     * @param {string} uid user id
     * @returns {Promise<Object|null>} UserDoc or null
     */
    async getUser(uid) {
      await ready;
      return adapter.getUser(uid);
    },

    /**
     * Create a user document, filling every field from DEFAULT_USER.
     * @param {string} uid user id
     * @param {Object} [partial] initial values
     * @returns {Promise<Object>} the stored UserDoc
     */
    async createUser(uid, partial) {
      await ready;
      if (!uid) throw new Error('A uid is required to create a user.');
      return adapter.createUser(uid, partial || {});
    },

    /**
     * Deep-merge a patch into a user document and stamp updatedAt.
     * Nested objects merge; arrays replace.
     * @param {string} uid user id
     * @param {Object} patch changes
     * @returns {Promise<Object>} the updated UserDoc
     */
    async updateUser(uid, patch) {
      await ready;
      if (!uid) throw new Error('A uid is required to update a user.');
      return adapter.updateUser(uid, patch || {});
    },

    /**
     * Record that the user is around. Throttled to one write per 5 minutes.
     * @param {string} uid user id
     * @returns {Promise<boolean>} true when a write happened
     */
    async touchActive(uid) {
      await ready;
      if (!uid) return false;
      const now = Date.now();
      if (lastTouch[uid] && now - lastTouch[uid] < TOUCH_THROTTLE_MS) return false;
      lastTouch[uid] = now;
      return adapter.setLastActive(uid, new Date(now).toISOString());
    },

    /**
     * Store the adaptive-learning map a swipe just produced. The map replaces
     * whatever is stored; it is never merged, because pruning a slug out of it
     * is a deliberate edit. Use this rather than updateUser for learning: the
     * value is already final, so it needs no transaction, and a swipe's usage
     * bump does need one.
     * @param {string} uid user id
     * @param {Object} learning the map from ZC.matching.updateLearning
     * @returns {Promise<boolean>} true when a write happened
     */
    async saveLearning(uid, learning) {
      await ready;
      if (!uid) return false;
      return adapter.setLearning(uid, learning || {});
    },

    /**
     * Candidates for the deck: everyone except me, anyone I have already
     * swiped, and blocks in either direction. Ranking is the engine's job.
     * @param {string} uid viewer id
     * @param {{limit?:number}} [options] max candidates (default 60)
     * @returns {Promise<Object[]>} UserDocs
     */
    async listCandidates(uid, options) {
      await ready;
      if (!uid) return [];
      return adapter.listCandidates(uid, options || {});
    },

    /**
     * Every swipe this user has made, newest first.
     * @param {string} uid swiper id
     * @returns {Promise<Object[]>} SwipeDocs
     */
    async getSwipes(uid) {
      await ready;
      if (!uid) return [];
      return adapter.getSwipes(uid);
    },

    /**
     * Write a swipe and create the match when the like is mutual. Idempotent:
     * re-recording the same swipe never produces a second match.
     * @param {string} fromUid swiper
     * @param {string} toUid swiped
     * @param {'like'|'pass'|'super'} action what they did
     * @returns {Promise<{matched:boolean, matchId:string|null, created:boolean}>}
     */
    async recordSwipe(fromUid, toUid, action) {
      await ready;
      if (!fromUid || !toUid) throw new Error('A swipe needs both people.');
      if (fromUid === toUid) throw new Error('You cannot swipe on yourself.');
      return adapter.recordSwipe(fromUid, toUid, action);
    },

    /**
     * Undo a swipe — unless it has since become a match.
     *
     * A match is two people's, so a rewind may not take one down: the other
     * side can already have read it and written into it. Refusing is not the
     * caller's job, because only storage knows whether the reciprocal like
     * arrived after the swipe was recorded.
     * @param {string} fromUid swiper
     * @param {string} toUid swiped
     * @returns {Promise<{ok:boolean, reason?:string}>} ok false with
     *   reason 'matched' when the pair have matched and nothing was deleted
     */
    async undoSwipe(fromUid, toUid) {
      await ready;
      if (!fromUid || !toUid) throw new Error('A rewind needs both people.');
      return adapter.undoSwipe(fromUid, toUid);
    },

    /**
     * People who liked me and are still waiting for my answer.
     * @param {string} uid viewer id
     * @returns {Promise<Object[]>} UserDocs
     */
    async getLikesReceived(uid) {
      await ready;
      if (!uid) return [];
      return adapter.getLikesReceived(uid);
    },

    /**
     * All of this user's matches as render-ready views, newest activity first.
     * @param {string} uid viewer id
     * @returns {Promise<Object[]>} MatchViews
     */
    async getMatches(uid) {
      await ready;
      if (!uid) return [];
      return adapter.getMatches(uid);
    },

    /**
     * One match as a render-ready view.
     * @param {string} matchId match id
     * @param {string} [uid] viewer (defaults to the signed-in user)
     * @returns {Promise<Object|null>} MatchView or null
     */
    async getMatch(matchId, uid) {
      await ready;
      if (!matchId) return null;
      return adapter.getMatch(matchId, uid || currentUid());
    },

    /**
     * Remove a match (and, in demo mode, its messages).
     * @param {string} matchId match id
     * @param {string} uid the participant asking
     * @returns {Promise<{ok:boolean, removed:boolean}>}
     */
    async unmatch(matchId, uid) {
      await ready;
      if (!matchId) throw new Error('A match id is required.');
      return adapter.unmatch(matchId, uid);
    },

    /**
     * Conversation history, oldest first.
     * @param {string} matchId match id
     * @param {{limit?:number}} [options] how many of the newest messages (default 200)
     * @returns {Promise<Object[]>} MessageDocs
     */
    async getMessages(matchId, options) {
      await ready;
      if (!matchId) return [];
      return adapter.getMessages(matchId, options || {});
    },

    /**
     * Send a message; trims, caps at 1000 chars and rejects empty text.
     * @param {string} matchId match id
     * @param {string} fromUid sender
     * @param {string} text message body
     * @returns {Promise<Object>} the stored MessageDoc
     */
    async sendMessage(matchId, fromUid, text) {
      await ready;
      if (!matchId || !fromUid) throw new Error('A message needs a conversation and a sender.');
      return adapter.sendMessage(matchId, fromUid, text);
    },

    /**
     * Subscribe to a conversation. Firestore uses onSnapshot; demo mode uses
     * the cross-tab storage event plus a 1.5s poll.
     * @param {string} matchId match id
     * @param {Function} cb called with the full ascending message list
     * @returns {Function} unsubscribe
     */
    listenMessages(matchId, cb) {
      if (!matchId || typeof cb !== 'function') return function () { /* nothing to do */ };
      return adapter.listenMessages(matchId, cb);
    },

    /**
     * Subscribe to this account's matches, as badge rows rather than views:
     * `{ id, users, unread, lastMessage, lastMessageAt, createdAt }`, newest
     * conversation first, and **no profiles**. Fetching a name per match on a
     * timer is what made the badge refresh expensive, and a badge draws a
     * number; the matches page still uses `getMatches` for the names.
     *
     * Firestore uses onSnapshot, which bills the first delivery and then only
     * what changes — so an open tab costs nothing while nothing happens. Demo
     * mode uses the cross-tab storage event plus the same poll `listenMessages`
     * uses, which is free either way.
     * @param {string} uid the viewer
     * @param {Function} cb called with the row list on every change
     * @returns {Function} unsubscribe
     */
    listenMatches(uid, cb) {
      if (!uid || typeof cb !== 'function') return function () { /* nothing to do */ };
      return adapter.listenMatches(uid, cb);
    },

    /**
     * Subscribe to how many people have liked this account and are still
     * waiting for an answer. A count, not a list: the badge shows a number and
     * loading a profile for each of them was pure waste.
     * @param {string} uid the viewer
     * @param {Function} cb called with the count on every change
     * @returns {Function} unsubscribe
     */
    listenLikesReceived(uid, cb) {
      if (!uid || typeof cb !== 'function') return function () { /* nothing to do */ };
      return adapter.listenLikesReceived(uid, cb);
    },

    /**
     * Clear this user's unread counter on a match.
     * @param {string} matchId match id
     * @param {string} uid the reader
     * @returns {Promise<boolean>}
     */
    async markRead(matchId, uid) {
      await ready;
      if (!matchId || !uid) return false;
      return adapter.markRead(matchId, uid);
    },

    /**
     * Today's usage counters, reset automatically when the stored date is not
     * today. The reset is persisted through the same atomic path a bump takes,
     * so a roll-over and a swipe racing each other cannot overwrite one
     * another the way two plain read-modify-writes could.
     * @param {string} uid user id
     * @returns {Promise<{date:string, likes:number, superLikes:number, rewinds:number}>}
     */
    async getUsage(uid) {
      await ready;
      const today = todayKey();
      const empty = { date: today, likes: 0, superLikes: 0, rewinds: 0 };
      if (!uid) return empty;
      const user = await adapter.getUser(uid);
      if (!user) return empty;
      const usage = normalizeUsage(user.usage);
      if (usage.date === today) return usage;
      // No field to move: the bump is the roll-over itself, and it already
      // swallows its own write failures.
      return adapter.bumpUsage(uid, null, 0);
    },

    /**
     * Increment one usage counter for today, atomically. In Firebase mode this
     * is a transaction, so concurrent swipes from two tabs or two devices both
     * count; the day roll-over happens inside the same transaction.
     * @param {string} uid user id
     * @param {'likes'|'superLikes'|'rewinds'} field counter to bump
     * @param {number} [by=1] amount
     * @returns {Promise<Object>} the updated usage record
     */
    async bumpUsage(uid, field, by) {
      await ready;
      // An unknown field still gets today's honest view (and rolls the day
      // over if it is stale), it just never moves a counter.
      if (!uid || !Object.prototype.hasOwnProperty.call(LIMIT_FIELDS, field)) return store.getUsage(uid);
      return adapter.bumpUsage(uid, field, by === undefined ? 1 : Number(by) || 0);
    },

    /**
     * Whether the user has budget left for an action today.
     * @param {string} uid user id
     * @param {'likes'|'superLikes'|'rewinds'} field counter to check
     * @returns {Promise<{allowed:boolean, remaining:number, limit:number, plan:string}>}
     */
    async canSpend(uid, field) {
      await ready;
      const user = uid ? await adapter.getUser(uid) : null;
      const plan = user && user.plan === 'premium' ? 'premium' : 'free';
      const limits = planLimits(plan);
      const limitKey = LIMIT_FIELDS[field] || 'likesPerDay';
      const limit = limits[limitKey];
      const usage = await store.getUsage(uid);
      const used = Number(usage[field]) || 0;
      const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
      return { allowed: remaining > 0, remaining: remaining, limit: limit, plan: plan };
    },

    /** The closed list of report reasons ({slug, label}), for the report UI. */
    REPORT_REASONS: REPORT_REASONS.map(function (r) { return { slug: r.slug, label: r.label }; }),

    /**
     * File a report about another user. One report per (reporter, subject)
     * pair, never editable; the author can list their own filings with
     * getMyReports and withdraw one with retractReport — in Firebase mode the
     * project owner reviews the queue in the console.
     * @param {string} fromUid the reporter
     * @param {string} aboutUid the account being reported
     * @param {string} reason one of REPORT_REASONS
     * @param {string} [details] optional free text, capped at 500 chars
     * @returns {Promise<{ok: boolean, id: string}>}
     */
    async reportUser(fromUid, aboutUid, reason, details) {
      await ready;
      return adapter.reportUser(fromUid, aboutUid, reason, details);
    },

    /**
     * Every report this user has filed, newest first. Read problems (offline,
     * a rules mismatch) degrade to an empty list with a console warning — the
     * settings page has to render either way.
     * @param {string} uid the reporter
     * @returns {Promise<Object[]>} ReportDocs ({id, from, about, reason, details, createdAt})
     */
    async getMyReports(uid) {
      await ready;
      if (!uid) return [];
      return adapter.getMyReports(uid);
    },

    /**
     * Withdraw a filed report. Retracting one that no longer exists is not an
     * error — it just reports `removed: false`.
     * @param {string} fromUid the reporter
     * @param {string} aboutUid the account the report is about
     * @returns {Promise<{ok: boolean, removed: boolean}>}
     */
    async retractReport(fromUid, aboutUid) {
      await ready;
      if (!fromUid || !aboutUid) throw new Error('A retraction needs both accounts.');
      return adapter.retractReport(fromUid, aboutUid);
    },

    /**
     * The public face of an account: what any signed-in user may see of it.
     * Demo mode serves the stored document itself; firebase mode reads the
     * discovery projection. Null when the account is gone or unreadable —
     * callers should treat that as "a deleted account", not as an error.
     * @param {string} uid the account to look up
     * @returns {Promise<Object|null>} UserDoc-shaped public profile or null
     */
    async getPublicProfile(uid) {
      await ready;
      if (!uid) return null;
      return adapter.getPublicProfile(uid);
    },

    /**
     * Remove everything stored about an account: swipes in both directions,
     * matches with their messages, the public discovery projection (firebase
     * mode) and the account document itself. Deleting the sign-in credential
     * is the caller's job — this only clears the data.
     * @param {string} uid the account being deleted
     * @returns {Promise<boolean>}
     */
    async deleteAccountData(uid) {
      await ready;
      if (!uid) throw new Error('deleteAccountData needs a uid.');
      return adapter.deleteAccountData(uid);
    },

    /**
     * Seed the demo database from the bundled profiles. No-op in firebase mode.
     * @param {boolean} [force=false] wipe and re-seed
     * @returns {Promise<boolean>} true when seeding ran
     */
    async seedDemo(force) {
      await ready;
      return adapter.seedDemo(!!force);
    },

    /**
     * Wipe and re-seed the demo database. Throws in firebase mode.
     * @returns {Promise<boolean>}
     */
    async resetDemo() {
      await ready;
      return adapter.resetDemo();
    },

    /**
     * Snapshot of the whole demo database, for the "export my data" download.
     * Returns null in firebase mode.
     * @returns {Promise<Object|null>}
     */
    async exportDemo() {
      await ready;
      return adapter.exportDemo();
    },

    /**
     * Restore a snapshot produced by exportDemo(). No-op in firebase mode.
     * @param {Object|string} json export object or JSON string
     * @returns {Promise<boolean>}
     */
    async importDemo(json) {
      await ready;
      return adapter.importDemo(json);
    },

    /**
     * Pure internals, exposed the way matching-engine.js exposes its own: not
     * part of the page-facing API, but the daily-counter arithmetic is worth
     * exercising directly rather than only through a storage round-trip.
     */
    _internal: {
      nextUsage: nextUsage,
      // The whole of "what is public about an account", in one pure function.
      // Exposed so tests/projection.test.js can hold it against the closed key
      // lists in firestore.rules directly, rather than inferring the shape from
      // a storage round-trip and hoping the two agree.
      projectDiscovery: projectDiscovery
    }
  };

  ZC.store = store;
})();
