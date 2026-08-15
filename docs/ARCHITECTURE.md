# Architecture

How Zero Cost AI Dating is put together, and why it is put together that way.

The whole application is static files. There is no server, no build step, no bundler and no
runtime dependency. `public/` is deployed verbatim; Node exists only to run tests and to
regenerate the seed bundle. Every design decision below follows from that one constraint plus
its sibling: it must also work with **no backend at all**.

---

## 1. The module graph

One global — `window.ZC` — with each file attaching its own surface to it. Files are plain
classic scripts wrapped in an IIFE with `'use strict'`, and each tolerates being loaded twice.

```
                          ┌──────────────────────┐
                          │   firebase-config.js │  ZC.config, ZC.firebase
                          │   demo?  firebase?   │  (the mode decision, made once)
                          └──────────┬───────────┘
                                     │
             ┌───────────────────────┼───────────────────────┐
             ▼                       ▼                       ▼
   ┌──────────────────┐   ┌────────────────────┐   ┌──────────────────────┐
   │     utils.js     │   │    seed-data.js    │   │  matching-engine.js  │
   │ ZC.util, ZC.ui   │   │ ZC.SEED_PROFILES   │   │     ZC.matching      │
   │ DOM, avatars,    │   │ ZC.INTEREST_TAGS   │   │  pure, no DOM, no    │
   │ toasts, modals   │   │ (generated file)   │   │  I/O, Node-loadable  │
   └────────┬─────────┘   └─────────┬──────────┘   └──────────┬───────────┘
            │                       │                         │
            └───────────┬───────────┘                         │
                        ▼                                     │
              ┌───────────────────┐                           │
              │   data-store.js   │  ZC.store                 │
              │  Firestore  ──or──│  one async API,           │
              │  localStorage     │  two adapters             │
              └─────────┬─────────┘                           │
                        ▼                                     │
                ┌───────────────┐                             │
                │    auth.js    │  ZC.auth                    │
                │ sessions,     │  requireAuth / requireGuest │
                │ guards        │  requireProfile             │
                └───────┬───────┘                             │
                        ▼                                     │
                 ┌─────────────┐                              │
                 │   app.js    │  ZC.app — nav, theme,        │
                 │   shell     │  toast host, badges          │
                 └──────┬──────┘                              │
                        ▼                                     │
   ┌────────────────────────────────────────────────┐         │
   │  dashboard.js · profile.js · matches.js ·      │◀────────┘
   │  settings.js · subscription.js                 │
   │  one controller per page, no cross-imports     │
   └────────────────────────────────────────────────┘
```

Rules that keep the graph acyclic:

- **Dependencies only point down.** `utils.js` knows nothing about the store; the store knows
  nothing about auth; auth knows nothing about any page.
- **Page controllers never talk to each other.** They share state through `ZC.store` and the
  URL, never through globals of their own.
- **`matching-engine.js` depends on nothing at all.** It is a pure function library that also
  works in Node (see §5), which is what makes it testable without a DOM.
- **Only `data-store.js` touches `firebase.firestore()`.** Only `auth.js` touches
  `firebase.auth()`. Nothing else in the codebase references the SDK, so the demo-mode fallback
  has exactly two places to get right.

### Public surfaces

| File | Attaches | Responsibility |
| --- | --- | --- |
| `firebase-config.js` | `ZC.config`, `ZC.firebase` | Read config (baked-in or `localStorage`), detect placeholders, initialise the SDK inside try/catch, decide `mode`, publish plan limits. |
| `utils.js` | `ZC.util`, `ZC.ui` | DOM helpers (`$`, `$$`, `el`), formatting (`timeAgo`, `fmtDate`), geo (`haversineKm`), deterministic SVG avatars, toasts, modals, focus-trapping, skeletons. |
| `seed-data.js` | `ZC.SEED_PROFILES`, `ZC.INTEREST_TAGS`, `ZC.INTEREST_BY_SLUG` | Generated from `seed/profiles.json`. Never hand-edited. |
| `data-store.js` | `ZC.store` | The one data API. Both adapters live here. |
| `matching-engine.js` | `ZC.matching` | Ranking, reasons, learning, icebreakers. |
| `auth.js` | `ZC.auth` | Sign-up/in/out, page guards, humanised error text, demo credential store. |
| `app.js` | `ZC.app` | Shared nav and tab bar, theme application, toast host, unread badge polling, `onReady`. |

