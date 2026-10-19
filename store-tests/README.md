# Store tests

For seven rounds the README carried this limitation:

> **The daily usage counter can undercount across devices.** `bumpUsage` is a
> read-modify-write, so two swipes racing from two tabs or two devices can collapse into
> one increment on the Firestore path.

It is a transaction now. These tests are the evidence — and, just as importantly, the
evidence that the *shipped* file is the one that got fixed.

## What they prove

Against a real Firestore emulator, driving the real `public/js/data-store.js`:

- **Twenty concurrent `bumpUsage` calls on one document store exactly twenty.** Against
  the old read-modify-write shape the same check stores **1 of 20** — everybody reads
  zero, everybody writes one. Interleaved `likes` and `superLikes` bumps both survive
  too, which matters because the transaction writes the whole `usage` map rather than one
  field.
- **The day roll-over happens inside that transaction.** Yesterday's counters reset to
  zero *before* today's increment lands, `getUsage` and `canSpend` agree about which day
  it is, and twenty bumps racing across midnight still total twenty.
- **A bump is one document write.** Only `usage` changes on the user document —
  `updatedAt` is not restamped, because a counter is not a profile edit — and the public
  `discovery/{uid}` projection is not republished. That second write used to happen on
  every single bump, mirroring a field that is deliberately excluded from the projection
  and could never appear in it. On a free tier whose whole thesis is staying inside a
  quota, it is worth a test. Note the scope: this is a saving on the *bump*. A whole like
  is three writes — the swipe, the counter, the affinity map — since the learning save
  stopped going through `updateUser` and became a plain field write. A pass is two, with
  no counter to move, and a mutual like is four: it also creates the match.
  `specs/19-write-cost.store.js` counts all three.
- **A whole-document save in flight cannot eat a bump's increment, or be eaten by it.** This
  is the check that caught this round's first attempt. `dashboard.js` used to start an
  `updateUser({learning})` on every swipe and leave it un-awaited across the counter bump
  that followed on a like or a super like, and `updateUser` was a whole-document
  read-modify-write — so whenever it read the document before the bump committed and wrote
  it back after, it re-wrote `usage` as it had read it and reverted the increment. Making
  the bump atomic made this *worse*, because a one-round-trip transaction commits early
  enough to lose that race: replaying that ordering thirty times stored **19 of 30**, then
  **17 of 30**. `updateUser` is transactional too now, and the same thirty overlaps store
  thirty. The deck itself no longer overlaps them: it finishes the bump first, when the
  swipe has one, and then saves the learning map through `saveLearning`, one field and no
  read. So `specs/05-swipe-race.store.js` stands for the overlap nothing sequences — a
  profile or settings save landing while a swipe bumps a counter — and keeps a
  learning-shaped patch only so its payload assertions stay exact.
- **What the transaction stores is a value `firestore.rules` accepts.** See the caveat
  below for how that one is arranged.

## Running them

The testing packages are deliberately **not** dependencies of this repo — `package.json`
declares none, and that stays true. Install them somewhere else and point `NODE_PATH` at
it:

```bash
mkdir -p /tmp/zc-emu && cd /tmp/zc-emu \
  && npm install firebase @firebase/rules-unit-testing firebase-tools
npm install --prefix /tmp/zc-sdk firebase@10.12.2   # the compat SDK the pages load

cd /path/to/zero-cost-ai-dating
export ZC_STORE_SDK=/tmp/zc-sdk/node_modules
NODE_PATH=/tmp/zc-emu/node_modules npm run test:store
```

`ZC_STORE_SDK` is where the store is driven from. It has to be the version in the pages'
gstatic tags: 12.18 and 12.19 keep a document in their memory cache after a read and 10.12.2
does not, which once let a check pass here that failed on the shipped SDK. Without it the run
uses `NODE_PATH`'s firebase and says which version it drove. With it pointing at a directory
that holds no compat SDK, or any other version, the runner exits 3 and says which directory it
looked in. A relative path is taken against the repository root, where `rules-tests/emulate.js`
starts the suite, not against the shell's directory. It has to be a separate install because
`@firebase/rules-unit-testing` peers with firebase ^12.

The emulator needs a Java runtime (17+), and booting it is most of a minute. Both
emulator suites can share one boot:

```bash
NODE_PATH=/tmp/zc-emu/node_modules npm run test:emulator   # rules, then store
```

