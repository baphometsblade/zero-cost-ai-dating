/* ==========================================================================
   Zero Cost AI Dating — store test harness

   Shared plumbing for the store suite: where to find the packages this repo
   deliberately does not depend on, and the open ruleset the suite's own
   project runs under.

   Package resolution is not reinvented here — it is rules-tests/harness's
   moduleRoots/resolveOutside, imported wholesale, so the two emulator suites
   can never disagree about where NODE_PATH points. Only the install hint
   differs, because this suite needs one package more than the rules suite:
   the `firebase` client SDK, whose compat build is the API shape
   public/js/data-store.js is written against.
   ========================================================================== */
'use strict';

const rules = require('../rules-tests/harness');

const ROOT = rules.ROOT;

const INSTALL_HINT =
  'Store tests need the firebase client SDK, @firebase/rules-unit-testing and\n' +
  'firebase-tools, which are deliberately NOT dependencies of this repo. Install them\n' +
  'somewhere else and point NODE_PATH at it, e.g.\n' +
  '  mkdir -p /tmp/zc-emu && cd /tmp/zc-emu \\\n' +
  '    && npm install firebase @firebase/rules-unit-testing firebase-tools\n' +
  '  cd ' + ROOT + ' && NODE_PATH=/tmp/zc-emu/node_modules npm run test:store';

/**
 * The emulator project this suite owns. The rules suite uses a different one,
 * so the two can share a single emulator process without either one's
 * documents or ruleset leaking into the other's.
 */
const PROJECT_ID = 'demo-zc-store';

/**
 * A second project, used only to replay a stored write against the *real*
 * firestore.rules. Kept apart from PROJECT_ID because that project runs open
 * rules and loading two rulesets onto one project id would mean whichever
 * suite ran last decided what the other was testing against.
 */
const RULES_PROJECT_ID = 'demo-zc-store-rules';

/**
 * The ruleset PROJECT_ID runs under. The client SDK cannot mint an auth token
 * without the Auth emulator, so a rules-enforcing project would reject every
 * write this suite makes and prove nothing about atomicity. What the shipped
 * transaction writes *is* checked against the real rules — see
 * specs/04-rules-accept.store.js, which replays the stored value as the
 * document's owner.
 */
const OPEN_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if true;',
  '    }',
  '  }',
  '}',
  ''
].join('\n');

/**
 * Split FIRESTORE_EMULATOR_HOST, which emulators:exec sets for us.
 * @returns {{host:string, port:number}|null} null when the variable is absent
 */
function emulatorAddress() {
  const raw = process.env.FIRESTORE_EMULATOR_HOST || '';
  const at = raw.lastIndexOf(':');
  if (at === -1) return null;
  const port = Number(raw.slice(at + 1));
  if (!port) return null;
  return { host: raw.slice(0, at) || '127.0.0.1', port: port };
}

module.exports = {
  ROOT: ROOT,
  RULES_PATH: rules.RULES_PATH,
  INSTALL_HINT: INSTALL_HINT,
  PROJECT_ID: PROJECT_ID,
  RULES_PROJECT_ID: RULES_PROJECT_ID,
  OPEN_RULES: OPEN_RULES,
  emulatorAddress: emulatorAddress,
  resolveOutside: rules.resolveOutside,
  loadOutside: rules.loadOutside,
  readRules: rules.readRules,
  ok: rules.ok,
  userDoc: rules.userDoc,
  discoveryDoc: rules.discoveryDoc
};