---

## 2. Load order, and why it is fixed

Every page ends its `<body>` with the same block, in this order, plus at most one page script:

```html
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js" crossorigin="anonymous"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js" crossorigin="anonymous"></script>
<script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js" crossorigin="anonymous"></script>
<script src="js/firebase-config.js"></script>
<script src="js/utils.js"></script>
<script src="js/seed-data.js"></script>
<script src="js/data-store.js"></script>
<script src="js/matching-engine.js"></script>
<script src="js/auth.js"></script>
<script src="js/app.js"></script>
<script src="js/<page>.js"></script>
```

- The three gstatic tags are **not** `defer` or `async`. `firebase-config.js` reads the
  `firebase` global at parse time to decide the mode; a deferred SDK would make that decision
  race.
- Everything is a **classic** script. No `type="module"`, because modules defer by default and
  because the shared `ZC` global is the entire module system here.
- If the gstatic tags fail — offline, blocked, corporate proxy, ad-blocker — `firebase` is
  simply `undefined`, `isConfigured` is false, and the app runs in demo mode. That is a
  supported, tested path, not an error state.
- `index.html` uses the same block with no page script (`app.js` is its controller).
  `404.html` loads only `utils.js` and `app.js` — it needs neither data nor auth.

`tests/static.test.js` asserts this order on every page, so a copy-paste slip fails CI rather
than the browser.

---

## 3. Two modes, one decision

```
                     ┌────────────────────────────────────┐
                     │ localStorage['zc.firebaseConfig']? │
                     └───────────────┬────────────────────┘
                          yes ┌──────┴──────┐ no
                              ▼             ▼
                    use that config    use baked-in config
                              └──────┬──────┘
                                     ▼
                  ┌──────────────────────────────────────┐
                  │ apiKey placeholder-looking?          │
                  │ /^your-|^AIza\.\.\.|REPLACE_ME/i     │
                  │ projectId starts with "your-"?       │
                  │ global `firebase` missing?           │
                  └──────┬───────────────────────┬───────┘
                   any yes│                      │all no
                          ▼                      ▼
                  ┌───────────────┐    ┌────────────────────────┐
                  │  mode='demo'  │    │ firebase.initializeApp │
                  │ ZC.firebase = │    │      inside try {}     │
                  │     null      │    └───────┬────────────┬───┘
                  └───────────────┘      threw │            │ ok
                          ▲                    │            ▼
                          └────────────────────┘   ┌──────────────────┐
                                                   │ mode='firebase'  │
                                                   │ ZC.firebase =    │
                                                   │ {app,auth,db}    │
                                                   └──────────────────┘
```

The decision happens once per page load and is published as `ZC.config.mode`. Exactly one
`console.info` line reports it. Nothing else in the codebase re-derives it — everything reads
`ZC.store.mode` or `ZC.config.mode`.

Plan limits also live in `ZC.config` so both the store and the UI agree:

| Limit | Free | Premium |
| --- | ---: | ---: |
| `likesPerDay` | 25 | ∞ |
| `superLikesPerDay` | 1 | 5 |
| `rewinds` | 0 | ∞ |
| `seeLikedYou` | no | yes |
| `adaptiveWeights` | no | yes |

---

## 4. Data model

Firestore documents and demo-mode records are **the same shape**, deliberately: the demo
adapter stores maps of the identical objects, so a profile exported from one can be imported
into the other and the matching engine cannot tell the difference.

### `users/{uid}`

```js
{
  uid, email, displayName,
  createdAt, updatedAt, lastActiveAt,        // ISO strings
  profileComplete: boolean,
  plan: 'free' | 'premium',  planSince: ISOString | null,

  profile: {
    birthdate: 'YYYY-MM-DD' | null,
    age: number | null,                      // denormalised for filtering
    gender: 'woman' | 'man' | 'nonbinary' | 'other',
    pronouns: string,
    bio: string,                             // <= 500 chars
    photos: string[],                        // 0..6 https URLs; empty => generated avatar
    interests: string[],                     // 0..12 slugs from INTEREST_TAGS
    personality: { openness, conscientiousness, extraversion, agreeableness, stability },
    location: { label, lat, lng } | null,
    showAge: boolean, showDistance: boolean
  },

  preferences: {
    interestedIn: ('woman'|'man'|'nonbinary'|'other')[],
    ageMin: number,        // >= 18
    ageMax: number,        // <= 100
    maxDistanceKm: number, // 1..500, where 500 means "anywhere"
    notifications: boolean,
    theme: 'system' | 'light' | 'dark',
    discoverable: boolean
  },

  learning: { interestAffinity: { [tagSlug]: number }, likeCount, passCount },
  usage:    { date: 'YYYY-MM-DD', likes, superLikes, rewinds },
  blocked:  string[]
}
```

