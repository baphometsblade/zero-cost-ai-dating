# Firestore rules tests

`firestore.rules` is the only server-side security this app has. There are no Cloud
Functions and no trusted server code anywhere, so every guarantee the README makes about
privacy — that your email and block list are not readable by other accounts, that nobody
can mint a match with a stranger and then message them, that the abuse queue cannot be
enumerated — is a claim about that one file.

For five rounds it was reviewed by eye and by bots. Nothing had ever executed it. These
tests run the real rules file against the Firestore emulator and assert what it actually
does.

## Running them

The testing packages are deliberately **not** dependencies of this repo — `package.json`
declares none, and that stays true. Install them somewhere else and point `NODE_PATH` at
it:

```bash
mkdir -p /tmp/zc-rules && cd /tmp/zc-rules \
  && npm install @firebase/rules-unit-testing firebase-tools

cd /path/to/zero-cost-ai-dating
NODE_PATH=/tmp/zc-rules/node_modules npm run test:rules
```

The emulator needs a Java runtime (17+). `npm run test:rules` boots it, runs every spec
inside it, and shuts it down. Filter to one spec by name:

```bash
NODE_PATH=/tmp/zc-rules/node_modules npm run test:rules -- reports
```

Exit codes: `0` all passed · `1` a check failed · `2` usage error or crash ·
`3` the testing packages or Java are missing — which is an environment problem, not a
failing rule, and reads differently on purpose.

## Layout

| File | What it is |
| --- | --- |
| `emulate.js` | Boots the emulator once and runs the suites that need it inside it. Shared by `npm run test:rules`, `npm run test:store` and `npm run test:emulator` — the store suite lives in [`store-tests/`](../store-tests/README.md) but pays the same Java start-up, so it is worth booting only once. |
| `run.js` | Loads `firestore.rules`, runs every spec, prints the summary. Refuses to report success if no check ran. |
| `harness.js` | Resolves the outside packages, and holds the document fixtures the rules validate against. |

One spec per collection, plus the catch-all. `tests/docs.test.js` fails if a spec exists
without a row here.

| Spec | The rule it executes |
| --- | --- |
| `specs/01-users.rules.js` | `users/{uid}` — owner-only, and shape-validated on write |
| `specs/02-discovery.rules.js` | `discovery/{uid}` — readable while discoverable, and only the public shape: interests from the editor's vocabulary, and a `lastActiveAt` in `toISOString()` shape no more than a day ahead |
| `specs/03-swipes.rules.js` | `swipes/{from_to}` — authored by you, immutable, id-pinned, a pass private to its author, probeable when absent only by its author, and deletable when absent only by the pair named in the id |
| `specs/04-matches.rules.js` | `matches/{a_b}` — participants only, only with a reciprocal like, stamps no more than a day ahead, whole-number unread counts, and probeable when absent only by the pair named in the id |
| `specs/05-messages.rules.js` | `matches/{id}/messages` — participants only, append-only, self-authored, stamped no more than a day ahead |
| `specs/06-reports.rules.js` | `reports/{from_about}` — bounded, author-only, unprobeable |
| `specs/07-default-deny.rules.js` | everything else — denied by default |
| `specs/08-budget.rules.js` | the rules file itself — how much of Firestore's 1000-expression-per-request ceiling `userDocOk` has left on the create, the routine update and the email-correcting update of the costliest document the store writes (a premium account with every optional field set, a location among them), and how long an `in` list the swipes read rule accepts before the same ceiling denies it. The second one binds the deck: `listCandidates` asks "have I swiped on these people" as `swipes where __name__ in [ids]`, the read rule is evaluated once per value, and going over comes back as a `permission-denied` naming nothing. Measured at 20; the store asks about 10 |

Each spec starts from an empty database, so one spec's fixtures can never satisfy
another's preconditions and mask a missing rule.

## What is covered

- **`users/{uid}`** — owner-only reads (the private-data split), the frozen `uid`/`createdAt`
  and an `email` that can only be corrected to the address on the caller's own sign-in token,
  every documented field bound, one field at a time, and a key list closed in
  every map that names its fields: one unexpected key at the top and in each of `profile`,
  `preferences`, `learning`, `usage`, `profile.personality` and `profile.location` is
  refused, as is a list where each of those maps belongs. `learning.interestAffinity` is
  keyed by interest rather than by field, so it is bounded instead of closed: at most 60
  keys, with a cap on the characters of its keys and another on its values.
- **`discovery/{uid}`** — readable by any signed-in user while discoverable, by design, and
  the closed key list that makes that safe: `email`, `blocked`, `learning`, `usage`, `plan`
  and `birthdate` all fail to smuggle in. A paused projection is readable only by its owner,
  a match and somebody it liked. A stranger can neither read one nor list them, and filing a
  report about one does not open it. Somebody it passed on cannot read it either, because
  that would expose the pass.
- **`swipes/{from_to}`** — the id convention, authorship, immutability, a pass aimed at you
  being unreadable and impossible to list (and a missing swipe aimed at you refused alike,
  so the refusal does not reveal the pass), and deletes in both directions (rewind, and
  account deletion purging inbound likes). That includes a second rewind of a swipe that is
  already gone, which the id allows and which is refused to a stranger and to a signed-out
  visitor.
- **`matches/{a_b}`** — that a match cannot be created without proof the other person liked
  you first, which is what stops an account minting a match against a uid found through the
  open `discovery` collection and then messaging a stranger.
- **`matches/{id}/messages`** — participants only, self-authored, 1–1000 characters, never
  editable, but deletable so unmatch and account deletion can purge a thread.
