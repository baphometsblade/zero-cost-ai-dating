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

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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

/**
 * Record every shape the shared header takes while a page loads, as an init
 * script: it runs before any page script, so it sees the header app.js mounts
 * first and every one that replaces it. A shape is whether the header offers
 * the guest's "Sign in", whether it carries the signed-in links, and whether
 * the tab bar is on the page. The observer reads the header after every
 * batch of changes, and a batch always ends before the next frame is drawn,
 * so every header that is painted is recorded, and some that never are:
 * stricter than what a person could see, never looser.
 * @returns {void}
 */
function recordHeaders() {
  window.__zcHeaders = [];
  let last = '';
  new MutationObserver(function () {
    const nav = document.querySelector('[data-zc-nav]');
    if (!nav) return;
    const shape = [
      nav.querySelector('a[href$="auth.html"]') ? 'sign-in' : '',
      nav.querySelector('.nav-links') ? 'links' : '',
      document.querySelector('[data-zc-tabbar]') ? 'tab bar' : ''
    ].filter(Boolean).join(' + ') || 'brand only';
    if (shape === last) return;
    last = shape;
    window.__zcHeaders.push(shape);
  }).observe(document, { childList: true, subtree: true });
}

/* --------------------------------------------------------------------------
   3. Fixtures
   -------------------------------------------------------------------------- */

