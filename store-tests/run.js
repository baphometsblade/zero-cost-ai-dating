/* ==========================================================================
   Zero Cost AI Dating — store test runner

   Runs every spec in store-tests/specs against the Firestore emulator, with
   the real public/js/data-store.js loaded into the process (see context.js).
   Expects to be started by the emulator, which sets FIRESTORE_EMULATOR_HOST:

     npm run test:store

   Exit codes: 0 all passed · 1 a check failed · 2 usage/crash ·
   3 the testing packages are not installed (see harness.INSTALL_HINT).
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('node:util');
const harness = require('./harness');
const claims = require('../scripts/claims');
const context = require('./context');

const SPEC_DIR = path.join(__dirname, 'specs');

/**
 * Load every spec module, in file-name order so runs are comparable.
 * @param {string[]} filters substrings; a spec runs when any matches its name
 * @returns {Object[]} spec modules, each carrying its file name
 */
function loadSpecs(filters) {
  return fs.readdirSync(SPEC_DIR)
    .filter(function (name) { return /\.store\.js$/.test(name); })
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
 * Build the `t` object a spec records expectations through. Same shape the
 * rules runner uses, so both suites read identically in a CI log.
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

/**
 * Security-rules-disabled access to a project, for seeding fixtures and for
 * reading back what the store actually stored. Verification never goes
 * through the client under test: bumpUsage returns an optimistic figure when
 * its write fails, so only the stored document is evidence.
 * @param {Object} env a RulesTestEnvironment
 * @param {Object} mod the modular firebase/firestore module
 * @returns {{get:Function, set:Function, del:Function}} document helpers
 */
function adminAccess(env, mod) {
  return {
    async get(collection, id) {
      let out = null;
      await env.withSecurityRulesDisabled(async function (c) {
        const snap = await mod.getDoc(mod.doc(c.firestore(), collection, id));
        out = snap.exists() ? snap.data() : null;
      });
      return out;
    },
    async set(collection, id, data) {
      await env.withSecurityRulesDisabled(async function (c) {
        await mod.setDoc(mod.doc(c.firestore(), collection, id), data);
      });
    },
    async del(collection, id) {
      await env.withSecurityRulesDisabled(async function (c) {
        await mod.deleteDoc(mod.doc(c.firestore(), collection, id));
      });
    }
  };
}

async function main() {
  const filters = process.argv.slice(2).filter(function (a) { return a.indexOf('--') !== 0; });

  const testing = harness.loadOutside('@firebase/rules-unit-testing');
  const firestoreSdk = harness.loadOutside('firebase/firestore');
  if (!testing || !firestoreSdk) {
    process.stderr.write(harness.INSTALL_HINT + '\n');
    return 3;
  }
  const address = harness.emulatorAddress();
  if (!address) {
    process.stderr.write(
      'FIRESTORE_EMULATOR_HOST is not set — run this through the emulator:\n' +
      '  npm run test:store\n'
    );
    return 2;
  }

  const specs = loadSpecs(filters);
  if (!specs.length) {
    process.stderr.write('No store specs matched ' + JSON.stringify(filters) + '\n');
    return 2;
  }

  // A denial or an aborted transaction is logged by the SDK as an error, and
  // this suite provokes both on purpose.
  if (typeof firestoreSdk.setLogLevel === 'function') firestoreSdk.setLogLevel('silent');

  // The suite's own project runs open rules (harness.OPEN_RULES): the client
  // SDK has no way to mint an auth token without the Auth emulator, so a
  // rules-enforcing project would deny every write and prove nothing about
  // atomicity. The separate project below carries the *real* firestore.rules
  // and is used by 04-rules-accept to replay what the store stored.
  const env = await testing.initializeTestEnvironment({
    projectId: harness.PROJECT_ID,
    firestore: { rules: harness.OPEN_RULES, host: address.host, port: address.port }
  });
  const rulesEnv = await testing.initializeTestEnvironment({
    projectId: harness.RULES_PROJECT_ID,
    firestore: { rules: harness.readRules(), host: address.host, port: address.port }
  });

  // Load the shipped store last, so it connects to a project whose ruleset is
  // already in place.
  const ctx = context.createContext();
  if (!ctx) {
    process.stderr.write(harness.INSTALL_HINT + '\n');
    await env.cleanup();
    await rulesEnv.cleanup();
    return 3;
  }

  const admin = adminAccess(env, firestoreSdk);
  const results = [];
  const started = Date.now();
  try {
    for (const spec of specs) {
      process.stdout.write('\n--- ' + spec.title + '\n');
      await env.clearFirestore();
      await rulesEnv.clearFirestore();
      ctx.drainWarnings();
      const t = createRecorder(results, spec.title);
      try {
        await spec.run(t, {
          // The real ZC.store, in firebase mode, talking to the emulator.
          store: ctx.store,
          ctx: ctx,
          h: harness,
          testing: testing,
          fs: firestoreSdk,
          ok: harness.ok,
          // Firestore hands map fields back with their keys in its own order,
          // so specs compare values, never serialised text.
          same: isDeepStrictEqual,
          show: function (value) { return JSON.stringify(value); },
          admin: admin,
          env: env,
          rulesEnv: rulesEnv
        });
      } catch (err) {
        t.check('spec ran to completion', false, err && err.stack ? err.stack.split('\n')[0] : String(err));
      }
    }
  } finally {
    ctx.restoreConsole();
    await env.cleanup();
    await rulesEnv.cleanup();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  process.stdout.write('\n=== summary\n');
  failed.forEach(function (r) { process.stdout.write('  FAIL  ' + r.label + ' — ' + r.name + '\n'); });
  process.stdout.write(
    '  ' + (results.length - failed.length) + '/' + results.length + ' checks passed in ' +
    ((Date.now() - started) / 1000).toFixed(1) + 's\n'
  );

  // The same false-green guard the rules and e2e runners carry: a run that
  // asserted nothing is not a passing run.
  if (!results.length) {
    process.stderr.write('  no checks ran — refusing to report success\n');
    return 2;
  }

  // And the same total check: an unfiltered green run has to count what this
  // project claims it counts. See scripts/claims.js.
  if (!filters.length && !failed.length) {
    const problem = claims.disagreement('store', results.length);
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
  process.stderr.write('store runner crashed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(2);
});
