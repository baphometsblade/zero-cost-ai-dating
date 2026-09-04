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
| `specs/02-discovery.rules.js` | `discovery/{uid}` — world-readable, but only the public shape |
| `specs/03-swipes.rules.js` | `swipes/{from_to}` — authored by you, immutable, id-pinned, and probeable when absent only by the pair named in the id |
| `specs/04-matches.rules.js` | `matches/{a_b}` — participants only, only with a reciprocal like, and the same id-bounded probe when absent |
| `specs/05-messages.rules.js` | `matches/{id}/messages` — participants only, append-only, self-authored |
| `specs/06-reports.rules.js` | `reports/{from_about}` — bounded, author-only, unprobeable |
| `specs/07-default-deny.rules.js` | everything else — denied by default |
| `specs/08-budget.rules.js` | the rules file itself — how much of Firestore's 1000-expression-per-request ceiling `userDocOk` has left |

Each spec starts from an empty database, so one spec's fixtures can never satisfy
another's preconditions and mask a missing rule.

## What is covered

- **`users/{uid}`** — owner-only reads (the private-data split), the frozen `uid`/`email`/
  `createdAt`, and every documented field bound, one field at a time.
- **`discovery/{uid}`** — readable by any signed-in user by design, and the closed key list
  that makes that safe: `email`, `blocked`, `learning`, `usage`, `plan` and `birthdate` all
  fail to smuggle in.
- **`swipes/{from_to}`** — the id convention, authorship, immutability, and deletes in both
  directions (rewind, and account deletion purging inbound likes).
- **`matches/{a_b}`** — that a match cannot be created without proof the other person liked
  you first, which is what stops an account minting a match against a uid found through the
  open `discovery` collection and then messaging a stranger.
- **`matches/{id}/messages`** — participants only, self-authored, 1–1000 characters, never
  editable, but deletable so unmatch and account deletion can purge a thread.
- **`reports/{from_about}`** — the id that bounds the queue, the subject having to exist,
  author-only visibility, and that a *missing* report also denies so its existence cannot
  be probed.
- **Absent documents, in all three of those** — the reports rule was alone in getting this
  right, and said so in a comment while the swipes rule two hundred lines above claimed a
  bare `resource == null` "leaks nothing". It does: an empty snapshot and a denial are
  different answers, so allowing every miss tells any signed-in caller whether the document
  they named exists. Swipes and matches carry deterministic ids built from the pair, so a
  probe answers "has Alice swiped on Bob" and "have those two matched" for uids anyone can
  enumerate out of the world-readable `discovery` collection. A miss is now allowed only
  when the id names the caller, which is every read the client actually makes, and both
  specs check the other half — that a miss between two strangers is refused.
- **Document size, as distinct from document shape** — a closed key list bounds how many
  fields a document may have and says nothing about how big one may be. Every timestamp in
  this project was checked as `is string`, which bounds nothing, so a swipe could be a
  megabyte under a name that reads like `createdAt`. Every stamp is capped now; `unread`
  may only be keyed by the two participants, with numeric counts; an `id` field must equal
  the document id; and `discovery/{uid}`'s `location` — which sat on its key list with no
  validator at all, in the only world-readable collection — is held to a coordinate pair.
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
  measured. Both the private document and the world-readable projection are held to it, and
  each cap has a control alongside it — six photo links at the length the profile editor
  allows must still save, or the bound is a broken feature rather than a bound.
- **The catch-all** — undeclared collections, and undeclared subcollections under your own
  user document, are closed rather than open.
- **The rules file's own budget.** Firestore evaluates at most 1000 expressions per request.
  It is hard, it is not configurable, and exceeding it is not a rule returning false: it is
  an error, and the write comes back as a flat `permission-denied` naming no field. When the
  caps above were added, every valid user write in this suite turned red at once — because
  `userDocOk`, with its fourteen keys and forty-odd validated fields, had room for **eleven**
  more trivial clauses and nothing had ever measured that. `08-budget` measures it now, by
  padding `userDocOk` with a known number of always-true clauses and finding where a valid
  document stops being accepted. It also measures the shape of the cost, which is not what
  it looks like: a function call is worth about 2.2 plain clauses, and `in` on a map is
  *cheaper* than reading a field, so factoring repeated bounds into helpers — the obvious
  tidy-up — spends the margin rather than saving it.

Query-level rules are covered too, not just document reads: the suite asserts that the
constrained queries the app issues are allowed and that an unconstrained scan of the same
collection is refused.
