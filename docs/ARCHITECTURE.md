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
  `404.html` loads no external script at all — not `utils.js`, not `app.js`. It has to
  answer for nested missing paths, whose own relative script URLs would 404 in turn, so it
  ships fully self-contained with one hash-pinned inline block.

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

Seven keys, all under one prefix, each holding a JSON map keyed by id:

| Key | Contents |
| --- | --- |
| `zc.demo.users` | `{ [uid]: UserDoc }` |
| `zc.demo.swipes` | `{ [swipeId]: SwipeDoc }` |
| `zc.demo.matches` | `{ [matchId]: MatchDoc }` |
| `zc.demo.messages` | `{ [matchId]: MessageDoc[] }` |
| `zc.demo.session` | the signed-in uid |
| `zc.demo.reports` | `{ [reportId]: ReportDoc }` |
| `zc.demo.seeded` | seed version marker |

Plus `zc.demo.credentials` (owned by `auth.js`) and `zc.firebaseConfig` (owned by the settings
page). All access goes through a `readJson(key, fallback)` / `writeJson(key, value)` pair that
swallows corrupt JSON, private-mode exceptions and quota errors, warns once, and keeps the UI
alive. A demo user who fills their quota gets a toast, not a white screen.

`writeJson` returns false when the write did not land, and whether a caller must check it
follows from whether the write can FAIL rather than from taste. A write that GROWS the
stored value can hit the quota, and every one of those is checked and throws — the swipe,
the match, the message, the user document, the report — because the Firestore adapter
rejects on the same failure and every caller already has the branch. Reporting an unwritten
document as written is how this adapter managed to announce a match nobody had, send a
message it had destroyed, and confirm a safety report it had not filed. A write that only
SHRINKS cannot fail: `unmatch`, `undoSwipe`, `markRead`, `retractReport` and
`deleteAccountData` re-serialise the map they just read with entries removed, with no
`await` in between, and a shorter overwrite lands even on a full origin. `bumpUsage` is the
deliberate exception — it swallows, because the Firestore adapter swallows, and
`store-tests` pins that contract against the emulator.

`listenMessages` in demo mode has no server to push from, so it does both of the things a
browser can: it listens for the `storage` event (another tab in the same profile) and polls a
cheap signature of the thread every 1.5 s (same tab). Callers cannot tell the two adapters
apart. `listenMatches`, `listenMatchViews` and `listenLikesReceived` ride the same plumbing, and
exist because the nav badges AND the conversation list were both 20-second polls that
re-read every match and a profile for each of them. They deliver rows and a count — no profiles, because a badge draws a number — and
on Firestore they are `onSnapshot`, which bills its first delivery and then only what
changes. `store-tests/specs/11-live-cost.store.js` measures that.

`listenMatchViews` is the same stream with the faces on: the MatchViews `getMatches`
returns, pushed. It exists separately rather than as an option on `listenMatches` because
the badge's contract — rows, no profiles — is what makes the badge cheap, and one method
that sometimes fetches profiles would make that contract untestable. Two things on a page
want this account's matches, and both go through **one** subscription.

That was first justified as a read saving, and the justification was wrong. Firestore's
client SDK already shares one server target between listeners on *exactly* the same query,
so a second `onSnapshot` on an identical query costs nothing — the store suite's counter
says otherwise only because it tallies per delivered callback, which is the right model for
the first-snapshot-then-changes rule and the wrong one for this case. What the shared hub
earns instead: the property holds by construction rather than by an undocumented client
optimisation that lasts only while the two queries stay byte-identical, and it gives one
error channel, one cached first delivery for a late subscriber, and one refcounted
teardown.

Faces are fetched once per person per page load, and — since the round that measured what
that actually cost — once per person per **five minutes** across page loads too. Every page
here is its own document, so the per-page memo starts empty on every navigation and the same
`discovery/{uid}` was re-read on each one; offline persistence is not enabled, so nothing in
the SDK covered it either and every one of those reads reached the server. `fetchProfiles`
keeps them in `localStorage` instead.

Five minutes is `TOUCH_THROTTLE_MS`, and taking the same number is the design rather than a
coincidence. The cached document is the whole projection, and `matches.js` renders
"Active 4h ago" out of its `lastActiveAt` — so the TTL is not only how stale a name may be,
it is how wrong the activity line may be, and `setLastActive` already refreshes that field
at most once per throttle window. A cache may not outlive the interval at which the field it
carries is itself rewritten.

