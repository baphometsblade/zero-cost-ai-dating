/* The Firebase path, in a browser, for the first time.

   Every other spec runs in demo mode, because the harness aborts the Firebase
   CDN and localStorage is the only backend a test could drive. That left the
   seam where the UI meets Firestore — and public/js/auth.js's Firebase backend
   entirely — untested anywhere.

   The obstacle was the shipped CSP: `connect-src 'self' https://*.googleapis.com
   …`, delivered as a <meta> tag in every page since round 7, so an emulator on
   another port is a different origin and the browser refuses to talk to it.
   The way through is not to touch the policy but to stop crossing the origin:
   the spec's own static server forwards the emulators' paths (see
   harness.startServer's `proxy` option), so the SDK's requests go to the page's
   own origin, which `'self'` already allows. The pages, their script tags and
   their CSP are exactly what ships.

   Every check reads back real emulator state — an Auth account, a Firestore
   document — rather than believing the DOM.

   e2e/README.md has the command that boots the two emulators around this spec.
   With neither of them listening it skips, by name and reason, and records no
   checks at all; it never passes quietly. */
'use strict';

const http = require('node:http');

/* --------------------------------------------------------------------------
   1. Where the emulators are
   -------------------------------------------------------------------------- */

// emulators:exec sets these; the defaults are the ports firebase-tools uses
// when nothing says otherwise, so a hand-started emulator pair works too.
const FIRESTORE = address(process.env.FIRESTORE_EMULATOR_HOST, 8080);
const AUTH = address(process.env.FIREBASE_AUTH_EMULATOR_HOST, 9099);

// The project whose ruleset the emulator loaded. GCLOUD_PROJECT is what
// emulators:exec exports; the fallback matches the command documented above.
const PROJECT = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'demo-zc-browser';

const DOCS = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

/**
 * Split a `host:port` env var, falling back to a port on localhost.
 * @param {string|undefined} raw the environment value
 * @param {number} fallbackPort the port to assume when it is absent
 * @returns {{host:string, port:number}}
 */
function address(raw, fallbackPort) {
  const value = String(raw || '');
  const at = value.lastIndexOf(':');
  const port = Number(at === -1 ? '' : value.slice(at + 1));
  if (!port) return { host: '127.0.0.1', port: fallbackPort };
  return { host: value.slice(0, at) || '127.0.0.1', port: port };
}

/* --------------------------------------------------------------------------
   2. Talking to the emulators from Node
   -------------------------------------------------------------------------- */

/**
 * One request to an emulator's REST surface, as the emulator's owner.
 *
 * `Bearer owner` is the emulator's admin credential: it is how the seeding and
 * the read-backs get past firestore.rules. The browser never uses it — every
 * write the app makes is checked by the real ruleset, which is the point.
 * @param {{host:string, port:number}} target which emulator
 * @param {string} method HTTP method
 * @param {string} path request path
 * @param {Object} [body] JSON body
 * @returns {Promise<{status:number, body:*}>} the parsed answer
 */
