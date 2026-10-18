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
 * Every script this project ships to a browser: each `.js` file anywhere under
 * `public/` (the worker included), plus the body of each inline `<script>` in a
 * page. The inline bodies are easy to forget — 404.html runs one, allowed by
 * its CSP hash, and it is the block the project expects to be hand-edited and
 * re-hashed. A walk that silently stopped matching would check nothing and
 * stay green, so the tests below assert that it found the files, and count the
 * inline scripts with a pattern of their own.
 * @returns {Array<{rel:string, source:string}>} an inline body's `rel` is
 *   `public/<page>.html <inline N>`, N counting from 1 in page order
 */
function shippedScripts() {
  const files = [];
  const publicDir = path.join(ROOT, 'public');
  (function walk(rel) {
    fs.readdirSync(path.join(publicDir, rel), { withFileTypes: true }).forEach(function (entry) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.js')) {
        files.push({ rel: 'public/' + child, source: fs.readFileSync(path.join(publicDir, child), 'utf8') });
      }
    });
  })('');
  fs.readdirSync(publicDir).filter(function (name) { return name.endsWith('.html'); }).forEach(function (name) {
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let m;
    let n = 0;
    while ((m = re.exec(html)) !== null) {
      if (/\ssrc\s*=/i.test(' ' + m[1])) continue;
      n += 1;
      files.push({ rel: 'public/' + name + ' <inline ' + n + '>', source: m[2] });
    }
  });
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
 * that hide a false positive.
 *
 * Comments go before strings, which looks like the dangerous order — stripping
 * `// ` out of `'rate // limit'` leaves an unterminated quote, and a quote that
 * ran away could blank the real code after it and hide a sink. It cannot,
 * because the two quote patterns exclude newlines: a broken literal dies at the
 * end of its own line and takes nothing with it. That is load-bearing rather
 * than incidental, so it is checked — a sink planted on the line after exactly
 * that string is still reported.
 *
 * @param {string} source a JavaScript file
 * @returns {string} the same text with comments and single-line literals blanked
 */
function code(source) {
  return withoutComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")      // single-quoted strings
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')      // double-quoted
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');       // templates
}

/**
 * Comments only, literals left alone. One sink has to be looked for *inside*
 * a string — a `javascript:` URL is only ever a string — so blanking strings
 * would erase the very thing being searched for. Blanking comments first still
 * spares a line like `// never build a javascript:void(0) href`, which is
 * documentation and not a defect.
 * @param {string} source a JavaScript file
 * @returns {string} the same text with comments blanked
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');     // line comments, sparing http://
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

/**
 * Every sink in one script, as `rel:line — sink (why)` strings.
 * @param {{rel:string, source:string}} file a script and the name to report it by
 * @returns {string[]} one entry per sink per line; empty when the script is clean
 */
function sinksIn(file) {
  const found = [];
  // The javascript:-URL pattern has to see string literals, so it gets the
  // comment-stripped source; every other sink is matched against code only.
  const stripped = code(file.source);
  const literalsIntact = withoutComments(file.source);
  SINKS.forEach(function (sink) {
    const haystack = sink.name === 'javascript: URL' ? literalsIntact : stripped;
    const lines = haystack.split('\n');
    lines.forEach(function (line, index) {
      if (sink.pattern.test(line)) {
        found.push(file.rel + ':' + (index + 1) + ' — ' + sink.name + ' (' + sink.why + ')');
      }
    });
  });
  return found;
}

test('no shipped script can turn a string into markup or into code', function () {
  const files = shippedScripts();
  // A run that found no files would pass having checked nothing.
  assert.ok(files.length >= 10,
    'expected the shipped scripts to be found, got ' + files.length +
    ' — public/js/ may have moved and this test would be checking nothing');

  const found = [];
  files.forEach(function (file) { found.push.apply(found, sinksIn(file)); });

  assert.deepEqual(found, [],
    'a script this project ships can hand a browser a string to parse or run:\n  ' +
    found.join('\n  ') +
    '\n\nEvery user-authored string in this app is somebody else\'s bio, name or message. ' +
    'Insert text with ZC.util.el({ text }) — which sets textContent — and build structure ' +
    'from elements, never from concatenated markup. If a case genuinely needs markup, it ' +
    'needs a conversation and a sanitiser, not a quick exception here.');
});

test('a literal broken by comment stripping cannot hide the sink on the next line', function () {
  // The claim in code()'s docblock, held to: stripping `// limit'` out of
  // 'rate // limit' leaves a quote with no partner, and the sink one line down
  // must still be reported — even with another quote further down for a
  // runaway literal to close on. A sink named only in a comment must not be.
  const planted = [
    "var label = 'rate // limit';",
    'node.innerHTML = label;',
    '// never write node.innerHTML = label here',
    "log('done');"
  ].join('\n');
  assert.deepEqual(sinksIn({ rel: 'planted.js', source: planted }),
    ['planted.js:2 — innerHTML (parses a string as HTML)']);
});

test('the scan reaches every script a page runs inline', function () {
  // Counted with a pattern of its own rather than with the helper the scan
  // uses, so a helper that stopped finding inline bodies fails here instead of
  // agreeing with itself. 404.html carries one today, allowed by its CSP hash —
  // and a re-hashed edit to it passes static.test.js (c), which checks only
  // that the hash is listed, so this scan is the only thing reading its body.
  const pageDir = path.join(ROOT, 'public');
  const scanned = shippedScripts();
  const missing = [];
  let inline = 0;
  fs.readdirSync(pageDir).filter(function (name) { return name.endsWith('.html'); }).forEach(function (name) {
    const html = fs.readFileSync(path.join(pageDir, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const tags = html.match(/<script(?![^>]*\ssrc\s*=)[^>]*>/gi) || [];
    inline += tags.length;
    const covered = scanned.filter(function (file) { return file.rel.indexOf('public/' + name + ' ') === 0; }).length;
    if (covered !== tags.length) {
      missing.push('public/' + name + ': ' + tags.length + ' inline script(s), ' + covered + ' scanned');
    }
  });
  assert.ok(inline >= 1, 'expected at least the 404 page\'s inline script to be found — the page scan found none');
  assert.deepEqual(missing, [], 'inline scripts the injection scan never reads:\n  ' + missing.join('\n  '));
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
