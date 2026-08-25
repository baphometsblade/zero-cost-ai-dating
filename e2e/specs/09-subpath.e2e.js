/* GitHub Pages hosts the live demo under /zero-cost-ai-dating/, not at the
   root — a shape no other spec exercises, because the shared server mounts
   public/ at '/'. Same app, mounted server: if a root-hosting assumption
   creeps back in (an absolute path, the old offline fallback arithmetic, a
   404 page that loads relative assets), one of these checks goes red. */
'use strict';

module.exports = {
  title: 'Subpath hosting, as GitHub Pages serves it',
  viewports: ['mobile'],

  async run(t, page, ctx) {
    const h = ctx.harness;
    // A private, mounted server: the shared one serves from the root, which is
    // precisely the shape this spec must not test. It is stopped twice on
    // purpose — once mid-test, once as cleanup — which h.startServer() allows.
    const server = await h.startServer(undefined, { mountPath: '/zero-cost-ai-dating' });
    const base = server.base;

    try {
      // The landing page, from under the subpath. The runner's closing
      // no-console-errors check makes this double as proof that the CSP meta
      // tag every page now carries blocks nothing the app actually loads.
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      t.check('the landing page loads from under the subpath',
        /explains itself/i.test(await page.title()), await page.title());

      // Links are relative throughout, so navigation must stay inside the
      // mount — an absolute href would walk off the project onto the 404 page.
      await page.click('[data-cta="secondary"]');
      await page.waitForURL('**/auth.html');
      t.check('clicking through to sign-in stays under the subpath',
        page.url() === base + 'auth.html', page.url());

      // Signed in on purpose, exactly like the offline spec: matches.html is
      // behind the auth guard, and the offline checks below need to reach it.
      // signIn() takes an origin-shaped base, i.e. no trailing slash.
      await h.signIn(page, base.slice(0, -1));

      // The worker registers relatively, so its scope must be the mount, not
      // the origin — scope is what decides which navigations it may answer.
      await page.goto(base + 'index.html', { waitUntil: 'domcontentloaded' });
      const scope = await page.evaluate(function () {
        return navigator.serviceWorker.ready.then(function (reg) { return reg.scope; });
      });
      t.check('the service worker scope is the subpath, not the origin', scope === base, scope);

      // The worker precaches on install; wait for the cache to actually hold
      // the shell rather than for an arbitrary delay. Matched by name prefix,
      // not exact name, because the version suffix bumps whenever the shell
      // changes and this spec cares that a shell is cached, not which vintage.
      // The relative match() URLs resolve against this page, so a hit here
      // also proves the cache keys live under the mount.
      const cached = await page.evaluate(function () {
        const wanted = ['index.html', 'matches.html', '404.html'];
        const deadline = Date.now() + 15000;
        function holdsShell(name) {
          return caches.open(name).then(function (cache) {
            return Promise.all(wanted.map(function (file) { return cache.match(file); }));
          }).then(function (hits) { return hits.every(Boolean); });
        }
        function poll() {
          return caches.keys().then(function (names) {
            const mine = names.filter(function (name) { return name.indexOf('zc-static-') === 0; });
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

      // Still online: a nested missing path. Pages answers every missing URL
      // with 404.html, and at this depth every relative URL inside it would
      // resolve into the missing directory and 404 in turn — the page has to
      // carry everything it needs.
      const before = ctx.session ? ctx.session.errors.length : 0;
      const missing = await page.goto(base + 'nowhere/deeper', { waitUntil: 'load' });
      t.check('a nested missing path answers 404 with the 404 page',
        !!missing && missing.status() === 404 && /not found/i.test(await page.title()),
        (missing ? missing.status() : 'no response') + ' "' + (await page.title()) + '"');

      // Chromium reports the navigation's own 404 status as a console error —
      // that one line is the server doing its job, and it is the only request
      // on this page that may fail. The spec claims exactly that line and
      // leaves the runner's closing gate armed for anything else: a relative
      // stylesheet in the 404 page would push a second failed-resource error
      // and go red right here.
      if (ctx.session) {
        // Console events trail the navigation slightly; wait for the expected
        // line, then a beat longer so a straggling second failure still counts.
        const deadline = Date.now() + 5000;
        while (ctx.session.errors.length === before && Date.now() < deadline) {
          await new Promise(function (resolve) { setTimeout(resolve, 100); });
        }
        await new Promise(function (resolve) { setTimeout(resolve, 300); });
        const fresh = ctx.session.errors.slice(before);
        const onlyTheDocument = fresh.length === 1 &&
          fresh[0].indexOf('nowhere/deeper') !== -1 &&
          /Failed to load resource/i.test(fresh[0]);
        t.check('the 404 page loads nothing beyond the document itself',
          onlyTheDocument, fresh.join(' | ') || 'no console error at all for the 404 document');
        if (onlyTheDocument) ctx.session.errors.splice(before);
      }

      // Going offline, for real — same drill as the offline spec: everything
      // below is answered by the service worker or not at all, and the spec
      // declares the window in which same-origin fetch failures are expected.
      if (ctx.session) ctx.session.expectNetworkErrors(true);
      await server.stop();

      const seen = {};
      for (const url of [base, base + 'matches']) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          seen[url] = await page.title();
        } catch (err) {
          seen[url] = 'NAVIGATION FAILED: ' + (err && err.message ? err.message.split('\n')[0] : err);
        }
      }

      // The exact navigations the old fallback arithmetic got wrong: it read
      // the page name straight out of url.pathname, so the bare base computed
      // 'zero-cost-ai-dating.html' and served the 404 shell. With the base
      // stripped first, '' maps to index.html and 'matches' to matches.html.
      t.check('offline, the bare subpath serves the landing page',
        /explains itself/i.test(seen[base]), seen[base]);
      t.check('offline, the clean matches URL serves the matches page',
        /Matches/i.test(seen[base + 'matches']), seen[base + 'matches']);
    } finally {
      // The cleanup half of the stop pair — the only one that runs when an
      // earlier check bails out. Idempotent when the mid-test stop ran too.
      await server.stop();
    }
  }
};
