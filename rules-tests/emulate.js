/* ==========================================================================
   Zero Cost AI Dating — rules test launcher

   Boots the Firestore emulator and runs rules-tests/run.js inside it, so the
   whole suite is one command:

     NODE_PATH=<somewhere>/node_modules npm run test:rules

   firebase-tools is resolved from outside the repository, exactly like
   Playwright is for the e2e suite, so package.json keeps its empty dependency
   lists. Failing to find it exits 3 with an install hint rather than a stack
   trace, so "the tools are missing" never reads as "the rules are broken".
   ========================================================================== */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const harness = require('./harness');

// A demo- prefix keeps the emulator from ever asking for real credentials.
const PROJECT_ID = 'demo-zc-rules';

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

const cli = findCli();
if (!cli) {
  process.stderr.write(harness.INSTALL_HINT + '\n');
  process.exit(3);
}

const args = process.argv.slice(2);
const inner = ['node', path.join(__dirname, 'run.js')].concat(args).join(' ');

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
