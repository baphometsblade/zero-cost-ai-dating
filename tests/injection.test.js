/* ==========================================================================
   Zero Cost AI Dating — no way to turn a string into markup or into code

   This is a dating app. Almost everything on the screen is a string somebody
   else typed: a display name, a bio, a message, an interest label, a city. In
   Firebase mode those strings arrive from another account's document, and the
   security rules bound their length and shape but cannot bound their content.
   The only thing standing between a hostile bio and script execution on your
   session is that the app never asks a browser to parse a string as HTML.

   That property held, and the README claimed it, and nothing enforced it. It
   is exactly the kind of invariant that survives right up until the afternoon
   somebody needs one bold word in one label.

   The single sink that existed was in `ZC.util.el` — a `html` prop assigning
   `innerHTML`, documented as "TRUSTED markup only". Nothing in the repository
   ever passed it, so it bought nothing and risked everything: the one line
   that can inject markup, in the helper every page builds every node with,
   guarded only by a comment asking readers to be careful. It is gone, and
   this file is what keeps it gone.

   The Content-Security-Policy is the second line, not the first. It blocks
   inline scripts, so an injected `<script>` would not run today — but the
   policy ships as a `<meta>` tag for GitHub Pages, `img`/`style` are not
   locked down to nothing, and "the CSP would probably catch it" is not a
   reason to hand a browser attacker-controlled markup. Defence in depth means
   both, and this checks the half that CSP cannot.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Every script this project actually ships to a browser. Deliberately not a
 * recursive walk of `public/`: a walk that silently stopped matching would
 * check nothing and stay green, and the file list here is short enough that a
 * new script is a deliberate line in this array.
 * @returns {Array<{rel:string, source:string}>}
 */
function shippedScripts() {
  const files = [];
  const jsDir = path.join(ROOT, 'public', 'js');
  fs.readdirSync(jsDir)
    .filter(function (name) { return name.endsWith('.js'); })
    .forEach(function (name) {
      files.push({ rel: 'public/js/' + name, source: fs.readFileSync(path.join(jsDir, name), 'utf8') });
    });
  const sw = path.join(ROOT, 'public', 'sw.js');
  if (fs.existsSync(sw)) files.push({ rel: 'public/sw.js', source: fs.readFileSync(sw, 'utf8') });
  return files;
}

/**
 * Strip comments and string literals, so a sink named in prose or in a regex
 * is not mistaken for one being used.
 *
 * This is why `matches.js` can say "Nothing on this page ever goes near
 * innerHTML" in its header without failing the check that enforces it — and
 * why the long explanation in `utils.js` about the sink that used to be there
 * does not resurrect it.
 *
 * Crude on purpose: it does not parse JavaScript, it blanks the three things
 * that hide a false positive. Anything it gets wrong fails loudly as an extra
 * match rather than quietly as a missed one.
 *
 * @param {string} source a JavaScript file
 * @returns {string} the same length-ish text with comments and literals blanked
 */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')      // line comments, sparing http://
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")      // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')      // double-quoted
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');       // templates
}

/**
 * The ways a string becomes markup or becomes code. Each is named so a failure
 * says what the risk is rather than just what matched.
 */
const SINKS = [
  { name: 'innerHTML', pattern: /\.innerHTML\s*=/, why: 'parses a string as HTML' },
  { name: 'outerHTML', pattern: /\.outerHTML\s*=/, why: 'parses a string as HTML' },
  { name: 'insertAdjacentHTML', pattern: /\.insertAdjacentHTML\s*\(/, why: 'parses a string as HTML' },
  { name: 'document.write', pattern: /document\s*\.\s*write(ln)?\s*\(/, why: 'parses a string as HTML' },
  { name: 'srcdoc', pattern: /\.srcdoc\s*=|['"]srcdoc['"]/, why: 'parses a string as a whole document' },
  { name: 'eval', pattern: /(^|[^.\w])eval\s*\(/, why: 'runs a string as code' },
  { name: 'new Function', pattern: /new\s+Function\s*\(/, why: 'runs a string as code' },
  { name: 'setTimeout with a string', pattern: /set(Timeout|Interval)\s*\(\s*['"`]/, why: 'runs a string as code' },
  { name: 'javascript: URL', pattern: /['"`]\s*javascript:/i, why: 'runs a string as code when navigated to' }
];

test('no shipped script can turn a string into markup or into code', function () {
  const files = shippedScripts();
  // A run that found no files would pass having checked nothing.
  assert.ok(files.length >= 10,
    'expected the shipped scripts to be found, got ' + files.length +
    ' — public/js/ may have moved and this test would be checking nothing');

  const found = [];
  files.forEach(function (file) {
    // The javascript:-URL pattern has to see string literals, so it is matched
    // against the raw source; every other sink is matched against code only.
    const stripped = code(file.source);
    SINKS.forEach(function (sink) {
      const haystack = sink.name === 'javascript: URL' ? file.source : stripped;
      const lines = haystack.split('\n');
      lines.forEach(function (line, index) {
        if (sink.pattern.test(line)) {
          found.push(file.rel + ':' + (index + 1) + ' — ' + sink.name + ' (' + sink.why + ')');
        }
      });
    });
  });

  assert.deepEqual(found, [],
    'a script this project ships can hand a browser a string to parse or run:\n  ' +
    found.join('\n  ') +
    '\n\nEvery user-authored string in this app is somebody else\'s bio, name or message. ' +
    'Insert text with ZC.util.el({ text }) — which sets textContent — and build structure ' +
    'from elements, never from concatenated markup. If a case genuinely needs markup, it ' +
    'needs a conversation and a sanitiser, not a quick exception here.');
});

test('the DOM helper offers no markup escape hatch', function () {
  const utils = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
  const stripped = code(utils);

  // The specific shape that used to exist, in the specific helper every page
  // uses. The check above would catch it too; this one names it, so a failure
  // points at the decision rather than at a regex.
  assert.ok(!/p\s*\.\s*html/.test(stripped),
    'ZC.util.el has an `html` prop again. It was removed because nothing used it ' +
    'and it was the only line in the project that could inject markup.');

  // And the prop stays in the ignore list, so a caller who passes `html` gets
  // nothing rather than an `html="<b>…"` attribute on the element.
  assert.match(utils, /DOM_PROP_KEYS\s*=\s*\{[^}]*\bhtml\s*:/,
    'html should stay in DOM_PROP_KEYS so passing it is inert rather than ' +
    'becoming a stray attribute');
});
