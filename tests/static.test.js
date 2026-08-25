/* ==========================================================================
   Zero Cost AI Dating — static HTML checks
   There is no bundler, no linter and no framework here, so nothing else would
   catch a typo'd href, a script block loaded in the wrong order, a class name
   that never made it into the CSS, or an inline handler that the shipped CSP
   will silently refuse to run. This file is that safety net: it parses every
   page in public/ with plain string work — no dependencies, deliberately — and
   asserts the five properties from §7 of the contract:

     (a) every local src/href resolves to a file that exists on disk
     (b) the <script> block matches the load order in §2, exactly
     (c) no inline <script> bodies, no style="…", no on*="…" handlers (CSP)
     (d) every class token used in HTML is defined somewhere in the CSS
     (e) every page has <html lang>, <title>, viewport and description

   Failures print the offending page and line, because a static check nobody
   can act on is worse than no check at all.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CSS_DIR = path.join(PUBLIC_DIR, 'css');

/* ------------------------------------------------------------------------
   Expected load order (§2 of the contract)
   ------------------------------------------------------------------------ */

// The three compat SDK bundles, in this order, before anything local.
const FIREBASE_SDK = [
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'
];

// The shared local block. A page may add exactly one page script after it.
const CORE_SCRIPTS = [
  'js/firebase-config.js',
  'js/utils.js',
  'js/seed-data.js',
  'js/data-store.js',
  'js/matching-engine.js',
  'js/auth.js',
  'js/app.js'
];

// 404.html loads no scripts at all: it answers *nested* missing paths too,
// where a relative js/… src would resolve inside the missing directory and
// 404 in turn, so the page ships fully self-contained.
const MINIMAL_PAGES = {
  '404.html': []
};

// Every page the ownership map promises. A missing one is a dead link waiting
// to happen, so assert the set rather than just walking whatever is there.
const EXPECTED_PAGES = [
  '404.html',
  'auth.html',
  'dashboard.html',
  'index.html',
  'matches.html',
  'profile.html',
  'settings.html',
  'subscription.html'
];

/* ------------------------------------------------------------------------
   Tiny parsing helpers — string and regex work only, no dependencies
   ------------------------------------------------------------------------ */

/**
 * Blank out HTML comments while preserving every character offset and newline,
 * so line numbers reported from the blanked text still match the real file.
 * @param {string} html source markup
 * @returns {string} markup with comment contents replaced by spaces
 */
function blankHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, function (block) {
    return block.replace(/[^\n]/g, ' ');
  });
}

/**
 * Blank out CSS comments, preserving offsets and newlines for the same reason.
 * @param {string} css source stylesheet
 * @returns {string} stylesheet with comment contents replaced by spaces
 */
function blankCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, function (block) {
    return block.replace(/[^\n]/g, ' ');
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
 * Parse an HTML attribute list into a plain object. Values may be double
 * quoted, single quoted or bare; valueless attributes (defer, async) map to ''.
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
 * Every <script> element in a document, in source order.
 * @param {string} html comment-blanked markup
 * @returns {Array<{attrs:Object,body:string,index:number}>} parsed script tags
 */
function parseScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ attrs: parseAttrs(m[1]), body: m[2], index: m.index });
  }
  return out;
}

/**
 * Every value of a given attribute in a document, with its offset.
 * @param {string} html comment-blanked markup
 * @param {string} name attribute name, e.g. 'class'
 * @returns {Array<{value:string,index:number}>} matches in source order
 */
function attrValues(html, name) {
  const out = [];
  const re = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ value: m[1] !== undefined ? m[1] : m[2], index: m.index });
  }
  return out;
}

/**
 * Load every page in public/ once, so each check re-reads nothing.
 * @returns {Array<{name:string,rel:string,file:string,raw:string,html:string}>} pages
 */
