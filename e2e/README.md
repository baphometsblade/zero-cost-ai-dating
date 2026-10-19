# End-to-end suite

The flows in here are DOM-driven, so no unit test can reach them: demo sign-in, the deck
and its keyboard, the match burst, chat persistence, profile and settings, reporting a
user (filing it, retracting it, and the block-and-unmatch branch), the data export and
account deletion, the deck fitting the viewport and every signed-in page held to its
width, offline navigation once the service worker has precached, hosting under a subpath,
the premium simulation, what a keyboard or screen-reader user is given, rewind, and —
against the emulators, when they are running — the Firebase path itself.
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
npm run test:e2e -- --require=firebase # the Firebase spec must run: a skip is a failing check
```

## The Firebase spec, and the emulators

`specs/10-firebase.e2e.js` is the only spec that runs the app against Firebase rather than
against localStorage. It needs the Firestore **and** Auth emulators; with either one
unreachable it prints `SKIP` and contributes no checks, so `npm run test:e2e` on a machine
with no emulator is exactly the run it always was.

firebase.json ships an `emulators` block — `firestore` on 8080, `auth` on 9099, the UI off
— so the emulators start from the repository itself:

```sh
npx --yes firebase-tools emulators:exec --only firestore,auth --project demo-zc-browser \
  "NODE_PATH=/tmp/pw/node_modules npm run test:e2e -- firebase"