// Names no bundled seed profile has, so a card carrying one can only have come
// from Firestore. public/js/seed-data.js is still loaded by every page — the
// deck rendering one of these is the difference between the two sources.
//
// Three, not two: the run swipes twice — see the rejected-commit check — and
// one has to be left on the deck for the sign-back-in check at the end.
const CANDIDATES = [
  { uid: 'e2e-firestore-fern', name: 'Fern of the Emulator', age: 30, gender: 'woman' },
  { uid: 'e2e-firestore-remy', name: 'Remy of the Emulator', age: 34, gender: 'man' },
  { uid: 'e2e-firestore-sol', name: 'Sol of the Emulator', age: 28, gender: 'nonbinary' }
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
      await page.waitForURL(h.pageUrl('profile'));

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

      // The name is asserted separately because it is the half that broke.
      // This check used to report `displayName=` and pass anyway: signing up
      // adopted the same uid twice at once, and the adoption that read
      // user.displayName before updateProfile had landed wrote an empty name
      // over the real one. Only the email was asserted, so three runs out of
      // three lost the name and the suite stayed green.
      t.check('and stores the name the person typed, not an empty one',
        !!created && created.displayName === displayName,
        created ? 'displayName=' + JSON.stringify(created.displayName) +
          ', expected ' + JSON.stringify(displayName) : 'no document');

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

      // A second like straight after the first, with no pause. This is not
      // padding: pressDeckKey comes back as soon as the stack re-renders,
      // which is long before persistSwipe has finished writing, so this one
      // lands while the first like's bookkeeping is still in flight — the
      // ordinary way a person swipes, and the shape that makes the
      // rejected-commit check near the end of this spec deterministic. With a
      // single like it caught the defect in one run out of three; with two it
      // caught it in three out of three.
      const alsoTop = await h.topCardName(page);
      const alsoSeeded = CANDIDATES.filter(function (who) { return alsoTop && alsoTop.indexOf(who.name) !== -1; });
      await h.pressDeckKey(page, 'ArrowRight', alsoTop);
      const swipeAgain = alsoSeeded.length === 1
        ? await awaitDoc('swipes/' + uid + '_' + alsoSeeded[0].uid)
        : null;
      t.check('and a second like on its heels is stored just the same',
        !!swipeAgain && swipeAgain.action === 'like',
        swipeAgain ? swipeAgain.from + ' -> ' + swipeAgain.to : 'top card was ' + alsoTop);

      /* ---- out, and back in ---- */
      // Every header this page shows on the way in is recorded, for the check
      // after the auth gate below. The recorder stays for this page's later
      // loads too, and is passive, so it changes nothing it watches.
      await page.addInitScript(recordHeaders);
      // And Firestore is held at the network until the first header is
      // recorded. A restored session is only known once users/{uid} has been
      // read, and app.js mounts the header when the document is parsed, which
      // is usually before that read is back, but not always: a read that wins
      // the race leaves nothing to see, and the check would pass on a page
      // that shows the guest's header every time the read loses it. Held, the
      // read cannot win, so the first mount is always made with the session
      // still unknown. These are the two paths the proxy above sends to
      // Firestore. A held request is let go with fallback(), not continue():
      // unroute() below sends on any request it finds still held by itself,
      // and a continue() that arrives after that throws "Route is already
      // handled!" out of the handler, which stopped the whole run; the
      // continue a fallback ends in is Playwright's own, which expects that.
      const FIRESTORE_CALL = function (url) {
        return url.pathname.indexOf('/v1/') === 0 || url.pathname.indexOf('/google.firestore.') === 0;
      };
      let releaseFirestore = null;
      const firestoreHeld = new Promise(function (resolve) { releaseFirestore = resolve; });
      await page.route(FIRESTORE_CALL, async function (route) { await firestoreHeld; await route.fallback(); });
      try {
        await page.goto(base + '/settings.html', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function () {
          return !!window.__zcHeaders && window.__zcHeaders.length > 0;
        }, null, { timeout: 10000 }).catch(function () {});
      } finally {
        releaseFirestore();
        await page.unroute(FIRESTORE_CALL);
      }

      // `main [data-signout]`, scoped, and the scope is the whole point. There are TWO
      // sign-out controls on this page: the one in the settings card, and the one
      // `app.js` injects into `nav.nav-links` — which CSS hides at phone widths, by
      // design. `page.click` takes the FIRST match in document order, and the nav comes
      // first, so once app.js has rendered the header this selector resolved to a 0x0
      // element and waited the full twenty seconds for it to become clickable.
      //
      // It passed for as long as it did because it was a race the spec usually won: the
      // click landed before the nav existed. This CI run lost it, and adding a wait
      // before the click — the obvious "fix" — made it lose every time, which is how it
      // was caught. Measured, not reasoned about: the failing element reported
      // `display: inline-flex` with a rect of 0x0 and `nav.nav-links` computing to
      // `display: none`.
      //
      // The settings page finishing its own auth gate is asserted first, so a failure
      // here can no longer be confused with `requireAuth` not having settled.
      const settled = await page.waitForFunction(function () {
        const hint = document.getElementById('signout-hint');
        return !!hint && /other devices/.test(hint.textContent);
      }, null, { timeout: 20000 }).then(function () { return true; }, function () { return false; });
      t.check('the settings page finishes its auth gate before anything is clicked',
        settled,
        settled ? 'the sign-out hint is the one firebase mode writes'
          : 'the hint was never rewritten — requireAuth had not settled, or the page ' +
            'redirected out from under the click');

      // Firebase restores a session asynchronously — the persisted credential,
      // then users/{uid} — and app.js mounts the header as soon as the
      // document is parsed, usually before the restore is over and, with
      // Firestore held above, always. It drew the guest's header then: a "Sign
      // in" button and no tab bar on a signed-in visitor's Settings page, for
      // as long as the restore took, and a click on it went to the sign-in
      // page, which sends a signed-in visitor on to the deck. Demo mode never
      // showed it, because its session is known before the header is built.
      // Nothing of the guest's may show until the auth state is known, and
      // the signed-in header has to arrive.
      await page.waitForFunction(function () {
        return !!document.querySelector('[data-zc-tabbar]');
      }, null, { timeout: 10000 }).catch(function () {});
      const shapes = await page.evaluate(function () { return window.__zcHeaders || []; });
      t.check('a signed-in visitor is never shown the guest header while the session is restored',
        shapes.length > 0 &&
          shapes.every(function (shape) { return shape.indexOf('sign-in') === -1; }) &&
          shapes[shapes.length - 1] === 'links + tab bar',
        shapes.join(' → ') || 'no header was ever mounted');

      await page.click('main [data-signout]');
      await page.waitForURL(h.pageUrl('index'));
      const signedOut = await page.evaluate(function () {
        return window.ZC && window.ZC.auth ? !window.ZC.auth.current : null;
      });
      t.check('signing out ends the Firebase session', signedOut === true, 'current=' + (signedOut ? 'null' : 'set'));

      // A reset request answers the same for any address. The Auth emulator
      // runs with email-enumeration protection off, as projects made before
      // Firebase turned it on by default do: an unknown address rejects with
      // auth/user-not-found, which the reset form used to show as the sign-in
      // sentence "That email and password do not match an account" — on a
      // form with no password field, and telling anyone which addresses have
      // no account here. The real one is asked too, so the two can be compared.
      await page.goto(base + '/auth.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#auth-form');
      const resetSays = {};
      for (const address of ['nobody-' + Date.now() + '@example.com', email]) {
        // The emulator answers the unknown address with a 400, which Chromium
        // logs as a failed resource; that is the answer under test, and the
        // window closes again before the real address is asked.
        if (ctx.session) ctx.session.expectConsoleError(address === email ? null : /status of 400/);
        await page.click('#forgot-btn');
        await page.fill('#input-reset-email', address);
        await page.click('#reset-submit');
        await page.waitForFunction(function () {
          const box = document.getElementById('auth-alert');
          return !!box && !box.classList.contains('hidden') && (box.textContent || '').trim().length > 0;
        });
        resetSays[address === email ? 'known' : 'unknown'] =
          (await page.textContent('#auth-alert') || '').replace(/\s+/g, ' ').trim();
        await page.click('#reset-back');
      }
      if (ctx.session) ctx.session.expectConsoleError(null);
      t.check('a password reset answers an unknown address exactly as it answers a real one',
        !!resetSays.known && resetSays.unknown === resetSays.known && !/password/i.test(resetSays.unknown),
        JSON.stringify(resetSays));

      // A sign-in in flight owns the form. The request is held at the network
      // until "Create account" has been clicked, then answered (wrong password,
      // so it fails). The tabs used to stay live: the view switched under the
      // busy button, the failure restored its "Sign in" label onto the Create
      // account view, and pressing that button created an account.
      await page.waitForSelector('#auth-form');
      let release = null;
      const held = new Promise(function (resolve) { release = resolve; });
      const SIGN_IN_CALL = '**/accounts:signInWithPassword*';
      await page.route(SIGN_IN_CALL, async function (route) { await held; await route.continue(); });
      if (ctx.session) ctx.session.expectConsoleError(/status of 400/);
      await page.fill('#input-email', email);
      await page.fill('#input-password', 'not-' + password);
      await page.click('#submit-btn');
      await page.waitForFunction(function () { return document.getElementById('submit-btn').disabled; });
      await page.click('#tab-signup');
      release();
      await page.waitForFunction(function () {
        const box = document.getElementById('auth-alert');
        return !!box && !box.classList.contains('hidden') && (box.textContent || '').trim().length > 0;
      });
      const formAfter = await page.evaluate(function () {
        return {
          signInSelected: document.getElementById('tab-signin').getAttribute('aria-selected'),
          nameShown: !document.getElementById('field-name').classList.contains('hidden'),
          button: (document.getElementById('submit-btn').textContent || '').trim()
        };
      });
      await page.unroute(SIGN_IN_CALL);
      if (ctx.session) ctx.session.expectConsoleError(null);
      t.check('switching tabs during a sign-in changes nothing until it answers',
        formAfter.signInSelected === 'true' && !formAfter.nameShown && formAfter.button === 'Sign in',
        JSON.stringify(formAfter));

      await page.waitForSelector('#auth-form');
      await page.fill('#input-email', email);
      await page.fill('#input-password', password);
      await page.click('#submit-btn');
      await page.waitForURL(function (url) { return !h.pageUrl('auth').test(url.href); });
      await page.waitForSelector('#deck-stack .swipe-card');
      const back = await page.evaluate(function () {
        return window.ZC && window.ZC.auth && window.ZC.auth.current ? window.ZC.auth.current.uid : null;
      });
      t.check('signing in again restores the same account', back === uid, 'uid=' + back);

      // And the deck it comes back to is still Firestore's: the account it
      // signed back into has two swipes on record, so neither candidate it
      // already liked may be offered again.
      const again = await h.topCardName(page);
      const returned = CANDIDATES.filter(function (who) {
        return again && again.indexOf(who.name) !== -1 &&
          (who.uid === seeded[0].uid || (alsoSeeded.length === 1 && who.uid === alsoSeeded[0].uid));
      });
      t.check('neither swiped candidate comes back after signing in again',
        !!again && returned.length === 0, 'top card: ' + again);

      /* ---- a connection that drops and comes back, in an empty conversation ---- */

      // The live thread asks the SDK for snapshots whose metadata changes, so
      // that a message the server has acknowledged stops saying 'Sending…'
      // (see below). The connection changing is such a snapshot too, with no
      // message changed, and it used to be delivered as the same list again:
      // an empty conversation repainted its openers on each drop and each
      // return, and a keyboard user's focus on one fell to the page. The
      // witness is the store's own query (newest first, the live window of
      // 200), so it shares the page's watch target and hears each flip in the
      // same pass; the SDK calls listeners back on `setTimeout(0)` in the
      // order they were added, and one more turn of the queue after the
      // witness has heard a flip is past the page's own callback for it.
      const quiet = CANDIDATES[1];
      const quietId = [uid, quiet.uid].sort().join('_');
      await emulator(FIRESTORE, 'PATCH', DOCS + '/matches/' + quietId, { fields: encodeFields({
        id: quietId, users: [uid, quiet.uid].sort(), createdAt: '2026-08-02T00:00:00.000Z',
        lastMessage: null, lastMessageAt: null, unread: { [uid]: 0, [quiet.uid]: 0 }
      }) });
      await page.goto(base + '/matches.html?m=' + encodeURIComponent(quietId), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#chat-log .icebreaker');
      await page.evaluate(function (id) {
        const log = document.getElementById('chat-log');
        const probe = { opener: log.querySelector('.icebreaker'), changes: 0, flips: [] };
        probe.opener.focus();
        probe.observer = new MutationObserver(function (records) { probe.changes += records.length; });
        probe.observer.observe(log, { childList: true, subtree: true, characterData: true });
        probe.stop = window.ZC.firebase.db.collection('matches').doc(id).collection('messages')
          .orderBy('createdAt', 'desc').limit(200)
          .onSnapshot({ includeMetadataChanges: true }, function (snap) { probe.flips.push(snap.metadata.fromCache); });
        window.__zcConnectionProbe = probe;
      }, quietId);
      const settleOn = async function (fromCache) {
        await page.waitForFunction(function (want) {
          const flips = window.__zcConnectionProbe.flips;
          return flips.length > 0 && flips[flips.length - 1] === want;
        }, fromCache);
        return page.evaluate(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () {
            const probe = window.__zcConnectionProbe;
            const opener = document.querySelector('#chat-log .icebreaker');
            return {
              changes: probe.changes,
              sameOpener: opener === probe.opener,
              focus: document.activeElement === probe.opener ? 'the opener' : (document.activeElement || {}).className || null
            };
          });
        });
      };
      await settleOn(false);
      await page.evaluate(function () { return window.ZC.firebase.db.disableNetwork(); });
      const whileAway = await settleOn(true);
      await page.evaluate(function () { return window.ZC.firebase.db.enableNetwork(); });
      const onReturn = await settleOn(false);
      const probeFlips = await page.evaluate(function () {
        const probe = window.__zcConnectionProbe;
        probe.stop();
        probe.observer.disconnect();
        return probe.flips;
      });
      t.check('a connection that drops and comes back leaves an empty conversation\'s openers, and the focus on one, where they were',
        [whileAway, onReturn].every(function (seen) {
          return seen.changes === 0 && seen.sameOpener && seen.focus === 'the opener';
        }),
        JSON.stringify({ away: whileAway, back: onReturn, witnessFromCache: probeFlips }));

      /* ---- a message sent with no connection ---- */

      // Offline, the SDK holds a write in memory until the server takes it,
      // and its listener shows the message straight away. The chat drew that
      // as sent, the composer was already empty, and with offline persistence
      // off, leaving the page threw the message away: it never reached the
      // server or the other person, and nothing on screen had said so.
      // `disableNetwork()` is the SDK's own offline switch, so the write is
      // held from here until `enableNetwork()` below and no longer.
      const peer = CANDIDATES[CANDIDATES.length - 1];
      const chatId = [uid, peer.uid].sort().join('_');
      await emulator(FIRESTORE, 'PATCH', DOCS + '/matches/' + chatId, { fields: encodeFields({
        id: chatId, users: [uid, peer.uid].sort(), createdAt: '2026-08-02T00:00:00.000Z',
        lastMessage: 'Dinner tonight?', lastMessageAt: '2026-08-02T00:00:01.000Z', unread: { [uid]: 0, [peer.uid]: 0 }
      }) });
      await emulator(FIRESTORE, 'PATCH', DOCS + '/matches/' + chatId + '/messages/m1', { fields: encodeFields({
        id: 'm1', from: peer.uid, text: 'Dinner tonight?', createdAt: '2026-08-02T00:00:01.000Z'
      }) });
      const stored = async function () {
        const answer = await emulator(FIRESTORE, 'GET', DOCS + '/matches/' + chatId + '/messages');
        return ((answer.body && answer.body.documents) || []).map(function (d) { return decodeFields(d.fields).text; });
      };
      const stampOf = function (text) {
        const bubble = Array.prototype.filter.call(document.querySelectorAll('#chat-log .msg'), function (node) {
          const body = node.querySelector('.msg-text');
          return !!body && body.textContent === text;
        })[0];
        const stamp = bubble && bubble.querySelector('.msg-time');
        return stamp ? stamp.textContent : null;
      };
      const thread = base + '/matches.html?m=' + encodeURIComponent(chatId);
      await page.goto(thread, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(function () {
        return /Dinner tonight\?/.test((document.getElementById('chat-log') || {}).textContent || '');
      });

      const LATE = 'Running ten minutes late, see you at eight?';
      await page.evaluate(function () { return window.ZC.firebase.db.disableNetwork(); });
      await page.fill('#chat-input', LATE);
      await page.click('#chat-send');
      const drawn = await page.waitForFunction(stampOf, LATE).then(function (handle) { return handle.jsonValue(); });
      const whileHeld = await stored();
      t.check('a message the server does not have yet is drawn as sending, not as sent',
        /Sending/.test(drawn || '') && whileHeld.indexOf(LATE) === -1,
        JSON.stringify({ stamp: drawn, onServer: whileHeld.indexOf(LATE) !== -1 }));

      await page.evaluate(function () { return window.ZC.firebase.db.enableNetwork(); });
      const sentStamp = await page.waitForFunction(function (text) {
        const bubble = Array.prototype.filter.call(document.querySelectorAll('#chat-log .msg'), function (node) {
          const body = node.querySelector('.msg-text');
          return !!body && body.textContent === text;
        })[0];
        const stamp = bubble && bubble.querySelector('.msg-time');
        return stamp && !/Sending/.test(stamp.textContent) ? stamp.textContent : null;
      }, LATE, { timeout: 15000 }).then(function (handle) { return handle.jsonValue(); }, function () { return null; });
      const afterAck = await stored();
      t.check('and once the server has it, the same bubble is drawn as sent',
        !!sentStamp && afterAck.indexOf(LATE) !== -1,
        JSON.stringify({ stamp: sentStamp, onServer: afterAck.indexOf(LATE) !== -1 }));

      // Leaving. Once the send has finished, a reload must not ask; then a
      // second message is held and leaving must. "Finished" is the button
      // dropping `aria-busy`, not the stamp turning: the send goes on to write
      // the conversation's preview and the other side's unread count after
      // the message itself is stored, and leaving inside that is worth a
      // question too. The session accepts every native dialog (see
      // harness.openSession), so the page goes either way and this only
      // records whether it was asked.
      await page.waitForFunction(function () {
        const send = document.getElementById('chat-send');
        return !!send && !send.hasAttribute('aria-busy');
      });
      const asked = [];
      const recordDialog = function (dialog) { asked.push(dialog.type()); };
      page.on('dialog', recordDialog);
      try {
        await page.goto(thread, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function (text) {
          return ((document.getElementById('chat-log') || {}).textContent || '').indexOf(text) !== -1;
        }, LATE);
        const askedWhenSent = asked.slice();
        const LOST = 'Actually, make it nine.';
        await page.evaluate(function () { return window.ZC.firebase.db.disableNetwork(); });
        await page.fill('#chat-input', LOST);
        await page.click('#chat-send');
        await page.waitForFunction(stampOf, LOST);
        await page.goto(base + '/dashboard.html', { waitUntil: 'domcontentloaded' });
        // A card, not just the stack: the stack is in the page's own markup, so
        // it is there before the account has loaded, and the probe below
        // deletes that account's document and recreates it with no finished
        // profile. A page still loading the account then finds it missing or
        // unfinished and goes to onboarding, and the sign-out checks at the end
        // would start from there instead of from this page.
        await page.waitForSelector('#deck-stack .swipe-card');
        t.check('leaving with a message still sending asks first, and leaving with none pending does not',
          askedWhenSent.length === 0 && asked.length === 1 && asked[0] === 'beforeunload',
          JSON.stringify({ nothingPending: askedWhenSent, oneHeld: asked.slice(askedWhenSent.length) }));
      } finally {
        page.off('dialog', recordDialog);
      }

      /* ---- the finding ---- */

      // Run after everything that reads this account's document, because it
      // deliberately leaves it missing.
      //
      // updateUser's transaction is written to cope with a users document that
      // is not there — `snap.exists ? snap.data() : missingUserBase(uid)`, the
      // uid and the signed-in account's email and name — and then
      // normalizeUser fills the gaps, including `lastActiveAt: null`. When this
      // spec was written, firestore.rules accepted that key only as a string,
      // so the write was refused and the branch could never do what it was
      // written to do: flipping that one field to a string was the whole
      // difference between 403 and 200, replayed by hand against the same
      // ruleset. `userDocOk` accepts null there now, as it does for
      // `planSince`, and rules-tests/specs/01-users.rules.js pins both sides of
      // it — null stored, a number still refused. What this probe adds is the
      // upsert branch itself, through the shipped store, in a browser.
      //
      // It was not a hypothetical. It was what made signing up log a 403
      // roughly every other run: auth.js adopted a new account twice at once —
      // from onAuthStateChanged and from the sign-up call — and the second
      // adopt saw the first one's document in the SDK's local cache, so it
      // took loadOrCreateDoc's *update* branch. A transaction reads the
      // server, where the create was still in flight, so it landed in exactly
      // the branch below, was denied, and auth.js fell back to an in-memory
      // copy — losing the display name until the next page load. Adoption is
      // queued per uid now, so the second adopt sees the first one's write
      // instead. Deleting the document first is the same state, on purpose,
      // every time.
      // Whether the race bit this run is worth saying, and taking those lines
      // out first keeps the detail below about the probe alone.
      // Two writers fighting over users/{uid} show up as 403 (the rules
      // refusing the racing write) or 409 ABORTED (a transaction losing its
      // base version). Read this as a GUARD, not as the proof that adoption is
      // serialised: reverting the serialisation leaves it green on a single
      // cold run, because the two adoptions then interleave in the order that
      // loses the name quietly rather than the order that collides loudly.
      // Eight sign-ups on the unserialised code produced one 409; one sign-up
      // produced none. The check above — the stored name — is the
      // deterministic detector, and it fails 3 runs out of 3. This one catches
      // the loud form if it ever comes back.
      //
      // 400 used to be thrown away here, written off as setLastActive touching
      // users/{uid} on every sign-up and out of scope. Both halves were wrong,
      // so it is asserted now instead of excused. A 400 on documents:commit is
      // FAILED_PRECONDITION — a transaction committing against a version that
      // moved under it — and documents:commit is the only write RPC the SDK
      // sends outside its WebChannel stream, so a plain update() cannot produce
      // one at all. setLastActive is a plain update(), and on four instrumented
      // sign-ups out of four it landed 200 against a document that was already
      // there. What did produce it was the *like*: persistSwipe started
      // bumpUsage's usage transaction and persistLearning's whole-document
      // updateUser transaction on the same users/{uid} in one tick, and
      // whichever committed second lost. The learning save waits for the bump
      // now instead of racing it, and it is a field write rather than a second
      // transaction, so nothing of this page's own is ever in flight against
      // users/{uid} while the counter commits. A 400 here again means
      // something has started racing itself once more.
      const raced = drain(ctx.session.errors, 'documents:commit', 403)
        .concat(drain(ctx.session.errors, 'documents:commit', 409));
      const stale = drain(ctx.session.errors, 'documents:commit', 400);
      t.check('signing up does not race its own account document',
        raced.length === 0,
        raced.length ? raced.length + ' rejected commit(s): ' + raced[0] : 'no rejected commits');
      t.check('and nothing up to here lost a transaction to a write of its own',
        stale.length === 0,
        stale.length ? stale.length + ' stale commit(s): ' + stale[0] : 'no rejected commits');

      // Settings deletes an account's data before its sign-in, and says so when
      // only the first half lands, so a profile editor left open in another tab
      // can still save into a users/{uid} that is gone, and updateUser builds it
      // again from the patch. The editor sent only the fields that differed
      // from what it had loaded, but profileComplete: true every time, so the
      // document came back complete with no birthdate and no age, discovery
      // published it with age null, and requireProfile, which reads nothing
      // but that flag, would let it into the deck: a profile this editor's own
      // validate() refuses. Here the document is removed behind the editor,
      // which is that state without the rest of the deletion. Before the probe
      // below, which needs the document gone again.
      await page.goto(base + '/profile.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#profile-main:not(.hidden)');
      const birthdateShown = await page.inputValue('#input-birthdate');
      await emulator(FIRESTORE, 'DELETE', DOCS + '/users/' + uid);
      const orphanBio = 'Saved from an editor opened before its document went.';
      await page.fill('#input-bio', orphanBio);
      await page.click('#save-btn');
      // Bounded, so a save that never lands is reported by the check below.
      await page.waitForFunction(function () {
        return !document.getElementById('save-btn').hasAttribute('aria-busy') &&
          /^Saved/.test(document.getElementById('save-status').textContent.trim());
      }, null, { timeout: 15000 }).catch(function () {});
      const reborn = await awaitDoc('users/' + uid, function (doc) {
        return !!doc.profile && doc.profile.bio === orphanBio;
      });
      const rebornPublic = await awaitDoc('discovery/' + uid, function (doc) {
        return !!doc.profile && doc.profile.bio === orphanBio;
      });
      const claimed = function (doc) {
        return !doc ? null : { complete: doc.profileComplete, birthdate: (doc.profile || {}).birthdate, age: (doc.profile || {}).age };
      };
      t.check('a profile save into a users/{uid} removed behind the editor claims a complete profile only with its birthdate',
        birthdateShown !== '' && !!reborn && reborn.profile.bio === orphanBio && !!rebornPublic &&
          (reborn.profileComplete !== true ||
            (reborn.profile.birthdate === birthdateShown && typeof reborn.profile.age === 'number' && reborn.profile.age >= 18)) &&
          (rebornPublic.profileComplete !== true || rebornPublic.profile.age === reborn.profile.age),
        JSON.stringify({ users: claimed(reborn), discovery: claimed(rebornPublic), shown: birthdateShown }));

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

      // Nothing is drained after the probe. A drain of every 403 on
      // documents:commit used to sit here, from when the rules refused this
      // write, so that the probe's 403 would not be reported a second time by
      // the runner's closing check. The rules accept the probe now, and that
      // drain was measured removing nothing; the only 403 it could still have
      // taken out was one from something else, which is what the closing check
      // is for. If the probe is ever refused again, the check above and the
      // closing check both say so — measured, with the rule put back to strings
      // only. So everything logged after the probe reaches the closing check, a
      // 400 included. The drains above take out only commits refused before it —
      // 403, 409 and 400 — and their own checks require there to be none: nothing
      // in this spec may lose a transaction to a write the same page made.

      /* ---- a saved config Firebase refuses still has a way back ---- */

      // Settings checks that a pasted config has its four keys and no
      // placeholder in it, and can check no more: an apiKey with one character
      // wrong looks like any other. Saved, it reloads the app in firebase mode,
      // where every sign-in and sign-up is refused. "Reset to demo mode" lived
      // only on settings.html, which sends anyone signed out to the sign-in
      // page, and the sign-in page said "Something went wrong" and offered no
      // way back: the browser was stuck until its site data was cleared by hand.
      //
      // A session of its own, because the main one is wired to the emulators on
      // every load and the reset has to be seen to stick. It runs the real SDK,
      // and the answer Google gives a key that is not valid is served for its
      // API hosts, so nothing leaves the machine. The service worker is kept
      // out, so it cannot answer any of these requests itself.
      const refused = await h.openSession(ctx.session.context.browser(), ctx.viewport, { serviceWorkers: 'block' });
      try {
        const rp = refused.page;
        // openSession aborts the CDN for a demo session. A route added later
        // answers first, and this one serves the SDK the main session loads.
        await refused.context.route('**://www.gstatic.com/**', function (route) {
          const mirror = process.env.E2E_FIREBASE_SDK || '';
          const file = mirror ? path.join(mirror, path.basename(new URL(route.request().url()).pathname)) : '';
          if (!file || !fs.existsSync(file)) return route.continue();
          return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(file) });
        });
        const keyNotValid = 'API key not valid. Please pass a valid API key.';
        await refused.context.route(/^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//, function (route) {
          return route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: {
              code: 400, message: keyNotValid, status: 'INVALID_ARGUMENT',
              errors: [{ message: keyNotValid, domain: 'global', reason: 'badRequest' }]
            } })
          });
        });

        // The way a person gets there: the demo account, Settings, a config
        // with one wrong character in its key, Save and reload.
        await h.signIn(rp, base);
        await rp.goto(base + '/settings.html', { waitUntil: 'domcontentloaded' });
        await rp.waitForSelector('#firebase-config');
        await rp.fill('#firebase-config', JSON.stringify({
          apiKey: 'AIzaSyB-typo-in-this-key-0000000000000',
          authDomain: 'e2e-typo.firebaseapp.com',
          projectId: 'e2e-typo',
          appId: '1:123456789012:web:abcdef0123456789'
        }));
        await rp.click('#save-firebase');
        await rp.waitForURL(h.pageUrl('auth'));
        await rp.waitForSelector('#auth-form');
        const stuckMode = await rp.evaluate(function () { return window.ZC.config.mode; });

        await rp.fill('#input-email', 'locked-out@example.com');
        await rp.fill('#input-password', 'a-long-enough-passphrase');
        await rp.click('#submit-btn');
        await rp.waitForFunction(function () {
          return !document.getElementById('auth-alert').classList.contains('hidden');
        });
        const said = (await rp.textContent('#auth-alert')).trim();
        t.check('a saved config Firebase refuses is named as the problem, not "Something went wrong"',
          stuckMode === 'firebase' && /config/i.test(said) && !/something went wrong/i.test(said),
          'mode ' + stuckMode + ', said ' + JSON.stringify(said));

        // The way back, from the page every signed-out visit ends on. The demo
        // session is still in this browser, so demo mode signs straight back
        // into it and the page goes on to the Settings page it was asked for.
        const offered = await rp.locator('#config-reset:visible').count();
        let back = { url: rp.url(), mode: stuckMode, stored: 'not reset' };
        if (offered) {
          await rp.click('#config-reset');
          await h.clickModalAction(rp, 'Reset and reload');
          // Bounded, and its answer is part of the check below rather than a
          // throw: a reset that never reaches Settings reports where it stopped.
          await rp.waitForURL(h.pageUrl('settings'), { timeout: 10000 }).then(null, function () { /* reported below */ });
          back = await rp.evaluate(function () {
            return {
              url: window.location.href,
              mode: window.ZC.config.mode,
              stored: window.localStorage.getItem('zc.firebaseConfig')
            };
          });
        }
        t.check('and the sign-in page it lands on resets it, back into the demo account it left',
          offered === 1 && back.mode === 'demo' && back.stored === null && h.pageUrl('settings').test(back.url),
          (offered ? '' : 'no reset on the sign-in page; ') + JSON.stringify(back));

        // Google's refusals are what this provoked, and the browser logs each
        // one as a failed resource. Anything else is a defect.
        const refusals = drain(refused.errors, 'googleapis.com', 400);
        t.check('and the whole round trip logs nothing else', refused.errors.length === 0,
          refusals.length + ' refusal(s) set aside; ' + (refused.errors.slice(0, 3).join(' | ') || 'nothing else'));
      } finally {
        await refused.context.close();
      }

      // A sign-out that fails leaves the page where it is, and must not leave
      // it deaf to the next change: a page marks its own sign-out so that the
      // session ending is not mistaken for another tab's doing, and that mark
      // used to outlive a failure. A sign-out in another tab afterwards then
      // changed nothing here, and the page stayed up as the account that had
      // left. Run after everything this account does, because it ends the
      // session.
      const failed = await page.evaluate(function () {
        const fb = window.ZC.firebase.auth;
        const real = fb.signOut;
        fb.signOut = function () {
          fb.signOut = real;
          const err = new Error('Sign-out held by the e2e suite.');
          err.code = 'auth/network-request-failed';
          return Promise.reject(err);
        };
        return window.ZC.auth.signOut();
      });
      const elsewhere = await ctx.session.context.newPage();
      await elsewhere.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
      await elsewhere.waitForFunction(function () { return !!(window.ZC && window.ZC.auth && window.ZC.auth.current); });
      await elsewhere.evaluate(function () { return window.ZC.auth.signOut(); });
      await page.waitForURL(h.pageUrl('auth'), { timeout: 10000 }).catch(function () {});
      const movedTo = page.url();
      await elsewhere.close();
      t.check('after a sign-out that failed, a sign-out in another tab still moves the page on',
        failed && failed.ok === false && movedTo.indexOf(base + '/') === 0 &&
          h.pageUrl('auth').test(movedTo) && /[?&]next=/.test(movedTo),
        JSON.stringify(failed) + ' · ' + movedTo);

      /* ---- two accounts whose identity the app did not choose ---- */

      // Both are made in the Auth emulator directly, the way a provider makes
      // one, and then signed into through the form like any other account.
      // The first carries the name Google would hand over for somebody called
      // this: seventy characters, where firestore.rules allow a users/{uid}
      // sixty. Its create was refused on every page load, so it never got a
      // document, and onboarding ended at "We could not find your profile
      // document" however many times it signed out and back in.
      const longName = 'Maria Fernanda de los Angeles Garcia-Rodriguez Montenegro y Bustamante';
      const longEmail = 'e2e-long-' + Date.now() + '@example.com';
      const longMade = await emulator(AUTH, 'POST', '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key',
        { email: longEmail, password: password, displayName: longName, returnSecureToken: true });
      const longUid = longMade.body && longMade.body.localId;
      await signInThroughForm(longEmail);
      await page.waitForURL(h.pageUrl('profile'));
      await page.waitForSelector('#profile-main:not(.hidden), #profile-error:not(.hidden)');
      const longPage = await page.evaluate(function () {
        const error = document.getElementById('profile-error');
        return {
          editor: !document.getElementById('profile-main').classList.contains('hidden'),
          error: error.classList.contains('hidden') ? '' : (error.textContent || '').trim()
        };
      });
      const longDoc = await awaitDoc('users/' + longUid);
      t.check('an account whose provider name is longer than the rules allow still gets users/{uid}',
        !!longUid && !!longDoc && longDoc.email === longEmail && longDoc.displayName === longName.slice(0, 40),
        longDoc ? 'displayName=' + JSON.stringify(longDoc.displayName) : 'no document for ' + longUid);
      t.check('and onboarding opens the editor for it, not a dead end',
        longPage.editor && !longPage.error, JSON.stringify(longPage));
      await page.evaluate(function () { return window.ZC.auth.signOut(); });

      // The second has a finished profile whose stored email is not its
      // account's: what updateUser's upsert used to leave behind (email ''),
      // and what an address changed outside the app leaves. auth.js corrects
      // it on every page load; the rules refused every correction, and the
      // refusal swapped the stored profile for a blank one, so every page
      // sent this finished account back through onboarding.
      const staleEmail = 'e2e-stale-' + Date.now() + '@example.com';
      const staleMade = await emulator(AUTH, 'POST', '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key',
        { email: staleEmail, password: password, returnSecureToken: true });
      const staleUid = staleMade.body && staleMade.body.localId;
      const staleSeed = Object.assign(userDoc({ uid: staleUid, name: 'Stale Address', age: 31, gender: 'woman' }), { email: '' });
      await emulator(FIRESTORE, 'PATCH', DOCS + '/users/' + staleUid, { fields: encodeFields(staleSeed) });
      await signInThroughForm(staleEmail);
      // The deck renders only once requireProfile has passed, and the profile
      // editor only once it has not, so whichever appears first is the answer.
      await page.waitForSelector('#deck-stack .swipe-card, #profile-main:not(.hidden), #profile-error:not(.hidden)');
      const staleAt = page.url();
      const staleDoc = await awaitDoc('users/' + staleUid, function (doc) { return doc.email === staleEmail; });
      t.check('a finished account stored with the wrong email reaches the deck, not onboarding',
        h.pageUrl('dashboard').test(staleAt), staleAt.replace(base, ''));
      t.check('and the stored email is corrected to the account\'s own',
        !!staleDoc && staleDoc.email === staleEmail && staleDoc.profileComplete === true,
        staleDoc ? 'email=' + JSON.stringify(staleDoc.email) : 'no document');

      /**
       * Sign in through auth.html as an account made in the Auth emulator.
       * @param {string} address its email; the password is the spec's own
       * @returns {Promise<void>}
       */
      async function signInThroughForm(address) {
        await page.goto(base + '/auth.html', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#auth-form');
        await page.fill('#input-email', address);
        await page.fill('#input-password', password);
        await page.click('#submit-btn');
        await page.waitForURL(function (url) { return !h.pageUrl('auth').test(url.href); });
      }
    } finally {
      await server.stop();
    }
  }
};