Filter to one spec by name, exactly like the rules suite:

```bash
NODE_PATH=/tmp/zc-emu/node_modules npm run test:store -- rollover
```

Exit codes: `0` all passed · `1` a check failed · `2` usage error or crash ·
`3` the testing packages or Java are missing, or `ZC_STORE_SDK` does not hold the compat
SDK the pages load. That is an environment problem, not a broken store, and reads
differently on purpose.

## Why it loads the shipped file

A suite that re-implemented the transaction would pass while the file the browser loads
was broken. This project has been bitten by that shape of false green twice: round 5's
end-to-end run reporting `0/0 checks passed`, and round 6's four rules checks that were
denied by a rule other than the one under test. So `context.js` does not model the store —
it arranges the four things `data-store.js` expects to find and then `require`s it:

1. `window`, aliased to `globalThis`, so the browser IIFE runs untouched under Node;
2. the real `public/js/utils.js` (its DOM access all lives inside functions the store
   never calls from Node);
3. `ZC.config.mode = 'firebase'`, plus the plan limits `canSpend` reads;
4. `ZC.firebase.db` — a **compat** Firestore (`db.collection(…)`, `db.runTransaction(…)`,
   the shape the adapter is written against) pointed at the emulator.

`public/js/seed-data.js` is loaded too, before the store, as every page loads it: the
projection publishes only the interests in its vocabulary (`ZC.INTEREST_BY_SLUG`) and the
engine learns only those, so leaving it out would test a branch no page takes.
`tests/data-store.test.js` does the same trick for demo mode, without an emulator.

Every assertion reads the **stored document**, never `bumpUsage`'s return value. A bump
whose write fails still hands the caller the optimistically computed figure — that is
deliberate, a counter must never take the deck down — so a check that trusted the return
value would go green against a store that persisted nothing.

## Caveats this suite is honest about

- **Most of it runs the shipped code with open rules.** The Firestore `context.js` hands the
  store is not signed in as anybody, so a rules-enforcing project would deny every write it
  makes and prove nothing about atomicity. The suite's own project (`demo-zc-store`)
  therefore has permissive rules. `specs/04-rules-accept.store.js` narrows that gap by
  replay: it lets the shipped transaction store a value, then replays *that exact value*
  against the real `firestore.rules` on a separate project, as the document's owner. The
  shipped code itself can be run through the rules as well, with no Auth emulator:
  `rulesEnv.authenticatedContext(uid).firestore()` is a compat Firestore that
  `@firebase/rules-unit-testing` signs in as `uid` with a mock token, and handed to the
  store in place of `ZC.firebase.db` it runs the shipped function against the real ruleset
  as that user. `specs/08-conversation.store.js` does exactly that for two rewinds of one
  swipe, because the second being refused was something only the real rules could show, and
  for a paused match's face in the conversation list and the open conversation.
  `specs/04-rules-accept.store.js` does it for the account document's identity calls — a
  create carrying a provider name over the rules' 60, `updateUser`'s upsert of a missing
  document, and the email correction `auth.js` sends — and for a learning-map save. 07
  (account deletion), 10 (a reciprocal swipe the rules refuse to show), 12 (the
  who-liked-you list), 14 (filing a report, naming a paused subject, and a report opening
  nothing) and 18 (the deck and its unindexed fallback) run their shipped calls the same
  way. None of them runs `bumpUsage`'s transaction that way, so in this suite it has never
  met the rules. The browser suite is where it does: `e2e/specs/10-firebase.e2e.js` signs up
  through the Auth emulator, likes twice against the shipped ruleset, and fails if any
  `documents:commit` — the request a transaction's write goes out on — came back 403 or 409.
- **Offline is injected, not real.** `03-writes` rejects the transaction the way a lost
  connection does (`db.disableNetwork()` would not: transactions still commit through it)
  and checks the shipped catch branch. It warns, stores nothing, and the optimistic figure
  counts on from the last count the page read or committed, even when the SDK's cache holds
  nothing, as with the 10.12.2 SDK the pages load.