function loadPages() {
  return fs.readdirSync(PUBLIC_DIR)
    .filter(function (name) { return name.endsWith('.html'); })
    .sort()
    .map(function (name) {
      const file = path.join(PUBLIC_DIR, name);
      const raw = fs.readFileSync(file, 'utf8');
      return { name: name, rel: 'public/' + name, file: file, raw: raw, html: blankHtmlComments(raw) };
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

// URLs the checks must not try to resolve on disk.
const EXTERNAL_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/;

/* ------------------------------------------------------------------------
   Preflight: the pages themselves
   ------------------------------------------------------------------------ */

test('public/ contains exactly the pages the ownership map promises', function () {
  const found = PAGES.map(function (page) { return page.name; });
  assert.deepEqual(found, EXPECTED_PAGES);
});

/* ------------------------------------------------------------------------
   (a) Local src/href targets exist
   ------------------------------------------------------------------------ */

test('(a) every local src/href resolves to a file on disk', function () {
  const problems = [];

  PAGES.forEach(function (page) {
    const re = /\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(page.html)) !== null) {
      const rawValue = (m[1] !== undefined ? m[1] : m[2]).trim();
      // Skip anchors, absolute URLs, protocol-relative URLs and empty values.
      if (!rawValue || rawValue.charAt(0) === '#' || EXTERNAL_RE.test(rawValue)) continue;

      // Query strings and fragments are routing, not part of the file name.
      const target = rawValue.split('#')[0].split('?')[0];
      if (!target) continue;

      const resolved = target.charAt(0) === '/'
        ? path.join(PUBLIC_DIR, target.slice(1))
        : path.resolve(path.dirname(page.file), target);
      const line = lineAt(page.html, m.index);

      if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
        problems.push(page.rel + ':' + line + ' -> "' + rawValue + '" escapes public/');
      } else if (!fs.existsSync(resolved)) {
        problems.push(page.rel + ':' + line + ' -> "' + rawValue + '" (no file at ' +
          path.relative(ROOT, resolved) + ')');
      }
    }
  });

  assert.equal(problems.length, 0, report('Dead local links:', problems));
});

/* ------------------------------------------------------------------------
   (b) Script load order
   ------------------------------------------------------------------------ */

test('(b) the script block matches the load order in §2', function () {
  const problems = [];

  PAGES.forEach(function (page) {
    const scripts = parseScripts(page.html);
    const srcs = scripts.map(function (tag) { return tag.attrs.src || ''; });

    if (Object.prototype.hasOwnProperty.call(MINIMAL_PAGES, page.name)) {
      // 404.html has its own, shorter list.
      const expected = MINIMAL_PAGES[page.name];
      if (srcs.join('|') !== expected.join('|')) {
        problems.push(page.rel + ' loads [' + srcs.join(', ') + '] but must load exactly [' +
          expected.join(', ') + ']');
      }
      return;
    }

    const expected = FIREBASE_SDK.concat(CORE_SCRIPTS);
    const head = srcs.slice(0, expected.length);
    if (head.join('|') !== expected.join('|')) {
      for (let i = 0; i < expected.length; i += 1) {
        if (head[i] !== expected[i]) {
          problems.push(page.rel + ' script #' + (i + 1) + ' is "' + (head[i] || '<missing>') +
            '", expected "' + expected[i] + '"');
        }
      }
    }

    // After the shared block a page may load exactly one page script: its own.
    const tail = srcs.slice(expected.length);
    const pageScript = 'js/' + page.name.replace(/\.html$/, '') + '.js';
    if (tail.length > 1) {
      problems.push(page.rel + ' loads ' + tail.length + ' extra scripts [' + tail.join(', ') +
        ']; only "' + pageScript + '" may follow the shared block');
    } else if (tail.length === 1 && tail[0] !== pageScript) {
      problems.push(page.rel + ' loads "' + tail[0] + '" after the shared block; expected "' +
        pageScript + '"');
    }

    // The SDK tags must be blocking: the local scripts assume `firebase` is
    // already defined (or definitively absent) by the time they run.
    scripts.slice(0, FIREBASE_SDK.length).forEach(function (tag, i) {
      const line = lineAt(page.html, tag.index);
      if ('defer' in tag.attrs || 'async' in tag.attrs) {
        problems.push(page.rel + ':' + line + ' the gstatic tag #' + (i + 1) + ' must not be defer/async');
      }
      if (tag.attrs.crossorigin !== 'anonymous') {
        problems.push(page.rel + ':' + line + ' the gstatic tag #' + (i + 1) +
          ' must carry crossorigin="anonymous"');
      }
    });
  });

  // Classic scripts everywhere — a module would break the shared ZC global.
  PAGES.forEach(function (page) {
    parseScripts(page.html).forEach(function (tag) {
      if (tag.attrs.type && tag.attrs.type !== 'text/javascript') {
        problems.push(page.rel + ':' + lineAt(page.html, tag.index) + ' script has type="' +
          tag.attrs.type + '"; only classic scripts are allowed');
      }
    });
  });

  assert.equal(problems.length, 0, report('Script load order problems:', problems));
});

