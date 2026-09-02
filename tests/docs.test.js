/* ==========================================================================
   Zero Cost AI Dating — the documentation, checked

   Documentation rots differently from code: nothing fails when it goes wrong.
   The three ways it has actually gone wrong here, in order of how long each
   went unnoticed:

     (a) a number that used to be true — "142 checks", "155/156 passing" — left
         behind by a suite that grew;
     (b) a path that used to exist, or never did, in a link or a tree diagram;
     (c) an `npm run` incantation for a script that was renamed.

   All three are mechanical, so all three are checked here. What is *not*
   checked is prose, and scripts/claims.js explains why: a sentence that has
   become untrue while keeping its number is beyond any test in this file, and
   dressing that up would be worse than admitting it.

   This suite reads only files. No browser, no emulator, no network — it runs
   in `npm test` on every push, which is the whole point: the check that
   catches stale documentation has to be the cheapest one there is.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const claims = require(path.join(ROOT, 'scripts', 'claims.js'));

/** Every markdown file that describes this project to a reader. */
const DOCS = [
  'README.md',
  'docs/ARCHITECTURE.md',
  'docs/DEPLOY.md',
  'e2e/README.md',
  'rules-tests/README.md',
  'store-tests/README.md'
].filter(function (rel) { return fs.existsSync(path.join(ROOT, rel)); });

/**
 * @param {string} rel repo-relative path
 * @returns {string} the file's contents
 */
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/* --------------------------------------------------------------------------
   (a) the numbers
   -------------------------------------------------------------------------- */

test('every "N checks" the README claims is a number scripts/claims.js stands behind', function () {
  const readme = read('README.md');
  // \s+ rather than a space: the store claim wraps across a line break, and a
  // number that only counts when the paragraph happens not to reflow is not a
  // check, it is a coincidence.
  const found = [];
  const pattern = /\*\*(\d+)\s+checks\*\*/g;
  let match;
  while ((match = pattern.exec(readme)) !== null) found.push(Number(match[1]));

  assert.ok(found.length >= Object.keys(claims.CLAIMS).length,
    'README quotes only ' + found.length + ' check totals; scripts/claims.js has ' +
    Object.keys(claims.CLAIMS).length + '. A suite lost its sentence, or the phrasing changed ' +
    'and this test can no longer see it.');

  const claimed = Object.keys(claims.CLAIMS).map(function (key) { return claims.CLAIMS[key].total; });
  const stale = found.filter(function (n) { return claimed.indexOf(n) === -1; });
  assert.deepEqual(stale, [],
    'README quotes check totals that no suite claims: ' + JSON.stringify(stale) + '. ' +
    'Either the suite changed and scripts/claims.js was not updated, or the README was ' +
    'edited by hand. The runners are the authority — run the suite and take its number.');

  const unquoted = claimed.filter(function (n) { return found.indexOf(n) === -1; });
  assert.deepEqual(unquoted, [],
    'scripts/claims.js claims totals the README never quotes: ' + JSON.stringify(unquoted) + '. ' +
    'A number nobody can read is not a claim; either the sentence was dropped or it was ' +
    'reworded past the `**N checks**` form this test looks for.');
});

test('the README describes as many unit suites as tests/ actually holds', function () {
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(function (name) { return name.endsWith('.test.js'); });
  assert.equal(files.length, claims.UNIT_SUITE_FILES,
    'tests/ holds ' + files.length + ' suites, scripts/claims.js says ' + claims.UNIT_SUITE_FILES);

  // The README writes this one in words, so the words are what gets checked.
  const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven',
    'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen'];
  const expected = WORDS[claims.UNIT_SUITE_FILES];
  assert.ok(expected, 'no word for ' + claims.UNIT_SUITE_FILES + ' — extend WORDS');
  assert.match(read('README.md'), new RegExp(expected + ' suites on Node'),
    'README should open the unit-suite section with "' + expected + ' suites on Node", ' +
    'because tests/ holds ' + files.length + ' of them');
});

/* --------------------------------------------------------------------------
   (b) the paths
   -------------------------------------------------------------------------- */

