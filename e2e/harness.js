/* ==========================================================================
   Zero Cost AI Dating — end-to-end harness

   The pieces every spec needs and none of them should own: locating a
   Playwright that is deliberately not a dependency of this repo, serving
   public/ the way Firebase Hosting does, and opening a browser session that
   behaves like a real visitor with no Firebase SDK available.
   ========================================================================== */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* --------------------------------------------------------------------------
   1. Playwright, from outside the dependency tree
   -------------------------------------------------------------------------- */

// The repo has no dependencies and must keep none, so Playwright is borrowed
// from wherever the caller already has it: an explicit E2E_PLAYWRIGHT path, a
// NODE_PATH entry, or a node_modules above this checkout (which is how the
// `npx playwright` install in CI ends up visible).
const INSTALL_HINT =
  'Playwright not found. Install it outside the repo, then point the suite at it, e.g. ' +
  '`npx --yes playwright@1.56.0 install --with-deps chromium` and run with ' +
  'NODE_PATH=<dir containing playwright> npm run test:e2e (or set E2E_PLAYWRIGHT=<path to the playwright package>).';

/**
 * Resolve the Playwright module without ever adding it to this project.
 * @returns {Object|null} the playwright module, or null when it is not installed
 */
function loadPlaywright() {
  const ids = [];
  if (process.env.E2E_PLAYWRIGHT) ids.push(process.env.E2E_PLAYWRIGHT);
  ids.push('playwright');
  for (let i = 0; i < ids.length; i += 1) {
    try {
      return require(ids[i]);
    } catch (err) {
      // Only a missing *top-level* module means "not installed"; a
      // MODULE_NOT_FOUND from inside Playwright is a real error worth seeing.
      const missing = err && err.code === 'MODULE_NOT_FOUND' &&
        String(err.message).indexOf("'" + ids[i] + "'") !== -1;
      if (!missing) throw err;
    }
  }
  return null;
}

/* --------------------------------------------------------------------------
   2. A static server that behaves like Firebase Hosting
   -------------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

/** True when the path exists and is a regular file. */
function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * Map a request path to a file on disk, honouring the `cleanUrls: true` in
 * firebase.json — `/matches` must serve matches.html, or the service worker's
 * offline fallbacks would be tested against a URL shape that never ships.
 * @param {string} root directory to serve from
 * @param {string} pathname the request pathname, already decoded
 * @returns {string|null} an absolute file path, or null when nothing matches
 */
function resolveFile(root, pathname) {
  const trimmed = pathname.replace(/\/+$/, '');
  const rel = trimmed === '' ? 'index.html' : trimmed.replace(/^\/+/, '');
  const direct = path.resolve(root, rel);
  // Refuse anything that climbed out of the served directory.
  if (direct !== root && direct.indexOf(root + path.sep) !== 0) return null;
  if (isFile(direct)) return direct;
  const asPage = direct + '.html';
  return isFile(asPage) ? asPage : null;
}

/**
 * Serve `public/` on an ephemeral port. Ephemeral because several specs run in
 * the same process and one of them deliberately kills its server mid-test.
 * @param {string} [root=PUBLIC_DIR] directory to serve
 * @returns {Promise<{origin:string, stop:function():Promise<void>}>}
 */
