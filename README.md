# Zero Cost AI Dating

**Dating that actually explains itself.**

A Tinder-style dating app where the matching is done by a real, inspectable ranking engine
that runs **on your device** — no model API, no inference bill, no data leaving the browser
to be scored. Every card in the deck arrives with a compatibility number *and* the reasons
behind it: which interests you share, how your personalities line up, how far away they are,
which words your two bios have in common.

It is built to run on Firebase's **free Spark plan forever**: static hosting, Firestore, and
Authentication. No Cloud Functions, no Cloud Storage, no server of any kind. And if you have
no Firebase project at all, it still runs — the whole app falls back to `localStorage` with a
bundled cast of 32 profiles, so you can try it in about thirty seconds.

**A hosted demo** is published from `main` to
**<https://baphometsblade.github.io/zero-cost-ai-dating/>** by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) — exactly that demo mode, so
everything you do there stays in your own browser's `localStorage`: no account, no server,
nothing uploaded anywhere. *(GitHub Pages has to be switched on once for the repository
before the first deploy can land — [docs/DEPLOY.md](docs/DEPLOY.md#github-pages-the-live-demo--and-why-it-is-not-this-guide)
has the one setting.)*

---

## Why "explainable" is the whole point

Most dating apps show you a person and a silence. This one shows you a person and its
reasoning:

> **78.4%** · Strong match
> ✨ You both love Hiking, Live music and Cooking
> 🧭 Very similar outlook — you match closely on warmth and openness
> 📍 Just 12 km away

Those lines are not decoration. They are generated from the same numbers that produced the
score, by the same function, in the same pass. If the engine cannot justify a match, it does
not claim one. The scoring code is roughly 1,250 lines of pure functions in
[`public/js/matching-engine.js`](public/js/matching-engine.js) — you can read the entire
thing, and its test suite asserts the behaviour rather than trusting it.

---

## Run it in 30 seconds

Locally, with nothing installed:

```bash
git clone https://github.com/<you>/zero-cost-ai-dating.git
cd zero-cost-ai-dating
npm run serve            # static server on http://localhost:5000
```

Then open <http://localhost:5000> and click **“Try the demo — no signup.”**

There is nothing to install. The project has **zero runtime dependencies and zero dev
dependencies** — `npm install` is not part of the workflow, and `npm run serve` is just
`python3 -m http.server 5000 --directory public`. Any static file server works just as well;
`public/` is the whole site.

With no Firebase config present the app boots in **demo mode**: 32 seeded profiles across
eleven US cities, a real swipe deck, real matching, real matches and chat — all persisted in
`localStorage`. Sign-up, sign-in, likes, limits, premium gating and the "who liked you" list
all work. Nothing is sent anywhere.

---

## What you get

| Screen | What it does |
| --- | --- |
| **Landing** (`index.html`) | The pitch, a feature grid, a 3-step explainer, an FAQ, and a one-click demo entry. |
| **Auth** (`auth.html`) | Email/password sign-in and sign-up with inline validation and a password strength meter, Google sign-in when Firebase is live, password reset, demo account entry. |
| **Discover** (`dashboard.html`) | The deck. Pointer-driven swiping with rotation, stamps and velocity commit — plus a complete keyboard equivalent (`←` pass, `→` like, `↑` super like, `z` rewind, `i` details, `?` shortcuts). Compatibility ring, up to three reasons per card, daily limits with a countdown, match celebration with generated icebreakers. |
| **Profile** (`profile.html`) | Bio with counter, 48 interest chips grouped by category, five personality sliders, 18+ birthdate guard, city picker or `navigator.geolocation`, up to six photo URLs, a live preview of your own card, and a completeness meter. |
| **Matches** (`matches.html`) | New-matches strip, conversation list with unread dots, live chat with day separators, icebreaker suggestions on empty threads, report/unmatch/block, and the premium "who liked you" list. |
| **Settings** (`settings.html`) | Discovery preferences, theme, notifications, **connect your own Firebase project** (paste a config, no code edits), viewing and retracting the reports you have filed, data export, demo reset, account deletion. |
| **Plans** (`subscription.html`) | An honest, non-deceptive plan comparison. Premium is a **local simulation** — see [Limitations](#limitations). |

Everything is mobile-first, works in light and dark, respects `prefers-reduced-motion`, and
is fully operable from the keyboard. The app is also an installable PWA: a manifest plus a
network-first service worker make it launchable from the home screen, and demo mode keeps
working with no connection at all — fitting, for an app whose matching never leaves the device.

---

## How the matching engine works

No network calls, no model weights, no randomness. Given the same two profiles and the same
`now`, it returns the same score forever.

### 1. Build a corpus

Every visible bio is tokenised — lowercased, diacritics stripped, split on non-alphanumerics,
stopwords removed, lightly stemmed (`ies→y`, `sses→ss`, trailing `s`, `ing`/`ed`) — and an
inverse document frequency table is built: `idf = ln((docCount + 1) / (df + 1)) + 1`. This is
classic TF‑IDF, which is exactly the right tool here: it is cheap, it is deterministic, and it
naturally down-weights the words every dating bio contains.

### 2. Apply hard filters

Cheap, absolute, and evaluated in order — first hit wins and the candidate is dropped:

`self` → `blocked` → `swiped` → `not-discoverable` → `incomplete` → `gender` → `age` → `distance`

Gender and age are **mutual**: they have to want your gender *and* you have to want theirs;
you must be in their age range *and* they in yours. A missing location never hard-fails — it
scores neutrally instead of quietly deleting people who have not set one.

### 3. Score seven components, each 0–1

| Component | Weight | How it is computed |
| --- | ---: | --- |
| `interests` | **0.28** | Weighted Jaccard over interest slugs plus a category bonus: `0.75 × (\|A∩B\| / \|A∪B\|) + 0.25 × catBonus` |
| `personality` | **0.22** | Five axes, weighted. Openness, warmth and reliability reward similarity; social energy tolerates a 25-point gap; emotional steadiness rewards both similarity *and* height |
| `bio` | **0.16** | Cosine similarity of the two TF‑IDF vectors |
| `distance` | **0.14** | `1 − (km / cap)^1.5`, where `cap = min(yourMax, theirMax, 500)` |
| `age` | **0.08** | `1 − min(1, \|Δyears\| / 20)` |
| `affinity` | **0.07** | Learned taste: the mean affinity you have shown toward this candidate's tags |
| `activity` | **0.05** | `1 / (1 + daysSinceActive / 7)` |

`score = 100 × Σ(weight × component)`, rounded to one decimal.

The `affinity` term is premium-only (adaptive weighting). When it is off, the engine does not
score it as `0` — it **drops the term and renormalises the remaining weights to sum to 1**, so
a free-plan user is never silently penalised for not having the feature.

### 4. A worked example

Ada (31, Portland) is looking at Bo (34, Vancouver WA). Ada is on the free plan, so `affinity`
is dropped and the other six weights are rescaled by `1 / 0.93`.

```
                component    weight    contribution
interests         0.446       0.3011      0.1344     3 shared of 7, 4 shared categories
bio               0.134       0.1720      0.0230     shared tokens: "cook", "record"
personality       0.931       0.2366      0.2202     warmth 0.96, openness 0.92
distance          0.911       0.1505      0.1371     12.0 km, cap 60 km
age               0.850       0.0860      0.0731     3 years apart
activity          0.903       0.0538      0.0486     last seen 18 hours ago
                                        ────────
                                          0.6364  ->  63.6
```

Which the engine renders as:

```
63.6% · Good match
🧭 Very similar outlook — you match closely on warmth and openness
📍 Just 12 km away
✨ You both love Hiking, Live music and Cooking
🎂 Only 3 years apart
```

Note what did *not* appear: the bio component scored 0.134, below the 0.15 threshold, so no
"your bios both mention…" line was claimed. Reasons are emitted from evidence or not at all.

### 5. It learns, gently

Every swipe nudges a small map of per-tag affinities (`lr = 0.15`, super likes 1.5×, passes
push down more softly than likes push up). Values are clamped to `[-1, 1]`, rounded to four
decimals, pruned below `|0.01|` and capped at 60 entries so the user document stays tiny. It
is a bag of scalars, not a model — which is precisely why it costs nothing to run and can be
explained in a sentence.

### 6. Icebreakers

Template-based and deterministic: shared interests first, then shared bio tokens, then a
shared city, then a personality-flavoured generic. A template with an unfilled placeholder is
never emitted — if there is nothing specific to say, you get a good generic opener instead.

### 7. What it costs to run

All of it happens on the main thread while the deck loads, so it is measured rather than
assumed. `npm run bench` synthesises a deterministic candidate pool — seeded PRNG, bios
spliced out of the real seed corpus so lengths and vocabulary are honest, 4–9 real interest
tags, full personality vectors, one metro area's worth of coordinates — and times both stages
with `process.hrtime.bigint()`:

```
$ npm run bench          # 2.1 GHz Xeon vCPU, Node 22; median run, warm-up discarded

  candidates   buildCorpus   rankCandidates        both  µs/candidate
          32       1.01 ms          2.41 ms     2.98 ms          93.1
         100       2.06 ms          6.97 ms     8.84 ms          88.4
         500       12.0 ms          36.0 ms     43.9 ms          87.8
        2000       42.5 ms           140 ms      182 ms          91.1
       10000        197 ms           713 ms      939 ms          93.9
```

The pool is bit-identical between runs, but the timings are not: a shared vCPU moves them a
few percent either way, and independent harnesses measuring the same engine landed between
82 and 94 µs per candidate. Read the shape, not the third digit.

Both stages are linear: 312× the candidates costs 315× the time, so the engine has no hidden
cliff, only a rate — about **90 µs per candidate** end to end on that machine. The deck asks
for 60 (`CANDIDATE_LIMIT`), which is **~5 ms**. Roughly a third of the ranking cost is
re-deriving *your* bio vector once per candidate, which would be the first thing to hoist if
this ever needed to be faster — at 5 ms it does not.

The script takes `--sizes=60,500,…` and `--json`, so it stays useful for checking a change
rather than only for producing this table.

---

## The zero-cost architecture

| Constraint | Consequence |
| --- | --- |
| Firebase **Spark (free)** plan only | **No Cloud Functions.** All logic is client-side. |
| No paid LLM/embedding API | Matching is a local, deterministic engine (TF‑IDF + cosine + vector compatibility). There is no `fetch` to any AI provider, ever. |
| No Cloud Storage (needs Blaze on new projects) | Photos are deterministic generated SVG avatars plus optional user-supplied external image URLs. No uploads. |
| No build step at runtime | Plain classic `<script>` tags. No bundler, no npm runtime deps. Node is dev-only, for tests and the seed export. |
| Must be demoable with zero setup | **Demo mode**: if Firebase is not configured or not reachable, the entire app runs off `localStorage`, seeded from bundled profiles. |

The practical upshot: the free Spark tier's 10 GB/month of hosting bandwidth and 50k/20k daily
Firestore reads/writes are far more than a project of this size will use, and there is no
resource in the stack that can bill you by surprise, because none of them are enabled.

---

## Connecting your own Firebase project

Two ways, neither of which requires a rebuild:

1. **From the app.** Settings → *Connect your own Firebase project* → paste the config object
   from the Firebase console. It is validated, stored in `localStorage['zc.firebaseConfig']`,
   and takes effect on reload. There is a Reset button that puts you back in demo mode.
2. **In the file.** Replace the placeholder values in
   [`public/js/firebase-config.js`](public/js/firebase-config.js) and deploy.

The app decides its mode at load: a placeholder-looking `apiKey`, an absent `firebase` global
(offline, blocked, ad-blocker), or any throw from `initializeApp` all land you in demo mode
with a single `console.info` line saying so. That fallback is a supported, tested path — never
an error dialog.

Full walkthrough: **[docs/DEPLOY.md](docs/DEPLOY.md)**.
How the pieces fit together: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Tests

```bash
npm test          # node --test   (no dependencies, no install)
npm run check:seed # fails if public/js/seed-data.js drifted from seed/profiles.json
```

### Unit suites

Nine suites on Node's built-in runner — **201 checks**, no install, no browser, seconds:

| Suite | What it pins down |
| --- | --- |
| `tests/auth.test.js` | The real `public/js/auth.js` on the demo backend, nothing mocked but the browser globals it reaches for: the salted credential vault (including the documented weak fallback when `crypto.subtle` is absent), sign-up and sign-in, the session record, `onChange`, and the three route guards. |
| `tests/csp-sync.test.js` | The `<meta http-equiv>` copy of the Content-Security-Policy on every page equals the `firebase.json` header minus `frame-ancestors`, and sits before the first `<link>` and `<script>` — two copies of a policy drift apart unless something forces them together. |
| `tests/data-store.test.js` | The demo storage adapter, loaded for real in Node against a `localStorage` shim: seeding (32 profiles, inbound likes, both conversations, idempotency, force re-seed), user create/update deep-merge semantics with wholesale `interestAffinity` replacement, swipe/match/undo idempotency, messaging with unread counters and the 1000-char cap, daily usage limits per plan, the reports lifecycle (file, list, retract, purge on account deletion), and export/import/reset round-trips. |
| `tests/matching-engine.test.js` | Every hard filter including the mutual gender/age cases, the neutral missing-location path, score bounds, determinism, tokeniser and cosine behaviour, learning clamp/prune/cap, ranking tie-breaks, weight renormalisation, and a golden end-to-end score. |
| `tests/pwa.test.js` | The manifest and the service worker carry no root-anchored assumptions, so the same `public/` installs and serves offline under a GitHub Pages project subpath as well as at a site root. |
| `tests/seed.test.js` | The shape of all 32 seeded profiles against the data model, unique uids and emails, valid interest slugs, ages consistent with birthdates, and `seed-data.js` being in sync with `seed/profiles.json`. |
| `tests/static.test.js` | Parses every HTML page: no dead local `src`/`href`, correct script load order, no inline scripts / `style=` / `on*=` handlers (the CSP would block them), no class token that the CSS does not define, and `lang` + `title` + viewport + description on every page. |
| `tests/usage.test.js` | The daily counter's decision, `nextUsage(current, field, amount, today)`, as a pure function: same-day increment, a stale day resetting to zeros *before* the amount lands, an unknown field, a missing or corrupt record, the clamp at zero. Then the same decision through the demo adapter, so it is proven to persist and `canSpend` is proven to agree with it. |
| `tests/utils.test.js` | The pure half of `ZC.util` — numbers, timing on a hand-rolled fake clock, dates, geo, hashing, avatars, URL parsing. The DOM half needs a live document and belongs to the browser suite. |

### Browser tests

`npm test` covers what can be exercised without a browser: the matching engine, the demo
store and its daily counter, the auth backend, the pure half of the utilities, the seed
schema, the static HTML. It cannot reach the flows that only exist in a DOM — signing in,
the deck and its keyboard, the match burst, chat that persists, reporting someone, deleting
your account, and the service worker serving the app with the network gone. Those live in
`e2e/`: **142 checks** across nine specs, each run at 390x844 and most of them at 1280x800 as
well — plus a tenth spec that needs the Firebase emulators and skips, by name and reason, when
they are not running.

Playwright drives them, and it is deliberately **not** a dependency: the promise that this
repo installs nothing holds, so you install the browser yourself and point Node at it.

```sh
npm install --prefix /tmp/pw playwright@1.56.0
npx --yes playwright@1.56.0 install --with-deps chromium

NODE_PATH=/tmp/pw/node_modules npm run test:e2e
```

With no Playwright at all the runner exits 3 with a one-line install hint, so "no browser
here" never reads as a failing test. See [`e2e/README.md`](e2e/README.md) for the spec
layout and for running one flow or one viewport.

The tenth spec, `e2e/specs/10-firebase.e2e.js`, is the only one that runs the app against
Firebase rather than `localStorage`: the real SDK, real Auth, real Firestore, and every result
read back out of the emulator instead of off the page. It drives the pages **with their real
CSP meta tag** — the emulators are reached through the page's own origin rather than by
relaxing the policy, which is the whole reason it can exist; the Limitations section explains
the constraint it is working around. With both emulators up the run is **160 checks**, all
passing.

It did not start that way. On its first run one check was red, and it had found a real bug:
`ZC.store.updateUser` could not create a user document at all, because `normalizeUser` writes
`lastActiveAt: null` for an account that has never been seen while `firestore.rules` accepted
that key only as a string — two lines below an explicit allowance for a null `planSince`. The
demo adapter had always upserted happily, so the two adapters had quietly disagreed, and no
fixture in `rules-tests/` ever used a null there. The rule now accepts null, and two rules
checks pin the shape.

Without an emulator the runner prints `SKIP` and records nothing, so `npm run test:e2e` on a
bare machine is still 142/142 — and CI runs it both ways, so the skip path and the emulator
path are each exercised on every push.

### Security rules tests

Everything this README claims about privacy — that your email and block list are not
readable by other accounts, that nobody can mint a match with a stranger and then message
them, that the abuse queue cannot be enumerated — is a claim about one file,
`firestore.rules`, because there is no server to enforce anything else. Reading it
carefully is not evidence. `rules-tests/` executes it against the Firestore emulator:
**129 checks**, including the attacks each rule exists to stop.

```sh
npm install --prefix /tmp/zc-rules @firebase/rules-unit-testing firebase-tools

NODE_PATH=/tmp/zc-rules/node_modules npm run test:rules
```

Same arrangement as the browser tests: not a dependency, needs a Java runtime for the
emulator, and exits 3 when the tooling is missing so an environment problem never reads as
a failing rule. See [`rules-tests/README.md`](rules-tests/README.md).

### Store tests

The daily usage counter is the one piece of client logic where reading the code carefully is
as weak an argument as it was for the rules: whether two concurrent bumps collapse into one
is a property of a real database, not of anything visible in the file. `store-tests/` loads
the **shipped** `public/js/data-store.js` into Node — `window` aliased to `globalThis`,
`ZC.firebase.db` pointed at the emulator through the compat SDK — and drives it: **31
checks**, including 20 concurrent `bumpUsage` calls on one document storing exactly 20, the
midnight roll-over happening inside the same transaction, a bump writing `usage` and nothing
else, and — the check that caught this round's own regression — 30 swipes replaying the
deck's real learning-save-then-bump ordering and storing exactly 30.

```sh
npm install --prefix /tmp/zc-emu firebase @firebase/rules-unit-testing firebase-tools

NODE_PATH=/tmp/zc-emu/node_modules npm run test:store      # the store suite
NODE_PATH=/tmp/zc-emu/node_modules npm run test:emulator   # rules, then store, one boot
```

Booting the emulator costs most of a minute, which is why both suites share
`rules-tests/emulate.js` and a single `emulators:exec`. `npm run test:rules` still runs the
rules suite alone, exactly as it did before.

Two honest edges. Every assertion reads the **stored document**, never `bumpUsage`'s return
value — a bump whose write failed still hands the caller the figure it computed, so a check
that trusted the return value could pass against a store that saved nothing. And the suite
runs with permissive rules, because the client SDK cannot mint an auth token without the Auth
emulator; a separate check closes that gap the only way left, by replaying the exact value
the transaction stored against the real `firestore.rules` as the document's owner. That is a
narrower claim than "the transaction passes the rules", and `store-tests/` says so.
See [`store-tests/README.md`](store-tests/README.md).

### CI

`.github/workflows/ci.yml` has three jobs. `verify` runs exactly `npm run check:seed` and
`npm test` on every push and pull request, across a Node 20 and Node 22 matrix (`fail-fast: false`, so one
version failing still reports the other) — no install, no browser, seconds. Two majors are
deliberate: pinning a single one once hid a real breakage, because the test runner stopped
matching a positional `tests/` directory argument after Node 20 and `npm test` silently ran
nothing on newer runtimes. `e2e` is separate and runs the browser suite, installing
Playwright and Chromium into the runner's temp directory — never into the repo — in a step
of its own, so a failed download reads as infrastructure rather than as a red test.
`emulator` does the same for the Firestore emulator, and runs both suites that need one —
`firestore.rules`, then the shipped store — inside a single boot, because booting costs more
than either suite does. There are no secrets and no deploy step — deploying stays a
deliberate local `npm run deploy`.

---

## Project layout

```
.
├── public/                  # the entire deployed site
│   ├── index.html           # landing
│   ├── auth.html            # sign in / create account
│   ├── dashboard.html       # the swipe deck
│   ├── profile.html         # profile editor + live preview
│   ├── matches.html         # match list + chat
│   ├── settings.html        # preferences, Firebase config, danger zone
│   ├── subscription.html    # plan comparison (simulated premium)
│   ├── 404.html
│   ├── css/
│   │   ├── style.css        # design tokens, layout, forms, buttons
│   │   └── components.css   # deck, chat, plans, overlays
│   └── js/
│       ├── firebase-config.js   # ZC.config / ZC.firebase — decides demo vs firebase
│       ├── utils.js             # ZC.util / ZC.ui — DOM, avatars, toasts, modals
│       ├── seed-data.js         # generated: ZC.SEED_PROFILES, ZC.INTEREST_TAGS
│       ├── data-store.js        # ZC.store — one API over Firestore *or* localStorage
│       ├── matching-engine.js   # ZC.matching — the ranking engine (also a Node module)
│       ├── auth.js              # ZC.auth — sessions, guards, humanised errors
│       ├── app.js               # ZC.app — nav, theme, toasts, badges
│       └── <page>.js            # one controller per page
├── seed/profiles.json       # source of truth for the demo cast
├── scripts/
│   ├── build-seed.js        # regenerates public/js/seed-data.js
│   └── bench-matching.js    # times buildCorpus + rankCandidates (npm run bench)
├── tests/                   # node:test suites
├── e2e/                     # browser suite (npm run test:e2e — Playwright, not a dep)
│   ├── run.js               # the runner
│   ├── harness.js           # Playwright lookup, static server, browser session
│   └── specs/*.e2e.js       # one flow each
├── rules-tests/             # firestore.rules against the emulator (npm run test:rules)
├── store-tests/             # the shipped data-store.js against the emulator (test:store)
├── docs/                    # architecture + deployment
├── firebase.json            # hosting, headers, CSP
├── firestore.rules          # the actual security boundary
└── firestore.indexes.json
```

---

## Security notes

- **Firestore rules are the real boundary.** [`firestore.rules`](firestore.rules) validates
  writes against the data model: only the owner reads or writes their `users/{uid}` document;
  `uid`, `email` and `createdAt` are immutable after creation; bios are capped at 500
  characters, interests at 12, photos at 6; a swipe can only be created by its `from` user and
  its document id must be `from_to`; matches are readable only by their two participants and
  require proof of a reciprocal like to create; messages require participation and
  `from == request.auth.uid`. Everything else is denied by default.
- **Private fields stay private.** Other users only ever read `discovery/{uid}`, a projection
  holding the public fields (derived age, never the birthdate; coordinates rounded to ~1 km).
  Email, block lists, usage counters and learned affinities never leave `users/{uid}`, and the
  projection's key list is closed with `hasOnly` so a tampered client cannot widen it.
- **Strict CSP.** `firebase.json` ships
  `script-src 'self' https://www.gstatic.com https://apis.google.com`, `object-src 'none'`,
  `frame-ancestors 'none'` and friends. Consequently there is not one inline `<script>` or
  `style="…"` attribute in the codebase — styles that must be dynamic are set through the
  CSSOM — and `tests/static.test.js` fails the build if one appears. Every page also carries
  the policy as a `<meta>` tag, because GitHub Pages cannot set headers; that copy is what
  makes it strict on a laptop too, and it has a cost — see Limitations.
- **No `innerHTML` with user data.** Every bio, name, message and location label is inserted
  with `textContent` (via `ZC.util.el({ text })`). Photo URLs are restricted to `https://`.
- **The Firebase web API key is not a secret.** It identifies your project; it does not
  authorise anything. Access control lives in the rules file, which is why that file is worth
  reading before you deploy.
- **Geolocation is opt-in and degradable.** `Permissions-Policy` limits it to same-origin, and
  a denied prompt just leaves you picking a city from a list.
- **Demo credentials never leave the browser.** They are salted and SHA-256 hashed via
  `crypto.subtle` — which is a demo affordance, not a security design. See below.

---

## Limitations

These are real, and worth knowing before you show this to anyone:

- **Client-side gating is only as strong as the Firestore rules.** Daily like limits, premium
  features and rewinds are enforced in the browser because the free plan has no server to
  enforce them on. A determined user with devtools can bypass any of it. The rules stop data
  *corruption* and cross-user reads; they do not — and on Spark cannot — implement rate limits
  or entitlement checks.
- **The daily usage counter is atomic online, and only online.** It used to be a
  read-modify-write that two tabs could collapse into one increment. On the Firestore path a
  bump is now a single `runTransaction`: the user document is read *inside* the transaction, a
  pure function decides the new `usage` map, and `tx.update` writes that one field. Fixing the
  bump alone turned out not to be enough, and the tests that caught it are the point of this
  section: `updateUser` was a whole-document read-modify-write, so the deck's un-awaited
  learning save — fired on every swipe, just before the bump — reliably overwrote the
  increment the transaction had just committed. Making the bump atomic actually made that
  *worse*, because a one-round-trip transaction commits early enough to lose the race. So
  `updateUser` is now transactional too, which is the real fix: any two concurrent writes to
  the user document used to lose data this way, not just the counter.
  None of that is asserted from reading the code. `store-tests/` loads the **shipped**
  `public/js/data-store.js` and drives it against the Firestore emulator, reading back the
  stored document: 20 concurrent bumps store exactly 20 (the old shape stored **1**), 20
  racing across midnight likewise, and 30 swipes replaying the deck's exact
  learning-then-bump ordering store exactly 30 — that last check stored **19 of 30** and
  **17 of 30** against this round's own first attempt, which is how the regression was found.
  What is *not* fixed, and is worth knowing:
  - **Offline, nothing is stored.** A transaction needs a server round-trip, so it fails with
    no connection; the store warns, persists nothing, and returns the figure it computed —
    from the SDK's cached copy of your document when it has one, and otherwise from a fresh
    day. Swipe with no connection and the stored counter can still come back light. That is
    deliberate: a counter that could not save must never take the deck down.
  - **A swipe is not one write.** The *bump* is a single write of a single field — it no
    longer restamps `updatedAt` or republishes the public `discovery/{uid}` projection to
    mirror a field that projection deliberately excludes. The deck also records the swipe
    itself and saves the learning map, so a like is **three** document writes: the swipe, the
    counter, and the affinity map. It was four until the learning save stopped going through
    `updateUser`, which republished the projection for a field the projection has never
    carried.
  - **Demo mode is not immune.** It is per-device, but not "one tab at a time": the store
    listens for `storage` events and supports several tabs of the same browser, and the demo
    adapter's bump is still a `localStorage` read-modify-write two of them can race. It shares
    the same pure decision function as the Firestore path, which buys agreement between the
    two adapters — not a distributed guarantee.
  - **The proof is an emulator over loopback**, not a claim about production latency.
    Contention windows are wider on a real network and the SDK's transaction retry budget is
    finite, so sustained contention can still exhaust it and fall back to the warn path.
  - And none of this makes the limit *enforceable*: that is still the bullet above.
- **Premium is simulated. No payment is processed.** The subscription page flips a `plan`
  field on your own user document after an explicit confirmation that says so. It exists so
  the gating logic can be exercised, not to sell anything. There is no payment provider, no
  charge, and nothing to cancel.
- **Demo auth is not real security.** In demo mode, accounts and salted password hashes live in
  `localStorage` on the device. Anyone with access to the browser has access to the account.
  It is a way to try the app without a backend, nothing more. Real security starts when you
  connect Firebase Authentication.
- **No photo uploads.** Cloud Storage requires the Blaze plan on new projects, so profiles use
  deterministic generated SVG avatars, or `https://` URLs you paste yourself. Those URLs are
  not proxied, scanned or moderated.
- **Discovery scans candidate pages and ranks them in the browser.** `listCandidates` walks
  the public `discovery` collection with a cursor (newest-active first, with cheap mutual
  gender/age pre-filters) until the deck is full or a scan cap is hit, and the ranking then
  runs on the main thread during the page load. Measured with `npm run bench` on a 2.1 GHz
  Xeon cloud vCPU under Node 22 — a deliberately slow stand-in, since no phone was actually
  measured — that costs ~90 µs per candidate and scales linearly: the 60-candidate deck the app actually
  loads takes ~5 ms, 500 candidates ~44 ms, 1,000 ~87 ms, 2,000 ~180 ms, 10,000 ~0.94 s. So
  the real ceiling is **around a thousand candidates per load** before ranking alone spends a
  100 ms frame budget, and a few thousand before it is visibly janky — more headroom than
  this section used to claim, and still nowhere near a real product. Past that the fix is a
  server-side pre-filter, which the free tier cannot host: the honest limit here is the plan,
  not the algorithm.
- **Moderation is a queue, not a team.** Report (with a reason and optional detail), block and
  unmatch are built in. Reports land in a `reports` collection capped at one per
  (reporter, subject) pair, visible only to their own author — and can be reviewed or
  retracted from Settings — and to the project owner, who reviews the queue in the Firebase
  console or with admin credentials. Nothing triages that queue automatically, and there is
  no in-app tooling for the owner to act on it.
- **The CSP ships in the markup, and that costs you local emulator development.** GitHub
  Pages cannot set response headers, so the `Content-Security-Policy` Firebase Hosting sends
  from `firebase.json` also travels as a `<meta>` tag in every page. A policy in the markup
  applies wherever the file is served — your own machine included — and an emulator on
  another port is a different origin, which `connect-src 'self'` does not cover. So a browser
  on `localhost:5000` will not talk to the Firestore or Auth emulator: sign-up simply does
  not move off the page, and the console says `Refused to connect to
  'http://127.0.0.1:8080/' because it violates the following Content Security Policy
  directive: "connect-src 'self' …"`. There is no server setting to unset, because no server
  is sending it. The two ways round — relax the meta copy while you work and put it back, or
  serve the emulator's paths from the page's own origin, which is what the browser suite does
  — are written up in
  [docs/DEPLOY.md](docs/DEPLOY.md#12-developing-against-the-emulators-in-a-browser). Neither
  is a fix; the constraint is the price of a policy GitHub Pages can honour at all.
- **The "AI" is classical ML, deliberately.** TF‑IDF, cosine similarity, weighted vector
  distance and a per-tag affinity table. It is explainable and free precisely because it is not
  a neural model, and it will not understand a bio the way a language model would.

---

## License

MIT — see [LICENSE](LICENSE). The profiles in `seed/profiles.json` are fictional.
