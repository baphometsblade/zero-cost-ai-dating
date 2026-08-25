/* ==========================================================================
   Zero Cost AI Dating — PWA subpath checks
   The same public/ directory is served from two very different places: the
   root of a Firebase Hosting site ('/') and a GitHub Pages *project* site
   ('/zero-cost-ai-dating/'). Nothing in the manifest or the service worker
   may assume root hosting, or the Pages demo installs under the wrong
   identity and offline navigation computes page names that were never
   cached. These checks pin the manifest to relative URLs and keep
   root-anchored path literals out of sw.js, so the assumption cannot creep
   back in a later edit. The CORE precache list is deliberately NOT checked
   here — check (f) in static.test.js already owns that both ways.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'manifest.webmanifest');
const SW_PATH = path.join(PUBLIC_DIR, 'sw.js');

// URLs that must not be treated as local files (same test as static.test.js).
const EXTERNAL_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/* ------------------------------------------------------------------------
   Tiny helpers — string and regex work only, no dependencies
   ------------------------------------------------------------------------ */

/**
 * Blank out block and whole-line comments in JS source while preserving every
 * character offset and newline, so line numbers reported from the blanked
 * text still match the real file. Comments are free to *talk about* absolute
 * paths — only code must not contain them.
 * @param {string} js source text
 * @returns {string} source with comment contents replaced by spaces
 */
function blankJsComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, function (block) {
      return block.replace(/[^\n]/g, ' ');
    })
    .replace(/^\s*\/\/[^\n]*/gm, function (line) {
      return line.replace(/[^\n]/g, ' ');
    });
}

/**
 * 1-based line number of a character offset in a string.
 * @param {string} text the text the offset points into
 * @param {number} index character offset
 * @returns {number} line number, counting from 1
 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Format a list of problems into a message a human can act on directly.
 * @param {string} headline what went wrong, in one line
 * @param {string[]} problems one entry per offending location
 * @returns {string} the assertion message
 */
function report(headline, problems) {
  return headline + '\n  - ' + problems.join('\n  - ') + '\n';
}

/* ------------------------------------------------------------------------
   The manifest: every URL relative, no origin-absolute identity
   ------------------------------------------------------------------------ */

test('the manifest keeps its identity and URLs subpath-relative', function () {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'public/manifest.webmanifest is missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // No "id": any value resolves against the *origin*, so even a relative id
  // would collide between projects sharing github.io. Absent, it defaults to
  // the resolved start_url — manifest-relative, correct on both hosts.
  assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'id'),
    'the manifest must not declare "id" — it resolves against the origin, ' +
    'so it cannot be made subpath-safe; omit it and start_url takes over');

  // "./" resolves against the manifest URL to whichever directory serves it.
  assert.equal(manifest.scope, './',
    'manifest "scope" must be "./" so the app scope follows the hosting path');

  // start_url must stay relative for the same reason: a leading slash (or a
  // full URL) would pin the installed app to root hosting.
  assert.equal(typeof manifest.start_url, 'string', 'manifest "start_url" must be a string');
  assert.notEqual(manifest.start_url.charAt(0), '/',
    'manifest "start_url" must not start with "/" — that assumes root hosting');
  assert.ok(!EXTERNAL_RE.test(manifest.start_url),
    'manifest "start_url" must be a relative path, not an absolute URL');
});

test('every manifest icon resolves to a file in public/', function () {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0,
    'the manifest must declare at least one icon');

  const problems = [];
  manifest.icons.forEach(function (icon, i) {
    const src = (icon && icon.src) || '';
    if (!src || src.charAt(0) === '/' || EXTERNAL_RE.test(src)) {
      problems.push('icons[' + i + '].src "' + src + '" is not a relative path');
    } else if (!fs.existsSync(path.join(PUBLIC_DIR, src))) {
      problems.push('icons[' + i + '].src "' + src + '" does not exist in public/');
    }
  });

  assert.equal(problems.length, 0, report('Manifest icon problems:', problems));
});

/* ------------------------------------------------------------------------
   The service worker: all paths flow through BASE, never a hard-coded root
   ------------------------------------------------------------------------ */

test('sw.js derives BASE and hard-codes no root-anchored path literals', function () {
  assert.ok(fs.existsSync(SW_PATH), 'public/sw.js is missing');
  const sw = fs.readFileSync(SW_PATH, 'utf8');

  // The one sanctioned way to learn where the worker lives. Everything else
  // must be expressed relative to it.
  assert.ok(sw.indexOf("const BASE = new URL('./', self.location).pathname;") !== -1,
    "sw.js must derive its base once via new URL('./', self.location).pathname");

  // Cheap guard: a string literal opening with '/' is a same-origin path that
  // only works at root hosting — exactly the assumption this round removed.
  // Comments are blanked first, so prose may still say '/zero-cost-ai-dating/'.
  const code = blankJsComments(sw);
  const problems = [];
  const re = /['"]\//g;
  let m;
  while ((m = re.exec(code)) !== null) {
    problems.push('public/sw.js:' + lineAt(code, m.index) +
      ' has a string literal starting with "/" — route it through BASE instead');
  }

  assert.equal(problems.length, 0, report('Root-hosting assumptions in sw.js:', problems));
});