- **One client, so a two-device race cannot be staged.** Every spec drives the store
  through one Firestore instance at a time, and that instance's local cache already
  reflects its own pending writes — so concurrent calls from it read each other's results
  and serialise instead of racing. `01-concurrency` still means what it says, because
  `bumpUsage` is a *transaction* and the emulator arbitrates it server-side. But a plain
  read-modify-write cannot be caught here: `13-messaging` sends three messages at once and
  the unread counter reaches three whether `sendMessage` uses `FieldValue.increment` or its
  fallback. Which branch runs is pinned by a check on `globalThis.firebase` instead,
  because that is what actually decides it — `context.js` had not set that global, and the
  shipped file was quietly taking the fallback under test while every browser took the
  increment.
- **Nothing here says anything about demo mode.** It is per-device, but not single-threaded:
  the store listens for `storage` events, so several tabs of one browser share the same
  `localStorage`, and the demo adapter's bump is still a read-modify-write two of them can
  race. `tests/data-store.test.js` covers what it does guarantee.

## Layout

| File | What it is |
| --- | --- |
| `../rules-tests/emulate.js` | Boots the emulator and runs the requested suites inside it. The `npm run test:store` entry point, shared with `test:rules` so one boot can serve both. |
| `run.js` | Runs every spec, prints the summary. Refuses to report success if no check ran. |
| `context.js` | Loads the shipped `public/js/data-store.js` into Node against an emulator-backed compat Firestore. |
| `harness.js` | The install hint, the project ids, the open ruleset, and `countingDb`, the stand-in for the database that the cost specs (09, 11, 12 and 15 to 21) count reads and writes through; its docblock lists the ways it is known to miss one and where a count it gives is only an upper bound. Package resolution is imported from `rules-tests/harness.js` so the two suites cannot disagree about where `NODE_PATH` points. |

One spec per property. `tests/docs.test.js` fails if a spec exists without a row here.

