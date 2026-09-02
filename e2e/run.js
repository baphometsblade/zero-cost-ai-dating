/* ==========================================================================
   Zero Cost AI Dating — end-to-end runner

   A hand-rolled runner rather than `node --test`, for one reason: `npm test`
   is `node --test` from the repo root, and anything it can discover would run
   in CI on a machine with no browser. Specs therefore live outside tests/ and
   are named *.e2e.js, which matches none of Node's test-file patterns.

   Usage:
     node e2e/run.js                     every spec, every viewport it declares
     node e2e/run.js deck matches        only specs whose file name matches
     node e2e/run.js --viewport=mobile   restrict to one viewport
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const harness = require('./harness');
const claims = require('../scripts/claims');

const SPEC_DIR = path.join(__dirname, 'specs');

/* --------------------------------------------------------------------------
   1. Arguments
   -------------------------------------------------------------------------- */

/**
 * Split argv into a viewport filter and a list of spec-name substrings.
 * @param {string[]} argv raw arguments, without node and the script path
 * @returns {{viewport:string|null, filters:string[]}}
 */
function parseArgs(argv) {
  let viewport = null;
  const filters = [];
  argv.forEach(function (arg) {
    const match = /^--viewport=(.+)$/.exec(arg);
    if (match) {
      viewport = match[1];
      return;
    }
    if (arg.indexOf('--') === 0) throw new Error('Unknown flag: ' + arg);
    filters.push(arg);
  });
  if (viewport && !harness.VIEWPORTS[viewport]) {
    throw new Error('Unknown viewport "' + viewport + '". Known: ' + Object.keys(harness.VIEWPORTS).join(', '));
  }
  return { viewport: viewport, filters: filters };
}

/* --------------------------------------------------------------------------
   2. Result recording
   -------------------------------------------------------------------------- */

/**
 * Build the `t` handed to a spec. Checks print as they happen, because a run
 * that hangs should still have told you how far it got.
 * @param {Object[]} sink array every result is appended to
 * @param {string} label the spec + viewport this recorder belongs to
 * @returns {{check:function, ok:function}}
 */
function createRecorder(sink, label) {
  return {
    /**
     * Record one named expectation.
     * @param {string} name what was expected, in plain words
     * @param {*} ok truthy when it held
     * @param {*} [detail] the observed value, shown on the line
     * @returns {boolean} the boolean form of `ok`
     */
    check: function (name, ok, detail) {
      const passed = !!ok;
      sink.push({ label: label, name: name, ok: passed });
      const suffix = detail === undefined || detail === null || detail === ''
        ? ''
        : '  [' + String(detail).replace(/\s+/g, ' ').slice(0, 160) + ']';
      process.stdout.write('  ' + (passed ? 'PASS' : 'FAIL') + '  ' + name + suffix + '\n');
      return passed;
    }
  };
}

/* --------------------------------------------------------------------------
   3. Spec loading
   -------------------------------------------------------------------------- */

/**
 * Load every spec module, in file-name order so runs are comparable.
 * @param {string[]} filters substrings; empty means "all"
 * @returns {Object[]} spec modules, each carrying its file name
 */