```

This used to say the opposite — "firebase.json has no `emulators` block ... so the emulator
config lives outside the repo" — and walked the reader through writing a second firebase.json
into /tmp by hand. That block has been in the repository since the Auth emulator was added
for this spec, and the hand-written copy it described was a copy of it.

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

A spec that deliberately MAKES the app fail — injecting a rejected store call to reach a
failure branch — has the same problem from the other side: the `console.error` it provokes
is the app behaving correctly, and every session treats a console error as a failure of the
whole spec. `session.expectConsoleError(/pattern/)` opens a window for exactly that message
and `expectConsoleError(null)` closes it again. A pattern rather than a boolean, so arming
it cannot swallow a second, unrelated error that happens to land inside the window — the
same reasoning as `expectNetworkErrors`, which is deliberately narrow for the same reason.

If the machine cannot reach `www.gstatic.com`, point `E2E_FIREBASE_SDK` at a directory
holding the CDN's own bundles (`firebase-app-compat.js`, `firebase-auth-compat.js`,
`firebase-firestore-compat.js` for the version the pages pin) and the session serves those
bytes for those URLs. Nothing about the pages changes — only where the same script comes
from.

## Layout

| Path | What it is |
| --- | --- |
| `run.js` | the runner: loads specs, opens a context per spec and viewport, prints results, exits non-zero on any failure, and on a complete run (no spec filter, no `--viewport`) holds the count to the total `scripts/claims.js` claims for it |
| `harness.js` | finding Playwright, serving `public/` the way Firebase Hosting does — both halves of `cleanUrls`, the extensionless page AND the 301 for a path that names the `.html`, which it used to skip — optionally forwarding the emulators' paths through that same origin, opening a browser session, and the page steps every spec shares |

One flow per spec, run in file-name order. `tests/docs.test.js` fails if a spec exists
without a row here, so this list cannot quietly fall behind `specs/`.

| Spec | The flow it drives |
| --- | --- |
| `specs/01-deck.e2e.js` | signing in, the deck rendering with scores and the reasons behind them, and the full keyboard path through it, including a key held down, or Enter held on one of the deck's buttons, making one swipe rather than one for every auto-repeat. It also covers what the deck does when storage moves under it. A swipe whose write fails while the next one waits for its budget gets its own card back, and the next one takes its own: the spec holds both and lets them go in that order, so the overlap always happens. A like on a card already passed elsewhere is told the pass stands, and spends no like and no learning. A retry that finds the deck's own first write on record (a write reported lost that had landed) is counted once and taught. And a deck left open across midnight re-reads its budgets, as does one come back to on a later day through `visibilitychange` or `pageshow` with no timer having run, so the hint and the Super button belong to the new day |
| `specs/02-match-burst.e2e.js` | right-swiping somebody who already liked you: the burst, and the icebreakers it offers. Then the burst arriving when the like's write answers rather than when the like is made. Arriving in the middle of the next card's drag, it leaves that card to spring back unstamped, with nothing stored for it. Arriving while the keyboard-shortcuts dialog is open, it waits for the dialog to close and then takes the focus, and Escape closes it even once a click has put the focus on the page |
| `specs/03-matches.e2e.js` | the matches list, opening a conversation, sending a message, and finding it still there after a reload, and much of what surrounds that. The list's relative stamps keep ticking with no conversation open, after Back on a phone, and beside a conversation that has ended. A long conversation opens at its newest message with the composer on screen, on a phone and at 1280x800, where the composer once finished below the window. A conversation longer than Firestore's live window (simulated, because the demo store delivers every message) is extended rather than rebuilt when a new message slides the window, so that one message is announced and the reader's selection and scroll position survive it. A counter the store refuses to clear is still shown as unread, and is asked again when the reader comes back to the tab rather than by every delivery in between. A press on a row outlasts a list delivery that changes nothing on it. And the spec drives what the page says and does when its live streams fail or the browser says it is offline, and a conversation restored from the back-forward cache, or ended by the other side. A dialog over a conversation keeps two promises. Escape closes the dialog and goes no further: on a phone it used to close the conversation behind it and empty the composer. And a destructive confirmation opens on Cancel, so the repeat of an Enter held on Unmatch dismisses it instead of unmatching. With the viewer's distance narrowed to 50 km and one liker paused, the premium who-liked-you panel sends to Discover only the likers the deck will show and lists the rest apart. It points at Settings only when widening the viewer's own filters would bring them back, and it still counts everyone the nav badge does. On Free the count no longer promises that all of them are in the deck. A match's full card keeps its score and reasons when only the other person's settings would keep them out of the deck. It names the viewer's filters only when those are a cause, and never prints "Not shown" on a card that is shown. Last, in sessions of their own with the time zone and clock moved, a day separator says "Yesterday" over the previous calendar day on the nights the clocks change: at 00:30 in New York the night after they go forward, when 24 hours back is two days back, and at 23:30 in Nuuk the day after they skip from 23:00 to midnight, when this time of day one date back never existed |
| `specs/04-profile-settings.e2e.js` | editing your profile and changing your settings, including the fields the deck then filters on, a location label emptied and saved, and what Settings says when a preference fails to save or your reports cannot be read. A rename saved in Settings survives a profile save from a tab opened before it, and that tab takes up the new name. After leaving with unsaved edits and pressing Back, the profile's bio box, counter and save line agree, Save stores what the box shows, and the discovery read-outs describe their sliders; each Back check records what the browser restored at `pageshow`, so a browser that restores nothing fails it rather than passing it. An ordinary load whose `load` event is held by a slow photo (in a context of its own, with the service worker kept out) keeps the error a Save showed and a date typed halfway. Then onboarding handing someone on to the page they were headed for (`?next=`) rather than always to the deck, signing in as someone else in another tab moving a page on before the new account's profile has loaded (in a context of its own, with the service worker kept out so the sign-in page can be stubbed), and signing out in one tab taking a second tab, open on the matches page, off to sign in |
| `specs/05-reports.e2e.js` | reporting somebody, retracting the report, and the block that outlives it. The report dialog opens on its reason and the retract confirmation on Cancel, so a held Enter can neither file a report nor retract one |
| `specs/06-layout.e2e.js` | the deck fitting the viewport — measured, not eyeballed, at every size the suite runs: on a phone, the action row on screen and the page not scrolling; on a desktop, every swipe button somewhere a pointer can land on it without a sideways scroll. Then every signed-in page, held to the viewport's width, and loaded with the layout shift that moves `<main>` added up, which has to come to nothing: no page may jump when the shared header mounts. And then each page left to finish — its data landed (the deck's first card or its empty state; the reports section done loading), nothing still marked busy on screen, half a second without a shift — with every shift it made on the way added up, whatever moved, and held under 0.1, Core Web Vitals' line for "good": the matches page's conversation card dropping 228px when the new-matches strip arrived above it, and the plans page filling an empty usage list above its switch buttons, each failed it. Last, the theme chosen in Settings is the one the first paint shows, dark on a light OS and light on a dark one, read with `app.js` held until after that paint |
| `specs/07-offline.e2e.js` | the service worker precaching, then serving the app with the network gone. Then a deploy under a returning visitor: the app served with the Cache-Control `firebase.json` gives each file, to a browser of the spec's own whose HTTP cache is on (every harness session routes the Firebase SDK away, and routing turns that cache off), a script changed on the server, and a reload that has to run the new one — with a service worker in control, and with none. Then offline after a deploy that leaves `sw.js` alone: a changed page and script, the page visited online and opened again with the server gone, both at the root the way Firebase Hosting serves it and under a GitHub Pages subpath. The page and its script have to come from the deploy that visit saw, and the visit has to have replaced the installed copy of the page |
| `specs/08-delete-account.e2e.js` | exporting your data first — whole, marked where it is not, or refused when your swipe history cannot be read — then the exact phrase that has to be typed before your account can be deleted, the deletion, and the deck turning the deleted account away afterwards |
| `specs/09-subpath.e2e.js` | hosting under a subpath: where the shared server serves `public/` at the root, this spec starts its own with `public/` mounted at `/zero-cost-ai-dating`, the way GitHub Pages serves a project site, and proves navigation, the service worker and the 404 page all survive the subpath, and that with the server stopped the worker still answers the bare subpath with the landing page and the clean `matches` URL with the matches page |
| `specs/10-firebase.e2e.js` | the one spec that runs in firebase mode, against the emulators, and reads every result back out of Firestore. Its sign-in round trip also checks that a password reset answers an unknown address exactly as a real one (the emulator, like older projects, reports unknown addresses), and that switching to Create account while a sign-in is held at the network changes nothing until it answers. A signed-in visitor opening Settings is never shown the guest's header ("Sign in", no tab bar) while Firebase restores the session: Firestore is held at the network until the page has mounted its first header, so that header is always drawn before the session is known, and every header the page mounts is recorded. A sign-out made to fail must not leave the page deaf: a sign-out in another tab afterwards still moves it. Last, two accounts made directly in the Auth emulator sign in through the form: one whose provider name is 70 characters must get `users/{uid}` (its name cut to 40) and the onboarding editor, and one with a finished profile stored with an empty email must reach the deck with the email corrected to its own |
| `specs/11-subscription.e2e.js` | the premium simulation: that the page says plainly it takes no money and asks for no card, that declining the confirmation changes nothing, and that accepting it actually moves the entitlement the deck reads. The entitlement is read at the gates, not off the plan field: the daily limit in the deck's hint and the `adaptive` option the ranking engine is handed, with the limits table changed underneath once to show that the deck, the plans page and a match's card on the matches page all follow the same table. Also that each of the free plan's rows tells a screen reader whether the feature is included, that a usage read that fails is said so rather than painted as a full allowance, that today's usage is as tall when its counters land as it arrived — on Free, on Premium, whose unlimited rows have no meter and once pulled the plan cards up 20px, and when the read fails and one line stands where three rows were — that a page which cannot start at all — its sign-in guard rejecting, or missing because `auth.js` did not load — clears the placeholder usage rows it arrived with rather than leaving them standing as a record with its numbers on the way, that a switch reads the account twice — each one read of `users/{uid}` in firebase mode — and not a third time for counters the write already returned, and that counters it returns from a day that has ended are asked of the store again rather than shown |
| `specs/12-accessibility.e2e.js` | the promises the docs make about keyboards and motion, executed: landmarks and accessible names on every page, `prefers-reduced-motion` actually stilling the deck, the modal's focus trap in both directions with Escape and focus restored, and the two pane swaps that strand a keyboard user if focus is not moved deliberately. The new-matches strip has to open a conversation in place as a row does, with focus on the composer, rather than load the whole page again. ArrowUp inside the deck's full explanation is left to scroll it rather than spending a super like. The focus stays on the deck when a button disables itself (the day's last super like) or Retry rebuilds the deck. And focus walked through settings and the profile with Tab and Shift+Tab never lands entirely under the sticky header or the phone's tab bar. It also checks what a screen reader is handed. The conversation list reaches the browser's accessibility tree as one list item per conversation, and each row is named by what it shows, the message included. The daily-limit banner is announced once, by a live region that was already on the page and exposed, and that region is not written to again: not by the countdown ticking in the last hour before midnight, and not when a like is refused under the banner, which the deck says in its own region |
| `specs/13-rewind.e2e.js` | rewind puts back a swipe nobody answered, and refuses to take down a match that formed after it — the reciprocal like arriving while the card is still the last thing in the deck's history, which the deck's own `matched` flag was stamped too early to see; the refusal has to reach the toast and the live region, and neither the match nor the swipe may be deleted |

A spec exports `{ title, viewports, run(t, page, ctx) }`. `t.check(name, ok, detail)`
records one named expectation and keeps going; throwing aborts that spec and fails it,
under the name `spec ran to completion` rather than the name of whatever was being waited
for. So a wait for the thing a check names gets a bound of its own, and its answer is what
the check records: a wait left to the session's 20-second default throws when it runs out,
and a `t.check(name, true)` written after it can only pass. Nor can `page.waitForFunction`
wait on the store: a predicate that returns a Promise counts as true on its first call, so
the wait settles on that one read. Poll inside `page.evaluate` with a deadline instead, as
`waitForSwipes` in `specs/13-rewind.e2e.js` does. `navigator.serviceWorker.ready` is the
same trap from the other side — it settles only once a worker is active, and
`page.evaluate` has no timeout of its own, so a broken install hung the run there — which is
why `specs/07-offline.e2e.js` and `specs/09-subpath.e2e.js` race it against 15 seconds. And
a navigation that failed is kept apart from the title of one that landed: the failure text
carries the URL, so `/Matches/i` once passed on "…/matches" in an error message.

Two optional exports: `session`, the options its browser context wants (see
`harness.openSession`), and `available()`, which returns `{ ok, why }` — a spec whose
requirements are missing is skipped by name and reason, and records nothing at all, so a
run that could not test something never reports a check for it. On a complete run — every
spec, at every viewport it declares — only the Firebase spec may skip: `scripts/claims.js`
claims one total for a run in which nothing skipped and one for a run in which that spec
alone did, and `run.js` fails a complete run in which any other spec skipped, because
there is no number to hold it to. Under `--require=firebase` not even the Firebase spec
may skip: its skip is recorded as a failing check. That is how CI's `emulators:exec` step
runs the suite, so that the total with the Firebase spec is actually held to account. A
second spec that grows an `available()` needs `run.js` taught its skip shape and a total
of its own in `scripts/claims.js`.

Waiting for a page by URL goes through `harness.pageUrl(name)`, never a `'**/dashboard.html'`
glob. The app links with relative `.html` URLs, so on GitHub Pages the address bar ends in
`.html` — and on Firebase Hosting it never does, because the 301 lands on `/dashboard`. Every
wait in this suite used to name the one shape production never shows, and passed only
because this server did not redirect.

Two things are load-bearing about the naming. Specs are `*.e2e.js` and live outside
`tests/`, because `npm test` is `node --test` from the repo root and anything it discovers
would run in CI on a machine with no browser. And for every spec but the Firebase one the
CDN is aborted on purpose: that is what puts the app into demo mode, which is the only
mode a test can drive with nothing behind it.
