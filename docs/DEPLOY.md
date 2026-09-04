# Deploying to Firebase (free tier)

Going from demo mode to a real, hosted app with accounts and a shared database. Every step
below stays on the **Spark (free) plan** — no billing account is required at any point, and
nothing in this repo will ask for one.

Budget about fifteen minutes, most of which is waiting for Firestore indexes to build.

---

## GitHub Pages (the live demo) — and why it is not this guide

The repository also publishes itself to GitHub Pages: `.github/workflows/pages.yml` uploads
`public/` on every push to `main`, which is what serves the
[live demo](https://baphometsblade.github.io/zero-cost-ai-dating/). That deploy is demo mode
only — no Firebase project is attached, so there are no accounts and no shared database;
every visitor gets the seeded cast in their own browser's `localStorage`.

**Pages has to be switched on once, by hand, before any of that works.** The workflow asks
for the site to be created (`configure-pages` with `enablement: true`), but the token
Actions runs with is not permitted to create one, and the job fails with *"Create Pages site
failed. Error: Resource not accessible by integration"* while the published URL simply 404s.
The fix is one setting in the repository, not a change to any file here:

> **Settings → Pages → Build and deployment → Source → GitHub Actions**

Then re-run the workflow (**Actions → pages → Run workflow**, or push anything to `main`).
From that point the step finds the existing site and the deploy proceeds on its own.

Two further Pages constraints are worth knowing because they shaped the code:

- **A project site lives under a subpath** (`/zero-cost-ai-dating/`), not the origin root.
  This is why every link in the app is relative, the manifest's `scope` is `./`, and
  `sw.js` derives its base from its own URL instead of assuming `/`.
- **Pages cannot set HTTP response headers.** The `Content-Security-Policy` that Firebase
  Hosting sends as a header (from `firebase.json`) therefore also ships as a `<meta>` tag in
  every page, and `tests/csp-sync.test.js` fails the suite if the two ever drift. The other
  headers — `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and the
  `Cache-Control` tiers — cannot be expressed as meta tags and exist only on Firebase
  Hosting. A policy in the markup applies wherever the file is served, your own machine
  included, which is why a browser cannot reach a local emulator without help — section 12.

That second point is the reason the rest of this guide exists: for a real deployment with
accounts, a shared database, and the full header set, Firebase Hosting on the Spark plan is
the recommended host. Everything below is that path.

---

## Before you start

| You need | Notes |
| --- | --- |
| A Google account | Any account can create Firebase projects. |
| Node.js ≥ 18 | Only for the Firebase CLI and the tests. The app itself needs nothing. |
| The Firebase CLI | `npm install -g firebase-tools`, then `firebase login`. |

You do **not** need to run `npm install` in this repo. It has zero dependencies.

---

## 1. Create the project

1. Open the [Firebase console](https://console.firebase.google.com/) → **Add project**.
2. Name it (for example `zero-cost-ai-dating`). The project id it generates is what you will
   use later — write it down.
3. Google Analytics is optional and unnecessary here; skipping it keeps the project simpler.
4. When the project is ready, confirm the plan badge in the sidebar says **Spark**. Do not
   upgrade. Nothing in this app requires Blaze.

---

## 2. Register a web app and copy the config

1. Project overview → the **`</>`** (Web) icon → give the app a nickname.
2. **Do not** tick "Also set up Firebase Hosting" here; the CLI does that in step 6 with the
   `firebase.json` already in this repo.
3. Copy the `firebaseConfig` object it shows you. It looks like:

```js
{
  apiKey: "AIzaSy…",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abc123"
}
```

This is **not a secret**. It identifies your project; it authorises nothing. Access control
lives entirely in `firestore.rules`, which is why step 5 matters more than this one.

---

## 3. Enable Authentication

Build → **Authentication** → *Get started*, then under **Sign-in method**:

1. Enable **Email/Password**. Leave "Email link (passwordless sign-in)" off — the app does not
   use it.
2. Enable **Google**. It asks for a public-facing name and a support email; both are required
   by Google, not by this app. If you skip Google sign-in, the button simply stays hidden in
   demo mode and errors politely otherwise — but enabling it takes twenty seconds.
3. Under **Settings → Authorized domains**, confirm `localhost`,
   `your-project.web.app` and `your-project.firebaseapp.com` are listed. Add any custom domain
   you plan to use later, or Google sign-in will fail there with `auth/unauthorized-domain`.

Optional but recommended: **Settings → User actions → Enable email enumeration protection.**
The app's error messages are already written to avoid confirming whether an address exists.

---

## 4. Create the Firestore database

Build → **Firestore Database** → *Create database*.

1. Choose **Production mode**. The permissive test-mode rules expire in 30 days and would be
   replaced by this repo's rules in step 6 anyway.
2. Pick a location close to your users. **This cannot be changed later.**
3. Ignore the "Storage" product entirely. This app never uses it, and `firebase.json`
   deliberately contains no `storage` block — adding one breaks deploys on projects that have
   not enabled it.

---

## 5. Read the rules before you ship them

Open [`firestore.rules`](../firestore.rules). It is the only server-side security this app
has, so it is worth the five minutes.

Everything below is also *executed* — `npm run test:rules` runs the real rules file against
the Firestore emulator, 129 checks including the attacks each rule exists to stop. If you
change the data model, run it. See [`rules-tests/README.md`](../rules-tests/README.md).
`npm run test:emulator` adds the store suite to the same emulator boot: 31 more checks that
drive the shipped `public/js/data-store.js` against a real Firestore, which is where the
daily counter's transaction is proven — see [`store-tests/README.md`](../store-tests/README.md).

- `users/{uid}` — readable and writable **only by the owner**. Email, birthdate, block lists,
  usage counters and learned affinities never leave the account. Writes are validated: `plan`
  must be `free` or `premium`, `profile.bio` ≤ 500 chars, `profile.interests` ≤ 12,
  `profile.photos` ≤ 6, `preferences.ageMin ≥ 18`, `ageMax ≤ 100`, `ageMin ≤ ageMax`, and
  `uid` / `email` / `createdAt` are immutable after creation.
- `discovery/{uid}` — the public projection other users actually see: display name, age (not
  birthdate), bio, interests, personality, ~1 km-rounded coordinates and the mutual filters.
  Readable by any signed-in user, writable only by the owner, and the key list is **closed**
  (`hasOnly`), so a tampered client cannot smuggle private fields into the readable copy. The
  app mirrors it automatically on every profile save.
- `swipes/{swipeId}` — create only when you are the `from` user, the document id is
  exactly `from_to`, **and** the key list is closed (`hasOnly`). That last part is not
  tidiness: `hasAll` bounds the keys it names and nothing else, so a swipe could be padded
  to Firestore's 1 MiB ceiling, and a swipe is the cheapest write in the project — it needs
  only a signed-in account and a uid, uids are enumerable from `discovery`, and the daily
  limit that would slow it down is enforced in the browser. A Spark project gets 1 GiB.
  `matches`, `messages` and `users/{uid}` are closed for the same reason.

  A closed key list bounds how *many* fields a document may have and not how big one may
  be, which is a separate hole and was open in every collection: `createdAt` and its
  siblings were checked as `is string`, so a swipe could still be a megabyte under a name
  that reads like a timestamp. Every stamp is now capped, `matches.unread` may only be
  keyed by the two participants with numeric counts, an `id` field must equal the document
  id, and `discovery/{uid}`'s `location` — which was on its key list with **no validator at
  all**, in the one world-readable collection — is held to a coordinate pair with a short
  label. What is still unbounded, and is one document per account rather than one per
  write: the string *elements* inside `profile.photos`, `profile.interests` and `blocked`,
  and the values in `learning.interestAffinity`. Rules cannot iterate a list or a map, and
  capping photo URLs needs a matching limit in the profile editor rather than a silent
  rejection at save time. Read your own (either direction). Delete your own, or one aimed at you —
  account deletion purges inbound likes too. No updates. A read of a document that is *not
  there* is allowed only when the id names you, which the client needs (every first swipe
  reads its own unwritten record and the usually-absent reciprocal one) and an onlooker must
  not have: an unconditional allowance would answer "has Alice swiped on Bob?" for any pair,
  from the difference between an empty snapshot and a denial.
- `matches/{matchId}` — read and update only if you are one of the two `users`; create only
  with `users.size() == 2`, yourself among them, an id equal to the sorted join, proof the
  other person actually liked you first, **and** that they have not blocked you. That last
  clause is what makes a block durable: unmatching removes the match document but not the
  like underneath it, so without it the other side could write the document again and
  resume the conversation. The rule reads their private `users/{uid}` document to check —
  which a rule may do and no client can. Absent documents follow the same id rule as swipes,
  for a fact worth hiding rather more: whether two named people have matched.
- `matches/{matchId}/messages/{msgId}` — read if you participate in the parent match; create
  only as yourself with 1–1000 characters of text. Never editable; deletable by participants
  so unmatch and account deletion can purge the conversation before the match goes.
- `reports/{reportId}` — the abuse queue, id fixed to `from_about` so each account can file
  at most one report per existing user (bounding queue floods and quota burn), and the
  subject must exist in `discovery`. A report is visible only to its own author, who may
  also delete it — that is what lets account deletion purge everything the account wrote —
  and reads of missing documents deny, so nobody can probe whether a report exists. The
  reported party can never see, edit or retract a report about them. **You review this
  queue yourself** in Firestore → Data → `reports`, or with an admin script; nothing
  triages it for you.
- Everything else: denied.

If you change the data model, change these rules in the same commit. They are not decoration —
they are the reason a client-only app can be shared with strangers at all.

---

## 6. Point the CLI at your project and deploy

From the repo root:

```bash
firebase login
firebase use --add          # pick your project, alias it "default"
```

`firebase use --add` rewrites `.firebaserc` for you; you can also edit it by hand:

```json
{ "projects": { "default": "your-project-id" } }
```

Then:

```bash
npm test                    # 9 suites, 201 checks, no install required
npm run deploy              # firebase deploy --only hosting,firestore
```

That single command uploads `public/`, publishes `firestore.rules`, and creates the composite
indexes from `firestore.indexes.json`. **Index builds take a few minutes** and the app will
throw `failed-precondition` errors on Discover until they finish — the console's Firestore →
Indexes tab shows the progress.

Useful narrower commands while iterating:

```bash
firebase deploy --only hosting            # markup, CSS, JS
firebase deploy --only firestore:rules    # rules only, near-instant
firebase deploy --only firestore:indexes  # indexes only
firebase hosting:channel:deploy preview   # a temporary preview URL, free
```

---

## 7. Wire the app to your project

The deployed site still boots in demo mode until it has a real config. Two ways to fix that,
and you can use either:

**Option A — from the app, no code change.** Open the deployed site → **Settings** → *Connect
your own Firebase project* → paste the config object from step 2 → Save. It is validated,
stored in `localStorage['zc.firebaseConfig']`, and applies on reload. This is per-browser: it
is the right choice for trying things out, and the wrong choice for a site other people will
visit.

**Option B — in the file, for everyone.** Edit `BAKED_CONFIG` in
[`public/js/firebase-config.js`](../public/js/firebase-config.js), replacing the six
placeholder values, then `firebase deploy --only hosting`. Every visitor now gets Firebase
mode.

A stored override always wins over the baked-in values, so if a browser looks stuck in the
wrong mode after option B, clear it with **Reset to demo mode** on that settings panel.

---

## 8. Verify

1. Open `https://your-project.web.app`.
2. Open devtools. You should see exactly one line like
   `[zero-cost-ai-dating v1.0.0] Firebase mode — project "your-project"`. If it says
   `Demo mode`, the config did not take — see Troubleshooting.
3. Create an account. In the console, Firestore → Data should now show `users/{uid}` with the
   full document shape from [ARCHITECTURE.md](ARCHITECTURE.md#4-data-model).
4. Complete the profile, then open Discover. On a brand-new project the deck will be empty —
   that is correct, and step 9 explains why.
5. Check that navigating to `/dashboard.html` lands on `/dashboard`. `cleanUrls: true` in
   `firebase.json` makes Hosting redirect the extension away; the in-app links use the `.html`
   form so they also work from a plain local file server.

---

## 9. Seeding: what is and is not possible

**In demo mode**, seeding is automatic. The 32 profiles in `seed/profiles.json` are written to
`localStorage` on first run, with each `lastActiveOffsetHours` converted to a timestamp
relative to *now*, so the cast never looks stale.

**In Firebase mode, there is deliberately no seeding path from the browser** — and that is the
rules doing their job. `firestore.rules` only lets a signed-in user write their own
`users/{uid}` document, so a client cannot bulk-create 32 fictional people. Any of these work
instead:

1. **Just use real accounts.** Sign up a few times (incognito windows, or `+1` addresses on a
   Gmail account) and fill in the profiles. Slow, but it is the honest shape of the product.
2. **Import the seed with admin credentials, outside this repo.** A short script using
   `firebase-admin` and a service-account key bypasses rules by design. That means an
   `npm install` and a downloaded private key, which is why it is not shipped here — keep it in
   a separate throwaway directory and never commit the key. If you go this way, write each
   profile to **both** `users/{uid}` and its public `discovery/{uid}` projection (the app
   normally mirrors the projection itself on every profile save).
3. **Use the console.** Firestore → Data lets you add documents by hand. Fine for two or three
   profiles, painful for thirty.
4. **Temporarily relax the rules.** Possible; also the easiest way to end up with an open
   database. If you do it, do it on a throwaway project, and re-deploy the real rules the
   moment you are done.

For demos and screenshots, demo mode is genuinely the better tool: it is fully featured,
instant, and cannot leak anything.

---

## 10. Optional: a custom domain

Hosting → **Add custom domain**, follow the DNS instructions, and wait for the certificate
(usually under an hour). Then go back to **Authentication → Settings → Authorized domains** and
add the new domain, or Google sign-in will fail on it.

Custom domains and their TLS certificates are included on the Spark plan.

---

## 11. Staying at $0

The Spark plan's relevant free quotas:

| Resource | Free allowance |
| --- | --- |
| Hosting storage | 10 GB |
| Hosting transfer | 360 MB/day |
| Firestore document reads | 50,000/day |
| Firestore writes / deletes | 20,000 / 20,000 per day |
| Firestore stored data | 1 GiB |
| Authentication (email + Google) | Unlimited |

The site is a few hundred kilobytes and a deck load costs roughly one read per candidate, so a
small deployment sits far inside these limits. Writes are the scarcer allowance, and the ones
this app makes are deliberately small: bumping the daily usage counter is a single-field
transaction — one write, not the two it used to cost when it rewrote the whole user document
and re-mirrored the public projection for a field that projection cannot contain.

More importantly: **on Spark, exceeding a quota stops the operation rather than billing
you.** There is no card on file and no way for this
project to generate a charge, because the two products that can — Functions and Storage — are
never enabled.

If you ever do upgrade to Blaze for unrelated reasons, set a budget alert first.

---

## 12. Developing against the emulators in a browser

`npm run test:rules` and `npm run test:emulator` already drive the Firestore emulator, but
from Node, where no Content-Security-Policy applies. Pointing a **browser** at a local
emulator is the case that bites, and it is worth knowing before you lose an afternoon to it.

The usual recipe is two lines after the app is created:

```js
firebase.firestore().useEmulator('127.0.0.1', 8080);
firebase.auth().useEmulator('http://127.0.0.1:9099');
```

Serve `public/` with `npm run serve`, open it, and try to sign up. The page does not move, and
devtools says:

```
Refused to connect to 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=…'
because it violates the following Content Security Policy directive: "connect-src 'self'
https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com
https://identitytoolkit.googleapis.com https://securetoken.googleapis.com
https://firestore.googleapis.com".
```

then the same for Firestore on `http://127.0.0.1:8080/`. Nothing is broken and nothing is
misconfigured.

**Why.** An origin is scheme + host + **port**. The page is served from port 5000 and the
emulator listens on 8080, so those are different origins: `connect-src 'self'` does not reach
the emulator, and none of the `googleapis.com` entries match a loopback address either. The
policy is doing exactly what it was written to do.

**Why there is no server setting to unset.** The policy also ships as a `<meta>` tag in every
page — the GitHub Pages section at the top of this guide explains why it has to — so it
travels with the file. Your local server never sends it; the markup carries it. That is the
trade-off of a policy GitHub Pages can honour at all, and it lands on anyone doing local
emulator development, not only on this repo's test suite.

Two ways through. Neither is a fix, and this guide is not claiming one:

**Relax `connect-src` while you develop — then put it back.** Add the emulator origins to the
meta tag in the pages you are working on:

```html
connect-src 'self' http://127.0.0.1:8080 http://127.0.0.1:9099 https://*.googleapis.com …
```

Sign-up then completes and the console is clean. This is a local edit, never a commit: while
the two copies disagree, `npm test` fails *every page carries exactly one CSP meta equal to
the header minus frame-ancestors* (`tests/csp-sync.test.js`), which is the reminder to revert.
Be clear about what that guard does **not** catch — relax the header in `firebase.json` to
match and the suite goes quiet again, all 201 checks passing, and the weakened policy deploys
to everyone. Change the meta copy only, and change it back.

**Or stop crossing the origin.** Serve the emulator's paths *from the page's own origin* and
every request is `'self'`, with the shipped policy untouched. That is what the browser suite
does: `startServer` in `e2e/harness.js` takes a `proxy` option that forwards Firestore's
`/v1/` and `/google.firestore.…` paths and Auth's `identitytoolkit`/`securetoken` paths to the
emulators, which is the only reason `e2e/specs/10-firebase.e2e.js` can drive the real Firebase
path in a browser against the pages exactly as they ship. The cost is a dev server that can
proxy, and `npm run serve` is `python3 -m http.server`, which cannot — so this is not a
two-line change to your own workflow. It is, though, the route that never touches the policy.

---

## 13. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Console says `Demo mode` after deploying | The config never took. Check `BAKED_CONFIG` in `firebase-config.js` for leftover `your-…` values, or clear a stale `localStorage['zc.firebaseConfig']` with Settings → *Reset to demo mode*. |
| `Refused to load … Content Security Policy` | Something added an inline `<script>`, a `style="…"` attribute, or a third-party script. Run `npm test`; `tests/static.test.js` names the file and line. |
| `Refused to connect … Content Security Policy` pointing at `127.0.0.1` | You are aiming a browser at a local emulator. A different port is a different origin, so `connect-src 'self'` does not cover it. Section 12 has both ways round it. |
| `auth/unauthorized-domain` on Google sign-in | Add the domain under Authentication → Settings → Authorized domains. |
| `auth/operation-not-allowed` | The provider is not enabled in the console (step 3). |
| Discover errors with `failed-precondition` and a console link | A composite index is still building, or was never deployed. Run `firebase deploy --only firestore:indexes` and wait. |
| `permission-denied` on a write | The rules rejected it. Check the field limits in step 5 — an over-long bio or a 13th interest is the usual culprit. |
| Everything works locally but not deployed | `npm run serve` bypasses `firebase.json` entirely, so headers and `cleanUrls` only exist in production. Use `firebase hosting:channel:deploy preview` to test the real configuration for free. |
| Rules changes seem to have no effect | Rules deploy separately from hosting: `firebase deploy --only firestore:rules`. |

---

## 14. Rolling back and tearing down

- **Hosting rollback:** Hosting → *Release history* → the ⋮ menu on any previous release →
  *Rollback*. Instant, free, and it does not touch data.
- **Rules rollback:** Firestore → Rules → *History* shows every published version with a
  restore button.
- **Delete everything:** Project settings → General → *Delete project*. Because nothing here
  is billed, an abandoned project simply sits idle — but deleting is tidier.

---

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together, and the
[README](../README.md#limitations) for what this deployment can and cannot enforce.