async function startServer(root) {
  const dir = path.resolve(root || PUBLIC_DIR);
  const server = http.createServer(function (req, res) {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (err) {
      pathname = '/';
    }
    const file = resolveFile(dir, pathname);
    const target = file || path.join(dir, '404.html');
    fs.readFile(target, function (err, body) {
      if (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('e2e server could not read ' + target);
        return;
      }
      res.writeHead(file ? 200 : 404, {
        'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        // The service worker is network-first; letting the browser answer from
        // its own HTTP cache would hide whether the worker is doing its job.
        'cache-control': 'no-store'
      });
      res.end(body);
    });
  });

  await new Promise(function (resolve, reject) {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = server.address().port;
  // Latched so the second stop() is a no-op that still resolves. The offline
  // spec stops its server mid-test (taking it away *is* the test) and stops it
  // again in its finally, which is the only cleanup that runs when an earlier
  // check bails out. Without the latch that pair raises ERR_SERVER_NOT_RUNNING.
  let closing = null;
  return {
    origin: 'http://127.0.0.1:' + port,
    /**
     * Stop listening *and* drop live sockets, so the next request truly fails.
     * Idempotent: calling it again returns the same promise.
     * @returns {Promise<void>} resolves once the server has closed
     */
    stop: function () {
      if (closing) return closing;
      // closeAllConnections landed in Node 18.2 and package.json allows 18.0,
      // where an unguarded call would throw and shutdown would never finish.
      // Without it, keep-alive sockets would just close a little later.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      closing = new Promise(function (resolve) { server.close(function () { resolve(); }); });
      return closing;
    }
  };
}

/* --------------------------------------------------------------------------
   3. Browser sessions
   -------------------------------------------------------------------------- */

const VIEWPORTS = {
  mobile: { key: 'mobile', label: 'mobile 390x844', width: 390, height: 844 },
  desktop: { key: 'desktop', label: 'desktop 1280x800', width: 1280, height: 800 }
};

// Unhandled rejections are re-emitted as console errors so a single listener
// catches them, including the ones raised on pages we later navigate away from.
const REJECTION_TAG = 'e2e-unhandled-rejection:';

/**
 * The Firebase SDK is aborted on purpose, so the browser reports those failed
 * script loads. They are the expected shape of demo mode.
 *
 * Deliberately matched on the failing request's URL, not on the message text.
 * A same-origin asset that fails reports "Failed to load resource:
 * net::ERR_..." with nothing in the text to tell it apart from the CDN, so a
 * text pattern broad enough to cover the aborted SDK also swallowed every real
 * resource regression — and the per-spec "no console errors" check would still
 * have passed. The URL is unambiguous.
 * @param {Object} msg a Playwright ConsoleMessage
 * @returns {boolean} true when the message is expected CDN noise, not a defect
 */
function isExpectedCdnNoise(msg) {
  const text = msg.text();
  if (text.indexOf(REJECTION_TAG) === 0) return false;
  const location = (typeof msg.location === 'function' && msg.location()) || {};
  const url = location.url || '';
  // The URL is authoritative; the text is only consulted when Chromium reports
  // no location, as it does for some worker-sourced messages.
  if (url) return /^https?:\/\/([a-z0-9-]+\.)*gstatic\.com\//i.test(url);
  return /gstatic\.com/i.test(text);
}

/**
 * Open an isolated browser context at one viewport, wired so that anything the
 * page logs as an error ends up in `errors`.
 * @param {Object} browser a Playwright Browser
 * @param {Object} viewport one of VIEWPORTS
 * @returns {Promise<{context:Object, page:Object, errors:string[]}>}
 */
async function openSession(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }
  });

  // Blocking the Firebase CDN is what puts the app into demo mode, which is
  // the only mode a test can drive without a real project behind it.
  await context.route('**://www.gstatic.com/**', function (route) { return route.abort(); });

  await context.addInitScript(function () {
    window.addEventListener('unhandledrejection', function (event) {
      const reason = event.reason;
      console.error('e2e-unhandled-rejection: ' + String((reason && (reason.stack || reason.message)) || reason));
    });
  });

  const errors = [];
  // The offline spec takes its own server away on purpose, and a page loading
  // from cache with nothing behind it legitimately logs same-origin resource
  // failures. Rather than widen the filter for everyone — which is what hid
  // real regressions before — a spec opts into that window explicitly, and
  // closes it again afterwards.
  const state = { expectingNetworkErrors: false };
  const isResourceFailure = function (text) {
    return /net::ERR|Failed to load resource/i.test(text);
  };

  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  // Playwright cancels dialogs by default, which would silently block any
  // navigation the unsaved-changes guard objects to. The app's own dialogs are
  // DOM modals, so the only native ones are beforeunload prompts.
  page.on('dialog', function (dialog) { return dialog.accept(); });
  page.on('pageerror', function (err) {
    errors.push('pageerror @ ' + page.url() + ' :: ' + (err && err.message ? err.message : String(err)));
  });
  page.on('console', function (msg) {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (isExpectedCdnNoise(msg)) return;
    if (state.expectingNetworkErrors && isResourceFailure(text)) return;
    errors.push('console.error @ ' + page.url() + ' :: ' + text);
  });

  return {
    context: context,
    page: page,
    errors: errors,
    /**
     * Tolerate same-origin resource failures for the duration of a deliberate
     * outage. Only the offline spec should need this; leaving it on would blind
     * the session to exactly the regressions the error check exists to catch.
     * @param {boolean} on whether an outage is expected right now
     * @returns {void}
     */
    expectNetworkErrors: function (on) { state.expectingNetworkErrors = !!on; }
  };
}

