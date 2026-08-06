/* ==========================================================================
   Zero Cost AI Dating — authentication
   One surface (ZC.auth) over two interchangeable backends:

     • firebase — Firebase Authentication (email/password + Google popup)
     • demo     — a localStorage account store so the app works with zero
                  setup. See the note above hashPassword(): demo credentials
                  are a convenience, not real security.

   Either way the result is the same: ZC.auth.current holds the account,
   ZC.auth.doc holds the UserDoc from ZC.store, and the require* guards keep
   pages honest about who may see them.

   This file also drives auth.html itself — section 12 only runs on a document
   that carries [data-auth-page], so every other page pays nothing for it.
   Exposes: ZC.auth.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  const ZC = window.ZC;

  // Tolerate a duplicated <script> tag (auth.html loads this file as both the
  // shared library and its page script).
  if (ZC.auth && ZC.auth.ready) {
    return;
  }

  const util = ZC.util || {};
  const ui = ZC.ui || {};

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  /** Demo credentials sit beside the rest of the demo database. */
  const CREDENTIALS_KEY = 'zc.demo.credentials';
  const SESSION_KEY = (ZC.store && ZC.store.KEYS && ZC.store.KEYS.session) || 'zc.demo.session';

  /** The bundled "you" profile that the demo button signs into. */
  const DEMO_UID = 'demo-you';
  const DEMO_EMAIL = 'you@example.com';
  const DEMO_NAME = 'You';

  const PASSWORD_MIN = 8;
  const NAME_MIN = 2;
  const NAME_MAX = 40;

  // Deliberately loose: the only authority on a valid address is the mail server.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;

  // If Firebase never reports an auth state (blocked network, dead SDK) the app
  // must still become usable rather than hang on ZC.auth.ready forever.
  const READY_TIMEOUT_MS = 8000;

  /** Firebase mode needs both a real config and a live auth handle. */
  const MODE = (ZC.config && ZC.config.mode === 'firebase' && ZC.firebase && ZC.firebase.auth)
    ? 'firebase'
    : 'demo';

  /* ------------------------------------------------------------------------
     2. Guarded storage
     ------------------------------------------------------------------------ */

  /**
   * Read and parse a JSON value from localStorage.
   * @param {string} key storage key
   * @param {*} fallback value returned when the key is missing or corrupt
   * @returns {*} the parsed value or the fallback
   */
  function readJson(key, fallback) {
    let raw;
    try {
      raw = window.localStorage.getItem(key);
    } catch (err) {
      return fallback;
    }
    if (raw === null || raw === undefined) return fallback;
    try {
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (err) {
      console.warn('[zc.auth] Ignoring corrupt value at ' + key + '.');
      return fallback;
    }
  }

  /**
   * Write a JSON value to localStorage.
   * @param {string} key storage key
   * @param {*} value anything JSON-serialisable
   * @returns {boolean} true when the write succeeded
   */
  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[zc.auth] Could not write ' + key + ' (storage full or blocked).', err);
      return false;
    }
  }

  /**
   * Delete a key, ignoring storage failures.
   * @param {string} key storage key
   * @returns {void}
   */
  function removeKey(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      // Nothing to do: a session we cannot clear is still cleared in memory.
    }
  }

  /* ------------------------------------------------------------------------
     3. Human error messages
     ------------------------------------------------------------------------ */

  /** Firebase codes never reach the screen; these sentences do. */
  const ERROR_TEXT = {
    'auth/email-already-in-use': 'That email already has an account. Try signing in instead.',
    'auth/invalid-email': 'That email address does not look right.',
    'auth/invalid-credential': 'That email and password do not match an account.',
    'auth/wrong-password': 'That email and password do not match an account.',
    'auth/user-not-found': 'That email and password do not match an account.',
    'auth/weak-password': 'Please pick a password with at least ' + PASSWORD_MIN + ' characters.',
    'auth/too-many-requests': 'Too many attempts from this device. Wait a minute, then try again.',
    'auth/network-request-failed': 'The network did not answer. Check your connection and try again.',
    'auth/user-disabled': 'That account has been disabled.',
    'auth/operation-not-allowed': 'This project has not switched that sign-in method on yet.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
    'auth/popup-closed-by-user': 'The Google window closed before sign-in finished.',
    'auth/cancelled-popup-request': 'Only one Google window at a time. Try again.',
    'auth/unauthorized-domain': 'This address is not on the Firebase project list of authorised domains.',
    'auth/requires-recent-login': 'Please sign in again to finish that.',
    'auth/internal-error': 'Sign-in failed unexpectedly. Please try again.'
  };

  const GENERIC_ERROR = 'Something went wrong. Please try again.';

  /**
   * Turn any thrown value into a sentence a person can act on.
   * @param {*} err an Error, a Firebase error or a string
   * @returns {string} friendly message
   */
  function humanError(err) {
    if (typeof err === 'string' && err) return err;
    if (!err) return GENERIC_ERROR;
    const code = typeof err.code === 'string' ? err.code : '';
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    console.warn('[zc.auth] Unmapped auth failure.', err);
    if (!code && typeof err.message === 'string' && err.message && err.message.indexOf('auth/') === -1) {
      return err.message;
    }
    return GENERIC_ERROR;
  }

  /**
   * Build an error carrying a Firebase-style code so both backends report the
   * same things through humanError().
   * @param {string} code e.g. 'auth/invalid-credential'
   * @param {string} [message] optional developer-facing text
   * @returns {Error}
   */
  function authError(code, message) {
    const err = new Error(message || code);
    err.code = code;
    return err;
  }

  /* ------------------------------------------------------------------------
     4. The demo credential vault

     DEMO ONLY — THIS IS NOT REAL SECURITY.
     Demo accounts never leave the browser. Passwords are stored as
     SHA-256(salt + password) with a fresh 16-byte salt per account, which
     keeps plain text out of localStorage and nothing more: there is no
     server, no rate limiting, no iteration count, and anyone with access to
     the device can read or replace the entire store. Use the Firebase backend
     (Settings → connect your own project) for accounts that matter.
     ------------------------------------------------------------------------ */

  /**
   * Hex-encode bytes.
   * @param {Uint8Array} bytes input
   * @returns {string} lowercase hex
   */
  function toHex(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) {
      out += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return out;
  }

  /**
   * A random per-account salt.
   * @returns {string} 32 hex characters
   */
  function randomSalt() {
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return toHex(bytes);
  }

  /**
   * Hash a demo password. Uses crypto.subtle where it exists and falls back to
   * ZC.util.hashString on non-secure origins (file://, plain http), where
   * crypto.subtle is simply absent.
   * @param {string} salt per-account salt
   * @param {string} password plain-text password
   * @returns {Promise<string>} the stored hash
   */
  async function hashPassword(salt, password) {
    const material = String(salt) + String(password);
    const subtle = window.crypto && window.crypto.subtle;
    if (subtle && typeof window.TextEncoder === 'function') {
      try {
        const digest = await subtle.digest('SHA-256', new window.TextEncoder().encode(material));
        return toHex(new Uint8Array(digest));
      } catch (err) {
        console.warn('[zc.auth] crypto.subtle refused; falling back to a weak hash.', err);
      }
    }
    const weak = typeof util.hashString === 'function' ? util.hashString(material) : material.length;
    return 'weak-' + Number(weak).toString(16);
  }

  /**
   * The credential map, keyed by lowercased email.
   * @returns {Object} { [emailLower]: { uid, salt, hash } }
   */
  function readCredentials() {
    const map = readJson(CREDENTIALS_KEY, {});
    return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  }

  /**
   * Persist the credential map.
   * @param {Object} map credential records
   * @returns {boolean} true when stored
   */
  function writeCredentials(map) {
    return writeJson(CREDENTIALS_KEY, map);
  }

  /**
   * Normalise an email for both lookup and storage.
   * @param {string} email raw input
   * @returns {string} trimmed, lowercased email
   */
  function normalizeEmail(email) {
    return String(email === null || email === undefined ? '' : email).trim().toLowerCase();
  }

  /* ------------------------------------------------------------------------
     5. Shared state
     ------------------------------------------------------------------------ */

  let listeners = [];
  let settled = false;
  let markReady = null;

  /** Resolves with the UserDoc (or null) once the first auth state settles. */
  const ready = new Promise(function (resolve) { markReady = resolve; });

  /**
   * Resolve ZC.auth.ready exactly once.
   * @returns {void}
   */
  function settle() {
    if (settled) return;
    settled = true;
    markReady(api.doc);
  }

  /**
   * Tell every onChange subscriber about the current doc.
   * @returns {void}
   */
  function emit() {
    listeners.slice().forEach(function (cb) {
      try {
        cb(api.doc);
      } catch (err) {
        console.error('[zc.auth] An onChange listener threw.', err);
      }
    });
  }

  /**
   * Publish a signed-in account.
   * @param {{uid:string, email:string, displayName:string}} account identity
   * @param {Object|null} doc the UserDoc
   * @returns {Object|null} the doc, for chaining
   */
  function setSignedIn(account, doc) {
    api.current = {
      uid: account.uid,
      email: account.email || '',
      displayName: account.displayName || (doc && doc.displayName) || ''
    };
    api.doc = doc || null;
    emit();
    return api.doc;
  }

  /**
   * Publish "nobody is signed in".
   * @returns {null}
   */
  function setSignedOut() {
    api.current = null;
    api.doc = null;
    emit();
    return null;
  }

  /* ------------------------------------------------------------------------
     6. User documents
     ------------------------------------------------------------------------ */

  /**
   * An in-memory stand-in used only when the store is unreachable, so a
   * storage failure degrades the app instead of locking everyone out.
   * @param {string} uid account id
   * @param {Object} seed { email, displayName }
   * @returns {Object} a UserDoc-shaped object
   */
  function fallbackDoc(uid, seed) {
    let base = {};
    if (ZC.store && ZC.store.DEFAULT_USER) {
      try {
        base = JSON.parse(JSON.stringify(ZC.store.DEFAULT_USER));
      } catch (err) {
        base = {};
      }
    }
    const stamp = new Date().toISOString();
    base.uid = uid;
    base.email = (seed && seed.email) || '';
    base.displayName = (seed && seed.displayName) || '';
    base.createdAt = stamp;
    base.updatedAt = stamp;
    base.lastActiveAt = stamp;
    return base;
  }

  /**
   * Load the UserDoc for an account, creating it on first sign-in and keeping
   * its identity fields in step with the auth record.
   * @param {string} uid account id
   * @param {Object} [seed] { email, displayName } to write on create
   * @returns {Promise<Object>} the UserDoc
   */
  async function loadOrCreateDoc(uid, seed) {
    const fields = seed || {};
    try {
      const existing = await ZC.store.getUser(uid);
      if (!existing) {
        return await ZC.store.createUser(uid, {
          email: fields.email || '',
          displayName: fields.displayName || ''
        });
      }
      const patch = {};
      if (fields.email && existing.email !== fields.email) patch.email = fields.email;
      if (fields.displayName && !existing.displayName) patch.displayName = fields.displayName;
      if (Object.keys(patch).length) return await ZC.store.updateUser(uid, patch);
      return existing;
    } catch (err) {
      console.warn('[zc.auth] Could not reach the profile store; using an in-memory copy.', err);
      return fallbackDoc(uid, fields);
    }
  }

  /**
   * Adopt an account as the signed-in user: load its doc, publish it and note
   * that the person is around.
   * @param {{uid:string, email?:string, displayName?:string}} account identity
   * @param {Object} [seed] fields to write when the doc is new
   * @returns {Promise<Object>} the UserDoc
   */
  async function adopt(account, seed) {
    const fields = {
      email: (seed && seed.email) || account.email || '',
      displayName: (seed && seed.displayName) || account.displayName || ''
    };
    const doc = await loadOrCreateDoc(account.uid, fields);
    setSignedIn(
      { uid: account.uid, email: fields.email, displayName: fields.displayName || doc.displayName },
      doc
    );
    // Presence is a nice-to-have; never let it fail a sign-in.
    Promise.resolve()
      .then(function () { return ZC.store.touchActive(account.uid); })
      .catch(function (err) { console.warn('[zc.auth] Could not record activity.', err); });
    return doc;
  }

  /* ------------------------------------------------------------------------
     7. Firebase backend
     ------------------------------------------------------------------------ */

  /**
   * The live Firebase Auth handle, or null in demo mode.
   * @returns {Object|null}
   */
  function fbAuth() {
    return (ZC.firebase && ZC.firebase.auth) || null;
  }

  /**
   * Turn a Firebase user into the identity shape the rest of the file uses.
   * @param {Object} user firebase.User
   * @param {Object} [seed] values to prefer over the Firebase record
   * @returns {{uid:string, email:string, displayName:string}}
   */
  function accountFromFirebase(user, seed) {
    return {
      uid: user.uid,
      email: (seed && seed.email) || user.email || '',
      displayName: (seed && seed.displayName) || user.displayName || ''
    };
  }

  /**
   * Create a Firebase account and its user document.
   * @param {string} email account email
   * @param {string} password plain-text password
   * @param {string} displayName public name
   * @returns {Promise<Object>} the UserDoc
   */
  async function firebaseSignUp(email, password, displayName) {
    const credential = await fbAuth().createUserWithEmailAndPassword(email, password);
    const user = credential.user;
    if (displayName && user && typeof user.updateProfile === 'function') {
      try {
        await user.updateProfile({ displayName: displayName });
      } catch (err) {
        // A missing display name on the auth record is cosmetic; the doc has it.
        console.warn('[zc.auth] Could not store the display name on the auth record.', err);
      }
    }
    return adopt(accountFromFirebase(user, { email: email, displayName: displayName }));
  }

  /**
   * Sign in with Firebase email/password.
   * @param {string} email account email
   * @param {string} password plain-text password
   * @returns {Promise<Object>} the UserDoc
   */
  async function firebaseSignIn(email, password) {
    const credential = await fbAuth().signInWithEmailAndPassword(email, password);
    return adopt(accountFromFirebase(credential.user, { email: email }));
  }

  /**
   * Sign in through the Google popup.
   * @returns {Promise<Object>} the UserDoc
   */
  async function firebaseSignInWithGoogle() {
    const sdk = (typeof window.firebase !== 'undefined') ? window.firebase : null;
    if (!sdk || !sdk.auth || typeof sdk.auth.GoogleAuthProvider !== 'function') {
      throw new Error('Google sign-in needs the Firebase auth SDK, which did not load.');
    }
    const provider = new sdk.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await fbAuth().signInWithPopup(provider);
    return adopt(accountFromFirebase(credential.user));
  }

  /* ------------------------------------------------------------------------
     8. Demo backend
     ------------------------------------------------------------------------ */

  /**
   * Read the uid out of the stored demo session, which may be a bare string.
   * @param {*} session stored value
   * @returns {string|null}
   */
  function sessionUid(session) {
    if (typeof session === 'string' && session) return session;
    if (session && typeof session === 'object' && typeof session.uid === 'string') return session.uid;
    return null;
  }

  /**
   * Start (or refresh) the demo session record other modules read.
   * @param {{uid:string, email?:string, displayName?:string}} account identity
   * @returns {void}
   */
  function writeDemoSession(account) {
    writeJson(SESSION_KEY, {
      uid: account.uid,
      email: account.email || '',
      displayName: account.displayName || '',
      at: new Date().toISOString()
    });
  }

  /**
   * Mint a demo uid that cannot collide with a bundled seed profile.
   * @returns {string}
   */
  function newDemoUid() {
    const random = typeof util.uid === 'function'
      ? util.uid()
      : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return 'local-' + random;
  }

  /**
   * Create a browser-only account.
   * @param {string} email account email (already normalised)
   * @param {string} password plain-text password
   * @param {string} displayName public name
   * @returns {Promise<Object>} the UserDoc
   */
  async function demoSignUp(email, password, displayName) {
    const credentials = readCredentials();
    if (credentials[email]) throw authError('auth/email-already-in-use');

    const salt = randomSalt();
    const hash = await hashPassword(salt, password);
    const uid = newDemoUid();
    credentials[email] = { uid: uid, salt: salt, hash: hash };
    if (!writeCredentials(credentials)) {
      throw new Error('This browser refused to save the account. Check that storage is not full or blocked.');
    }

    const account = { uid: uid, email: email, displayName: displayName };
    const doc = await adopt(account, { email: email, displayName: displayName });
    writeDemoSession(account);
    return doc;
  }

  /**
   * Sign in to a browser-only account.
   * @param {string} email account email (already normalised)
   * @param {string} password plain-text password
   * @returns {Promise<Object>} the UserDoc
   */
  async function demoSignIn(email, password) {
    const record = readCredentials()[email];
    if (!record || !record.uid) throw authError('auth/invalid-credential');
    const hash = await hashPassword(record.salt, password);
    if (hash !== record.hash) throw authError('auth/invalid-credential');

    const account = { uid: record.uid, email: email, displayName: '' };
    const doc = await adopt(account, { email: email });
    writeDemoSession({ uid: record.uid, email: email, displayName: doc.displayName });
    return doc;
  }

  /**
   * Sign in as the bundled "You" profile — the zero-setup way into the app.
   * @returns {Promise<Object>} the UserDoc
   */
  async function demoSignInAsDemoUser() {
    // The seed is idempotent: this only writes on the very first run.
    try {
      await ZC.store.seedDemo(false);
    } catch (err) {
      console.warn('[zc.auth] Could not seed the demo database.', err);
    }
    let doc = await ZC.store.getUser(DEMO_UID);
    if (!doc) {
      // No bundled profile available — a blank demo account still works.
      doc = await ZC.store.createUser(DEMO_UID, { email: DEMO_EMAIL, displayName: DEMO_NAME });
    }
    const account = { uid: DEMO_UID, email: doc.email || DEMO_EMAIL, displayName: doc.displayName || DEMO_NAME };
    writeDemoSession(account);
    setSignedIn(account, doc);
    Promise.resolve()
      .then(function () { return ZC.store.touchActive(DEMO_UID); })
      .catch(function (err) { console.warn('[zc.auth] Could not record activity.', err); });
    return doc;
  }

  /**
   * Follow a demo session that was created elsewhere (page load, other tab).
   * @param {string} uid account id from the session record
   * @returns {Promise<Object|null>} the UserDoc, or null when it has vanished
   */
  async function adoptDemoSession(uid) {
    let doc = null;
    try {
      doc = await ZC.store.getUser(uid);
    } catch (err) {
      console.warn('[zc.auth] Could not read the session profile.', err);
    }
    if (!doc) {
      // The account was deleted or the database was reset under us.
      removeKey(SESSION_KEY);
      return setSignedOut();
    }
    return adopt({ uid: uid, email: doc.email, displayName: doc.displayName });
  }

  /* ------------------------------------------------------------------------
     9. Navigation helpers used by the guards
     ------------------------------------------------------------------------ */

  /**
   * Read a query parameter from the current URL.
   * @param {string} name parameter name
   * @returns {string|null}
   */
  function readQuery(name) {
    if (typeof util.qs === 'function') return util.qs(name);
    try {
      return new URLSearchParams(window.location.search).get(name);
    } catch (err) {
      return null;
    }
  }

  /**
   * Accept only same-site relative destinations, so a crafted ?next= cannot
   * bounce anyone to another origin.
   * @param {string|null} value candidate path
   * @returns {string|null} the path, or null when it is not safe
   */
  function safePath(value) {
    if (!value) return null;
    const path = String(value).trim();
    // A backslash can be read as a slash by some parsers, so refuse it outright.
    if (!path || path.indexOf('\\') !== -1) return null;
    // Absolute site paths are fine; protocol-relative "//host" is not.
    if (path.charAt(0) === '/') return path.charAt(1) === '/' ? null : path;
    // Bare page names, with or without the .html suffix (hosting uses cleanUrls).
    // Anything carrying a scheme, such as javascript:, fails this test.
    if (/^[a-z0-9][a-z0-9._-]*(\.html)?([?#].*)?$/i.test(path)) return path;
    return null;
  }

  /**
   * Reduce a relative URL to its bare page name, so two spellings of the same
   * page ('/dashboard', 'dashboard.html?x=1') compare equal.
   * @param {string} path relative URL
   * @returns {string} page name without directory, suffix or query
   */
  function pageNameOf(path) {
    return String(path).split(/[?#]/)[0].replace(/^.*\//, '').replace(/\.html$/i, '').toLowerCase();
  }

  /**
   * The destination a signed-in visitor asked for, else a sensible default.
   * A ?next= pointing at the current page is ignored — that is a redirect loop.
   * @param {string} fallback where to go when no ?next= was given
   * @returns {string} a relative URL
   */
  function resolveNext(fallback) {
    const wanted = safePath(readQuery('next'));
    if (!wanted) return fallback;
    return pageNameOf(wanted) === pageNameOf(window.location.pathname) ? fallback : wanted;
  }

  /**
   * Append the current location as ?next= so a guard can send people back.
   * @param {string} target the page to send them to
   * @returns {string} target with the next parameter
   */
  function withNext(target) {
    let query = '';
    try {
      // Drop any next= we were handed so redirects cannot nest inside each other.
      const params = new URLSearchParams(window.location.search);
      params.delete('next');
      query = params.toString();
    } catch (err) {
      query = '';
    }
    const here = window.location.pathname + (query ? '?' + query : '');
    const separator = target.indexOf('?') === -1 ? '?' : '&';
    return target + separator + 'next=' + encodeURIComponent(here);
  }

  /**
   * Leave the page. Uses replace() so guards never build up history entries.
   * @param {string} url relative destination
   * @returns {void}
   */
  function leaveTo(url) {
    window.location.replace(url);
  }

  /**
   * A promise that never settles — returned by guards that are navigating
   * away, so callers simply stop instead of rendering a page they may not see.
   * @returns {Promise<never>}
   */
  function pending() {
    return new Promise(function () { /* the page is leaving */ });
  }

  /* ------------------------------------------------------------------------
     10. The public surface
     ------------------------------------------------------------------------ */

  const api = {
    /** 'firebase' or 'demo' — which backend is live. */
    mode: MODE,

    /** Resolves with the UserDoc (or null) once the first auth state settles. */
    ready: ready,

    /** { uid, email, displayName } while signed in, else null. */
    current: null,

    /** The cached UserDoc for the signed-in account, else null. */
    doc: null,

    /**
     * Create an account and its user document.
     * @param {string} email account email
     * @param {string} password plain-text password (8+ characters)
     * @param {string} displayName public name (2–40 characters)
     * @returns {Promise<{ok:boolean, user?:Object, error?:string}>}
     */
    async signUp(email, password, displayName) {
      const address = normalizeEmail(email);
      const secret = String(password === null || password === undefined ? '' : password);
      const name = String(displayName === null || displayName === undefined ? '' : displayName).trim();

      if (!EMAIL_RE.test(address)) return { ok: false, error: ERROR_TEXT['auth/invalid-email'] };
      if (secret.length < PASSWORD_MIN) return { ok: false, error: ERROR_TEXT['auth/weak-password'] };
      if (name.length < NAME_MIN || name.length > NAME_MAX) {
        return { ok: false, error: 'Please use a display name between ' + NAME_MIN + ' and ' + NAME_MAX + ' characters.' };
      }

      try {
        const doc = MODE === 'firebase'
          ? await firebaseSignUp(address, secret, name)
          : await demoSignUp(address, secret, name);
        settle();
        return { ok: true, user: doc };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },

    /**
     * Sign in to an existing account.
     * @param {string} email account email
     * @param {string} password plain-text password
     * @returns {Promise<{ok:boolean, user?:Object, error?:string}>}
     */
    async signIn(email, password) {
      const address = normalizeEmail(email);
      const secret = String(password === null || password === undefined ? '' : password);
      if (!EMAIL_RE.test(address)) return { ok: false, error: ERROR_TEXT['auth/invalid-email'] };
      if (!secret) return { ok: false, error: 'Please enter your password.' };

      try {
        const doc = MODE === 'firebase'
          ? await firebaseSignIn(address, secret)
          : await demoSignIn(address, secret);
        settle();
        return { ok: true, user: doc };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },

    /**
     * Sign in with Google. Firebase mode only.
     * @returns {Promise<{ok:boolean, user?:Object, error?:string}>}
     */
    async signInWithGoogle() {
      if (MODE !== 'firebase') {
        return {
          ok: false,
          error: 'Google sign-in needs a Firebase project. In demo mode, create a local account or use the demo account.'
        };
      }
      try {
        const doc = await firebaseSignInWithGoogle();
        settle();
        return { ok: true, user: doc };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },

    /**
     * Sign in instantly as the bundled demo profile. Demo mode only.
     * @returns {Promise<{ok:boolean, user?:Object, error?:string}>}
     */
    async signInAsDemoUser() {
      if (MODE === 'firebase') {
        return {
          ok: false,
          error: 'The demo account only exists in demo mode. Sign in with your account instead.'
        };
      }
      try {
        const doc = await demoSignInAsDemoUser();
        settle();
        return { ok: true, user: doc };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },

    /**
     * Sign out of whichever backend is live and clear the cached doc.
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async signOut() {
      let failure = null;
      if (MODE === 'firebase') {
        try {
          await fbAuth().signOut();
        } catch (err) {
          failure = err;
        }
      }
      // Always drop the local session, even if the SDK complained.
      removeKey(SESSION_KEY);
      setSignedOut();
      settle();
      return failure ? { ok: false, error: humanError(failure) } : { ok: true };
    },

    /**
     * Send a password reset email. Demo mode has no mail service and says so.
     * @param {string} email account email
     * @returns {Promise<{ok:boolean, error?:string}>}
     */
    async resetPassword(email) {
      const address = normalizeEmail(email);
      if (!EMAIL_RE.test(address)) return { ok: false, error: ERROR_TEXT['auth/invalid-email'] };
      if (MODE !== 'firebase') {
        return {
          ok: false,
          error: 'Demo mode cannot send email: accounts live only in this browser. Create a new account, or use the demo account.'
        };
      }
      try {
        await fbAuth().sendPasswordResetEmail(address);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: humanError(err) };
      }
    },

    /**
     * Re-read the signed-in user's document, e.g. after another page changed
     * the plan or the profile.
     * @returns {Promise<Object|null>} the refreshed UserDoc
     */
    async refresh() {
      if (!api.current) return null;
      try {
        const doc = await ZC.store.getUser(api.current.uid);
        if (doc) {
          api.doc = doc;
          emit();
        }
        return api.doc;
      } catch (err) {
        console.warn('[zc.auth] Could not refresh the profile document.', err);
        return api.doc;
      }
    },

    /**
     * Subscribe to sign-in state. The callback fires once the first state has
     * settled and on every change after that.
     * @param {Function} cb called with the UserDoc or null
     * @returns {Function} unsubscribe
     */
    onChange(cb) {
      if (typeof cb !== 'function') return function () { /* nothing to unsubscribe */ };
      let active = true;
      listeners.push(cb);
      ready.then(function () {
        if (!active) return;
        try {
          cb(api.doc);
        } catch (err) {
          console.error('[zc.auth] An onChange listener threw.', err);
        }
      });
      return function () {
        active = false;
        listeners = listeners.filter(function (fn) { return fn !== cb; });
      };
    },

    /**
     * Guard a page that needs an account. Signed-out visitors are sent to the
     * sign-in page with ?next= pointing back here, and this never resolves.
     * @param {{redirect?:string}} [options] where to send signed-out visitors
     * @returns {Promise<Object>} the UserDoc
     */
    async requireAuth(options) {
      const opts = options || {};
      // Wait for the first state, then read the live doc — a sign-in that
      // happened after settling must count.
      await ready;
      const doc = api.doc;
      if (doc) return doc;
      leaveTo(withNext(opts.redirect || 'auth.html'));
      return pending();
    },

    /**
     * Guard a page that only makes sense signed out (the auth page itself).
     * @param {{redirect?:string}} [options] where to send signed-in visitors
     * @returns {Promise<null>} null when the visitor may stay
     */
    async requireGuest(options) {
      const opts = options || {};
      await ready;
      if (!api.doc) return null;
      leaveTo(resolveNext(opts.redirect || 'dashboard.html'));
      return pending();
    },

    /**
     * Like requireAuth, but also insists on a finished profile — anyone who
     * has not completed onboarding is sent to fill it in first.
     * @param {{redirect?:string}} [options] passed through to requireAuth
     * @returns {Promise<Object>} the UserDoc
     */
    async requireProfile(options) {
      const doc = await api.requireAuth(options);
      if (doc && doc.profileComplete) return doc;
      leaveTo('profile.html?onboarding=1');
      return pending();
    }
  };

  ZC.auth = api;

  /* ------------------------------------------------------------------------
     11. Boot: settle the first auth state
     ------------------------------------------------------------------------ */

  /**
   * React to a Firebase auth state change.
   * @param {Object|null} user firebase.User or null
   * @returns {Promise<void>}
   */
  async function onFirebaseUser(user) {
    try {
      if (user && user.uid) {
        await adopt(accountFromFirebase(user));
      } else {
        setSignedOut();
      }
    } catch (err) {
      console.warn('[zc.auth] Could not apply the auth state.', err);
      setSignedOut();
    } finally {
      settle();
    }
  }

  /**
   * Wire up whichever backend is live and resolve ZC.auth.ready.
   * @returns {Promise<void>}
   */
  async function boot() {
    if (MODE === 'firebase') {
      try {
        fbAuth().onAuthStateChanged(
          function (user) { onFirebaseUser(user); },
          function (err) {
            console.warn('[zc.auth] Firebase stopped reporting auth state.', err);
            setSignedOut();
            settle();
          }
        );
      } catch (err) {
        console.warn('[zc.auth] Firebase Auth is unusable; treating this session as signed out.', err);
        setSignedOut();
        settle();
      }
      return;
    }

    // Demo mode: the session is a localStorage record we can read immediately.
    try {
      const uid = sessionUid(readJson(SESSION_KEY, null));
      if (uid) {
        await adoptDemoSession(uid);
      } else {
        setSignedOut();
      }
    } catch (err) {
      console.warn('[zc.auth] Could not restore the demo session.', err);
      setSignedOut();
    }
    settle();
  }

  // Sign-out (or sign-in) in one tab is sign-out in all of them.
  window.addEventListener('storage', function (event) {
    if (MODE !== 'demo' || event.key !== SESSION_KEY) return;
    const uid = sessionUid(readJson(SESSION_KEY, null));
    if (!uid) {
      setSignedOut();
      return;
    }
    if (api.current && api.current.uid === uid) return;
    adoptDemoSession(uid).catch(function (err) {
      console.warn('[zc.auth] Could not follow the session change.', err);
    });
  });

  // A backstop so a blocked Firebase never leaves pages waiting forever.
  window.setTimeout(function () {
    if (settled) return;
    console.warn('[zc.auth] No auth state after ' + READY_TIMEOUT_MS + 'ms; continuing as signed out.');
    setSignedOut();
    settle();
  }, READY_TIMEOUT_MS);

  boot();

  /* ------------------------------------------------------------------------
     12. The auth page

     Only runs on auth.html, which marks itself with [data-auth-page]. All the
     markup is static; this code toggles it and talks to the API above.
     ------------------------------------------------------------------------ */

  /** Headline, sub-copy and button label per view. */
  const PAGE_COPY = {
    signin: {
      title: 'Welcome back',
      sub: 'Sign in to pick up where you left off.',
      submit: 'Sign in',
      busy: 'Signing in…'
    },
    signup: {
      title: 'Create your account',
      sub: 'Takes a minute. Matching runs on this device — your answers are never sent to an AI service.',
      submit: 'Create account',
      busy: 'Creating your account…'
    },
    reset: {
      title: 'Reset your password',
      sub: 'We will email you a link to choose a new one.',
      submit: 'Send reset link',
      busy: 'Sending…'
    }
  };

  /**
   * Score a password for the strength meter.
   * @param {string} value the password
   * @returns {{pct:number, tone:string, label:string}} meter state
   */
  function scorePassword(value) {
    const password = String(value || '');
    if (!password) return { pct: 0, tone: 'is-weak', label: 'enter at least ' + PASSWORD_MIN + ' characters' };
    if (password.length < PASSWORD_MIN) {
      return { pct: 15, tone: 'is-weak', label: 'too short — ' + PASSWORD_MIN + ' characters minimum' };
    }
    let points = 1;
    if (password.length >= 12) points += 1;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) points += 1;
    if (/\d/.test(password)) points += 1;
    if (/[^A-Za-z0-9]/.test(password)) points += 1;

    const scale = [
      { pct: 25, tone: 'is-weak', label: 'weak — add length or variety' },
      { pct: 45, tone: 'is-ok', label: 'fair' },
      { pct: 65, tone: 'is-ok', label: 'good' },
      { pct: 85, tone: 'is-strong', label: 'strong' },
      { pct: 100, tone: 'is-strong', label: 'very strong' }
    ];
    return scale[Math.min(points, scale.length) - 1];
  }

  /**
   * Wire up auth.html. Returns immediately on every other page.
   * @returns {void}
   */
  function bootAuthPage() {
    const root = document.querySelector('[data-auth-page]');
    if (!root) return;

    const dom = {
      title: document.getElementById('auth-title'),
      sub: document.getElementById('auth-sub'),
      alert: document.getElementById('auth-alert'),
      demoNotice: document.getElementById('demo-notice'),
      tabs: document.getElementById('auth-tabs'),
      tabSignin: document.getElementById('tab-signin'),
      tabSignup: document.getElementById('tab-signup'),
      panel: document.getElementById('auth-panel'),
      form: document.getElementById('auth-form'),
      nameField: document.getElementById('field-name'),
      nameInput: document.getElementById('input-name'),
      nameError: document.getElementById('error-name'),
      emailField: document.getElementById('field-email'),
      emailInput: document.getElementById('input-email'),
      emailError: document.getElementById('error-email'),
      passwordField: document.getElementById('field-password'),
      passwordInput: document.getElementById('input-password'),
      passwordError: document.getElementById('error-password'),
      passwordHint: document.getElementById('hint-password'),
      passwordToggle: document.getElementById('toggle-password'),
      strengthBlock: document.getElementById('strength-block'),
      strengthFill: document.getElementById('strength-fill'),
      strengthLabel: document.getElementById('strength-label'),
      forgotRow: document.getElementById('forgot-row'),
      forgotBtn: document.getElementById('forgot-btn'),
      submit: document.getElementById('submit-btn'),
      googleBlock: document.getElementById('google-block'),
      googleBtn: document.getElementById('google-btn'),
      demoBlock: document.getElementById('demo-block'),
      demoBtn: document.getElementById('demo-btn'),
      resetForm: document.getElementById('reset-form'),
      resetField: document.getElementById('field-reset-email'),
      resetInput: document.getElementById('input-reset-email'),
      resetError: document.getElementById('error-reset-email'),
      resetSubmit: document.getElementById('reset-submit')
    };

    // The shared .container is 1120px wide; a sign-in card reads better narrow.
    // Inline style attributes are forbidden by the CSP, so this goes via CSSOM.
    root.style.setProperty('max-width', '460px');
    root.style.setProperty('margin-inline', 'auto');

    let view = 'signin';

    /* --- small helpers ---------------------------------------------------- */

    /**
     * Show or hide an element.
     * @param {Element} node target
     * @param {boolean} show whether it should be visible
     * @returns {void}
     */
    function toggle(node, show) {
      if (node) node.classList.toggle('hidden', !show);
    }

    /**
     * Put a message in the page-level live region.
     * @param {string} message text to announce
     * @param {'warn'|'info'} [tone='warn'] which notice style to use
     * @returns {void}
     */
    function showAlert(message, tone) {
      dom.alert.classList.remove('notice-warn', 'notice-info');
      dom.alert.classList.add(tone === 'info' ? 'notice-info' : 'notice-warn');
      dom.alert.classList.remove('hidden');
      dom.alert.textContent = message;
    }

    /**
     * Empty and hide the live region.
     * @returns {void}
     */
    function clearAlert() {
      dom.alert.textContent = '';
      dom.alert.classList.add('hidden');
    }

    /**
     * Mark one field as invalid.
     * @param {Element} field the .field wrapper
     * @param {Element} input the control
     * @param {Element} error the .field-error node
     * @param {string} message what went wrong
     * @returns {void}
     */
    function setFieldError(field, input, error, message) {
      field.classList.add('has-error');
      error.textContent = message;
      input.setAttribute('aria-invalid', 'true');
    }

    /**
     * Clear one field's error state.
     * @param {Element} field the .field wrapper
     * @param {Element} input the control
     * @param {Element} error the .field-error node
     * @returns {void}
     */
    function clearFieldError(field, input, error) {
      field.classList.remove('has-error');
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    }

    /**
     * Clear every field error on the card.
     * @returns {void}
     */
    function clearAllFieldErrors() {
      clearFieldError(dom.nameField, dom.nameInput, dom.nameError);
      clearFieldError(dom.emailField, dom.emailInput, dom.emailError);
      clearFieldError(dom.passwordField, dom.passwordInput, dom.passwordError);
      clearFieldError(dom.resetField, dom.resetInput, dom.resetError);
    }

    /**
     * Disable a button and show a spinner while work is in flight.
     * @param {Element} button the control
     * @param {boolean} on whether work is running
     * @param {string} [label] text to show while busy
     * @returns {void}
     */
    function busy(button, on, label) {
      if (ui.setBusy) {
        ui.setBusy(button, on, label);
        return;
      }
      button.disabled = !!on;
    }

    /**
     * Fire a toast when the UI layer is available.
     * @param {string} message toast text
     * @param {string} kind info|success|warn|error
     * @returns {void}
     */
    function toast(message, kind) {
      if (ui.toast) ui.toast(message, kind);
    }

    /* --- validation ------------------------------------------------------- */

    /**
     * Validate the visible fields of the sign-in / sign-up form.
     * @returns {boolean} true when the form may be submitted
     */
    function validateForm() {
      let firstInvalid = null;
      clearAllFieldErrors();

      if (view === 'signup') {
        const name = dom.nameInput.value.trim();
        if (name.length < NAME_MIN || name.length > NAME_MAX) {
          setFieldError(dom.nameField, dom.nameInput, dom.nameError,
            'Use between ' + NAME_MIN + ' and ' + NAME_MAX + ' characters.');
          firstInvalid = firstInvalid || dom.nameInput;
        }
      }

      const email = normalizeEmail(dom.emailInput.value);
      if (!email) {
        setFieldError(dom.emailField, dom.emailInput, dom.emailError, 'Please enter your email address.');
        firstInvalid = firstInvalid || dom.emailInput;
      } else if (!EMAIL_RE.test(email)) {
        setFieldError(dom.emailField, dom.emailInput, dom.emailError, 'That does not look like an email address.');
        firstInvalid = firstInvalid || dom.emailInput;
      }

      const password = dom.passwordInput.value;
      if (!password) {
        setFieldError(dom.passwordField, dom.passwordInput, dom.passwordError, 'Please enter your password.');
        firstInvalid = firstInvalid || dom.passwordInput;
      } else if (view === 'signup' && password.length < PASSWORD_MIN) {
        setFieldError(dom.passwordField, dom.passwordInput, dom.passwordError,
          'Use at least ' + PASSWORD_MIN + ' characters.');
        firstInvalid = firstInvalid || dom.passwordInput;
      }

      if (firstInvalid) {
        firstInvalid.focus();
        return false;
      }
      return true;
    }

    /**
     * Validate the forgot-password form.
     * @returns {boolean} true when it may be submitted
     */
    function validateReset() {
      clearFieldError(dom.resetField, dom.resetInput, dom.resetError);
      const email = normalizeEmail(dom.resetInput.value);
      if (!EMAIL_RE.test(email)) {
        setFieldError(dom.resetField, dom.resetInput, dom.resetError, 'Enter the email address on your account.');
        dom.resetInput.focus();
        return false;
      }
      return true;
    }

    /* --- view switching --------------------------------------------------- */

    /**
     * Repaint the strength meter for the current password.
     * @returns {void}
     */
    function renderStrength() {
      const state = scorePassword(dom.passwordInput.value);
      dom.strengthFill.className = 'meter-fill ' + state.tone;
      dom.strengthFill.style.setProperty('width', state.pct + '%');
      dom.strengthLabel.textContent = 'Password strength: ' + state.label;
    }

    /**
     * Keep the address bar in step with the visible view, so a refresh or a
     * shared link lands on the same tab.
     * @returns {void}
     */
    function syncUrl() {
      if (!window.history || typeof window.history.replaceState !== 'function') return;
      try {
        const params = new URLSearchParams(window.location.search);
        if (view === 'signup') {
          params.set('mode', 'signup');
        } else {
          params.delete('mode');
        }
        const query = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
      } catch (err) {
        // A failed URL tidy-up is cosmetic only.
      }
    }

    /**
     * Switch between the sign-in, sign-up and reset views.
     * @param {'signin'|'signup'|'reset'} next which view to show
     * @param {boolean} [moveFocus] focus the first field of the new view
     * @returns {void}
     */
    function setView(next, moveFocus) {
      view = next;
      const copy = PAGE_COPY[next];
      const isReset = next === 'reset';
      const isSignup = next === 'signup';

      dom.title.textContent = copy.title;
      dom.sub.textContent = copy.sub;
      clearAlert();
      clearAllFieldErrors();

      toggle(dom.tabs, !isReset);
      toggle(dom.panel, !isReset);
      toggle(dom.resetForm, isReset);
      toggle(dom.nameField, isSignup);
      toggle(dom.strengthBlock, isSignup);
      toggle(dom.forgotRow, next === 'signin');
      toggle(dom.googleBlock, !isReset && MODE === 'firebase');
      toggle(dom.demoBlock, !isReset && MODE === 'demo');

      // A hidden control must not be focusable or submitted.
      dom.nameInput.disabled = !isSignup;
      dom.passwordInput.setAttribute('autocomplete', isSignup ? 'new-password' : 'current-password');
      dom.passwordHint.textContent = isSignup
        ? 'At least ' + PASSWORD_MIN + ' characters.'
        : 'Passwords are case-sensitive.';

      if (!isReset) {
        dom.submit.textContent = copy.submit;
        dom.tabSignin.classList.toggle('is-active', !isSignup);
        dom.tabSignup.classList.toggle('is-active', isSignup);
        dom.tabSignin.setAttribute('aria-selected', String(!isSignup));
        dom.tabSignup.setAttribute('aria-selected', String(isSignup));
        dom.tabSignin.setAttribute('tabindex', isSignup ? '-1' : '0');
        dom.tabSignup.setAttribute('tabindex', isSignup ? '0' : '-1');
        dom.panel.setAttribute('aria-labelledby', isSignup ? 'tab-signup' : 'tab-signin');
        syncUrl();
      }

      if (isSignup) renderStrength();

      if (moveFocus) {
        if (isReset) {
          dom.resetInput.focus();
        } else if (isSignup && !dom.nameInput.value) {
          dom.nameInput.focus();
        } else if (!dom.emailInput.value) {
          dom.emailInput.focus();
        } else {
          dom.passwordInput.focus();
        }
      }
    }

    /* --- destinations ----------------------------------------------------- */

    /**
     * Where to land after signing in: an honoured ?next=, else the deck.
     * @returns {string} relative URL
     */
    function signInDestination() {
      return resolveNext('dashboard.html');
    }

    /**
     * New accounts always go through onboarding, carrying ?next= along so the
     * profile page can hand people back to where they were headed.
     * @returns {string} relative URL
     */
    function signUpDestination() {
      const next = safePath(readQuery('next'));
      return 'profile.html?onboarding=1' + (next ? '&next=' + encodeURIComponent(next) : '');
    }

    /* --- events ----------------------------------------------------------- */

    // Segmented control: click plus full arrow-key support.
    dom.tabSignin.addEventListener('click', function () { setView('signin', true); });
    dom.tabSignup.addEventListener('click', function () { setView('signup', true); });
    dom.tabs.addEventListener('keydown', function (event) {
      const key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
      event.preventDefault();
      const next = (key === 'ArrowRight' || key === 'End') ? 'signup' : 'signin';
      setView(next, false);
      (next === 'signup' ? dom.tabSignup : dom.tabSignin).focus();
    });

    // Clear a field's error as soon as the person starts fixing it.
    dom.nameInput.addEventListener('input', function () {
      clearFieldError(dom.nameField, dom.nameInput, dom.nameError);
    });
    dom.emailInput.addEventListener('input', function () {
      clearFieldError(dom.emailField, dom.emailInput, dom.emailError);
    });
    dom.passwordInput.addEventListener('input', function () {
      clearFieldError(dom.passwordField, dom.passwordInput, dom.passwordError);
      if (view === 'signup') renderStrength();
    });
    dom.resetInput.addEventListener('input', function () {
      clearFieldError(dom.resetField, dom.resetInput, dom.resetError);
    });

    // Validate on blur so mistakes surface before the submit button is pressed.
    dom.emailInput.addEventListener('blur', function () {
      const value = normalizeEmail(dom.emailInput.value);
      if (value && !EMAIL_RE.test(value)) {
        setFieldError(dom.emailField, dom.emailInput, dom.emailError, 'That does not look like an email address.');
      }
    });
    dom.nameInput.addEventListener('blur', function () {
      const value = dom.nameInput.value.trim();
      if (view === 'signup' && value && value.length < NAME_MIN) {
        setFieldError(dom.nameField, dom.nameInput, dom.nameError, 'Use at least ' + NAME_MIN + ' characters.');
      }
    });

    // Show / hide the password without losing the caret.
    dom.passwordToggle.addEventListener('click', function () {
      const revealed = dom.passwordInput.getAttribute('type') === 'text';
      dom.passwordInput.setAttribute('type', revealed ? 'password' : 'text');
      dom.passwordToggle.setAttribute('aria-pressed', String(!revealed));
      dom.passwordToggle.textContent = revealed ? 'Show password' : 'Hide password';
      dom.passwordInput.focus();
    });

    // Forgot password: swap to the reset view and carry the typed email over.
    dom.forgotBtn.addEventListener('click', function () {
      if (dom.emailInput.value && !dom.resetInput.value) dom.resetInput.value = dom.emailInput.value;
      setView('reset', true);
    });
    document.getElementById('reset-back').addEventListener('click', function () {
      setView('signin', true);
    });

    // Sign in / create account.
    dom.form.addEventListener('submit', async function (event) {
      event.preventDefault();
      clearAlert();
      if (!validateForm()) return;

      const copy = PAGE_COPY[view];
      const signingUp = view === 'signup';
      busy(dom.submit, true, copy.busy);
      try {
        const result = signingUp
          ? await ZC.auth.signUp(dom.emailInput.value, dom.passwordInput.value, dom.nameInput.value)
          : await ZC.auth.signIn(dom.emailInput.value, dom.passwordInput.value);

        if (!result.ok) {
          busy(dom.submit, false);
          showAlert(result.error, 'warn');
          (signingUp ? dom.emailInput : dom.passwordInput).focus();
          return;
        }
        toast(signingUp ? 'Account created — your profile is next.' : 'Signed in.', 'success');
        leaveTo(signingUp ? signUpDestination() : signInDestination());
      } catch (err) {
        busy(dom.submit, false);
        showAlert(humanError(err), 'warn');
      }
    });

    // Forgot-password submit.
    dom.resetForm.addEventListener('submit', async function (event) {
      event.preventDefault();
      clearAlert();
      if (!validateReset()) return;

      busy(dom.resetSubmit, true, PAGE_COPY.reset.busy);
      try {
        const result = await ZC.auth.resetPassword(dom.resetInput.value);
        busy(dom.resetSubmit, false);
        if (!result.ok) {
          showAlert(result.error, 'warn');
          return;
        }
        showAlert('If an account exists for that address, a reset link is on its way. Check your inbox and spam folder.', 'info');
      } catch (err) {
        busy(dom.resetSubmit, false);
        showAlert(humanError(err), 'warn');
      }
    });

    // Google (firebase mode only — the block stays hidden otherwise).
    dom.googleBtn.addEventListener('click', async function () {
      clearAlert();
      busy(dom.googleBtn, true, 'Opening Google…');
      try {
        const result = await ZC.auth.signInWithGoogle();
        if (!result.ok) {
          busy(dom.googleBtn, false);
          showAlert(result.error, 'warn');
          return;
        }
        toast('Signed in with Google.', 'success');
        leaveTo(result.user && result.user.profileComplete ? signInDestination() : signUpDestination());
      } catch (err) {
        busy(dom.googleBtn, false);
        showAlert(humanError(err), 'warn');
      }
    });

    // Demo account (demo mode only — the block stays hidden otherwise).
    dom.demoBtn.addEventListener('click', async function () {
      clearAlert();
      busy(dom.demoBtn, true, 'Loading the demo…');
      try {
        const result = await ZC.auth.signInAsDemoUser();
        if (!result.ok) {
          busy(dom.demoBtn, false);
          showAlert(result.error, 'warn');
          return;
        }
        toast('Signed in as the demo account.', 'success');
        leaveTo(result.user && result.user.profileComplete ? signInDestination() : signUpDestination());
      } catch (err) {
        busy(dom.demoBtn, false);
        showAlert(humanError(err), 'warn');
      }
    });

    /* --- first paint ------------------------------------------------------ */

    // Demo-mode affordances: the notice, the demo button, no Google.
    toggle(dom.demoNotice, MODE === 'demo');

    const requested = String(readQuery('mode') || '').toLowerCase();
    setView(requested === 'signup' || requested === 'register' ? 'signup' : 'signin', false);

    // Signed-in visitors have no business on this page.
    ZC.auth.requireGuest().catch(function (err) {
      console.warn('[zc.auth] Guest check failed.', err);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootAuthPage);
  } else {
    bootAuthPage();
  }
})();