function loadSpecs(filters) {
  return fs.readdirSync(SPEC_DIR)
    .filter(function (name) { return /\.e2e\.js$/.test(name); })
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

/* --------------------------------------------------------------------------
   4. The run
   -------------------------------------------------------------------------- */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    // A usage mistake deserves the sentence, not the stack.
    process.stderr.write(err.message + '\n');
    return 2;
  }

  const playwright = harness.loadPlaywright();
  if (!playwright) {
    process.stderr.write(harness.INSTALL_HINT + '\n');
    // A distinct code so CI can tell "no browser available" from "tests failed".
    return 3;
  }

  const specs = loadSpecs(args.filters);
  if (!specs.length) {
    process.stderr.write('No specs matched ' + JSON.stringify(args.filters) + '\n');
    return 2;
  }

  // A filter can match specs and still select nothing to run, when none of them
  // declares the requested viewport — `--viewport=desktop` against a spec that
  // is mobile-only, say. Left alone that reports "0/0 checks passed" and exits
  // 0, which is the one thing a test runner must never do: report green for a
  // run that verified nothing.
  const runnable = specs.filter(function (spec) {
    return !args.viewport || spec.viewports.indexOf(args.viewport) !== -1;
  });
  if (!runnable.length) {
    process.stderr.write(
      'No spec runs at viewport ' + JSON.stringify(args.viewport) + '. ' +
      specs.map(function (s) { return s.file + ' [' + s.viewports.join(', ') + ']'; }).join('; ') + '\n'
    );
    return 2;
  }

  const results = [];
  const skipped = [];
  const skippedFiles = [];
  const started = Date.now();
  const server = await harness.startServer();
  const browser = await playwright.chromium.launch();

  try {
    for (const spec of runnable) {
      // A spec may need something this machine has not got — the Firebase
      // suite needs the emulators running. Saying so out loud and recording
      // nothing is the only honest answer: a check that "passes" because it
      // never ran is the false green this runner exists to prevent.
      if (typeof spec.available === 'function') {
        const verdict = await spec.available();
        if (!verdict || !verdict.ok) {
          const why = (verdict && verdict.why) || 'no reason given';
          process.stdout.write('\n--- ' + spec.title + '\n  SKIP  ' + why + '\n');
          skipped.push(spec.title + ' — ' + why);
          skippedFiles.push(spec.file);
          continue;
        }
      }
      const wanted = args.viewport ? spec.viewports.filter(function (v) { return v === args.viewport; }) : spec.viewports;
      for (const key of wanted) {
        const viewport = harness.VIEWPORTS[key];
        const label = spec.title + ' [' + viewport.label + ']';
        process.stdout.write('\n--- ' + label + '\n');

        // spec.session is how a spec asks for a context that is not the
        // default "real visitor, no Firebase SDK" one.
        const session = await harness.openSession(browser, viewport, spec.session);
        const t = createRecorder(results, label);
        try {
          await spec.run(t, session.page, {
            base: server.origin,
            viewport: viewport,
            harness: harness,
            // Specs that cause deliberate network failures need to say so; see
            // session.expectNetworkErrors in harness.js.
            session: session
          });
        } catch (err) {
          t.check('spec ran to completion', false, err && err.stack ? err.stack.split('\n')[0] : err);
        }
        // Anything the page logged as an error is a failure of the whole spec,
        // whichever step provoked it.
        t.check(
          'no console errors, page errors or unhandled rejections',
          session.errors.length === 0,
          session.errors.slice(0, 3).join(' | ')
        );
        await session.context.close();
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  process.stdout.write('\n=== summary\n');
  failed.forEach(function (r) { process.stdout.write('  FAIL  ' + r.label + ' — ' + r.name + '\n'); });
  skipped.forEach(function (line) { process.stdout.write('  SKIP  ' + line + '\n'); });
  process.stdout.write(
    '  ' + (results.length - failed.length) + '/' + results.length + ' checks passed in ' +
    ((Date.now() - started) / 1000).toFixed(1) + 's\n'
  );

  // Belt and braces for the same false-green: whatever route got us here, a run
  // that asserted nothing is not a passing run.
  if (!results.length) {
    process.stderr.write('  no checks ran — refusing to report success\n');
    return 2;
  }

  // And the weaker false-green above it: a run that asserted *fewer things than
  // it used to*, and passed all of them. Only a complete run can say anything
  // about the total — a filter or a viewport restriction counts less by design
  // — and which total depends on whether the emulators were there for the
  // Firebase spec. See scripts/claims.js.
  if (!args.viewport && !args.filters.length && !failed.length) {
    // Two totals are claimed, and exactly two situations are recognised: every
    // spec ran, or the Firebase one alone was skipped for want of emulators.
    // Anything else skipping is a shape nobody has claimed a number for, and
    // guessing one would be the false confidence this check exists to remove.
    const onlyFirebaseSkipped = skippedFiles.length === 1 &&
      skippedFiles[0].indexOf('firebase') !== -1;
    const key = skippedFiles.length === 0 ? 'e2eFirebase' : (onlyFirebaseSkipped ? 'e2e' : null);
    const problem = key ? claims.disagreement(key, results.length) : null;
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
  process.stderr.write('e2e runner crashed: ' + (err && err.stack ? err.stack : err) + '\n');
  process.exit(2);
});
