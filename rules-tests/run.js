/* ==========================================================================
   Zero Cost AI Dating — Firestore rules test runner

   Loads firestore.rules into the Firestore emulator and runs every spec in
   rules-tests/specs against it. Expects to be started by the emulator, which
   sets FIRESTORE_EMULATOR_HOST:

     npm run test:rules

   Exit codes: 0 all passed · 1 a check failed · 2 usage/crash ·
   3 the testing packages are not installed (see harness.INSTALL_HINT).
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const harness = require('./harness');
const claims = require('../scripts/claims');

const SPEC_DIR = path.join(__dirname, 'specs');
const PROJECT_ID = 'demo-zc-rules';

/**
 * Load every spec module, in file-name order so runs are comparable.
 * @param {string[]} filters substrings; a spec runs when any matches its name
 * @returns {Object[]} spec modules, each carrying its file name
 */
function loadSpecs(filters) {
  return fs.readdirSync(SPEC_DIR)
    .filter(function (name) { return /\.rules\.js$/.test(name); })
    .sort()
    .filter(function (name) {
      return !filters.length || filters.some(function (f) { return name.indexOf(f) !== -1; });
    })
    .map(function (name) {
      const spec = require(path.join(SPEC_DIR, name));
      spec.file = name;
      return spec;
    });
}

/**
 * Build the `t` object a spec records expectations through.
 * @param {Object[]} sink where results accumulate
 * @param {string} label the spec's title
 * @returns {Object} recorder with a check() method
 */
function createRecorder(sink, label) {
  return {
    check: function (name, ok, detail) {
      const passed = !!ok;
      sink.push({ label: label, name: name, ok: passed });
      const suffix = detail ? '  [' + detail + ']' : '';
      process.stdout.write('  ' + (passed ? 'PASS' : 'FAIL') + '  ' + name + suffix + '\n');
      return passed;
    }
  };
}

async function main() {
  const filters = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });

  const testing = harness.loadOutside('@firebase/rules-unit-testing');
  if (!testing) {
    process.stderr.write(harness.INSTALL_HINT + '\n');
    return 3;
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    process.stderr.write(
      'FIRESTORE_EMULATOR_HOST is not set — run this through the emulator:\n' +
      '  npm run test:rules\n'
    );
    return 2;
  }

  const specs = loadSpecs(filters);
  if (!specs.length) {
    process.stderr.write('No rules specs matched ' + JSON.stringify(filters) + '\n');
    return 2;
  }

  // Every denial these tests assert is logged by the SDK as an error, which
  // would bury the actual results in expected noise.
  const firestoreSdk = harness.loadOutside('firebase/firestore');
  if (firestoreSdk && typeof firestoreSdk.setLogLevel === 'function') {
    firestoreSdk.setLogLevel('silent');
  }

  const address = harness.emulatorAddress();
  const testEnv = await testing.initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: harness.readRules(), host: address.host, port: address.port }
  });

  const results = [];
  const started = Date.now();
  try {
    for (const spec of specs) {
      process.stdout.write('\n--- ' + spec.title + '\n');
      // Every spec starts from an empty database, so one spec's fixtures can
      // never satisfy another's preconditions and mask a missing rule.
      await testEnv.clearFirestore();
      const t = createRecorder(results, spec.title);
      try {
        await spec.run(t, {
          env: testEnv,
          testing: testing,
          h: harness,
          // Shared so every spec reports a denial identically.
          ok: harness.ok,
          // Seed documents the rules would otherwise forbid us from creating.
          seed: function (fn) { return testEnv.withSecurityRulesDisabled(fn); },
          // Firestore handles for a signed-in uid, and for a signed-out visitor.
          as: function (uid) { return testEnv.authenticatedContext(uid).firestore(); },
          anon: function () { return testEnv.unauthenticatedContext().firestore(); }
        });
      } catch (err) {
        t.check('spec ran to completion', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
      }
    }
  } finally {
    await testEnv.cleanup();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  process.stdout.write('\n=== summary\n');
  failed.forEach(function (r) { process.stdout.write('  FAIL  ' + r.label + ' — ' + r.name + '\n'); });
  process.stdout.write(
    '  ' + (results.length - failed.length) + '/' + results.length + ' checks passed in ' +
    ((Date.now() - started) / 1000).toFixed(1) + 's\n'
  );

  // The same false-green guard the e2e runner carries: a run that asserted
  // nothing is not a passing run.
  if (!results.length) {
    process.stderr.write('  no checks ran — refusing to report success\n');
    return 2;
  }

  // And the same total check: an unfiltered green run has to count what this
  // project claims it counts. See scripts/claims.js.
  if (!filters.length && !failed.length) {
    const problem = claims.disagreement('rules', results.length);
    if (problem) {
      process.stderr.write('\n  ' + problem + '\n');
      return 1;
    }
  }
  return failed.length ? 1 : 0;
}

main().then(function (code) {
  process.exit(code);
}, function (err) {
  process.stderr.write('rules runner crashed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(2);
});
