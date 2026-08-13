/* The service worker's whole point: once the shell is cached, the clean URLs
   Firebase Hosting serves must keep working with no server at all. This spec
   runs its own server precisely so it can take it away. */
'use strict';

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
      const registered = await page.evaluate(function () {
        return navigator.serviceWorker.ready.then(function (reg) {
          return !!(reg && reg.active);
        });
      });
      t.check('the service worker installs and activates', registered);

      // The worker precaches on install; wait for the cache to actually hold
      // the shell rather than for an arbitrary delay.
      const cached = await page.evaluate(function () {
        const wanted = ['index.html', 'matches.html', '404.html'];
        const deadline = Date.now() + 15000;
        function poll() {
          return caches.open('zc-static-v2').then(function (cache) {
            return Promise.all(wanted.map(function (name) { return cache.match(name); }));
          }).then(function (hits) {
            if (hits.every(Boolean)) return true;
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
      const seen = {};
      for (const route of ['/', '/matches', '/definitely-not-a-page']) {
        try {
          await page.goto(server.origin + route, { waitUntil: 'domcontentloaded', timeout: 15000 });
          seen[route] = await page.title();
        } catch (err) {
          seen[route] = 'NAVIGATION FAILED: ' + (err && err.message ? err.message.split('\n')[0] : err);
        }
      }

      // Matched on the tagline, not the product name: the 404 page carries the
      // name too, and a fallback that quietly served it would still "pass".
      t.check('offline "/" serves the landing page', /explains itself/i.test(seen['/']), seen['/']);
      t.check('offline "/matches" serves the matches page', /Matches/i.test(seen['/matches']), seen['/matches']);
      t.check('offline an unknown route serves the 404 page',
        /404|not found|lost/i.test(seen['/definitely-not-a-page']), seen['/definitely-not-a-page']);

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
  }
};
