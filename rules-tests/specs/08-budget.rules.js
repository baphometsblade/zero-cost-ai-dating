/* ==========================================================================
   The rules file's own evaluation budget.

   Firestore evaluates at most **1000 expressions per request**. It is a hard
   limit, it is not configurable, and going over it is not a rule that returns
   false — it is an error, and the write comes back as a flat `permission-denied`
   naming no field and no line. From the browser it is indistinguishable from
   "you are not allowed to do that".

   `users/{uid}` is the document that gets close. It carries fourteen top-level
   keys, four nested maps and about forty-five validated fields, and `userDocOk`
   checks all of them on every create. When this spec was written the file had
   room for **eleven** more trivial clauses before every account creation in the
   app would have started failing. Nothing measured that, nothing mentioned it,
   and the way it was found was by adding six clauses and watching every valid
   write in the suite turn red at once.

   So it is measured here, the same way: pad `userDocOk` with a known number of
   always-true clauses and find where a plain, valid user document stops being
   accepted. The number that comes out is how many clauses the next person has
   to spend before this file stops working — and if it is small, they need to
   know that before they write the clause, not after.

   The margin is thin on purpose rather than by neglect: the alternative to
   spending it was leaving `profile.photos`, `profile.interests`, `blocked` and
   `learning.interestAffinity` bounded by element count only, which meant one
   element could be a megabyte. Those bounds cost four of the eleven. What must
   not happen is spending the rest of it without noticing.

   The same budget binds a second thing, found later and from the other
   direction. `listCandidates` asks "have I already swiped on these people" with
   a key query — `swipes where __name__ in [ids]` — instead of reading the
   viewer's whole swipe history, and the read rule for `swipes` is evaluated
   once per value in that list. Firestore's own ceiling for `in` is thirty; this
   file's is lower, and it is the one that decides. So the largest list the
   shipped rules actually accept is measured here too, and the store's batch
   size has to stay well under it. The failure it prevents is nasty: a
   `permission-denied` on the deck, on the accounts with the longest lists,
   naming nothing.
   ========================================================================== */
'use strict';

/* What this number is, and is not.
   ---------------------------------
   It is a measurement of the rules engine's own accounting, not of anything in
   this repository, so it can move when the emulator does. It has been the same
   on two independent machines — this sandbox and CI, both on firebase-tools
   15.26.0 with emulator jar v1.22.0, which CI pins — but a version bump could
   shift it either way without a line of this project changing.

   If that happens the check is still telling the truth: there is now less room
   than there was. What it cannot tell you is whether the cause was your edit or
   the engine's, and the difference matters, so find out before reacting.
   Lowering FLOOR to make a red build green is the one response that is always
   wrong — it is the number this file exists to stop anybody from quietly
   spending. */

/** Clauses of headroom this file must keep. Below it, stop and buy some back. */
const FLOOR = 5;

/** Where to stop searching. Also the proof that the ceiling is real: a run that
    reached this number would mean the padding was not being evaluated at all. */
const SEARCH_CEILING = 64;

/** The clause the padding is made of, and the unit the answer is counted in. */
const PAD = ' && d.uid is string';

/** Where in userDocOk the padding goes — a clause the validator always reaches. */
const ANCHOR = "d.plan in ['free', 'premium']";

/**
 * The batch size `public/js/data-store.js` uses for its swipe lookups.
 *
 * Repeated here rather than imported: the store does not export it, and a check
 * that read the same constant as the code would agree with it however wrong
 * both were. If the two ever diverge this file goes red for the right reason —
 * it is measuring the engine, not the constant.
 */
const SWIPE_BATCH = 10;

/**
 * How long an `in` list to search up to. Below Firestore's own limit of thirty
 * on purpose: at thirty-one the SDK raises `invalid-argument` before the rules
 * are consulted at all, and a search that could not tell that apart from a
 * denial would report the SDK's limit as if it were the budget's.
 */
const IN_SEARCH_CEILING = 29;