/**
 * Repo-relative paths a document points at. Two forms are collected, and only
 * two, because they are the two that are unambiguous:
 *
 *   - markdown link targets, `[text](e2e/README.md)` — anything with a scheme
 *     or a bare `#anchor` is somebody else's problem;
 *   - backticked paths that begin with a directory this repo has.
 *
 * Placeholders are skipped on sight: `users/{uid}`, globs, and the `<angle>`
 * form all describe a shape rather than a file.
 *
 * @param {string} text the document
 * @param {string[]} dirs top-level directory names in the repo
 * @returns {string[]} unique paths, in order of appearance
 */
function referencedPaths(text, dirs) {
  const seen = [];
  const add = function (raw) {
    const value = raw.split('#')[0].trim();
    if (!value) return;
    if (/[*{}<>\s|]/.test(value)) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return;
    if (seen.indexOf(value) === -1) seen.push(value);
  };

  let match;
  const links = /\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = links.exec(text)) !== null) add(match[1]);

  // `dir/thing` in backticks, anchored on a real top-level name so that
  // `usage.likesToday` and `no-store` cannot be mistaken for files.
  const inline = /`([^`]+)`/g;
  while ((match = inline.exec(text)) !== null) {
    const value = match[1];
    if (value.indexOf('/') === -1) continue;
    const head = value.split('/')[0];
    if (dirs.indexOf(head) === -1) continue;
    add(value);
  }
  return seen;
}

test('every file and directory the docs point at exists', function () {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(function (entry) { return entry.isDirectory() && entry.name[0] !== '.'; })
    .map(function (entry) { return entry.name; });

  const missing = [];
  DOCS.forEach(function (doc) {
    const from = path.dirname(path.join(ROOT, doc));
    referencedPaths(read(doc), dirs).forEach(function (rel) {
      // A link resolves from the document; a backticked path is written from
      // the repository root, which is how this project has always used them.
      const candidates = [path.resolve(from, rel), path.resolve(ROOT, rel)];
      if (!candidates.some(function (abs) { return fs.existsSync(abs); })) {
        missing.push(doc + ' → ' + rel);
      }
    });
  });

  assert.deepEqual(missing, [],
    'documentation points at things that are not there:\n  ' + missing.join('\n  '));
});

/* --------------------------------------------------------------------------
   (c) the commands
   -------------------------------------------------------------------------- */

test('every "npm run" in the docs names a script package.json defines', function () {
  const scripts = JSON.parse(read('package.json')).scripts || {};
  const unknown = [];
  DOCS.forEach(function (doc) {
    const text = read(doc);
    const pattern = /npm run ([a-z][a-z0-9:-]*)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!Object.prototype.hasOwnProperty.call(scripts, match[1])) {
        unknown.push(doc + ' → npm run ' + match[1]);
      }
    }
  });
  assert.deepEqual(unknown, [],
    'documented commands that would fail:\n  ' + unknown.join('\n  '));
});

/* --------------------------------------------------------------------------
   (d) no suite may arrive invisibly
   -------------------------------------------------------------------------- */

test('every spec file is named in its suite\'s README', function () {
  const suites = [
    { dir: 'e2e/specs', doc: 'e2e/README.md', ext: '.e2e.js' },
    { dir: 'rules-tests/specs', doc: 'rules-tests/README.md', ext: '.rules.js' },
    { dir: 'store-tests/specs', doc: 'store-tests/README.md', ext: '.store.js' }
  ].filter(function (suite) { return fs.existsSync(path.join(ROOT, suite.dir)); });

  const unmentioned = [];
  suites.forEach(function (suite) {
    if (!fs.existsSync(path.join(ROOT, suite.doc))) return;
    const doc = read(suite.doc);
    fs.readdirSync(path.join(ROOT, suite.dir))
      .filter(function (name) { return name.endsWith(suite.ext); })
      .forEach(function (name) {
        if (doc.indexOf(name) === -1) unmentioned.push(suite.doc + ' never mentions ' + name);
      });
  });

  assert.deepEqual(unmentioned, [],
    'specs that exist but are undocumented — a reader of the README would not know they run:\n  ' +
    unmentioned.join('\n  '));
});
