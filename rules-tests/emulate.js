/* ==========================================================================
   Zero Cost AI Dating — emulator test launcher

   Boots the Firestore emulator once and runs the suites that need it inside
   it, so each is one command:

     NODE_PATH=<somewhere>/node_modules npm run test:rules      # firestore.rules
     NODE_PATH=<somewhere>/node_modules npm run test:store      # public/js/data-store.js
     NODE_PATH=<somewhere>/node_modules npm run test:emulator   # both, one boot

   Booting the emulator is a Java start-up and most of a minute; running the
   two suites in one `emulators:exec` pays that once instead of twice, which
   is why this launcher is shared rather than copied into store-tests/. It
   re-invokes itself with --inner as the command emulators:exec runs, so the
   sequencing lives in one file rather than in a shell string.

   firebase-tools is resolved from outside the repository, exactly like
   Playwright is for the e2e suite, so package.json keeps its empty dependency
   lists. Failing to find it exits 3 with an install hint rather than a stack
   trace, so "the tools are missing" never reads as "the rules are broken".
   ========================================================================== */
'use strict';

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const harness = require('./harness');

// A demo- prefix keeps the emulator from ever asking for real credentials.
const PROJECT_ID = 'demo-zc-rules';

/** The runners this launcher knows how to start, in the order they run. */
const SUITES = {
  rules: path.join(__dirname, 'run.js'),
  store: path.join(__dirname, '..', 'store-tests', 'run.js')
};
const SUITE_ORDER = ['rules', 'store'];

// Where each suite keeps its specs, and how its files are named. Mirrors the
// two runners' own loadSpecs so a filter selects here exactly what it would
// select there.
const SPEC_DIRS = {
  rules: { dir: path.join(__dirname, 'specs'), re: /\.rules\.js$/ },
  store: { dir: path.join(__dirname, '..', 'store-tests', 'specs'), re: /\.store\.js$/ }
};

/**
 * Whether a suite has any spec a filter selects. A filter names one spec, and
 * a spec belongs to exactly one suite, so forwarding `users` to both suites
 * used to run the rules spec and then fail the whole command on the store
 * runner's "No store specs matched" — a green run reported as a failure.
 * @param {string} suite suite name
 * @param {string[]} filters substrings, empty meaning "everything"
 * @returns {boolean} true when at least one spec matches
 */
function suiteHasMatch(suite, filters) {
  if (!filters.length) return true;
  const spec = SPEC_DIRS[suite];
  let names = [];
  try {
    names = require('fs').readdirSync(spec.dir);
  } catch (err) {
    return false;
  }
  return names.some(function (name) {
    return spec.re.test(name) && filters.some(function (f) { return name.indexOf(f) !== -1; });
  });
}

/**
 * Which suites to run and what to pass them. `--suite=` may name several,
 * comma-separated; everything that is not a flag is a spec-name filter and is
 * forwarded to each runner untouched.
 * @param {string[]} argv arguments after the script name
 * @returns {{suites:string[], filters:string[], inner:boolean}|null} null on a bad --suite
 */
function parseArgs(argv) {
  let suites = ['rules'];
  const filters = [];
  let inner = false;
  for (const arg of argv) {
    if (arg === '--inner') {
      inner = true;
    } else if (arg.indexOf('--suite=') === 0) {
      suites = arg.slice('--suite='.length).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    } else if (arg.indexOf('--') !== 0) {
      filters.push(arg);
    }
    // Any other flag is for the runners to ignore, as before.
  }
  if (!suites.length || suites.some(function (s) { return !SUITES[s]; })) return null;
  return {
    suites: SUITE_ORDER.filter(function (s) { return suites.indexOf(s) !== -1; }),
    filters: filters,
    inner: inner
  };
}

/**
 * The store suite's harness, loaded lazily: it is only needed for its install
 * hint, and requiring it eagerly would make a rules-only run depend on the
 * store suite being present.
 * @returns {{INSTALL_HINT: string}} the store harness
 */
function storeHarness() {
  return require(path.join(__dirname, '..', 'store-tests', 'harness.js'));
}

/**
 * Whether a Java runtime is callable. The emulator is a Java program, so
 * without one the boot fails in firebase-tools with exit 1.
 * @returns {boolean} true when `java -version` runs
 */
