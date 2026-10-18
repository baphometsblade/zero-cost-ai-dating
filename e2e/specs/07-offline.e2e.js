/* The service worker's whole point: once the shell is cached, the clean URLs
   Firebase Hosting serves must keep working with no server at all. This spec
   runs its own server precisely so it can take it away.

   And the other side of caching: after a deploy, a returning visitor runs that
   deploy's scripts, not the ones their browser kept. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Load the app as a returning visitor, deploy a changed script under it, and
 * report whether a reload ran the new one.
 *
 * Production's caching, as close as this suite gets to it: the site is served
 * with the Cache-Control firebase.json gives each file, and the browser is one
 * of this spec's own. Every session the harness opens routes the Firebase SDK
 * away, and Playwright turns the HTTP cache off for any context that routes —
 * which is why no spec could see this. Here the SDK's hosts simply do not
 * resolve, so the page falls back to demo mode with the cache left on.
 *
 * Scripts were cached for an hour against pages that were not, so for that
 * hour after a deploy a reload ran the old scripts against the new page, with
 * the service worker in control or without one: its network-first fetch goes
 * through the same HTTP cache. PR #48 met it as a conversation list that never
 * appeared, under a matches.js that did not know to reveal it.
 * @param {Object} h the harness
 * @param {'allow'|'block'} workers whether a service worker may take control
 * @returns {Promise<{controlled:boolean, ran:*}>}
 */
async function deployedScriptRuns(h, workers) {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-deploy-'));
  let server = null;
  let browser = null;
  // Everything after the copy is inside the try, so a server that started
  // and a browser that did not still end with the server stopped and the
  // copy gone, rather than a listening port holding the run open.
  try {
    fs.cpSync(h.PUBLIC_DIR, site, { recursive: true });
    server = await h.startServer(site, { cacheHeaders: true });
    browser = await h.loadPlaywright().chromium.launch({
      args: ['--host-resolver-rules=MAP www.gstatic.com ~NOTFOUND, MAP apis.google.com ~NOTFOUND']
    });
    const context = await browser.newContext({ serviceWorkers: workers });
    const page = await context.newPage();
    await h.signIn(page, server.origin);
    // Two more pages, so the worker (when allowed) has installed and claimed
    // the tab, and every script the next load asks for is in the HTTP cache.
    await page.goto(server.origin + '/matches.html', { waitUntil: 'load' });
    await page.goto(server.origin + '/settings.html', { waitUntil: 'load' });
    const controlled = await page.evaluate(function () {
      return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    });
    // The deploy: a script changes on the server, and nothing else does.
    fs.appendFileSync(path.join(site, 'js', 'utils.js'), '\n;window.__zcDeployed = 2;\n');
    await page.goto(server.origin + '/matches.html', { waitUntil: 'load' });
    const ran = await page.evaluate(function () { return window.__zcDeployed || null; });
    return { controlled: controlled, ran: ran };
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
    fs.rmSync(site, { recursive: true, force: true });
  }
}

