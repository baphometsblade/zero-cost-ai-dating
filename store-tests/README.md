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
  quota, it is worth a test. Note the scope: this is a saving on the *bump*. A whole swipe
  is three writes — the swipe, the counter, the affinity map — since the learning save
  stopped going through `updateUser` and became a plain field write. A mutual like is four:
  it also creates the match.
- **A swipe does not lose its increment to the deck's own learning save.** This is the
  check that caught this round's first attempt. `dashboard.js` fires an un-awaited
  `updateUser({learning})` immediately before the bump, and `updateUser` was a
  whole-document read-modify-write — so it re-wrote `usage` as it had read it and reverted
  the increment that had just committed. Making the bump atomic made this *worse*, because
  a one-round-trip transaction commits early enough to lose that race: replaying the deck's
  exact ordering thirty times stored **19 of 30**, then **17 of 30**. `updateUser` is
  transactional too now, and the same thirty swipes store thirty.
- **What the transaction stores is a value `firestore.rules` accepts.** See the caveat
  below for how that one is arranged.

## Running them

The testing packages are deliberately **not** dependencies of this repo — `package.json`
declares none, and that stays true. Install them somewhere else and point `NODE_PATH` at
it:

```bash
mkdir -p /tmp/zc-emu && cd /tmp/zc-emu \
  && npm install firebase @firebase/rules-unit-testing firebase-tools

cd /path/to/zero-cost-ai-dating
NODE_PATH=/tmp/zc-emu/node_modules npm run test:store
```

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
`3` the testing packages or Java are missing — which is an environment problem, not a
broken store, and reads differently on purpose.

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

`public/js/seed-data.js` is deliberately left out: it only feeds the demo adapter's
seeding, which firebase mode never runs. `tests/data-store.test.js` does the same trick
for demo mode, without an emulator.

Every assertion reads the **stored document**, never `bumpUsage`'s return value. A bump
whose write fails still hands the caller the optimistically computed figure — that is
deliberate, a counter must never take the deck down — so a check that trusted the return
value would go green against a store that persisted nothing.

## Caveats this suite is honest about

- **It runs with open rules, and cannot do otherwise.** The client SDK has no way to mint
  an auth token without the Auth emulator, so a rules-enforcing project would deny every
  write and prove nothing about atomicity. The suite's own project (`demo-zc-store`)
  therefore has permissive rules. `specs/04-rules-accept.store.js` closes that gap the
  only honest way left: it lets the shipped transaction store a value, then replays *that
  exact value* against the real `firestore.rules` on a separate project, as the
  document's owner. What it does not do is run the transaction itself through the rules.
- **Offline is out of reach here.** A failed transaction warns and returns the optimistic
  figure, and nothing persists. That path is exercised only by its nearest neighbour — a
  bump for a uid with no user document — not by real connectivity loss.
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
| `harness.js` | The install hint, the project ids, and the open ruleset. Package resolution is imported from `rules-tests/harness.js` so the two suites cannot disagree about where `NODE_PATH` points. |

One spec per property. `tests/docs.test.js` fails if a spec exists without a row here.

| Spec | The property it establishes |
| --- | --- |
| `specs/01-concurrency.store.js` | concurrent bumps land exactly once each — 20 at a time on one document store 20 |
| `specs/02-rollover.store.js` | the day roll-over happens inside the transaction, so a bump at midnight cannot resurrect yesterday |
| `specs/03-writes.store.js` | a bump writes the `usage` field and nothing else, so it can never clobber a profile edit |
| `specs/04-rules-accept.store.js` | the value the transaction stores is one `firestore.rules` accepts — the two suites agreeing about the same document |
| `specs/05-swipe-race.store.js` | a document save in flight cannot eat the counter, or be eaten by it |
| `specs/06-projection-order.store.js` | a racing save cannot leave the public `discovery/{uid}` projection behind the private document |
| `specs/07-deletion.store.js` | deleting an account leaves nothing of it behind — every collection enumerated, not just the ids the test knows about, plus the match's message subcollection; a report *about* the account is the documented exception and stays in the queue |
| `specs/08-conversation.store.js` | a conversation stays live past the listener's window — seeded beyond both the current 200 and the 500 the listener used to ask for — survives a rewind of the swipe that led to it, because the reciprocal like can arrive after the swipe the caller remembers, and leaves nothing underneath it when `unmatch` finally removes it, which the message-delete rule stops being able to authorise once the parent is gone |
| `specs/09-read-cost.store.js` | a background refresh does not get more expensive the longer somebody has used the app — the Firestore the store talks to is wrapped and every document a read returns is tallied, and the same call against twice the swipe history has to come out at the same number |
| `specs/10-blocked-match.store.js` | a match write the rules refuse — which is how a block is enforced, since the list is private — comes back as a plain "no match" instead of throwing, so the deck does not take the card back and tell somebody their swipe was lost |

Each spec starts from a cleared database, but the store itself is loaded once per process
(the IIFE returns early on a second load, and `require` caches), so specs use their own
uids rather than assuming they are alone.