function hasJava() {
  const probe = spawnSync('java', ['-version'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

/**
 * Locate the firebase-tools CLI entry point outside this repo's tree. Shares
 * harness.resolveOutside so this and the module loader search the same places.
 * @returns {string|null} absolute path to firebase.js, or null
 */
function findCli() {
  // Resolve the package's own manifest, then the bin beside it.
  const entry = harness.resolveOutside('firebase-tools/package.json');
  if (!entry) return null;
  const cli = path.join(path.dirname(entry), 'lib', 'bin', 'firebase.js');
  return require('fs').existsSync(cli) ? cli : null;
}

// How loud each exit code is, when two suites disagree. A failed check is the
// loudest thing that can happen: it is the only code that means "the software
// is wrong". Math.max got this backwards — with one suite failing a check (1)
// and the other missing a package (3) it reported 3, so a real rules
// regression came out as "your environment is incomplete" behind an install
// hint, which is precisely the confusion the exit-3 convention exists to stop.
const CODE_RANK = { 0: 0, 3: 1, 2: 2, 1: 3 };

/**
 * Combine two runner exit codes, keeping the one that says the most.
 * @param {number} a first code
 * @param {number} b second code
 * @returns {number} the code to exit with
 */
function worse(a, b) {
  const ra = CODE_RANK[a] === undefined ? 2 : CODE_RANK[a];
  const rb = CODE_RANK[b] === undefined ? 2 : CODE_RANK[b];
  return rb > ra ? b : a;
}

/**
 * Inside the emulator: run each requested suite in turn, so a failure in one
 * still lets the other report. Every suite runs even if an earlier one failed
 * — the point of a CI log is to show all the damage at once.
 * @param {string[]} suites suite names, already validated
 * @param {string[]} filters spec-name filters to forward
 * @returns {number} the worst exit code any runner produced
 */
function runSuites(suites, filters) {
  let code = 0;
  for (const name of suites) {
    if (suites.length > 1) process.stdout.write('\n########  ' + name + '  ########\n');
    const result = spawnSync(process.execPath, [SUITES[name]].concat(filters), {
      cwd: harness.ROOT, stdio: 'inherit', env: process.env
    });
    code = worse(code, result.signal ? 2 : (result.status === null ? 2 : result.status));
  }
  return code;
}

/**
 * Quote one argument for the single command string emulators:exec takes.
 * @param {string} token an argument
 * @returns {string} the token, quoted only when it needs to be
 */
function quote(token) {
  return /[\s"']/.test(token) ? JSON.stringify(token) : token;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  process.stderr.write('usage: node rules-tests/emulate.js [--suite=' + SUITE_ORDER.join(',') + '] [spec filter…]\n');
  process.exit(2);
}

// A filter picks specs, not suites, so drop the suites it cannot match rather
// than letting them report "nothing matched" as a failure. If it matches
// nothing anywhere, that IS a usage error and still exits 2.
const selected = parsed.suites.filter(function (name) { return suiteHasMatch(name, parsed.filters); });
if (!selected.length) {
  process.stderr.write('No specs in ' + parsed.suites.join(', ') + ' matched ' +
    JSON.stringify(parsed.filters) + '\n');
  process.exit(2);
}
parsed.suites = selected;

if (parsed.inner) {
  // Started by emulators:exec, which has set FIRESTORE_EMULATOR_HOST for us.
  process.exit(runSuites(parsed.suites, parsed.filters));
}

// The hint has to name what the chosen suites actually need: the store suite
// wants the firebase client SDK on top of what the rules suite needs, and
// printing the rules hint for `--suite=store` sent the reader to install two
// packages, boot the emulator again, and only then be told about the third.
const hint = parsed.suites.indexOf('store') === -1 ? harness.INSTALL_HINT : storeHarness().INSTALL_HINT;

const cli = findCli();
if (!cli) {
  process.stderr.write(hint + '\n');
  process.exit(3);
}

// The emulator is a Java program, and firebase-tools reports a missing runtime
// by exiting 1 — the code this repo reserves for "a check failed". Probing for
// java here keeps a broken environment reading as an environment problem.
if (!hasJava()) {
  process.stderr.write('The Firestore emulator needs a Java runtime (17+), which is not on PATH.\n');
  process.stderr.write('Install one (e.g. Temurin 21) and re-run.\n');
  process.exit(3);
}

const inner = ['node', __filename, '--inner', '--suite=' + parsed.suites.join(',')]
  .concat(parsed.filters)
  .map(quote)
  .join(' ');

// The emulator writes firestore-debug.log into the working directory; *.log is
// gitignored, so a run cannot dirty the tree.
const child = spawn(process.execPath, [
  cli, 'emulators:exec', '--only', 'firestore', '--project', PROJECT_ID, inner
], { cwd: harness.ROOT, stdio: 'inherit', env: process.env });

child.on('exit', function (code, signal) {
  process.exit(signal ? 2 : (code === null ? 2 : code));
});
child.on('error', function (err) {
  process.stderr.write('could not start the Firestore emulator: ' + (err && err.message ? err.message : err) + '\n');
  process.stderr.write(harness.INSTALL_HINT + '\n');
  process.exit(3);
});