Unlike the shared stream above, this one really is a read saving, which is the whole
difference between the two: there the SDK was already doing it, here nothing was.
`store-tests/specs/15-live-list.store.js` counts the rest, and
`store-tests/specs/17-face-cache.store.js` counts this one — a cold page load at 2N and the
next at N — then spends most of its length on the ways a cache is worse than no cache: an
entry past its window, a clock corrected backwards, a face filed under the wrong uid, an
older stored shape, a cache that is not JSON, storage that is full, and a profile that is
missing and must not be remembered as missing.

Both listeners can now report a failure as well as a value. That is not decoration: before
it, a stream that died left the demo adapter delivering an empty list — telling somebody
with two conversations they had none — while the Firestore adapter delivered nothing at
all, leaving a skeleton on screen. The same fault, and the two adapters lying about it in
opposite directions, inside the one primitive a live list is built on.

A listener's removals are not counted, and that is a billing rule rather than a
simplification: Firestore charges "for a read when a document is removed from the result
set because the document has changed", and in contrast "when a document is deleted, you
are not charged for a read". The client cannot tell the two apart — both arrive as a
`removed` change carrying the document's last known data — but this app's rules can:
`swipes` is `allow update: if false`, and a match document's id is built from `users`, so
neither live query can lose a document except by deletion. Ending a conversation is
therefore delivered and free. The counter said one read, and one spec stated that as the
bill until it was measured against the pricing page.

Writes are counted too — `harness.countingDb` tallies both halves of the bill now. It bills what Firestore would: a refused write is not a write, so the tally moves
when the promise resolves rather than when the call is made, and a transaction's callback is
replayed on contention, so each attempt buffers its own writes and only the one that
committed is added. Counting where `tx.set` is called reports twenty concurrent bumps as
forty, measured. `store-tests/specs/19-write-cost.store.js` pins a pass at 2, an ordinary
like at 3, a mutual like at 4, a message at 2 and a profile save at 2 — with the documents
named, because three writes to the wrong places is also three writes.

A transaction's own `tx.get` is counted too, and was not until `specs/20-spend-cost` needed
it. The helper's header had defended that omission on two grounds — that nothing measured
with it used a transaction, and that counting them would move numbers in five specs. The
first was never true: `bumpUsage` is a transaction, so every roll-over and every counted
swipe was paying for a read the tally reported as free. The second had never been executed;
counting them moves no number the suite asserts. The reads go straight to the tally rather
than being buffered per attempt the way the writes are, because the asymmetry is real — a
replayed attempt's writes were never billed, and its reads were.

`listCandidates` is the app's largest read path and was the last one whose bill nothing
counted. It excluded people the viewer had already swiped on by reading the whole swipe
history — `getSwipes(uid)`, one read per swipe ever made, on every deck load, measured at
122 for a fresh account and 321 after two hundred swipes. It now asks by key instead:
swipe ids are derived from the pair, so `swipes where __name__ in [ids]` answers the
question for ten people at a time and a key query bills what it returns with a floor of
one. The cost stops depending on the history and becomes the account, the pages walked,
and one lookup per ten candidates considered — with the swipe lookup moved to LAST among
the filters, so somebody the mutual age or gender filter excludes is never asked about.

Ten, because the ceiling here is the ruleset's rather than Firestore's thirty: the swipes
read rule is evaluated once per value in the list, and 1000 expressions per request is a
hard limit whose overrun is a `permission-denied` naming nothing.
`rules-tests/specs/08-budget.rules.js` measures the cliff (20) and fails if the batch loses
its margin; `store-tests/specs/18-deck-cost.store.js` measures the bill. A refused batch
falls back to one read per person, warns, and still produces a deck.

The other read path was the smallest question in the app, asked constantly. The deck
consults the daily counters twice around every card — `checkBudget(field)` before the spend
and `refreshBudgets()` after it — and every answer comes out of `users/{uid}`. `canSpend`
needed two things from that document, the plan and the counters, and fetched it twice to get
them: once for the plan, then again inside `getUsage`. `refreshBudgets` needs all three
counters, so it called `canSpend` three times in a `Promise.all`. **A like was eight reads of
one document that had not changed between the first and the eighth**; a deck load, which does
the same repaint once and no pre-spend check, was six.