`ZC.store.DEFAULT_USER` is this shape with sane defaults; every writer merges into it, so a
document written by the profile editor and one written by sign-up are structurally identical.

### `discovery/{uid}` — the public projection (Firebase mode)

In Firebase mode `users/{uid}` is readable **only by its owner**. What other people see is
`discovery/{uid}`, a projection the store mirrors automatically on every profile save:
display name, `profileComplete`, `lastActiveAt`, the public `profile.*` subset (derived age
but never the birthdate; coordinates rounded to ~1 km) and the mutual filter preferences
(`interestedIn`, `ageMin`, `ageMax`, `maxDistanceKm`, `discoverable`). Email, birthdate,
block lists, usage counters and learned affinities never leave the private document, and the
rules close the projection's key list with `hasOnly` so a tampered client cannot widen it.
Candidate listing, the matches list and "who liked you" all read the projection; the demo
adapter keeps a single local store since nothing ever leaves the browser there.

### The rest

| Collection | Id | Shape |
| --- | --- | --- |
| `swipes` | `${from}_${to}` | `{ id, from, to, action: 'like'\|'pass'\|'super', createdAt }` |
| `matches` | `[a,b].sort().join('_')` | `{ id, users: [uidA, uidB], createdAt, lastMessage, lastMessageAt, unread: { [uid]: number } }` |
| `matches/{id}/messages` | random | `{ id, from, text, createdAt }` |
| `reports` | `${from}_${about}` | `{ id, from, about, reason, details, createdAt }` — one per (reporter, subject) pair; readable/deletable only by its author; the owner reads the queue in the console |

**Deterministic ids are load-bearing.** Because a swipe id is `from_to` and a match id is the
sorted pair, both writes are idempotent: re-recording the same swipe cannot create a duplicate
match, and two devices racing to record the reciprocal like converge on the same document.
This is how mutual matching works without a Cloud Function to arbitrate — and the Firestore
rules enforce the id convention so a client cannot invent one.

`ZC.store` hands pages a denormalised `MatchView` rather than a raw `MatchDoc`:

```js
{ matchId, otherUid, other /* UserDoc */, createdAt, lastMessage, lastMessageAt, unread }
```

### Interests

`ZC.INTEREST_TAGS` is exactly 48 `{ slug, label, emoji, category }` entries across ten
categories (`outdoors, arts, food, music, fitness, tech, travel, homebody, social, mindful`).
Profiles store slugs only; labels and emoji are looked up through `ZC.INTEREST_BY_SLUG` at
render time, so renaming a label never migrates data. The list is generated into
`public/js/seed-data.js` from `seed/profiles.json` by `scripts/build-seed.js`, and
`npm run check:seed` fails if the generated file drifts.

---

## 5. The storage layer

`ZC.store` is a promise-based facade with one job: **make the rest of the app unable to tell
which backend it is talking to.** Every method is `async`; no page ever touches `firebase`.

```
   pages ──▶ ZC.store  ─┬─▶ Firestore adapter   (mode === 'firebase')
                        └─▶ localStorage adapter (mode === 'demo')
```

`ZC.store.ready` resolves when the chosen adapter is usable. In demo mode that includes
seeding: on first run the 32 bundled profiles are written into `zc.demo.users`, with each
`lastActiveOffsetHours` converted to an ISO timestamp *relative to now* — which is why the
demo cast never looks like it went quiet in 2026.

### Firestore adapter

- Reads and writes `users`, `swipes`, `matches` and the `messages` subcollection directly.
- Queries are shaped to match `firestore.indexes.json`: candidates by
  (`profileComplete`, `preferences.discoverable`, `lastActiveAt`), swipes by (`from`,
  `createdAt`), inbound likes by (`to`, `action`), matches by (`users` array-contains,
  `lastMessageAt`).
