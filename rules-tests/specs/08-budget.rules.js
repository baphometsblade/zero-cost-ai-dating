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
   ========================================================================== */
'use strict';

/** Clauses of headroom this file must keep. Below it, stop and buy some back. */
const FLOOR = 5;

/** Where to stop searching. Also the proof that the ceiling is real: a run that
    reached this number would mean the padding was not being evaluated at all. */
const SEARCH_CEILING = 64;

/** The clause the padding is made of, and the unit the answer is counted in. */
const PAD = ' && d.uid is string';

/** Where in userDocOk the padding goes — a clause the validator always reaches. */
const ANCHOR = "d.plan in ['free', 'premium']";

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
        ? 'Spend it knowing a function call is worth about 2.2 of these.'
        : 'Buy some back before adding anything: inline a helper, or drop a check ' +
          'that a write path already enforces.'));
  }
};