/* ------------------------------------------------------------------------
   (c) Nothing the shipped CSP would refuse to run
   ------------------------------------------------------------------------ */

test('(c) no inline script bodies, style attributes or on* handlers', function () {
  const problems = [];

  PAGES.forEach(function (page) {
    // Inline <script> bodies: blocked by script-src 'self'.
    parseScripts(page.html).forEach(function (tag) {
      const line = lineAt(page.html, tag.index);
      if (!tag.attrs.src) {
        problems.push(page.rel + ':' + line + ' has a <script> without src (inline scripts are CSP-blocked)');
      } else if (tag.body.trim() !== '') {
        problems.push(page.rel + ':' + line + ' has a non-empty <script> body: "' +
          tag.body.trim().slice(0, 48) + '"');
      }
    });

    // style="…": blocked because the CSP allows stylesheets, not attributes.
    // Styles are set through the CSSOM instead (el.style.setProperty).
    const styleRe = /\sstyle\s*=\s*["']/gi;
    let m;
    while ((m = styleRe.exec(page.html)) !== null) {
      problems.push(page.rel + ':' + lineAt(page.html, m.index) +
        ' has a style="…" attribute; set it via el.style.setProperty instead');
    }

    // on*="…": inline event handlers are CSP-blocked too; listeners are wired in JS.
    const handlerRe = /\s(on[a-z]+)\s*=\s*["']/gi;
    let h;
    while ((h = handlerRe.exec(page.html)) !== null) {
      problems.push(page.rel + ':' + lineAt(page.html, h.index) + ' has an inline ' + h[1] +
        '="…" handler; use addEventListener in the page script');
    }
  });

  assert.equal(problems.length, 0, report('Content-Security-Policy violations in markup:', problems));
});

/* ------------------------------------------------------------------------
   (d) Class contract: HTML may only use classes the CSS defines
   ------------------------------------------------------------------------ */

test('(d) every class used in HTML exists in the CSS', function () {
  const cssFiles = fs.readdirSync(CSS_DIR)
    .filter(function (name) { return name.endsWith('.css'); })
    .sort();
  assert.ok(cssFiles.length > 0, 'expected stylesheets in public/css');

  // Collect every class selector the stylesheets define. Comments are blanked
  // first so a class merely *mentioned* in a section header does not count.
  const defined = new Set();
  cssFiles.forEach(function (name) {
    const css = blankCssComments(fs.readFileSync(path.join(CSS_DIR, name), 'utf8'));
    const re = /\.(-?[_a-zA-Z][\w-]*)/g;
    let m;
    while ((m = re.exec(css)) !== null) defined.add(m[1]);
  });

  // Every class token used in markup, remembering where it was used.
  const unknown = new Map();
  PAGES.forEach(function (page) {
    attrValues(page.html, 'class').forEach(function (attr) {
      const line = lineAt(page.html, attr.index);
      attr.value.split(/\s+/).forEach(function (token) {
        if (!token || defined.has(token)) return;
        if (!unknown.has(token)) unknown.set(token, []);
        unknown.get(token).push(page.rel + ':' + line);
      });
    });
  });

  const problems = Array.from(unknown.keys()).sort().map(function (token) {
    return '.' + token + '  used at ' + unknown.get(token).join(', ');
  });

  assert.equal(problems.length, 0, report(
    'Class tokens used in HTML but never defined in public/css:', problems));
});

/* ------------------------------------------------------------------------
   (e) Document head essentials
   ------------------------------------------------------------------------ */

test('(e) every page has lang, title, viewport and description', function () {
  const problems = [];

  PAGES.forEach(function (page) {
    // <html lang="…">
    const htmlTag = /<html\b([^>]*)>/i.exec(page.html);
    if (!htmlTag) {
      problems.push(page.rel + ' has no <html> element');
    } else if (!(parseAttrs(htmlTag[1]).lang || '').trim()) {
      problems.push(page.rel + ' is missing a non-empty <html lang="…">');
    }

    // <title>…</title>
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(page.html);
    if (!title || title[1].trim() === '') {
      problems.push(page.rel + ' is missing a non-empty <title>');
    }

    // Meta tags, indexed by their name attribute.
    const metas = {};
    const metaRe = /<meta\b([^>]*)>/gi;
    let m;
    let hasCharset = false;
    while ((m = metaRe.exec(page.html)) !== null) {
      const attrs = parseAttrs(m[1]);
      if ('charset' in attrs) hasCharset = true;
      if (attrs.name) metas[attrs.name.toLowerCase()] = attrs.content || '';
    }

    if (!hasCharset) {
      problems.push(page.rel + ' is missing <meta charset="…">');
    }
    if (!metas.viewport) {
      problems.push(page.rel + ' is missing <meta name="viewport">');
    } else if (metas.viewport.indexOf('width=device-width') === -1) {
      problems.push(page.rel + ' viewport "' + metas.viewport + '" does not set width=device-width');
    }
    if (!metas.description || metas.description.trim() === '') {
      problems.push(page.rel + ' is missing a non-empty <meta name="description">');
    }
  });

  assert.equal(problems.length, 0, report('Document head problems:', problems));
});

/* ------------------------------------------------------------------------
   (f) The service worker's CORE precache list matches the shipped assets
   ------------------------------------------------------------------------ */

test('(f) sw.js CORE precache list matches the shipped assets', function () {
  const swPath = path.join(PUBLIC_DIR, 'sw.js');
  assert.ok(fs.existsSync(swPath), 'public/sw.js is missing');
  const sw = fs.readFileSync(swPath, 'utf8');

  // Pull the CORE array out with plain string work, same as everything else.
  const coreMatch = /const CORE = \[([\s\S]*?)\];/.exec(sw);
  assert.ok(coreMatch, 'Could not find "const CORE = [...]" in public/sw.js');
  const listed = [];
  const entryRe = /'([^']+)'/g;
  let e;
  while ((e = entryRe.exec(coreMatch[1])) !== null) listed.push(e[1]);

  const problems = [];

  // Every listed asset must exist — a typo here caches nothing and breaks
  // cache.addAll() for the whole shell.
  listed.forEach(function (rel) {
    if (!fs.existsSync(path.join(PUBLIC_DIR, rel))) {
      problems.push('sw.js CORE lists "' + rel + '" which does not exist in public/');
    }
  });

  // And every shell asset must be listed — an app shell that silently skips a
  // page or script is not usable offline. The worker itself is excluded (the
  // browser manages its lifecycle; caching it would pin old versions).
  const expected = [];
  ['', 'css', 'js'].forEach(function (dir) {
    const abs = path.join(PUBLIC_DIR, dir);
    fs.readdirSync(abs).forEach(function (name) {
      const rel = dir ? dir + '/' + name : name;
      if (rel === 'sw.js') return;
      if (!/\.(html|css|js|svg|webmanifest)$/.test(name)) return;
      if (!fs.statSync(path.join(abs, name)).isFile()) return;
      expected.push(rel);
    });
  });
  expected.forEach(function (rel) {
    if (listed.indexOf(rel) === -1) {
      problems.push('public/' + rel + ' is not in sw.js CORE — it will not be available offline');
    }
  });

  assert.equal(problems.length, 0, report('Service worker precache problems:', problems));
});