function emulator(target, method, path, body) {
  return new Promise(function (resolve, reject) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { authorization: 'Bearer owner' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = http.request({
      host: target.host, port: target.port, method: method, path: path, headers: headers, timeout: 10000
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch (err) { /* a plain-text answer is fine */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', function () { req.destroy(new Error('timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Firestore's typed-value encoding, for the seed documents. */
function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(value) } };
}

/** The `fields` half of a Firestore REST document. */
function encodeFields(object) {
  const fields = {};
  Object.keys(object).forEach(function (key) { fields[key] = encodeValue(object[key]); });
  return fields;
}

/** Turn a REST document's `fields` back into plain JavaScript. */
function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return ((value.arrayValue || {}).values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields((value.mapValue || {}).fields);
  return null;
}

/** Decode a whole document body. */
function decodeFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach(function (key) { out[key] = decodeValue(fields[key]); });
  return out;
}

/**
 * Read one document straight out of Firestore.
 * @param {string} path collection/doc, e.g. 'users/abc'
 * @returns {Promise<Object|null>} the document, or null when it is not there
 */
async function readDoc(path) {
  const answer = await emulator(FIRESTORE, 'GET', DOCS + '/' + path);
  if (answer.status !== 200 || !answer.body || !answer.body.fields) return null;
  return decodeFields(answer.body.fields);
}

/**
 * Wait for a document to satisfy a condition. The app's writes are
 * asynchronous — and its "Saved" wording is on screen before the round trip
 * finishes — so the emulator, not the DOM, is what a check waits on.
 * @param {string} path collection/doc
 * @param {function(Object):boolean} [predicate] what to wait for; existence by
 *   default
 * @param {number} [ms=15000] how long to keep looking
 * @returns {Promise<Object|null>} the document, or the last read on timeout
 */
async function awaitDoc(path, predicate, ms) {
  const wanted = predicate || function () { return true; };
  const deadline = Date.now() + (ms || 15000);
  let last = null;
  for (;;) {
    last = await readDoc(path);
    if (last && wanted(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise(function (resolve) { setTimeout(resolve, 200); });
  }
}

/**
 * Take the console errors a check has already reported out of the session's
 * list. Matched on the failing resource and the status code, both of which the
 * harness records, so this can never swallow an error it was not aimed at.
 * @param {string[]} errors the session's collected errors, edited in place
 * @param {string} resource a substring of the failing request's URL
 * @param {number} status the HTTP status in the message
 * @returns {string[]} the lines that were removed
 */
function drain(errors, resource, status) {
  const removed = [];
  for (let i = errors.length - 1; i >= 0; i -= 1) {
    if (errors[i].indexOf(resource) !== -1 && errors[i].indexOf('status of ' + status) !== -1) {
      removed.push(errors.splice(i, 1)[0]);
    }
  }
  return removed;
}

/* --------------------------------------------------------------------------
   3. Fixtures
   -------------------------------------------------------------------------- */

// Names no bundled seed profile has, so a card carrying one can only have come
// from Firestore. public/js/seed-data.js is still loaded by every page — the
// deck rendering one of these is the difference between the two sources.
const CANDIDATES = [
  { uid: 'e2e-firestore-fern', name: 'Fern of the Emulator', age: 30, gender: 'woman' },
  { uid: 'e2e-firestore-remy', name: 'Remy of the Emulator', age: 34, gender: 'man' }
];

/**
 * The public projection the deck reads. Same shape as
 * rules-tests/harness.js's discoveryDoc, which is what firestore.rules
 * validates against.
 * @param {Object} who an entry from CANDIDATES
 * @returns {Object} a discovery document
 */
function discoveryDoc(who) {
  return {
    uid: who.uid,
    displayName: who.name,
    profileComplete: true,
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    profile: {
      age: who.age,
      gender: who.gender,
      pronouns: '',
      bio: 'Seeded straight into the Firestore emulator, never into the bundle.',
      photos: [],
      interests: ['hiking', 'coffee'],
      personality: { openness: 70, conscientiousness: 60, extraversion: 50, agreeableness: 65, stability: 55 },
      location: null,
      showAge: true,
      showDistance: true
    },
    preferences: { interestedIn: ['woman', 'man', 'nonbinary', 'other'], ageMin: 18, ageMax: 100, maxDistanceKm: 500, discoverable: true }
  };
}

/** The private document behind a projection, so the seed is a whole account. */
function userDoc(who) {
  const projection = discoveryDoc(who);
  return {
    uid: who.uid,
    email: who.uid + '@example.com',
    displayName: who.name,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastActiveAt: '2026-08-01T00:00:00.000Z',
    profileComplete: true,
    plan: 'free',
    planSince: null,
    profile: Object.assign({ birthdate: '1996-01-01' }, projection.profile),
    preferences: Object.assign({ notifications: true, theme: 'system' }, projection.preferences),
    learning: { interestAffinity: {}, likeCount: 0, passCount: 0 },
    usage: { date: '2026-08-01', likes: 0, superLikes: 0, rewinds: 0 },
    blocked: []
  };
}

/* --------------------------------------------------------------------------
   4. The spec
   -------------------------------------------------------------------------- */

module.exports = {
  title: 'Firebase mode against the emulators',
  // One viewport: this spec is about what reaches Firestore, not about layout,
  // and every run of it signs a fresh account up.
  viewports: ['mobile'],

  // Not the default "real visitor with no Firebase SDK" context: the real SDK
  // has to load, and it has to be pointed at the emulators through the page's
  // own origin. See harness.openSession.
  session: {
    firebase: {
      config: {
        // The emulators accept any key; what matters is that this does not
        // look like the placeholder, so firebase-config.js takes the real path.
        apiKey: 'emulator-api-key',
        authDomain: '127.0.0.1',
        projectId: PROJECT,
        storageBucket: PROJECT + '.appspot.com',
        messagingSenderId: '000000000000',
        appId: '1:000000000000:web:emulator'
      }
    }
  },

  /**
   * Both emulators have to be listening. Nothing here is worth faking: a
   * skipped spec that says so is honest, a green one that never connected is
   * not.
   * @returns {Promise<{ok:boolean, why:string}>}
   */
  async available() {
    const where = 'firestore ' + FIRESTORE.host + ':' + FIRESTORE.port +
      ', auth ' + AUTH.host + ':' + AUTH.port;
    try {
      await emulator(FIRESTORE, 'GET', '/');
    } catch (err) {
      return { ok: false, why: 'no Firestore emulator (' + where + '): ' + err.message };
    }
    try {
      await emulator(AUTH, 'GET', '/');
    } catch (err) {
      return { ok: false, why: 'no Auth emulator (' + where + '): ' + err.message };
    }
    return { ok: true, why: '' };
  },

  async run(t, page, ctx) {
    const h = ctx.harness;

    /* ---- a server that is also the emulators' front door ---- */
    // These are the paths the compat SDK asks for: Firestore's WebChannel
    // streams live under /google.firestore.…, its unary RPCs under /v1/, and
    // Auth addresses the emulator by the API host it would have called.
    const server = await h.startServer(undefined, {
      proxy: {
        '/v1/': FIRESTORE.port,
        '/google.firestore.': FIRESTORE.port,
        '/identitytoolkit.googleapis.com/': AUTH.port,
        '/securetoken.googleapis.com/': AUTH.port,
        '/www.googleapis.com/': AUTH.port
      }
    });
    const base = server.origin;

    try {
      /* ---- a clean project, then the seed ---- */
      await emulator(FIRESTORE, 'DELETE', '/emulator/v1/projects/' + PROJECT + '/databases/(default)/documents');
      await emulator(AUTH, 'DELETE', '/emulator/v1/projects/' + PROJECT + '/accounts');
      for (const who of CANDIDATES) {
        await emulator(FIRESTORE, 'PATCH', DOCS + '/discovery/' + who.uid, { fields: encodeFields(discoveryDoc(who)) });
        await emulator(FIRESTORE, 'PATCH', DOCS + '/users/' + who.uid, { fields: encodeFields(userDoc(who)) });
      }

      // Guard against the worst false green available here: an emulator with
      // no ruleset loaded allows everything, and every check below would pass
      // while proving nothing about firestore.rules. An anonymous write must
      // be refused.
      const anonymous = await new Promise(function (resolve, reject) {
        const payload = Buffer.from(JSON.stringify({ fields: { uid: { stringValue: 'nobody' } } }));
        const req = http.request({
          host: FIRESTORE.host, port: FIRESTORE.port, method: 'PATCH',
          path: DOCS + '/users/nobody',
          headers: { 'content-type': 'application/json', 'content-length': payload.length }
        }, function (res) { res.resume(); resolve(res.statusCode); });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      if (!t.check('the emulator is enforcing the shipped firestore.rules', anonymous === 403, 'anonymous write -> ' + anonymous)) return;

      /* ---- sign-up ---- */
      const email = 'e2e-' + Date.now() + '@example.com';
      const password = 'a-long-enough-passphrase';
      const displayName = 'Bea Browser';

      await page.goto(base + '/auth.html?mode=signup', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-form');

      // Everything downstream is meaningless if the app quietly fell into demo
      // mode, so prove the real SDK loaded and firebase-config.js chose it.
      const mode = await page.evaluate(function () {
        return {
          sdk: typeof window.firebase,
          mode: window.ZC && window.ZC.config && window.ZC.config.mode,
          project: window.ZC && window.ZC.config && window.ZC.config.firebase && window.ZC.config.firebase.projectId
        };
      });
      if (!t.check('the page runs in firebase mode with the real SDK loaded',
        mode.sdk === 'object' && mode.mode === 'firebase' && mode.project === PROJECT,
        JSON.stringify(mode) + (mode.sdk === 'object' ? '' : ' — no CDN here? set E2E_FIREBASE_SDK'))) return;

      await page.fill('#input-name', displayName);
      await page.fill('#input-email', email);
      await page.fill('#input-password', password);
      await page.click('#submit-btn');
      await page.waitForURL('**/profile.html*');

      // accounts:query is the Auth emulator's admin listing; the /emulator/…
      // path answers DELETE only.
      const accounts = await emulator(AUTH, 'POST', '/identitytoolkit.googleapis.com/v1/projects/' + PROJECT + '/accounts:query', {});
      const mine = ((accounts.body && accounts.body.userInfo) || []).filter(function (account) {
        return account.email === email;
      });
      if (!t.check('signing up creates a Firebase Auth account', mine.length === 1, 'accounts with that email: ' + mine.length)) return;
      const uid = mine[0].localId;

      const created = await awaitDoc('users/' + uid);
      t.check('signing up creates users/{uid} in Firestore',
        !!created && created.uid === uid && created.email === email,
        created ? 'email=' + created.email + ' displayName=' + created.displayName : 'no document');

      /* ---- the profile save, and its public projection ---- */
      await page.waitForSelector('#profile-main:not(.hidden)');
      const bio = 'Written in a browser at ' + new Date().toISOString() + '.';
      await page.fill('#input-name', displayName);
      await page.fill('#input-birthdate', '1995-02-19');
      await page.selectOption('#input-gender', 'woman');
      await page.fill('#input-bio', bio);
      // The checkbox inside a chip is visually hidden, so click the chip.
      await page.locator('#interest-groups label.chip').nth(0).click();
      await page.locator('#interest-groups label.chip').nth(1).click();
      const chosen = await page.$$eval('#interest-groups input:checked', function (inputs) {
        return inputs.map(function (input) { return input.value; });
      });
      await page.click('#save-btn');

      const savedUser = await awaitDoc('users/' + uid, function (doc) {
        return doc.profileComplete === true;
      });
      t.check('the profile save reaches users/{uid}',
        !!savedUser && savedUser.profile && savedUser.profile.bio === bio && savedUser.profileComplete === true,
        savedUser ? 'complete=' + savedUser.profileComplete + ' bio=' + (savedUser.profile || {}).bio : 'no document');

      const projection = await awaitDoc('discovery/' + uid, function (doc) {
        return doc.profile && doc.profile.bio === bio;
      });
      t.check('the profile save mirrors to discovery/{uid}',
        !!projection && projection.displayName === displayName && projection.profile.bio === bio,
        projection ? 'displayName=' + projection.displayName : 'no document');
      t.check('the projection carries the interests but not the birthdate',
        !!projection && String(projection.profile.interests) === String(chosen) &&
        !('birthdate' in projection.profile),
        projection ? 'interests=' + projection.profile.interests : 'no document');

      /* ---- the deck, reading Firestore ---- */
      await page.goto(base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#deck-stack .swipe-card');
      const top = await h.topCardName(page);
      const seeded = CANDIDATES.filter(function (who) { return top && top.indexOf(who.name) !== -1; });
      if (!t.check('the deck renders a candidate that came from Firestore, not the bundle',
        seeded.length === 1, 'top card: ' + top)) return;

      /* ---- a like, as a swipes/{from_to} document ---- */
      await h.pressDeckKey(page, 'ArrowRight', top);
      const swipe = await awaitDoc('swipes/' + uid + '_' + seeded[0].uid);
      t.check('liking the top card writes swipes/{from_to}',
        !!swipe && swipe.from === uid && swipe.to === seeded[0].uid && swipe.action === 'like',
        swipe ? swipe.from + ' -> ' + swipe.to + ' (' + swipe.action + ')' : 'no document');

      /* ---- out, and back in ---- */
      await page.goto(base + '/settings.html', { waitUntil: 'domcontentloaded' });
      await page.click('[data-signout]');
      await page.waitForURL('**/index.html');
      const signedOut = await page.evaluate(function () {
        return window.ZC && window.ZC.auth ? !window.ZC.auth.current : null;
      });
      t.check('signing out ends the Firebase session', signedOut === true, 'current=' + (signedOut ? 'null' : 'set'));

      await page.goto(base + '/auth.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-form');
      await page.fill('#input-email', email);
      await page.fill('#input-password', password);
      await page.click('#submit-btn');
      await page.waitForURL(function (url) { return !/auth\.html/.test(url.href); });
      await page.waitForSelector('#deck-stack .swipe-card');
      const back = await page.evaluate(function () {
        return window.ZC && window.ZC.auth && window.ZC.auth.current ? window.ZC.auth.current.uid : null;
      });
      t.check('signing in again restores the same account', back === uid, 'uid=' + back);

      // And the deck it comes back to is still Firestore's: the account it
      // signed back into has one swipe on record, so the candidate it already
      // liked must not be offered again.
      const again = await h.topCardName(page);
      t.check('the swiped candidate does not come back after signing in again',
        !!again && again.indexOf(seeded[0].name) === -1, 'top card: ' + again);

      /* ---- the finding ---- */

      // Run last, because it deliberately leaves the account's document
      // missing.
      //
      // updateUser's transaction is written to cope with a users document that
      // is not there — `snap.exists ? snap.data() : { uid: uid }` — and then
      // normalizeUser fills the gaps, including `lastActiveAt: null`.
      // firestore.rules L133 accepts that key only as a string, so the write
      // is refused and the branch can never do what it was written to do.
      // Flipping that one field to a string is the whole difference between
      // 403 and 200, replayed by hand against the same ruleset.
      //
      // This is not a hypothetical. It is what makes signing up log a 403
      // roughly every other run: auth.js adopts a new account twice — once
      // from onAuthStateChanged, once from the sign-up call — and the second
      // adopt sees the first one's document in the SDK's local cache, so it
      // takes loadOrCreateDoc's *update* branch. A transaction reads the
      // server, where the create is still in flight, so it lands in exactly
      // the branch below, is denied, and auth.js falls back to an in-memory
      // copy — losing the display name until the next page load. Deleting the
      // document first is the same state, on purpose, every time.
      // Whether the race bit this run is worth saying, and taking those lines
      // out first keeps the detail below about the probe alone.
      const raced = drain(ctx.session.errors, 'documents:commit', 403);

      await emulator(FIRESTORE, 'DELETE', DOCS + '/users/' + uid);
      const recreate = await page.evaluate(function (id) {
        return window.ZC.store.updateUser(id, { displayName: 'Recreated by updateUser' })
          .then(function () { return { ok: true, message: '' }; }, function (err) {
            return { ok: false, message: String((err && (err.code || err.message)) || err) };
          });
      }, uid);
      t.check('updateUser can create the user document it was asked to update',
        recreate.ok === true,
        recreate.message + ' · sign-up hit the same denial ' + raced.length + ' time(s) this run');

      // Both shapes of console error left in this session are reported by
      // checks above; leaving them in would have the runner's closing check
      // report the same findings a second time, and the sign-up race would
      // make it do so at random. Everything else still reaches that check.
      drain(ctx.session.errors, 'documents:commit', 403);
      // FAILED_PRECONDITION on a commit is Firestore telling the SDK that the
      // document moved under a transaction; it re-reads and replays, which is
      // the behaviour store-tests/ exists to prove and which every check above
      // depends on having worked. It is still a console error in a browser —
      // worth knowing that a page talking to Firestore cannot promise a
      // spotless console under contention.
      drain(ctx.session.errors, 'documents:commit', 400);
    } finally {
      await server.stop();
    }
  }
};
