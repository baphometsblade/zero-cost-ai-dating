/* ==========================================================================
   Zero Cost AI Dating — end-to-end harness

   The pieces every spec needs and none of them should own: locating a
   Playwright that is deliberately not a dependency of this repo, serving
   public/ the way Firebase Hosting does, and opening a browser session that
   behaves like a real visitor — either with no Firebase SDK available (demo
   mode, which is what nine specs out of ten want) or with the real SDK
   pointed at a local emulator through the page's own origin.
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

/* Per-connection headers. They describe the hop they arrived on, so passing
   them to the next hop is a lie; Node writes its own. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade'];

/* One socket per proxied request, never pooled. Node's global agent keeps
   sockets alive and hands them round, and this proxy has to be able to hang up
   on a Firestore long-poll that outlived its page — with pooling, that hang-up
   took an unrelated in-flight request's socket with it and the page saw a 502. */
const PROXY_AGENT = new http.Agent({ keepAlive: false, maxSockets: 64 });

/* How long a proxied answer may stay open before it is closed cleanly.
   Firestore's Listen and Write channels are long-lived by design, and a
   browser allows only six connections per origin over HTTP/1.1. In production
   that never bites: Firestore is a different origin and speaks HTTP/2. Folded
   onto the page's own origin — which is the whole trick that keeps the shipped
   CSP intact — six of them is the entire budget, and channels left behind by a
   page that has been navigated away from spend it: measured, the site reached
   six open channels and then every request, including a plain fetch of
   index.html, waited forever. Ending them on a timer recycles the connections,
   and a WebChannel reopens a backchannel that ends, which is what it does
   behind any real proxy. */
const MAX_PROXY_ANSWER_MS = 5000;

/**
 * Normalise one `opts.proxy` value into an address.
 * @param {number|string} value a port, or 'host:port'
 * @returns {{host:string, port:number}|null} null when it is neither
 */
function toAddress(value) {
  if (typeof value === 'number') return { host: '127.0.0.1', port: value };
  const raw = String(value || '');
  const at = raw.lastIndexOf(':');
  const port = Number(at === -1 ? raw : raw.slice(at + 1));
  if (!port) return null;
  return { host: (at === -1 ? '' : raw.slice(0, at)) || '127.0.0.1', port: port };
}

/**
 * Hand one request on to an emulator and stream the answer straight back.
 *
 * Streamed, never buffered: Firestore's Listen and Write channels are
 * long-lived responses whose chunks have to reach the page as they arrive, and
 * collecting the body first would turn a live listener into a hang.
 * @param {Object} req the incoming request
 * @param {Object} res the response to write
 * @param {{host:string, port:number}} target where the emulator listens
 * @param {Set} live upstream requests to destroy when the server stops
 * @returns {void}
 */
