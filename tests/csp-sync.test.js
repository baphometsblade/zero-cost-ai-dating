/* ==========================================================================
   Zero Cost AI Dating — CSP header/meta lockstep
   Firebase Hosting delivers the Content-Security-Policy as a response header
   (declared in firebase.json). GitHub Pages cannot set headers at all, so
   every page also carries the same policy in a <meta http-equiv> tag — and
   two copies of a policy drift apart unless something forces them together.
   This file is that something. The meta copy must equal the header value
   minus its frame-ancestors directive (browsers ignore frame-ancestors
   delivered via meta and log a warning; everything else in the policy is
   meta-legal), and it must sit before the first <link> and <script> in each
   page, because a CSP meta only governs the resources that come after it.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

/* ------------------------------------------------------------------------
   Tiny parsing helpers — string and regex work only, no dependencies
   ------------------------------------------------------------------------ */

/**
 * The Content-Security-Policy header value firebase.json declares, wherever
 * it sits in the hosting headers blocks.
 * @returns {string} the raw header value, or '' if none is declared
 */
function headerPolicy() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const blocks = (config.hosting && config.hosting.headers) || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const headers = blocks[i].headers || [];
    for (let j = 0; j < headers.length; j += 1) {
      if (headers[j].key === 'Content-Security-Policy') return headers[j].value;
    }
  }
  return '';
}

/**
 * What the meta copy of the policy must say: the header value with its
 * frame-ancestors directive dropped. Computed, not hard-coded, so a future
 * edit to firebase.json moves the expectation along with it.
 * @param {string} policy the raw header value
 * @returns {string} the policy as every <meta> tag must carry it
 */
function metaPolicy(policy) {
  return policy.split(';')
    .map(function (directive) { return directive.trim(); })
    .filter(function (directive) {
      return directive !== '' && !/^frame-ancestors\b/i.test(directive);
    })
    .join('; ');
}

/**
 * Blank out HTML comments while preserving every character offset, so tag
 * positions found in the blanked text still index into the real file.
 * @param {string} html source markup
 * @returns {string} markup with comment contents replaced by spaces
 */
function blankHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, function (block) {
    return block.replace(/[^\n]/g, ' ');
  });
}

/**
 * Parse an HTML attribute list into a plain object. Values may be double
 * quoted, single quoted or bare; valueless attributes map to ''.
 * @param {string} chunk the text between the tag name and the closing '>'
 * @returns {Object<string,string>} attribute name (lowercased) -> value
 */
function parseAttrs(chunk) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const value = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : ''));
    attrs[m[1].toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Every CSP <meta> tag in a document, with its offset.
 * @param {string} html comment-blanked markup
 * @returns {Array<{content:string,index:number}>} matches in source order
 */
function cspMetas(html) {
  const out = [];
  const re = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    if ((attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy') {
      out.push({ content: attrs.content || '', index: m.index });
    }
  }
  return out;
}

/**
 * Load every page in public/ once, so each check re-reads nothing.
 * @returns {Array<{rel:string,html:string}>} pages, comments blanked
 */
function loadPages() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter(function (name) { return name.endsWith('.html'); })
    .sort()
    .map(function (name) {
      const raw = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
      return { rel: 'public/' + name, html: blankHtmlComments(raw) };
    });
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

const PAGES = loadPages();
const HEADER = headerPolicy();
const EXPECTED = metaPolicy(HEADER);

/* ------------------------------------------------------------------------
   The checks
   ------------------------------------------------------------------------ */

test('firebase.json still declares the Content-Security-Policy header', function () {
  // If the header disappears, the meta copies in public/*.html would quietly
  // become the only policy — that must be a deliberate decision, not a drift.
  assert.notEqual(HEADER, '', 'firebase.json declares no Content-Security-Policy header');
  assert.notEqual(EXPECTED, '', 'the CSP header holds nothing deliverable via <meta>');
});

test('every page carries exactly one CSP meta equal to the header minus frame-ancestors', function () {
  const problems = [];

  PAGES.forEach(function (page) {
    const metas = cspMetas(page.html);
    if (metas.length !== 1) {
      problems.push(page.rel + ' has ' + metas.length + ' CSP meta tags; expected exactly 1');
      return;
    }
    if (metas[0].content !== EXPECTED) {
      problems.push(page.rel + ' CSP meta says\n      "' + metas[0].content +
        '"\n    but firebase.json (minus frame-ancestors) says\n      "' + EXPECTED + '"');
    }
  });

  assert.equal(problems.length, 0, report('CSP meta tags out of lockstep with firebase.json:', problems));
});

test('the CSP meta precedes the first <link> and the first <script>', function () {
  // A CSP meta governs only what comes after it, so a stylesheet or script
  // above it would load ungoverned — silently, and only on GitHub Pages.
  const problems = [];

  PAGES.forEach(function (page) {
    const metas = cspMetas(page.html);
    if (metas.length !== 1) return; // already reported above

    const firstLink = /<link\b/i.exec(page.html);
    const firstScript = /<script\b/i.exec(page.html);
    if (firstLink && firstLink.index < metas[0].index) {
      problems.push(page.rel + ' has a <link> before the CSP meta — it loads ungoverned');
    }
    if (firstScript && firstScript.index < metas[0].index) {
      problems.push(page.rel + ' has a <script> before the CSP meta — it loads ungoverned');
    }
  });

  assert.equal(problems.length, 0, report('Resources loading before the CSP meta:', problems));
});