| Spec | The property it establishes |
| --- | --- |
| `specs/01-concurrency.store.js` | concurrent bumps land exactly once each — 20 at a time on one document store 20 |
| `specs/02-rollover.store.js` | the day roll-over happens inside the transaction, so a bump at midnight cannot resurrect yesterday |
| `specs/03-writes.store.js` | a bump writes the `usage` field and nothing else, so it can never clobber a profile edit; a bump that cannot reach the server counts on from the last count the page read or committed (whatever a caller did to the record it was handed), even where the SDK keeps no cached copy (10.12.2, the version the pages load) — and `touchActive` honours the one-touch-per-five-minutes throttle `docs/ARCHITECTURE.md` claims for it (its timing, not its cost: a touch is two writes, and `21-navigation-cost` is what counts them), the only interesting logic in the facade rather than in an adapter, and until now the only such claim nothing executed — including that its stamp lives in storage rather than in a per-page variable, and that a browser which refuses that write is not something the user is told about, and that an origin which can be READ but not written still throttles — the case the move into storage was supposed to survive and did not |
| `specs/04-rules-accept.store.js` | the values the shipped code stores are ones `firestore.rules` accepts — the counter the transaction writes, and the `discovery/{uid}` projection a profile save publishes (only vocabulary interests, and no activity stamp later than now, even when the private document holds others), each replayed against the real ruleset. The projection half matters most: a profile save writes it in the same transaction as the private document, so a value the rules refuse there fails the whole save, and sign-up writes it on its own and swallows a refusal, which leaves the account out of every deck with nothing but a console warning. It also runs the account document's identity calls through the real rules as the account: a create carrying a 70-character provider name, an upsert of a missing document (which must store the signed-in account's email), and the email correction, with an address that is not the token's still refused. And a learning map that strangers' 239-character tags filled to 1195 of its 1200 key characters saves again on the next swipe, under the real rules, keeping only vocabulary slugs. And with the device clock 25 hours fast, a block and a profile edit still save, the public profile included, while the public activity stamp stays the one the rules last accepted |
| `specs/05-swipe-race.store.js` | a document save in flight cannot eat the counter, or be eaten by it |
| `specs/06-projection-order.store.js` | a racing save cannot leave the public `discovery/{uid}` projection behind the private document — and neither can a birthday. A profile saved with the clock moved 240 days back, with a birthday 30 days ago, must be served at its new age after the next visit's presence touch. The touch carries `profile.age` in the `discovery/{uid}` update it already makes, so it is still two writes and no read. A deck limited to the old age then no longer offers the person, and one limited to the new age offers them at it, as the demo deck always did |
| `specs/07-deletion.store.js` | deleting an account leaves nothing of it behind — every collection enumerated, not just the ids the test knows about, plus the match's message subcollection; a report *about* the account is a documented exception and stays in the queue. So is a pass aimed at it, which the rules keep private to its author: run as the account itself under the real rules, the purge succeeds, takes its own swipes, the likes aimed at it and both of its documents, and leaves that pass with the account that made it. A liker who rewinds between the purge's query and its batch delete leaves a miss, or a pass if they swipe again. The rules refuse both to the target, so the whole batch is refused, but this does not stop the purge: it asks again once and leaves that pass with its author. Refused a second time, it throws with the account's documents intact, and a retry finishes it |
| `specs/08-conversation.store.js` | a conversation stays live past the listener's window — seeded beyond both the current 200 and the 500 the listener used to ask for — survives a rewind of the swipe that led to it, because the reciprocal like can arrive after the swipe the caller remembers, and leaves nothing underneath it when `unmatch` finally removes it, which the message-delete rule stops being able to authorise once the parent is gone — and a second rewind of a swipe that is already gone answers `{ ok: true }` under the real ruleset, as the demo adapter does, where the swipe delete rule used to refuse it. Under the same rules, a match who has paused is still named in the conversation list and in the open conversation |
| `specs/09-read-cost.store.js` | opening the page does not get more expensive the longer somebody has used the app — the Firestore the store talks to is wrapped and every document a read returns is tallied, and the same call against twice the swipe history has to come out at the same number Also the free plan's half: `countLikesReceived` must agree with the list, read exactly one document fewer per person waiting — everything but the profiles — and leave the face cache empty where the list fills it, because the page that says "free accounts never receive the real ones" used to fetch and cache every one. And `pendingOf`'s answered-lookup, batched ten at a time: 49 reads became 38 here |
| `specs/10-blocked-match.store.js` | a match write the rules refuse — which is how a block is enforced, since the list is private — comes back as a plain "no match" instead of throwing, so the deck does not take the card back and tell somebody their swipe was lost. And, under the real rules, the reciprocal swipe the rules refuse to show — a pass, or no swipe yet — is a plain "no match" too, from a like and from a lost match check finished on a later page load, and is not logged, while liking somebody who liked you still makes the match. The injected refusal is met exactly twice, once dated now and once dated by the like it answers. And under the real rules with the device clock 25 hours fast, a mutual like still makes the match, dated by that like, while somebody who blocked the account is still plainly no match |
| `specs/11-live-cost.store.js` | a badge subscription costs one read per match once, nothing at all while nothing happens, and one read when one conversation changes — the claim the twenty-second poll was replaced on, counted rather than quoted |
| `specs/12-live-likes.store.js` | the who-liked-you count goes down when *this* client answers somebody — which its own query can never tell it, and which the poll it replaced got right by brute force — and a stranger's new like costs three reads whether eight people were waiting or eight hundred. Subscribing costs the senders, the block list once, and one lookup per TEN senders; it pinned one per sender until `21-navigation-cost` showed that cost is paid on every page. And the who-liked-you LIST, asked for before that count has delivered — the order matches.html was measured asking in, on premium — waits for the count's answer instead of reading the account and the lookups again, so it adds only one profile per person it lists. Once the count has delivered, the list never takes its word, not even while a later lookup is still out: from then on the count is remembering answers, and a remembered answer cannot see one given from another tab. A count that stops, dies or fails its lookup hands a waiting list back to look for itself. Under the real rules, the list loads and keeps the face of a liker who has paused, and the count agrees, with nobody who passed in either |
| `specs/13-messaging.store.js` | the messaging path against a real Firestore — `sendMessage`, `getMessages`, `markRead` and `getMatch` were four of the fifteen facade methods this suite had never called in firebase mode, so the documents the adapter produces had never met the rules that judge them. Also pins which branch `sendMessage` takes: `context.js` had not made `firebase` global, so the shipped file was quietly using its read-modify-write fallback under test while every browser used `FieldValue.increment`. Then a message the server has not taken yet: sent with the SDK's network disabled, it is delivered marked `pending: true` while `sendMessage` waits and the server holds nothing. Once the server acknowledges it, it is delivered again unmarked, in exactly the four keys the demo adapter stores. And a connection that drops and comes back, with nothing else changed, delivers nothing new, as the demo adapter's `deliver()` drops an unchanged list. And, under the real rules, a count the other side parked at the million ceiling does not stop a message updating the preview, on the pages' SDK as well as the testing library's |
| `specs/16-reconcile.store.js` | the match check that was started and never answered — the swipe lands, the match step does not, and nothing anywhere retried, because both clients have spent their swipe. A note the failing device leaves is finished on the next page load: **three reads and one write**, and **zero reads on every page load that owes nothing**, which is what makes running it everywhere free. Also the claim the whole design rests on, executed rather than argued: `unmatch` deletes the match and leaves BOTH swipes, so "mutual like with no match document" is byte-for-byte an ended conversation — replacing the note with the sweep it was chosen over reopens one, measured. And the two ways a repair must end: a refusal spends the note (retrying a blocked pair forever makes the repetition the tell), an outage keeps it. And a match check that fails on a pair decided earlier says which decision stands, through an error that cannot be marked as well, and keeps the note taken before the call, even when the swipe made was a pass, so the next page load finishes it |
| `specs/15-live-list.store.js` | the conversation list, pushed rather than polled: a page holding both the nav badge and the list pays for the rows ONCE, plus one face per person per page, and nothing at all while nothing happens — and nothing when the other side ends a conversation either, because a deletion is delivered but not billed, which this file asserted as one read until it was checked against Firestore's pricing page. What the shared stream does NOT do is save a read — the client SDK already shares one server target between listeners on exactly the same query, so the second subscription was always free, and the "two instead of one" this file reported was `countingDb` tallying per delivered callback. The checks say deliveries where they mean deliveries; see that spec's header. Also the two things a composed listener gets wrong silently: a profile read that lands after a newer list must not put the older one back, and a hydration still resolving when the page tears down must not be delivered. And the failure both adapters used to lie about in opposite directions — a stream that dies now says so, to every subscriber, and a retry afterwards is allowed to work |
| `specs/17-face-cache.store.js` | a face read on one page is not read again on the next — every page here is its own document, so `getMatches` re-read a `discovery/{uid}` per conversation on every visit, and that is a real bill rather than the one 15 got wrong: offline persistence is off, so each page load is a fresh SDK with an empty cache and the skipped `get()` would have reached the server. **Cold 2N, warm N**, and the saving is proved by editing the stored copy rather than by trusting the counter. Then every way a cache is worse than no cache: an entry past its window, one stamped in the future by a corrected clock, one filed under the wrong uid, one written by an older shape, one that is not JSON, an origin whose storage is full, and a profile that is missing — none of which may show the wrong person, throw, grow without bound, or be remembered as missing. And the path matches.html actually runs: the live list files its faces in one write, as `getMatches` does, where it used to rewrite the whole cache once for every face it read. The premium likes panel, which files its faces after the list's, can no longer evict the conversation faces the list has just paid for, though a conversation face past its window still gives way |
| `specs/18-deck-cost.store.js` | what a deck load costs, which until this file was the biggest read path in the app and the only major one nothing counted. `listCandidates` excluded people you had already swiped on by reading your **entire swipe history**, every time: measured here before the change at **122 reads fresh, 221 after a hundred swipes, 321 after two hundred** — the same defect `09-read-cost` exists for, in the same file, two functions apart, and the comment above it argued it could not be fixed. Swipe ids are derived from the pair, so it asks by key instead, ten at a time; the checks are the scaling property (four times the history, the same bill), the batching, that only the room the deck has left is asked about, that somebody the mutual filters exclude is never asked about at all, and that a refused batch still produces a deck — as does an SDK with no `FieldPath.documentId`, which now says so where it used to fall back to one read per person without a word. Under the real rules, it also checks that the deck and its fallback for a missing composite index both load and leave out a paused profile, that the fallback pages past a page of people already swiped on, and that a walk which loses the index part-way finishes in the fallback, missing and repeating nobody |
| `specs/19-write-cost.store.js` | the other half of the bill. A Spark project gets 50,000 reads a day and **20,000 writes**, and until this file nothing counted a write — `scripts/claims.js` names *"a 'three writes' that was four for a mutual like"* as one of the three numbers that drifted before anything executed them, and it was still prose. Executed now: a pass is **2** writes, an ordinary like **3**, a mutual like **4**, a like on a pair already passed **0** (and the answer says the pass stands, so the deck counts and learns nothing either), a swipe on a decided mutual pair that has lost its match **1** (the match itself), a message **2**, a profile save **2** — with the documents named, because three writes to the wrong places is also three writes, and the wrong place has history: the learning save used to go through `updateUser` and republish `discovery/{uid}`. Everything from its section 6 on is about the counter rather than the app, because a cost counter is easy to build wrong in more ways than the two this row once said were all of them. A write the server refuses is not billed, and neither is one the SDK refuses before sending it; a transaction's callback is replayed, so twenty concurrent bumps must come to twenty however many attempts that takes. `add()` is counted too and exercised though nothing shipped uses it, because the day somebody reaches for it the alternative is a tally that silently reports one short. A reference reached through a snapshot (its `docs`, `forEach` or `docChanges()`, a listener's delivery, a transaction's `get`) or as what `add()` resolves to is billed like one built from the database, and the counter used to see none of them. Account deletion reaches every match that way: for an account with one match of two messages, a swipe each way and no filed reports it is **7 writes and 6 reads**, and the match's own delete and the scan of its messages were billed and never counted. A listener is counted any of the five ways the SDK accepts one — the four its typings declare and a fifth — where all but one used to count nothing — and an observer's `error` still reaches the app. Turning a counted reference into text is not a write, a chained `batch.set(a).set(b).commit()` is two writes rather than none, and a read the client's own cache answers is not a read. Only the SDK's own objects are followed, so a converter's model comes back as the app made it. Some ways out of the counter are still open, and the store takes none of them; `store-tests/harness.js` lists the ones known |
| `specs/20-spend-cost.store.js` | the smallest question in the app, and per swipe the most expensive thing the deck did. `canSpend` needed two things out of `users/{uid}` — the plan and the counters — and fetched the document twice to get them, once for the plan and once more inside `getUsage`; `refreshBudgets` then asked about all three counters in a `Promise.all`. **A like was eight reads of one document that had not changed between the first and the eighth.** It is **two** now: `canSpend` reads once, and `canSpendAll` answers every field from that one read. The checks are the properties that survive a refactor rather than the numbers — one question is one read, all three are also one read, and the batch AGREES with the single answer field for field, since a cheaper second opinion is worth nothing. Midnight is the other half: three parallel `canSpend` calls each found the same stale record and each fired its own roll-over transaction, so the first repaint of every day cost three contended writes; both sides of that are measured here rather than one asserted and the other remembered. Writing it cost the instrument a correction: `countingDb` did not count a transaction's own `tx.get`, and its header defended that on two grounds — that nothing measured with the helper used a transaction, and that counting them would move numbers in five specs. The first was never true (`bumpUsage` is a transaction) and the second had never been run (it moves no number the suite asserts) |
| `specs/21-navigation-cost.store.js` | what EVERY page pays before it does anything of its own, which nothing counted and which is paid most often. Each page is its own HTML document with a fresh SDK, so each navigation resolves the account and subscribes the nav badge: **`1 + max(1, N)` reads per page load for N conversations** — two with none, seventeen at sixteen. Pinned as a known cost rather than a virtue, so it fails if the badge ever starts hydrating profiles and also if somebody fixes it, which is the point; the header says what the fix would take (an `unreadFor` array, a schema change, not built). The premium half was fixed: the likes listener paid `1 + 2M` for M people waiting, a `get` per sender to learn whether it had been answered — billed even though a waiting sender's answer is a document that does not exist — and now asks ten at a time, `M + 1 + ⌈M/10⌉`, with answered likes still found and excluded. And the touch's write count, which `docs/ARCHITECTURE.md` handed to `19-write-cost` and which nothing had ever executed: **two**, the account and its projection, then nothing for five minutes |
| `specs/14-reports.store.js` | the abuse-report path, likewise never run against Firestore — the id that bounds the queue, the trimming, the listing, and the refused read that has to mean "nothing left to retract" without letting an outage mean the same thing; and, under the real rules, that a match who deletes their projection can still be reported, that a reporter who has since unmatched can still name a subject who paused while the next account on the same browser cannot, from the server or the face cache, and that filing a report does not open a paused profile to a stranger |

Each spec starts from a cleared database, but the store itself is loaded once per process
(the IIFE returns early on a second load, and `require` caches), so specs use their own
uids rather than assuming they are alone.