/* --------------------------------------------------------------------------
   4. Shared page steps
   -------------------------------------------------------------------------- */

/**
 * Land on the marketing page, take the demo route in, and wait until the deck
 * has actually rendered a card. Almost every spec starts here.
 * @param {Object} page a Playwright Page
 * @param {string} base the server origin
 * @returns {Promise<void>}
 */
async function signIn(page, base) {
  await page.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-cta="demo"]:not(.hidden)');
  await page.click('[data-cta="demo"]');
  await page.waitForURL('**/dashboard.html');
  await page.waitForSelector('#deck-stack .swipe-card');
}

/** The display name on the top card, or null when the deck is empty. */
async function topCardName(page) {
  return page.evaluate(function () {
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    if (!card) return null;
    const name = card.querySelector('.swipe-name');
    return name ? name.textContent.trim() : card.textContent.trim().slice(0, 40);
  });
}

/**
 * Send one deck keystroke and wait for the consequence: either the top card
 * changed or a match overlay went up. A right swipe onto someone who already
 * liked you does both, so callers must tolerate either outcome.
 * @param {Object} page a Playwright Page
 * @param {string} key the key to press ('ArrowLeft', 'ArrowRight', 'ArrowUp')
 * @param {string|null} before the name that was on top before the press
 * @returns {Promise<{name:string|null, burst:boolean}>}
 */
async function pressDeckKey(page, key, before) {
  await page.keyboard.press(key);
  await page.waitForFunction(function (previous) {
    if (document.querySelector('.match-burst')) return true;
    const card = document.querySelector('#deck-stack .swipe-card:not([data-exiting])');
    const name = card && card.querySelector('.swipe-name');
    return !!name && name.textContent.trim() !== previous;
  }, before);
  const burst = (await page.locator('.match-burst').count()) > 0;
  return { name: await topCardName(page), burst: burst };
}

/** Dismiss an open match overlay, if there is one, and wait for it to go. */
async function closeBurst(page) {
  if (!(await page.locator('.match-burst').count())) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector('.match-burst', { state: 'detached' });
}

/**
 * Click the footer button of an open modal by its visible label. The dialogs
 * are built from a shared helper, so this works for every one of them.
 * @param {Object} page a Playwright Page
 * @param {string} label the exact button text
 * @returns {Promise<void>}
 */
async function clickModalAction(page, label) {
  await page.waitForSelector('.modal-backdrop .modal-foot');
  await page.locator('.modal-foot button', { hasText: new RegExp('^' + label + '$') }).first().click();
}

module.exports = {
  PUBLIC_DIR: PUBLIC_DIR,
  INSTALL_HINT: INSTALL_HINT,
  VIEWPORTS: VIEWPORTS,
  loadPlaywright: loadPlaywright,
  startServer: startServer,
  openSession: openSession,
  signIn: signIn,
  topCardName: topCardName,
  pressDeckKey: pressDeckKey,
  closeBurst: closeBurst,
  clickModalAction: clickModalAction
};