module.exports = {
  title: 'firestore.rules stays inside its 1000-expression evaluation budget',

  async run(t, ctx) {
    const { h, testing } = ctx;
    const source = h.readRules();
    const address = h.emulatorAddress();

    t.check('the padding anchor is still in firestore.rules',
      source.indexOf(ANCHOR) !== -1,
      'looked for ' + JSON.stringify(ANCHOR) + ' inside userDocOk');
    if (source.indexOf(ANCHOR) === -1) return;

    let projects = 0;

    /**
     * Does a plain, valid user document write succeed under these rules?
     * Its own project each time, because a ruleset is per-project.
     * @param {string} rules the ruleset to install
     * @returns {Promise<boolean>} true when the write was allowed
     */
    async function accepts(rules) {
      projects += 1;
      const env = await testing.initializeTestEnvironment({
        projectId: 'demo-zc-budget-' + projects,
        firestore: { rules: rules, host: address.host, port: address.port }
      });
      let allowed = true;
      try {
        await env.authenticatedContext('budget-user').firestore()
          .doc('users/budget-user').set(h.userDoc('budget-user'));
      } catch (err) {
        allowed = false;
      }
      await env.cleanup();
      return allowed;
    }

    /** The rules with `n` extra always-true clauses inside userDocOk. */
    function padded(n) {
      return source.replace(ANCHOR, ANCHOR + new Array(n).fill(PAD).join(''));
    }

    // Nothing below means anything if the unpadded file is already over.
    const base = await accepts(source);
    t.check('a plain, valid user document is accepted by the shipped rules',
      base, base ? 'allowed' : 'DENIED — userDocOk is already over the 1000-expression limit');
    if (!base) return;

    let lo = 0;
    let hi = SEARCH_CEILING;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await accepts(padded(mid))) lo = mid; else hi = mid - 1;
    }
    const headroom = lo;

    // Without this the measurement could be vacuous: a harness that allowed
    // every write would report SEARCH_CEILING and sail past the floor below.
    t.check('the ceiling is real — enough padding does break the rules',
      headroom < SEARCH_CEILING,
      headroom + ' clauses fit, searched up to ' + SEARCH_CEILING);

    t.check('and userDocOk keeps at least ' + FLOOR + ' clauses of headroom under it',
      headroom >= FLOOR,
      headroom + ' more `' + PAD.trim() + '` clauses fit before every user write fails. ' +
      (headroom >= FLOOR
        ? 'Spend it knowing a clause that is a function call costs about 2.2 of these.'
        : 'Buy some back before adding anything: inline a helper, or drop a check ' +
          'that a write path already enforces.'));

    /* ---- the same budget, seen from the swipes read rule --------------- */

    const mod = h.loadOutside('firebase/firestore');
    t.check('the modular firestore package is available to ask a key query with',
      !!(mod && mod.documentId && mod.getDocs),
      mod ? 'loaded' : 'not installed — see the suite install hint');
    if (!mod || !mod.documentId) return;

    // The two copies of the batch size have to be the same number, or this
    // measurement is of a batch nobody uses. `tests/limits.test.js` compares the
    // form's bounds with the rules' for the same reason: a limit written down
    // twice needs something reading both.
    const storeSource = require('node:fs')
      .readFileSync(require('node:path').join(h.ROOT, 'public/js/data-store.js'), 'utf8');
    const declared = /const\s+SWIPE_LOOKUP_BATCH\s*=\s*(\d+)\s*;/.exec(storeSource);
    t.check('data-store.js asks about swipes in batches of ' + SWIPE_BATCH + ', as this file assumes',
      !!declared && Number(declared[1]) === SWIPE_BATCH,
      declared
        ? 'SWIPE_LOOKUP_BATCH is ' + declared[1] + ', this file measures for ' + SWIPE_BATCH
        : 'no `const SWIPE_LOOKUP_BATCH = N;` found in public/js/data-store.js');

    const READER = 'budget-swiper';

    /**
     * Does the shipped ruleset accept `swipes where __name__ in [n ids]`?
     *
     * Half the documents are seeded and half are not, deliberately: the cost
     * this is measuring is in the length of the list rather than in the results,
     * and a run where every id missed would exercise the rule's `resource ==
     * null` branch alone. A denial from anything other than the rules would be
     * a different measurement, so the code is reported rather than swallowed.
     * @param {number} n how many ids to ask about
     * @returns {Promise<{allowed:boolean, code:string}>}
     */
    async function keyQueryAllowed(n) {
      projects += 1;
      const env = await testing.initializeTestEnvironment({
        projectId: 'demo-zc-inbudget-' + projects,
        firestore: { rules: source, host: address.host, port: address.port }
      });
      const ids = [];
      for (let i = 0; i < n; i += 1) ids.push(READER + '_budget-them-' + String(i).padStart(3, '0'));
      await env.withSecurityRulesDisabled(async function (c) {
        const db = c.firestore();
        for (let i = 0; i < n; i += 2) {
          const to = ids[i].split('_')[1];
          await mod.setDoc(mod.doc(db, 'swipes', ids[i]), {
            id: ids[i], from: READER, to: to, action: 'pass', createdAt: '2026-01-01T00:00:00.000Z'
          });
        }
      });
      let allowed = true;
      let code = '';
      try {
        const db = env.authenticatedContext(READER).firestore();
        await mod.getDocs(mod.query(mod.collection(db, 'swipes'),
          mod.where(mod.documentId(), 'in', ids)));
      } catch (err) {
        allowed = false;
        code = (err && err.code) || String(err);
      }
      await env.cleanup();
      return { allowed: allowed, code: code };
    }

    const one = await keyQueryAllowed(1);
    t.check('the shipped rules accept a key query on the caller\'s own swipes at all',
      one.allowed,
      one.allowed ? 'allowed' : 'DENIED (' + one.code + ') — the deck cannot ask this question');
    if (!one.allowed) return;

    let inLo = 1;
    let inHi = IN_SEARCH_CEILING;
    let lastCode = '';
    while (inLo < inHi) {
      const mid = Math.ceil((inLo + inHi) / 2);
      const answer = await keyQueryAllowed(mid);
      if (answer.allowed) { inLo = mid; } else { inHi = mid - 1; lastCode = answer.code; }
    }
    const widest = inLo;

    // Same vacuity guard as above, and it earns its place here: if the query
    // were allowed at every length the search would report the ceiling and the
    // floor below would pass while measuring nothing at all.
    t.check('an `in` list can be made long enough to exhaust the budget',
      widest < IN_SEARCH_CEILING,
      widest + ' ids accepted, searched up to ' + IN_SEARCH_CEILING +
      (lastCode ? '; the first refusal came back as ' + lastCode : ''));

    t.check('and the deck\'s batch of ' + SWIPE_BATCH + ' keeps at least a 2x margin under that',
      widest >= SWIPE_BATCH * 2,
      widest + ' ids fit; data-store.js asks about ' + SWIPE_BATCH + ' at a time. ' +
      (widest >= SWIPE_BATCH * 2
        ? 'Making the swipes read rule more expensive shrinks this before it shrinks anything visible.'
        : 'Cut SWIPE_LOOKUP_BATCH in data-store.js, or make the swipes read rule cheaper — ' +
          'a deck that asks for more than fits comes back permission-denied naming nothing.'));
  }
};
