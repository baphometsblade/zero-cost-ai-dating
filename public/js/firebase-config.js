/* ==========================================================================
   Zero Cost AI Dating — Firebase bootstrap
   Decides, once per page load, whether the app talks to a real Firebase
   project ("firebase" mode) or to localStorage ("demo" mode). This file must
   never throw: a missing SDK, a placeholder config or a blocked network is a
   supported path that quietly lands the app in demo mode.
   Exposes: ZC.config, ZC.firebase.
   ========================================================================== */
(function () {
  'use strict';

  window.ZC = window.ZC || {};
  var ZC = window.ZC;

  // Tolerate being loaded twice (e.g. a page that includes the block by mistake).
  if (ZC.config && ZC.config.mode) {
    return;
  }

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------------
     1. Config sources
     ------------------------------------------------------------------------ */

  /**
   * Baked-in config. Replace these values with your own project's, or paste a
   * config JSON into Settings → "Connect your own Firebase project" (which
   * writes localStorage['zc.firebaseConfig'] and wins over these values).
   */
  var BAKED_CONFIG = {
    apiKey: 'your-api-key-here',
    authDomain: 'your-project.firebaseapp.com',
    projectId: 'your-project-id',
    storageBucket: 'your-project.appspot.com',
    messagingSenderId: '000000000000',
    appId: '1:000000000000:web:0000000000000000000000'
  };

  var OVERRIDE_KEY = 'zc.firebaseConfig';
  var CONFIG_FIELDS = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];

  // An apiKey that matches this is obviously a stand-in, not a real credential.
  var PLACEHOLDER_RE = /^your-|^AIza\.\.\.|REPLACE_ME/i;

  /**
   * Read the user-supplied config override from localStorage.
   * Corrupt JSON, a hostile shape or storage being unavailable all yield null.
   * @returns {Object|null} partial config or null
   */
  function readOverride() {
    var raw;
    try {
      raw = window.localStorage.getItem(OVERRIDE_KEY);
    } catch (err) {
      // Private-mode / disabled storage — nothing to override with.
      return null;
    }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      var out = {};
      for (var i = 0; i < CONFIG_FIELDS.length; i += 1) {
        var key = CONFIG_FIELDS[i];
        if (typeof parsed[key] === 'string' && parsed[key].trim()) {
          out[key] = parsed[key].trim();
        }
      }
      return out.apiKey ? out : null;
    } catch (err) {
      console.warn('[zc] Ignoring malformed ' + OVERRIDE_KEY + ' in localStorage.');
      return null;
    }
  }

  /**
   * True when the config looks like it points at a real project rather than
   * the placeholders shipped in this file.
   * @param {Object} cfg config object
   * @returns {boolean}
   */
  function looksReal(cfg) {
    var apiKey = cfg && cfg.apiKey;
    if (!apiKey || typeof apiKey !== 'string') return false;
    if (PLACEHOLDER_RE.test(apiKey)) return false;
    if (String(cfg.projectId || '').indexOf('your-') === 0) return false;
    return true;
  }

  /* ------------------------------------------------------------------------
     2. Resolve the config and (maybe) initialise the SDK
     ------------------------------------------------------------------------ */

  var override = readOverride();
  var firebaseConfig = {};
  var f;
  for (f = 0; f < CONFIG_FIELDS.length; f += 1) {
    firebaseConfig[CONFIG_FIELDS[f]] = BAKED_CONFIG[CONFIG_FIELDS[f]];
  }
  if (override) {
    for (f = 0; f < CONFIG_FIELDS.length; f += 1) {
      if (override[CONFIG_FIELDS[f]]) firebaseConfig[CONFIG_FIELDS[f]] = override[CONFIG_FIELDS[f]];
    }
  }

  // The compat SDK is loaded from gstatic; if that failed, `firebase` is undefined.
  var sdk = (typeof firebase !== 'undefined' && firebase) ? firebase : null;
  var sdkPresent = !!(sdk && typeof sdk.initializeApp === 'function');
  var isConfigured = looksReal(firebaseConfig) && sdkPresent;

  var handles = null;
  var initError = null;

  if (isConfigured) {
    try {
      // Reuse an existing app so a double load can never throw "app already exists".
      var app = (sdk.apps && sdk.apps.length) ? sdk.app() : sdk.initializeApp(firebaseConfig);
      var auth = typeof sdk.auth === 'function' ? sdk.auth(app) : null;
      var db = typeof sdk.firestore === 'function' ? sdk.firestore(app) : null;
      if (auth && db) {
        handles = { app: app, auth: auth, db: db };
      } else {
        initError = new Error('firebase-auth-compat or firebase-firestore-compat did not load');
      }
    } catch (err) {
      initError = err;
      handles = null;
    }
  }

  var mode = handles ? 'firebase' : 'demo';

  /* ------------------------------------------------------------------------
     3. Publish the namespace
     ------------------------------------------------------------------------ */

  /**
   * Global app configuration. `limits` is the single source of truth for what
   * each plan may do; the store's canSpend() reads it directly.
   */
  ZC.config = {
    firebase: firebaseConfig,
    isConfigured: isConfigured,
    mode: mode,
    version: VERSION,
    overrideKey: OVERRIDE_KEY,
    limits: {
      free: { likesPerDay: 25, superLikesPerDay: 1, rewinds: 0, seeLikedYou: false, adaptiveWeights: false },
      premium: { likesPerDay: Infinity, superLikesPerDay: 5, rewinds: Infinity, seeLikedYou: true, adaptiveWeights: true }
    }
  };

  /** Live SDK handles, or null in demo mode. Callers use ZC.store / ZC.auth instead. */
  ZC.firebase = handles;

  // Exactly one line of boot noise, so the active mode is obvious in the console.
  if (mode === 'firebase') {
    console.info('[zero-cost-ai-dating v' + VERSION + '] Firebase mode — project "' + firebaseConfig.projectId + '"' + (override ? ' (config from Settings)' : ''));
  } else {
    console.info('[zero-cost-ai-dating v' + VERSION + '] Demo mode — data lives in localStorage.' +
      (initError ? ' Firebase init failed: ' + (initError.message || initError) : sdkPresent ? ' No real Firebase config found.' : ' Firebase SDK not available.'));
  }
})();