- `listenMessages` is a real `onSnapshot` subscription; the returned function unsubscribes.
- Client-side filtering finishes the job the indexes cannot: mutual gender/age/distance
  filtering happens in the matching engine, not in the query, because Firestore cannot express
  a mutual predicate and the free plan has nowhere else to run one.

### localStorage adapter

Six keys, all under one prefix, each holding a JSON map keyed by id:

| Key | Contents |
| --- | --- |
| `zc.demo.users` | `{ [uid]: UserDoc }` |
| `zc.demo.swipes` | `{ [swipeId]: SwipeDoc }` |
| `zc.demo.matches` | `{ [matchId]: MatchDoc }` |
| `zc.demo.messages` | `{ [matchId]: MessageDoc[] }` |
| `zc.demo.session` | the signed-in uid |
| `zc.demo.seeded` | seed version marker |

Plus `zc.demo.credentials` (owned by `auth.js`) and `zc.firebaseConfig` (owned by the settings
page). All access goes through a `readJson(key, fallback)` / `writeJson(key, value)` pair that
swallows corrupt JSON, private-mode exceptions and quota errors, warns once, and keeps the UI
alive. A demo user who fills their quota gets a toast, not a white screen.

`listenMessages` in demo mode has no server to push from, so it does both of the things a
browser can: it listens for the `storage` event (another tab in the same profile) and polls a
cheap signature of the thread every 1.5 s (same tab). Callers cannot tell the two adapters
apart.

### Shared semantics

- `recordSwipe(from, to, action)` writes `swipes/{from}_{to}`; if the reciprocal swipe exists
  and both are positive (`like`/`super`), it creates `matches/{sortedPair}` and returns
  `{ matched: true, matchId }`. Idempotent in both adapters.
- `undoSwipe` deletes the swipe and, if that swipe created a match, the match with it — which
  is why the dashboard refuses to rewind across a match.
- `getUsage` auto-resets when `usage.date` is not today, so daily limits need no scheduler.
- `canSpend(uid, field)` returns `{ allowed, remaining, limit, plan }` by reading the plan
  limits out of `ZC.config`, and is called *before* every spend.
- `touchActive` is throttled to one write per five minutes, because `lastActiveAt` feeds the
  activity score but is not worth a write per navigation.

---

## 6. The matching engine

`matching-engine.js` is the only file with a dual export, so the same source runs in the
browser and under `node --test`:

```js
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZC = root.ZC || {}; root.ZC.matching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () { /* ... */ });
```

Constraints that make it testable: **no I/O, no DOM, no `Date.now()` inside scoring.** The
current time is passed in via `opts.now`, so a test can pin the activity component to an exact
value and a golden score never rots.

The pipeline, once per deck load:

```
listCandidates ──▶ buildCorpus(profiles) ──▶ rankCandidates(me, candidates, opts)
                        (idf table)                │
                                                   ├─ hard filters, first hit wins
                                                   ├─ 7 component scores, each 0..1
                                                   ├─ weighted sum -> 0..100
                                                   ├─ reasons (max 4, by strength)
                                                   └─ sort: score desc,
                                                            lastActiveAt desc,
                                                            uid asc
```

The tie-break chain is total and deterministic — no `Math.random`, no insertion-order
dependence — so the same deck renders in the same order on every device. `opts.adaptive`
(premium only) enables the learned `affinity` term; when it is off the term is dropped and the
remaining weights are renormalised to sum to 1 rather than scored as zero.

`updateLearning(learning, candidate, action)` is pure and returns a new object: the caller
persists it through `ZC.store.updateUser` after the swipe animation, never blocking the UI on
the write.

