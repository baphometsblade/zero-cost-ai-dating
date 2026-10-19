/* The service worker's whole point: once the shell is cached, the clean URLs
   Firebase Hosting serves must keep working with no server at all. This spec
   runs its own server precisely so it can take it away.

   And the other side of caching: after a deploy, a returning visitor runs that
   deploy's scripts, not the ones their browser kept — and offline, the page
   they last opened comes back with the scripts it ran, from one deploy. */
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

/**
 * Let the worker precache a returning visitor's shell, deploy a changed page
 * and a changed script under it — and not sw.js, which is the usual deploy —
 * visit that page online, then take the server away and open it again.
 *
 * Offline, the page and its script have to be the deploy the visitor last saw
 * online. On Firebase Hosting they were not: cleanUrls answers every page at
 * its clean URL, so the worker stored the visit under `/matches`, while an
 * offline navigation looks a page up by its file name, `matches.html`, which
 * only the install ever wrote. The scripts live under one name and every
 * visit refreshed them, so offline the install's page ran the latest scripts.
 * GitHub Pages serves the file name itself, so there the names already agreed;
 * both shapes run, so a fix for one host cannot break the other.
 * @param {Object} h the harness
 * @param {Object} browser the browser to open a context of this check's own in
 * @param {Object} viewport one of h.VIEWPORTS
 * @param {string} mount '' for the Firebase Hosting shape, or the project
 *   subpath GitHub Pages serves the site under
 * @returns {Promise<Object>} what the page ran online and offline, and any errors
 */
async function deployedPageOffline(h, browser, viewport, mount) {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-offline-deploy-'));
  let server = null;
  let session = null;
  try {
    fs.cpSync(h.PUBLIC_DIR, site, { recursive: true });
    server = await h.startServer(site, mount ? { mountPath: mount } : undefined);
    session = await h.openSession(browser, viewport);
    const page = session.page;
    // signIn appends '/index.html' to what it is given.
    await h.signIn(page, server.base.replace(/\/$/, ''));
    // An active worker has finished its install, and its install stores the
    // whole shell before it completes — so from here the cache holds deploy 1.
    const active = await page.evaluate(function () {
      return Promise.race([
        navigator.serviceWorker.ready.then(function (reg) { return !!(reg && reg.active); }),
        new Promise(function (resolve) { setTimeout(function () { resolve(false); }, 15000); })
      ]);
    });
    if (!active) return { active: false, errors: session.errors.slice() };

    // The deploy: the page and its script change, sw.js does not.
    const html = path.join(site, 'matches.html');
    fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace('<title>', '<title>Deploy 2 · '));
    fs.appendFileSync(path.join(site, 'js', 'matches.js'), '\n;window.__zcPageDeploy = 2;\n');

    // Asked for by its file name, the way the app's own links ask: Hosting
    // answers with a 301 to `/matches`, Pages with the page.
    await page.goto(server.base + 'matches.html', { waitUntil: 'load' });
    const online = await page.evaluate(function () {
      return { path: location.pathname, title: document.title, js: window.__zcPageDeploy || 1 };
    });

    // The worker writes the cache after it has answered, so wait for those
    // writes rather than for a delay: until the new script is stored and no
    // copy of this page from before the deploy is left anywhere in the shell.
    // A worker that never replaces the old copy runs out the clock, and that
    // alone fails the check.
    const settled = await page.evaluate(function () {
      const deadline = Date.now() + 10000;
      function entries(cache) {
        return cache.keys().then(function (requests) {
          return Promise.all(requests.map(function (request) {
            return cache.match(request).then(function (res) { return res.text(); });
          }));
        });
      }
      function poll() {
        return caches.keys().then(function (names) {
          const mine = names.filter(function (name) { return name.indexOf('zc-static:') === 0; });
          return Promise.all(mine.map(function (name) { return caches.open(name).then(entries); }));
        }).then(function (perCache) {
          const bodies = [].concat.apply([], perCache);
          const script = bodies.some(function (body) { return body.indexOf('__zcPageDeploy') !== -1; });
          const stale = bodies.some(function (body) { return body.indexOf('<title>Matches ·') !== -1; });
          if (script && !stale) return true;
          if (Date.now() > deadline) return false;
          return new Promise(function (resolve) { setTimeout(resolve, 200); }).then(poll);
        });
      }
      return poll();
    });

    // Offline, back to the address the visitor was on: `/matches` on Hosting,
    // `…/matches.html` on Pages. A page served from cache with nothing behind
    // it may log same-origin resource failures, and only those are let through.
    session.expectNetworkErrors(true);
    await server.stop();
    let offline = null;
    try {
      await page.goto(server.origin + online.path, { waitUntil: 'load', timeout: 15000 });
      offline = await page.evaluate(function () {
        return { title: document.title, js: window.__zcPageDeploy || 1 };
      });
    } catch (err) {
      offline = { failed: err && err.message ? err.message.split('\n')[0] : String(err) };
    }
    return { active: true, online: online, settled: settled, offline: offline, errors: session.errors.slice() };
  } finally {
    if (session) await session.context.close();
    if (server) await server.stop();
    fs.rmSync(site, { recursive: true, force: true });
  }
}

/**
 * Which deploy a page load ran: its page by title, its script by the marker.
 * @param {Object|null} side one load from deployedPageOffline
 * @returns {{page:number, script:number}|null} null when the load failed
 */
function deployOf(side) {
  if (!side || side.failed) return null;
  return { page: /^Deploy 2 · /.test(side.title || '') ? 2 : 1, script: side.js };
}

/**
 * Whether deployedPageOffline saw one deploy throughout: the new page and the
 * new script online, the same two offline, and nothing logged as an error.
 * And the visit has to have REPLACED the copy the worker installed, not
 * written one beside it: a worker that stored and looked up pages under a
 * wrong name would agree with itself on the page just visited, and serve the
 * 404 page offline for every page it installed and nobody has visited since.
 * @param {Object} seen what deployedPageOffline returned
 * @returns {boolean}
 */
function oneDeployOffline(seen) {
  const fresh = function (side) { const d = deployOf(side); return !!d && d.page === 2 && d.script === 2; };
  return seen.active && seen.settled && fresh(seen.online) && fresh(seen.offline) && seen.errors.length === 0;
}

/**
 * The same, short enough for the runner's one-line detail.
 * @param {Object} seen what deployedPageOffline returned
 * @returns {string}
 */
function describeDeploys(seen) {
  if (!seen.active) return 'no active worker after 15 s; errors: ' + seen.errors.join(' | ');
  const side = function (load) {
    const d = deployOf(load);
    return d ? 'page ' + d.page + ' script ' + d.script : 'FAILED ' + (load && load.failed);
  };
  return 'online ' + side(seen.online) + ' at ' + seen.online.path + '; offline ' + side(seen.offline) +
    '; cache settled: ' + seen.settled + '; errors: ' + (seen.errors.join(' | ') || 'none');
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

    /* ---- after a deploy, offline: the page and its scripts from one deploy ---- */

    const browser = page.context().browser();
    const onHosting = await deployedPageOffline(h, browser, ctx.viewport, '');
    t.check('offline after a deploy, a page visited online and its scripts are one deploy (Firebase Hosting)',
      oneDeployOffline(onHosting), describeDeploys(onHosting));
    const onPages = await deployedPageOffline(h, browser, ctx.viewport, '/zero-cost-ai-dating');
    t.check('and under a GitHub Pages project subpath',
      oneDeployOffline(onPages), describeDeploys(onPages));
  }
};
