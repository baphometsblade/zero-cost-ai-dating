# End-to-end suite

The flows in here are DOM-driven, so no unit test can reach them: demo sign-in, the deck
and its keyboard, the match burst, chat persistence, profile and settings, reporting a
user (filing it, retracting it, and the block-and-unmatch branch), account deletion, the
phone layout, offline navigation once the service worker has precached, and — against the
emulators, when they are running — the Firebase path itself.
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

## The Firebase spec, and the emulators

`specs/10-firebase.e2e.js` is the only spec that runs the app against Firebase rather than
against localStorage. It needs the Firestore **and** Auth emulators; with neither reachable
it prints `SKIP` and contributes no checks, so `npm run test:e2e` on a machine with no
emulator is exactly the run it always was.

firebase.json has no `emulators` block — nothing shipped needs one, and the Auth emulator
will not start without it — so the emulator config lives outside the repo alongside the
rest of the toolchain:

```sh
mkdir -p /tmp/zc-emu && cd /tmp/zc-emu
cat > firebase.json <<'JSON'
{
  "firestore": { "rules": "/absolute/path/to/zero-cost-ai-dating/firestore.rules" },
  "emulators": {
    "auth": { "port": 9099 },
    "firestore": { "port": 8080 },
    "ui": { "enabled": false }
  }
}
JSON

npx --yes firebase-tools emulators:exec --only firestore,auth --project demo-zc-browser \
  "cd /absolute/path/to/zero-cost-ai-dating && NODE_PATH=/tmp/pw/node_modules npm run test:e2e -- firebase"
```

`emulators:exec` exports `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` and
`GCLOUD_PROJECT`, which is how the spec finds them; started by hand it falls back to
127.0.0.1:8080, 127.0.0.1:9099 and project `demo-zc-browser`. The project matters: it is
the one the emulator loaded `firestore.rules` for, and the spec's first check proves an
anonymous write is refused rather than trusting that it did.

The spec drives the shipped pages **with their real CSP meta tag**, which allows
`connect-src 'self'` and nothing on another port. Rather than relax that, the spec's own
static server forwards the emulators' paths (`harness.startServer`'s `proxy` option), so
every request the SDK makes goes to the page's own origin. `page.addInitScript` writes the
same stored config Settings writes and wraps `initializeApp`, so the app's own
`firebase-config.js` decides it is in firebase mode by its ordinary route.

Two consequences of folding Firestore onto the page's origin, both handled in
`harness.js` and both worth knowing before changing that code:

* a browser allows six connections per origin over HTTP/1.1, and Firestore's Listen and
  Write channels are long-lived, so proxied answers are closed on a timer — without that
  the page reached six open channels and then every request, static files included, waited
  forever;
* a transaction that loses a race answers `400 FAILED_PRECONDITION` before the SDK replays
  it, which is a console error in a browser even though nothing is wrong. The spec accounts
  for that shape explicitly rather than the harness widening its rule for everyone.

If the machine cannot reach `www.gstatic.com`, point `E2E_FIREBASE_SDK` at a directory
holding the CDN's own bundles (`firebase-app-compat.js`, `firebase-auth-compat.js`,
`firebase-firestore-compat.js` for the version the pages pin) and the session serves those
bytes for those URLs. Nothing about the pages changes — only where the same script comes
from.

## Layout

| Path | What it is |
| --- | --- |
| `run.js` | the runner: loads specs, opens a context per spec and viewport, prints results, exits non-zero on any failure |
| `harness.js` | finding Playwright, serving `public/` the way Firebase Hosting does (clean URLs), optionally forwarding the emulators' paths through that same origin, opening a browser session, and the page steps every spec shares |

One flow per spec, run in file-name order. `tests/docs.test.js` fails if a spec exists
without a row here, so this list cannot quietly fall behind `specs/`.

| Spec | The flow it drives |
| --- | --- |
| `specs/01-deck.e2e.js` | signing in, the deck rendering with scores and the reasons behind them, and the full keyboard path through it |
| `specs/02-match-burst.e2e.js` | right-swiping somebody who already liked you: the burst, and the icebreakers it offers |
| `specs/03-matches.e2e.js` | the matches list, opening a conversation, sending a message, and finding it still there after a reload |
| `specs/04-profile-settings.e2e.js` | editing your profile and changing your settings, including the fields the deck then filters on |
| `specs/05-reports.e2e.js` | reporting somebody, retracting the report, and the block that outlives it |
| `specs/06-layout.e2e.js` | the deck fitting the viewport — measured, not eyeballed, at every size the suite runs |
| `specs/07-offline.e2e.js` | the service worker precaching, then serving the app with the network gone |
| `specs/08-delete-account.e2e.js` | deleting your account, and what is left behind afterwards (nothing that names you) |
| `specs/09-subpath.e2e.js` | the one spec that skips the shared server: it mounts `public/` at `/zero-cost-ai-dating`, the way GitHub Pages serves a project site, and proves navigation, the service worker and the 404 page all survive the subpath |
| `specs/10-firebase.e2e.js` | the one spec that runs in firebase mode, against the emulators, and reads every result back out of Firestore |
| `specs/11-subscription.e2e.js` | the premium simulation: that the page says plainly it takes no money and asks for no card, that declining the confirmation changes nothing, and that accepting it actually moves the entitlement the deck reads |
| `specs/12-accessibility.e2e.js` | the promises the docs make about keyboards and motion, executed: landmarks and accessible names on every page, `prefers-reduced-motion` actually stilling the deck, the modal's focus trap in both directions with Escape and focus restored, and the two pane swaps that strand a keyboard user if focus is not moved deliberately |
| `specs/13-rewind.e2e.js` | rewind puts back a swipe nobody answered, and refuses to take down a match that formed after it — the reciprocal like arriving while the card is still the last thing in the deck's history, which the deck's own `matched` flag was stamped too early to see; the refusal has to reach the toast and the live region, and neither the match nor the swipe may be deleted |

A spec exports `{ title, viewports, run(t, page, ctx) }`. `t.check(name, ok, detail)`
records one named expectation and keeps going; throwing aborts that spec and fails it.
Two optional exports: `session`, the options its browser context wants (see
`harness.openSession`), and `available()`, which returns `{ ok, why }` — a spec whose
requirements are missing is skipped by name and reason, and records nothing at all, so a
run that could not test something never reports a check for it.

Two things are load-bearing about the naming. Specs are `*.e2e.js` and live outside
`tests/`, because `npm test` is `node --test` from the repo root and anything it discovers
would run in CI on a machine with no browser. And for every spec but the Firebase one the
CDN is aborted on purpose: that is what puts the app into demo mode, which is the only
mode a test can drive with nothing behind it.
