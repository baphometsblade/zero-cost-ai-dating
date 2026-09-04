/* ==========================================================================
   Zero Cost AI Dating — the numbers this project claims about itself

   Every suite in this repo exists because "we read the code carefully" is not
   evidence. The README then turns those runs into sentences — "**129 checks**,
   including the attacks each rule exists to stop" — and those sentences are
   the one part of the project nothing was executing. They drifted three times
   in this repository's short life: a spec count that stayed at nine after a
   tenth arrived, a "155/156" that outlived the run it described, and a
   "three writes" that was four for a mutual like. Each was caught by a human
   or a reviewer reading carefully, which is exactly the standard the rest of
   the project refuses to accept.

   So the totals live here, once, and are enforced from both ends:

     - tests/docs.test.js asserts that the numbers written in README.md are
       these numbers and no others. It needs no browser and no emulator, so it
       runs in `npm test` on every push.

     - each runner (e2e/run.js, rules-tests/run.js, store-tests/run.js)
       asserts, at the end of a complete run, that what it actually counted is
       what is claimed here.

   A suite that grows therefore fails its own run until this file is updated,
   and updating this file fails `npm test` until the README agrees. There is no
   order in which the documentation can quietly fall behind the code.

   Deliberately not enforced: prose. "Nine suites", "twenty concurrent bumps",
   the description of what a check proves — a number in a sentence can be
   checked, but a sentence that has become untrue while keeping its number
   cannot, and pretending otherwise would be the same false confidence this
   file exists to remove. The suite-file count is the one exception, because it
   is as mechanical as the totals.
   ========================================================================== */
'use strict';

/**
 * What each suite counts on a complete run: no spec filter, no viewport
 * filter, nothing skipped that could have run. A filtered run counts less by
 * design and is not checked against these.
 */
const CLAIMS = {
  unit: {
    total: 217,
    how: 'npm test',
    note: 'Node\'s built-in runner, no install'
  },
  e2e: {
    total: 200,
    how: 'npm run test:e2e',
    note: 'the eleven browser-only specs, both viewports, Firebase spec skipped'
  },
  e2eFirebase: {
    total: 218,
    how: 'npm run test:e2e, with the Firestore and Auth emulators up',
    note: 'the same eleven specs plus the twelfth, which drives the real SDK'
  },
  rules: {
    total: 129,
    how: 'npm run test:rules',
    note: 'firestore.rules executed against the emulator'
  },
  store: {
    total: 37,
    how: 'npm run test:store',
    note: 'the shipped data-store.js driven against the emulator'
  }
};

/** How many files `tests/` holds, which the README describes in words. */
const UNIT_SUITE_FILES = 13;

/**
 * Compare a finished run's count against what this project claims, and phrase
 * the disagreement for a reader who has to decide which side is wrong.
 *
 * Both directions are failures, and the message says which happened: a run
 * that counted fewer checks than claimed has usually lost some silently
 * (a spec that stopped being discovered, a viewport that stopped running),
 * which is the more dangerous of the two and reads as green everywhere else.
 *
 * @param {string} key a key of CLAIMS
 * @param {number} observed how many checks the run actually recorded
 * @returns {string|null} a message to print, or null when they agree
 */
function disagreement(key, observed) {
  const claim = CLAIMS[key];
  if (!claim) return 'unknown claim ' + JSON.stringify(key) + ' — scripts/claims.js has no such suite';
  if (observed === claim.total) return null;
  const direction = observed < claim.total
    ? 'FEWER than claimed: ' + (claim.total - observed) + ' check(s) stopped running'
    : 'MORE than claimed: ' + (observed - claim.total) + ' check(s) were added';
  return 'this run counted ' + observed + ' checks, ' + direction + '.\n' +
    '  scripts/claims.js says ' + claim.how + ' is ' + claim.total + ' checks (' + claim.note + ').\n' +
    '  If the new number is right, update scripts/claims.js and the README sentence that quotes it —\n' +
    '  tests/docs.test.js will tell you if you update one and not the other.';
}

module.exports = { CLAIMS: CLAIMS, UNIT_SUITE_FILES: UNIT_SUITE_FILES, disagreement: disagreement };