Eight was not a number anybody chose; it is two functions each doing the obvious thing, and
`getUsage` re-reading a document its caller already holds looks like nothing at all in a
diff. The fix is to separate the decision from the fetch: `usageFromUser(uid, user)` takes a
document the caller has, and `spendAnswer(user, usage, field)` is pure. `canSpend` is one
read; `canSpendAll(uid)` answers every field from that same read, and is what the dashboard
calls. **A like is two reads now.** `store-tests/specs/20-spend-cost.store.js` counts them,
and — because a cheaper second opinion is worth nothing — checks that the batch agrees with
the single answer field for field.

Midnight is the part that was not only about reads. The roll-over is persisted, through the
same transaction a bump takes, so three parallel `canSpend` calls each found the same stale
record — in flight together, none of them can see another's reset — and each fired its own
transaction: three contended writes for one midnight, on the first repaint of every day. One
read means one roll-over. Both sides of that are measured in the spec rather than one
asserted and the other remembered.

### Shared semantics

- `recordSwipe(from, to, action)` writes `swipes/{from}_{to}`; if the reciprocal swipe exists
  and both are positive (`like`/`super`), it creates `matches/{sortedPair}` and returns
  `{ matched: true, matchId }`. Idempotent in both adapters.
- `reconcileMatches(uid)` finishes a match check that was started and never answered. The
  facade notes the pair in `localStorage` before calling the adapter, clears the note on any
  settled outcome, and keeps it only for a rejection that says the swipe itself landed;
  `app.js` drains the log once per page. It is a note rather than a sweep because `unmatch`
  leaves both swipes behind, so a mutual like with no match document is indistinguishable
  from a conversation somebody ended — a sweep would reopen every one of them. Costs three
  reads and one write per repair, and nothing at all when nothing is owed. Device-local: it
  finishes what that browser began.
- `undoSwipe` deletes the swipe, and refuses — `{ ok: false, reason: 'matched' }`, nothing
  deleted — when the pair already have a match. A match is two people's: the other side can
  have read it and written into it, so one of them pressing rewind may not take it away. The
  dashboard checks too, from the `matched` flag on its history entry, but that flag is
  stamped when the swipe is written and is blind to a reciprocal like arriving afterwards,
  which is the ordinary case. The Firebase adapter reads and deletes in one transaction, so
  a like landing between the read and the delete is caught on the replay rather than missed.
- `getUsage` auto-resets when `usage.date` is not today, so daily limits need no scheduler.
- `canSpend(uid, field)` returns `{ allowed, remaining, limit, plan }` by reading the plan
  limits out of `ZC.config`, and is called *before* every spend. `canSpendAll(uid)` returns
  one of those per counter from a **single** read of `users/{uid}`, which is what the deck
  uses to repaint the hint, the banner and the buttons together; both go through the same
  pure `spendAnswer`, so they cannot give different answers for the same field.
- `touchActive` is throttled to one *touch* per five minutes **across page loads** — and a
  touch is TWO writes, not one: `setLastActive` stamps `users/{uid}` and then
  `discovery/{uid}`, because the projection carries `lastActiveAt` too and every other deck
  ranks on it. `store-tests/specs/03-writes.store.js` executes the timing; the count is
  `specs/19-write-cost.store.js`'s business. The throttle exists because
  `lastActiveAt` feeds the activity score but is not worth a write per navigation. It is
  called on every auth resolution and on every page that resolves a user, so without the
  throttle a browsing session is one Firestore write per navigation.
  "Across page loads" is the load-bearing part and was not true until it was measured:
  the last-write times lived in a module-level object, and every page here is its own
  HTML document, so each navigation started with an empty map and wrote again. The bound
  held only within a single page — the one case it was not needed for. They live in
  `localStorage` now (`zc.lastTouch`), with the in-memory copy kept as a fallback for a
  browser that has storage disabled, where a throttle that cannot remember should still
  hold within the page rather than disappear.
  Storage disabled is not the only way it fails, and the other way was the one that
  mattered: an origin at its quota can still be READ, so the stored map parsed, the
  fallback was never consulted, and every touch wrote again. The in-memory copy is merged
  in — later stamp per uid wins — but only after a write has actually failed, so storage
  stays authoritative whenever it works. A stamp in the future is refused as "inside the
  window" too: a fast device clock would otherwise wedge the account until real time
  caught up, with the projection every other deck ranks it by reading as maximally fresh.
  Failing to store the stamp is never reported to the user — in Firebase mode nothing
  about the account is in `localStorage`, so "changes will not be saved" would be false,
  and this is the one write in the app designed to be droppable.
  `store-tests/specs/03-writes.store.js` executes all of it: the second touch must not
  write, a touch after the window must — which pins the five minutes rather than merely
  "some throttle" — ageing the *stored* stamp must change the answer, which is what a
  fresh page with fresh memory and the same storage actually does, three touches on a
  readable-but-full origin must be one write, and none of it may say anything to the user.
  `tests/data-store.test.js` covers the clock, which needs no emulator.

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
persists it through `ZC.store.saveLearning` after the swipe animation, never blocking the UI
on the write. Not `updateUser`, which is what this said and what the deck used to do — that
spent a transaction on a value already final, rewrote the whole user document, and
republished `discovery/{uid}` to mirror a field the projection has never carried. It also
raced the usage bump's own transaction on the same document, so one of the two came back
`FAILED_PRECONDITION` on every single like; the SDK replayed it and the data was always
right, which is why it went unnoticed. `saveLearning` is one field write, no read, nothing
to lose.

