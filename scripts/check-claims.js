/* ==========================================================================
   Zero Cost AI Dating — does `npm test` really count what the README says?

   The other three suites check their own totals: e2e/run.js, rules-tests/run.js
   and store-tests/run.js each own their summary line and can compare it to
   scripts/claims.js before exiting. The unit suite cannot. `npm test` is
   `node --test`, the total is printed by the runner after every test file has
   finished, and no test inside that run can see it — a test that asserted the
   total would be asserting a number that does not exist yet.

   That gap is not theoretical. It caught its own author immediately: the unit
   total was written as 210 while the suite counted 206, tests/docs.test.js was
   green (the README and scripts/claims.js agreed with each other, and agreeing
   is all that file can check), and the wrong number would have shipped.

   So this runs the suite in a child process and reads the count back out of
   its TAP summary. It is a second run of a suite that takes a couple of
   seconds, which is a cheap price for the one number the project cannot
   otherwise verify.
   ========================================================================== */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const claims = require(path.join(ROOT, 'scripts', 'claims.js'));

/**
 * Read the totals out of a `node --test` TAP summary.
 * @param {string} output everything the runner wrote
 * @returns {{pass:number, fail:number}|null} null when the summary is absent
 */
function summarise(output) {
  const pass = /^# pass (\d+)$/m.exec(output);
  const fail = /^# fail (\d+)$/m.exec(output);
  if (!pass || !fail) return null;
  return { pass: Number(pass[1]), fail: Number(fail[1]) };
}

/**
 * The arguments the unit suite is run with: the tests `npm test` runs, with
 * the reporter named instead of left to Node. Node chooses TAP by itself only
 * when stdout is not a terminal, and only up to Node 22. From Node 23 its
 * default is the spec reporter everywhere, whose summary reads "ℹ pass N",
 * and summarise() would find nothing in it. TAP's summary lines are the ones
 * this script reads; the spec reporter's layout is written for people, and
 * Node can change it.
 */
const RUN = ['--test', '--test-reporter=tap'];

/**
 * Run the unit suite, compare its total with scripts/claims.js and say what
 * was found.
 * @returns {number} the exit code: 0 agreed, 1 disagreed or failing, 2 unverifiable
 */
function main() {
  const run = spawnSync(process.execPath, RUN, {
    cwd: ROOT,
    encoding: 'utf8',
    // node --test writes TAP to stdout; the reporter's own diagnostics go to stderr.
    env: process.env
  });

  if (run.error) {
    process.stderr.write('could not run the unit suite: ' + run.error.message + '\n');
    return 2;
  }

  const output = (run.stdout || '') + (run.stderr || '');
  const totals = summarise(output);

  if (!totals) {
    // The summary format is Node's, not ours, so say plainly that the check
    // could not be made rather than inventing a verdict either way.
    process.stderr.write(
      'could not find "# pass N" in the unit suite output — Node\'s TAP summary format may have\n' +
      'changed. This check cannot verify the claimed total; scripts/check-claims.js needs updating.\n'
    );
    return 2;
  }

  if (totals.fail > 0) {
    // Not this script's business: `npm test` reports that, and reporting it
    // twice in different words helps nobody.
    process.stderr.write(
      'the unit suite has ' + totals.fail + ' failing check(s); run `npm test` for the detail.\n' +
      'Not comparing totals — a failing suite\'s count is not a claim worth checking.\n'
    );
    return 1;
  }

  const problem = claims.disagreement('unit', totals.pass);
  if (problem) {
    process.stderr.write('npm test: ' + problem + '\n');
    return 1;
  }

  process.stdout.write('npm test: ' + totals.pass + ' checks, as claimed.\n');
  return 0;
}

// Only when run as a script. tests/docs.test.js requires this file for RUN and
// summarise, from inside a `node --test` run; a require that started the suite
// again would find Node refusing to nest the run, report it as unverifiable,
// and leave exit code 2 behind to fail that test file.
if (require.main === module) {
  process.exitCode = main();
}

module.exports = { RUN: RUN, summarise: summarise, main: main };
