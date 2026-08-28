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
| `specs/*.rules.js` | One spec per collection, plus the catch-all. |

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
- **The catch-all** — undeclared collections, and undeclared subcollections under your own
  user document, are closed rather than open.

Query-level rules are covered too, not just document reads: the suite asserts that the
constrained queries the app issues are allowed and that an unconstrained scan of the same
collection is refused.