Weights, component formulas and the reason thresholds are documented in the
[README](../README.md#how-the-matching-engine-works).

---

## 7. Pages and the shell

`app.js` runs on every page. It mounts the toast host, applies the saved theme to
`<html data-theme>`, renders the shared nav and bottom tab bar, wires sign-out, and keeps the
unread badges live through `ZC.store.listenMatches` — plus `listenLikesReceived` on the premium
plan — held by `syncBadgeListeners()` and released by `stopBadgePolling()`. On Firestore those
are `onSnapshot` streams that bill their first delivery and then only what changes; in demo mode
they ride the store's shared 1.5 s storage poll.

This section used to describe a 20-second badge poll gated on `document.visibilityState`, "so a
backgrounded tab costs nothing". Both halves are gone: §6 was updated when the listeners landed
and §7 was edited around and left contradicting it. The visibility claim would not hold now in
either mode — a snapshot stream re-bills its first delivery on every reconnect, and the demo
poll has no visibility gate at all.

`matches.js` is the other listener holder, and until recently was the reason this whole section
was only half true: it kept a 20-second `getMatches` poll of its own long after the badges had
moved. It now subscribes with `listenMatchViews`, through the same shared stream `app.js` uses,
and holds `listStop` released by `pagehide` and re-taken by `pageshow` and `visibilitychange`.
The `pageshow` handler is the one this app did not have anywhere: a document restored from the
back-forward cache re-runs none of the boot path, and the poll was quietly covering for that.

A stream that DIED and one that is merely SLOW are handled differently, and conflating them
cost the page its own recovery: the store reports a death once and the stream is over, so the
page releases its handle and a return to the tab can open a fresh one — holding a dead
subscription made `subscribeList` a no-op forever and left the retry button as the only way
back from a failure a reconnect may already have fixed. A slow first delivery keeps the
handle, because that stream is alive and a second one would be stacked on top of it.
The subscription is deliberately NOT gated on visibility — an idle listener costs nothing, and
each detach and re-attach pays a fresh first delivery.

Because the list arrives rather than being fetched, the first delivery is also where the page
resolves `?m=`. Doing it any earlier resolves a deep link against a list that has not come, finds
nothing, and clears the URL with nothing left to retry.

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
  `textContent` — in practice `ZC.util.el(tag, { text })`. `el()` has **no** `html` option.
  There was one — `node.innerHTML = String(p.html)`, documented as "TRUSTED markup only" and
  never passed by anything in the repository — and this section used to describe it as
  existing and safe. That is the worst shape a sink can have: the one line that can inject
  markup, in the helper every page builds every node with, kept alive by a comment asking
  the next reader to be careful. A rule nobody can break beats a rule everybody is asked to
  remember, so the line is gone, `tests/injection.test.js` fails the build if it or any
  relative comes back, and `html` survives only in `DOM_PROP_KEYS` so that passing it is
  inert rather than becoming a stray attribute.
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

The table names four of them; `tests/` holds fourteen, and all fourteen `tests/` suites run on
`node --test` with no dependencies, which is what keeps the `verify` job down to a checkout,
`npm run check:seed` and `npm test` — no install step, and it finishes in seconds. That short job is run twice, over a `node: ['20', '22']` matrix,
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
