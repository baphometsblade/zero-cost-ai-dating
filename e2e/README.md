# End-to-end suite

The flows in here are DOM-driven, so no unit test can reach them: demo sign-in, the deck
and its keyboard, the match burst, chat persistence, profile and settings, reporting a
user, account deletion, the phone layout, and offline navigation once the service worker
has precached.
Every check runs at 390x844 and at 1280x800 unless the spec says otherwise.

## Running it

Playwright is **not** a dependency of this repo and must not become one — `dependencies`
and `devDependencies` stay empty. Install it somewhere else and point Node at it:

```sh
npm install --prefix /tmp/pw playwright@1.56.0
npx --yes playwright@1.56.0 install --with-deps chromium

NODE_PATH=/tmp/pw/node_modules npm run test:e2e
```

`E2E_PLAYWRIGHT=/path/to/playwright` works too. With no Playwright at all the runner exits
3 and prints a one-line hint, so "no browser here" never looks like a failing test.

```sh
npm run test:e2e                       # everything
npm run test:e2e -- deck matches       # only specs whose file name matches
npm run test:e2e -- --viewport=mobile  # only 390x844
```

## Layout

| Path | What it is |
| --- | --- |
| `run.js` | the runner: loads specs, opens a context per spec and viewport, prints results, exits non-zero on any failure |
| `harness.js` | finding Playwright, serving `public/` the way Firebase Hosting does (clean URLs), opening a browser session, and the page steps every spec shares |
| `specs/*.e2e.js` | one flow each, in file-name order |

A spec exports `{ title, viewports, run(t, page, ctx) }`. `t.check(name, ok, detail)`
records one named expectation and keeps going; throwing aborts that spec and fails it.

Two things are load-bearing about the naming. Specs are `*.e2e.js` and live outside
`tests/`, because `npm test` is `node --test` from the repo root and anything it discovers
would run in CI on a machine with no browser. And the Firebase CDN is aborted on purpose:
that is what puts the app into demo mode, which is the only mode a test can drive without
a real project behind it.