function forward(req, res, target, live) {
  const headers = {};
  Object.keys(req.headers).forEach(function (name) {
    if (HOP_BY_HOP.indexOf(name) === -1) headers[name] = req.headers[name];
  });
  // The emulator routes on Host for some of its endpoints, and it must see its
  // own address rather than the page's.
  headers.host = target.host + ':' + target.port;

  const upstream = http.request({
    host: target.host, port: target.port, method: req.method, path: req.url,
    headers: headers, agent: PROXY_AGENT
  }, function (answer) {
    const out = {};
    Object.keys(answer.headers).forEach(function (name) {
      if (HOP_BY_HOP.indexOf(name) === -1) out[name] = answer.headers[name];
    });
    res.writeHead(answer.statusCode, out);
    // End cleanly rather than cutting the socket: a finished chunked answer is
    // an empty poll to the client, where a truncated one is a transport error.
    const cap = setTimeout(function () { res.end(); upstream.destroy(); }, MAX_PROXY_ANSWER_MS);
    answer.on('end', function () { clearTimeout(cap); });
    answer.on('close', function () { clearTimeout(cap); });
    answer.pipe(res);
  });
  live.add(upstream);
  const done = function () { live.delete(upstream); };
  upstream.on('close', done);
  upstream.on('error', function (err) {
    done();
    // A dead emulator has to read as a failed request, not as a silently empty
    // one: 502 with the reason is what a spec can put in a check's detail.
    // Once the answer has started there is no status left to change, and the
    // reason would land inside the body as corruption, so it just ends.
    if (res.headersSent) {
      res.end();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('e2e proxy could not reach ' + target.host + ':' + target.port + ' — ' + err.message);
  });
  // A page that goes away mid-poll leaves a long-poll GET open at the other
  // end; without this the process would not exit. Only when the answer never
  // finished — hanging up on a completed exchange is how sockets get pulled
  // out from under the next request.
  res.on('close', function () { if (!res.writableEnded) upstream.destroy(); });
  req.pipe(upstream);
}

/**
 * Serve `public/` on an ephemeral port. Ephemeral because several specs run in
 * the same process and one of them deliberately kills its server mid-test.
 * @param {string} [root=PUBLIC_DIR] directory to serve
 * @param {Object} [opts]
 * @param {string} [opts.mountPath] serve the site under this prefix instead of
 *   the root, the way GitHub Pages serves a project site
 *   (e.g. '/zero-cost-ai-dating'); requests outside it get the 404 treatment
 * @param {Object} [opts.proxy] path prefix -> emulator port (or 'host:port').
 *   Anything whose path starts with a prefix is forwarded there instead of
 *   being looked up on disk. This is what lets a page talk to the Firestore
 *   and Auth emulators without leaving its own origin, and so without the
 *   shipped `connect-src 'self'` having to be relaxed for the tests.
 * @returns {Promise<{origin:string, base:string, stop:function():Promise<void>}>}
 */
async function startServer(root, opts) {
  const dir = path.resolve(root || PUBLIC_DIR);
  // Longest prefix first, so '/emulator/v1/' can sit in front of '/v1/'.
  const routes = Object.keys((opts && opts.proxy) || {})
    .sort(function (a, b) { return b.length - a.length; })
    .map(function (prefix) { return { prefix: prefix, target: toAddress(opts.proxy[prefix]) }; })
    .filter(function (route) { return !!route.target; });
  const live = new Set();
  // '' when serving from the root, or a prefix with no trailing slash when a
  // spec asks for the GitHub Pages shape. With '' the checks below reduce to
  // "pathname starts with '/'", which is always true, so every existing caller
  // sees exactly the behaviour this server has always had.
  const mount = (opts && opts.mountPath) ? String(opts.mountPath).replace(/\/+$/, '') : '';
  const server = http.createServer(function (req, res) {
    let pathname = '/';
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    } catch (err) {
      pathname = '/';
    }
    // Emulator traffic first: it is addressed by path, and none of those paths
    // exist under public/ anyway.
    const route = routes.find(function (candidate) { return pathname.indexOf(candidate.prefix) === 0; });
    if (route) {
      forward(req, res, route.target, live);
      return;
    }
    // Pages answers the slashless project URL with a redirect to the slash
    // form, so the page's relative URLs resolve inside the site; mirror that
    // rather than serving index.html under a base every relative link breaks
    // on — a spec must not go green against a URL shape production redirects.
    if (mount && pathname === mount) {
      res.writeHead(301, { location: mount + '/' });
      res.end();
      return;
    }
    // Under a mount only paths below mountPath exist; anything else is a
    // miss, exactly as Pages answers a URL outside the project. What is left
    // after the prefix comes off resolves the same way as at the root.
    const inSite = pathname.indexOf(mount + '/') === 0;
    const file = inSite ? resolveFile(dir, pathname.slice(mount.length)) : null;
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
  const origin = 'http://127.0.0.1:' + port;
  // Latched so the second stop() is a no-op that still resolves. The offline
  // spec stops its server mid-test (taking it away *is* the test) and stops it
  // again in its finally, which is the only cleanup that runs when an earlier
  // check bails out. Without the latch that pair raises ERR_SERVER_NOT_RUNNING.
  let closing = null;
  return {
    origin: origin,
    // Where the site's pages actually start: origin + '/' at the root,
    // origin + mountPath + '/' under a mount. Specs that must not assume root
    // hosting build every URL from this instead of from origin.
    base: origin + mount + '/',
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
      // Proxied requests live on a second socket this server does not own. A
      // Firestore listen channel would keep that one open long after the page
      // is gone, and server.close() waits for it.
      live.forEach(function (upstream) { upstream.destroy(); });
      live.clear();
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

const CDN_PATTERN = '**://www.gstatic.com/**';

// Where a copy of the CDN's Firebase bundles lives, for a machine that cannot
// reach www.gstatic.com. The files are the CDN's own, fetched once by hand:
//
//   mkdir -p /tmp/zc-fbsdk && cd /tmp/zc-fbsdk
//   for f in app auth firestore; do
//     curl -O https://www.gstatic.com/firebasejs/10.12.2/firebase-$f-compat.js
//   done
//
// Serving them back for the same URLs is a stand-in for the CDN, not for the
// page: the pages, their script tags and their CSP are exactly what ships, and
// the browser runs the same SDK bytes it would have downloaded. Unset, the
// browser goes to the real CDN.
const SDK_MIRROR = process.env.E2E_FIREBASE_SDK || '';

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
 * Point the app's Firebase SDK at the emulators the page's own server is
 * forwarding to. Runs before any page script, so it is in place by the time
 * firebase-config.js decides which mode the app is in.
 *
 * Two halves. The stored config override is the same one Settings writes, so
 * firebase-config.js takes its real path and lands on mode 'firebase'. The
 * property on `window.firebase` catches the compat bundle defining itself and
 * wraps initializeApp, because useEmulator has to be called on handles that do
 * not exist until the app is created — and firebase-config.js creates the app
 * and reads auth() and firestore() off it in one breath.
 *
 * The emulator address is the page's own origin, deliberately: `connect-src
 * 'self'` in the shipped CSP allows exactly that and nothing else.
 * @param {Object} config the firebase config to install
 * @returns {void}
 */
function installEmulatorWiring(config) {
  try {
    window.localStorage.setItem('zc.firebaseConfig', JSON.stringify(config));
  } catch (err) {
    // No storage means no override, and the checks that follow will say so.
  }
  var sdk;
  Object.defineProperty(window, 'firebase', {
    configurable: true,
    get: function () { return sdk; },
    set: function (value) {
      sdk = value;
      if (!value || typeof value.initializeApp !== 'function' || value.zcEmulatorWrapped) return;
      value.zcEmulatorWrapped = true;
      var initializeApp = value.initializeApp;
      value.initializeApp = function () {
        var app = initializeApp.apply(this, arguments);
        var port = Number(window.location.port) ||
          (window.location.protocol === 'https:' ? 443 : 80);
        value.firestore(app).useEmulator(window.location.hostname, port);
        value.auth(app).useEmulator(window.location.origin, { disableWarnings: true });
        return app;
      };
    }
  });
}

/**
 * Open an isolated browser context at one viewport, wired so that anything the
 * page logs as an error ends up in `errors`.
 * @param {Object} browser a Playwright Browser
 * @param {Object} viewport one of VIEWPORTS
 * @param {Object} [opts]
 * @param {Object} [opts.firebase] run this session in firebase mode instead of
 *   demo mode: `{ config }` is installed as the stored Firebase config and the
 *   SDK is pointed at the emulators through the page's own origin. The CDN is
 *   then let through, because the real SDK has to load.
 * @returns {Promise<{context:Object, page:Object, errors:string[]}>}
 */
async function openSession(browser, viewport, opts) {
  const firebase = (opts && opts.firebase) || null;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height }
  });

  if (!firebase) {
    // Blocking the Firebase CDN is what puts the app into demo mode, which is
    // the only mode a test can drive without a project or an emulator behind it.
    await context.route(CDN_PATTERN, function (route) { return route.abort(); });
  } else {
    if (SDK_MIRROR) {
      await context.route(CDN_PATTERN, function (route) {
        const file = path.join(SDK_MIRROR, path.basename(new URL(route.request().url()).pathname));
        if (!isFile(file)) return route.continue();
        return route.fulfill({
          status: 200,
          contentType: 'text/javascript; charset=utf-8',
          body: fs.readFileSync(file)
        });
      });
    }
    await context.addInitScript(installEmulatorWiring, firebase.config);
  }

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
    // Only a session that aborted the CDN may write its failures off as
    // expected. When the SDK is supposed to load, a gstatic error is the
    // whole story and has to be reported.
    if (!firebase && isExpectedCdnNoise(msg)) return;
    if (state.expectingNetworkErrors && isResourceFailure(text)) return;
    // Chromium points a failed-resource message at the resource, not at the
    // page. Recording that is what lets a spec tell one "Failed to load
    // resource" apart from another — "status 400" alone names nothing.
    const location = (typeof msg.location === 'function' && msg.location()) || {};
    const where = location.url && location.url !== page.url() ? location.url : page.url();
    errors.push('console.error @ ' + where + ' :: ' + text);
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