Weights, component formulas and the reason thresholds are documented in the
[README](../README.md#how-the-matching-engine-works).

---

## 7. Pages and the shell

`app.js` runs on every page. It mounts the toast host, applies the saved theme to
`<html data-theme>`, renders the shared nav and bottom tab bar, wires sign-out, and polls the
unread badge every 20 s — but only while `document.visibilityState === 'visible'`, so a
backgrounded tab costs nothing.

Page guards live in `auth.js` and run first in each controller:

| Guard | Behaviour |
| --- | --- |
| `requireAuth()` | Redirects to `auth.html` (preserving `?next=`) and never resolves when signed out. |
| `requireGuest()` | The inverse, for `auth.html`. |
| `requireProfile()` | `requireAuth` plus a redirect to `profile.html?onboarding=1` when the profile is incomplete. |

Because these never resolve on the redirect path, a controller can safely `await` one and then
assume it has a user document.

Cross-page state travels in the URL, not in globals: `matches.html?m=<matchId>&draft=<text>`,
`profile.html?onboarding=1`, `auth.html?mode=signup&next=…`. `history.replaceState` keeps the
match id current without adding history entries.

---

## 8. Rendering rules

- **Text in, text out.** Every string that came from a user or the seed file is inserted with
  `textContent` — in practice `ZC.util.el(tag, { text })`. `el()`'s `html` option exists for
  static markup the code itself authored and is never handed a value from a document.
- **No inline styles.** The CSP forbids `style="…"`, so anything dynamic (the compatibility
  ring's `--pct`, a drag transform, a completeness bar's width) is set with
  `el.style.setProperty(...)`, which CSP allows.
- **No inline scripts or `on*` handlers.** All behaviour is wired with `addEventListener` in
  the page controller.
- **Skeletons, not spinners, for content.** Lists render `.skeleton` nodes while loading so
  layout does not jump.
- **Every async call is wrapped.** A failure shows a toast and leaves a usable screen. There
  are no unhandled rejections and no blank states.

The design system is two files: `style.css` (tokens, layout, forms, buttons, nav) and
`components.css` (deck, chat, plans, overlays). Dark mode is expressed both as
`@media (prefers-color-scheme: dark)` and `:root[data-theme="dark"]`, with
`:root[data-theme="light"]` forcing light — the explicit attribute always wins over the OS.
`tests/static.test.js` fails if markup uses a class the CSS never defines.

---

## 9. Testing layers

| Layer | Where | What it protects |
| --- | --- | --- |
| Pure logic | `tests/matching-engine.test.js` | The engine's filters, formulas, learning and ordering — the part that would be hardest to debug from the UI. |
| Storage | `tests/data-store.test.js` | The demo adapter loaded for real against a `localStorage` shim: seeding, merge semantics, swipes and matches, messaging, usage limits, reports, export/import. |
| Data | `tests/seed.test.js` | The bundled cast matches the data model, and the generated bundle matches its JSON source. |
| Markup | `tests/static.test.js` | Dead links, script order, CSP violations, undefined classes, missing head tags. |
| Flows | `e2e/specs/*.e2e.js` | What only exists in a DOM: sign-in, the deck and its keyboard, the match burst, chat persistence, reports, deletion, the phone layout, offline navigation. |
| Trust boundary | `rules-tests/specs/*.rules.js` | `firestore.rules` executed against the emulator: who can read what, the closed discovery projection, the reciprocal-like proof, the append-only chat, the bounded report queue, and the catch-all deny. |

All four `tests/` suites run on `node --test` with no dependencies, which is what keeps the
`verify` job down to a checkout, `npm run check:seed` and `npm test` — no install step, and
it finishes in seconds. That short job is run twice, over a `node: ['20', '22']` matrix,
because a single pinned version once hid a breakage: the runner stopped matching a
positional `tests/` directory argument after Node 20, so `npm test` ran zero tests on newer
runtimes while CI stayed green.

The two layers that need real infrastructure are deliberately kept out of that job. Their
specs live in `e2e/` and `rules-tests/`, not `tests/`, so `node --test` never discovers
them, and CI drives each from its own job that installs what it needs — Playwright and
Chromium, or the Firestore emulator — into the runner's temp directory. Neither is ever a
dependency of this repo; see [`e2e/README.md`](../e2e/README.md) and
[`rules-tests/README.md`](../rules-tests/README.md).

The trust-boundary layer exists because `firestore.rules` is the only server-side security
here, so every privacy guarantee in the README rests on it. Reviewing it is not the same as
running it: the suite asserts the attacks each rule exists to stop — reading another
account's document, smuggling a private field into the public projection, minting a match
with someone who never liked you, probing whether a report about you exists.

---

## 10. What is deliberately absent

- **No Cloud Functions.** Matching, match creation and limit enforcement all happen on the
  client. This is the central trade-off of the project; see the README's Limitations.
- **No Cloud Storage.** Photos are generated SVG data URIs or pasted `https://` URLs.
- **No bundler, transpiler, linter or framework.** The dependency count is zero and the
  install step does not exist.
- **No analytics, trackers or third-party scripts.** `connect-src` in the CSP lists Google's
  identity and Firestore endpoints and nothing else.