module.exports = {
  title: 'Offline navigation after precache',
  viewports: ['mobile'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    // A private server, because stopping the shared one would strand the specs
    // that run after this. It is stopped twice on purpose — see below — which
    // h.startServer() is written to allow.
    const server = await h.startServer();

    try {
      // Signed in on purpose: the pages worth reaching offline are the ones
      // behind the auth guard, and a signed-out visitor would simply be
      // redirected to auth.html before the cached page could prove anything.
      await h.signIn(page, server.origin);
      await page.goto(server.origin + '/index.html', { waitUntil: 'domcontentloaded' });
      // `ready` settles only once a worker is active — never, when install
      // fails — and page.evaluate has no timeout of its own, so on its own
      // this check could not fail: a broken install hung the run at this line
      // instead (measured: a CORE entry that 404s, killed after two minutes
      // with nothing printed). Raced against the same 15 s the precache wait
      // below allows, a worker that never activates is a FAIL here.
      const registered = await page.evaluate(function () {
        return Promise.race([
          navigator.serviceWorker.ready.then(function (reg) { return !!(reg && reg.active); }),
          new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 15000); })
        ]);
      });
      if (!t.check('the service worker installs and activates', registered,
        registered ? 'active' : 'no active worker after 15 s')) return;

      // The worker precaches on install; wait for the cache to actually hold
      // the shell rather than for an arbitrary delay.
      const cached = await page.evaluate(function () {
        const wanted = ['index.html', 'matches.html', '404.html'];
        const deadline = Date.now() + 15000;
        // Find the shell by the cache-name prefix rather than the exact
        // version: sw.js bumps its CACHE constant whenever the shell changes,
        // and pinning the literal here would fail this spec on every bump for
        // reasons that have nothing to do with offline behaviour.
        function holdsShell(name) {
          return caches.open(name).then(function (cache) {
            return Promise.all(wanted.map(function (file) { return cache.match(file); }));
          }).then(function (hits) { return hits.every(Boolean); });
        }
        function poll() {
          return caches.keys().then(function (names) {
            const mine = names.filter(function (name) { return name.indexOf('zc-static:') === 0; });
            return Promise.all(mine.map(holdsShell));
          }).then(function (flags) {
            if (flags.some(Boolean)) return true;
            if (Date.now() > deadline) return false;
            return new Promise(function (resolve) { setTimeout(resolve, 200); }).then(poll);
          });
        }
        return poll();
      });
      if (!t.check('the app shell is precached', cached)) return;

      // Going offline, for real: every check below this line is answered by the
      // service worker or not at all. Do not "tidy" this away in favour of the
      // stop() in the finally — that one is cleanup, this one is the test.
      //
      // A page loading from cache with nothing behind it may legitimately log
      // same-origin request failures, so this spec — and only this spec —
      // declares that window. Every other spec still fails on one.
      if (ctx.session) ctx.session.expectNetworkErrors(true);
      await server.stop();

      // Clean URLs, exactly as Hosting serves them: no .html anywhere.
      //
      // A navigation that FAILED is kept apart from the title of one that
      // landed. They used to share one string, and the failure text carries the
      // URL — so against a worker that broke every offline navigation, the
      // "/matches" check still passed, because `/Matches/i` found the word in
      // "net::ERR_FAILED at http://…/matches". Only a title can satisfy these now.
      const seen = {};
      for (const route of ['/', '/matches', '/definitely-not-a-page']) {
        try {
          await page.goto(server.origin + route, { waitUntil: 'domcontentloaded', timeout: 15000 });
          seen[route] = { ok: true, title: await page.title() };
        } catch (err) {
          seen[route] = { ok: false, title: '', failed: err && err.message ? err.message.split('\n')[0] : String(err) };
        }
      }
      /** The title an offline navigation landed on, or null when it did not land. */
      function landed(route) {
        return seen[route] && seen[route].ok ? seen[route].title : null;
      }
      /** What to print beside a check: the title, or why there was none. */
      function shown(route) {
        const out = seen[route] || {};
        return out.ok ? out.title : 'NAVIGATION FAILED: ' + out.failed;
      }

      // Matched on the tagline, not the product name: the 404 page carries the
      // name too, and a fallback that quietly served it would still "pass".
      t.check('offline "/" serves the landing page', /explains itself/i.test(landed('/') || ''), shown('/'));
      t.check('offline "/matches" serves the matches page', /Matches/i.test(landed('/matches') || ''), shown('/matches'));
      t.check('offline an unknown route serves the 404 page',
        /404|not found|lost/i.test(landed('/definitely-not-a-page') || ''), shown('/definitely-not-a-page'));

      // Serving the shell is only half of it: the page has to come up with its
      // own data too, since demo mode keeps everything on the device.
      let rows = -1;
      try {
        await page.goto(server.origin + '/matches', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForSelector('#match-list .match-row', { timeout: 15000 });
        rows = await page.locator('#match-list .match-row').count();
      } catch (err) {
        rows = -1;
      }
      t.check('the cached matches page still lists its conversations offline', rows === 2, 'rows=' + rows);
    } finally {
      // The cleanup half of the pair. The stop above is inside the try and is
      // skipped whenever an earlier check bails out or throws, so the port would
      // leak for the rest of the run without this; when it did run, stop() is
      // idempotent and this call resolves against the same shutdown.
      await server.stop();
    }

    /* ---- after a deploy, the deploy's scripts ---- */

    // firebase.json serves scripts and stylesheets `no-cache` now, so the
    // browser asks before it reuses one; Hosting answers 304 with no body when
    // nothing changed. With the old `max-age=3600` both of these ran the
    // cached script.
    const withWorker = await deployedScriptRuns(h, 'allow');
    t.check('after a deploy, a reload runs the new scripts with the service worker in control',
      withWorker.controlled && withWorker.ran === 2, JSON.stringify(withWorker));
    const withoutWorker = await deployedScriptRuns(h, 'block');
    t.check('and with no service worker at all', withoutWorker.ran === 2, JSON.stringify(withoutWorker));
  }
};