- **`reports/{from_about}`** — the id that bounds the queue, the subject having to exist (in
  discovery, or as the reporter's match, so deleting a projection does not take a match out
  of the queue), author-only visibility, and that a *missing* report also denies so its
  existence cannot be probed.
- **Absent documents, in all three of those** — the reports rule was alone in getting this
  right, and said so in a comment while the swipes rule two hundred lines above claimed a
  bare `resource == null` "leaks nothing". It does: an empty snapshot and a denial are
  different answers, so allowing every miss tells any signed-in caller whether the document
  they named exists. Swipes and matches carry deterministic ids built from the pair, so a
  probe answers "has Alice swiped on Bob" and "have those two matched" for uids anyone can
  enumerate out of the public `discovery` collection. A miss is now allowed only
  when the id names the caller (for a swipe, as its author), which is every read the client
  needs answered. Both specs check the other half: that a miss between two strangers is
  refused, and for swipes, a miss aimed at the caller too.
- **Document size, as distinct from document shape** — a closed key list bounds how many
  fields a document may have and says nothing about how big one may be. Every timestamp in
  this project was checked as `is string`, which bounds nothing, so a swipe could be a
  megabyte under a name that reads like `createdAt`. Every stamp is capped now, and the ones
  that order other people's screens are held to no more than a day past the server's clock;
  `unread` may only be keyed by the two participants, with whole-number counts up to a
  million; an `id` field must equal the document id; and `discovery/{uid}`'s `location` —
  which sat on its key list with no validator at all, in the only public collection —
  is held to a coordinate pair.
  Each of those has a check, and each check writes to its **own** document: they shared one
  at first, and a whole-suite mutation run showed the first write succeeding and turning
  the next into an update, refused by a different rule, green for the wrong reason.
- **Every key a closed allowlist admits.** `hasOnly` decides which fields a document may
  have and says nothing about what any of them may contain, so a key on the list that
  nothing else in its validator looks at is a field the rules accept unexamined — any type,
  any size, up to 1 MiB. That happened twice. `discovery/{uid}`'s `location` was found by
  eye a few rounds ago; `personality` had the identical defect three lines away, survived
  that pass and every one since, and was found only when `tests/limits.test.js` started
  asking the question mechanically. `reports/{from_about}` had it too, on `id`, in the one
  collection whose entire design is a deterministic id bounding the queue. Both are
  validated now, and both are executed here.
- **The contents of a list, not just its length** — `size()` bounds how many elements a
  list has and says nothing about what is in them, so `photos: [<a quarter of a megabyte>]`
  was one photo, comfortably under six. The same was true of `interests`, of `blocked`, and
  of both the keys and the values of `learning.interestAffinity` — a map value could be a
  megabyte-long string under the name `hiking`. `docs/DEPLOY.md` listed exactly those as
  the hole that could not be closed, because the rules language cannot iterate a list.
  It cannot, and it does not need to: `join` turns a list into a string and a string can be
  measured. Both the private document and the public projection are held to it (the
  projection's `interests` more tightly still, to the editor's vocabulary), and each cap has
  a control alongside it — six photo links at the length the profile editor allows must
  still save, or the bound is a broken feature rather than a bound.
- **The catch-all** — undeclared collections, and undeclared subcollections under your own
  user document, are closed rather than open.
- **The rules file's own budget.** Firestore evaluates at most 1000 expressions per request.
  It is hard, it is not configurable, and exceeding it is not a rule returning false: it is
  an error, and the write comes back as a flat `permission-denied` naming no field. When the
  caps above were added, every valid user write in this suite turned red at once — because
  `userDocOk`, with its fourteen keys and forty-odd validated fields, had room for **eleven**
  more trivial clauses and nothing had ever measured that. `08-budget` measures it now, by
  padding `userDocOk` with a known number of always-true clauses and finding where a valid
  document stops being accepted — on create, on a routine update and on the update that
  corrects a stored email, for the costliest document the store writes, with the floor
  applied to the lowest. It used to measure only the create of a free account, the write
  with the most room, and that hid the one that binds: updating the suite's fixture as a
  premium account, every optional field set and a location among them, was already over the
  limit. So the shipped upgrade to premium, run as that account's owner, came back as a flat
  `permission-denied`, while the same account without its location upgraded and the spec
  reported five clauses to spare. The shape of the cost is measured by the spec too, on a
  small ruleset of its own built the way `userDocOk` is, and it is not what it looks like: a
  call such as `stampOk(d.createdAt)` costs about 2.4 plain clauses and the same check
  written inline about 2.2, so factoring repeated bounds into helpers — the obvious tidy-up
  — spends the margin rather than saving it. Both figures are printed on every run. They
  used to be written down from memory as 2.2 and 1.5, and a comment built on them called a
  forwarding wrapper "pure overhead"; put back, it moved the headroom by nothing.

  These figures are a measurement of the rules engine's accounting rather than of anything
  in this repository, so an emulator upgrade could move them with nothing here changing.
  The single figure the spec used to print, 5 for creating a free account, read the same on
  two independent machines, and that old spec, run against the old rules on firebase-tools
  15.32.1, which fetches the same emulator jar, still reads 5. The three it prints now, for
  creating, updating and correcting the email of a premium account, have been measured on
  one machine only, and until CI prints the same nothing says they reproduce. Whatever moves
  them, the response is to find out what did — never to lower the floor until the build goes
  green, which is the one thing that would make the check worthless.

Query-level rules are covered too, not just document reads: the suite asserts that the
constrained queries the app issues are allowed and that an unconstrained scan of the same
collection is refused.
