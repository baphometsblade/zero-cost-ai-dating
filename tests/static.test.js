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
     (f) sw.js CORE lists exactly what Hosting deploys, worker aside
     (g) every glyph the stylesheets generate has alternative text
     (h) every page that themes itself applies the stored theme from <head>

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

// The one script a page loads in its <head>, ahead of the block above: the
// stored theme has to be on <html> before the body is painted, and the body
// is painted before any script at its end has run. See check (h).
const HEAD_SCRIPTS = ['js/theme-boot.js'];

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
 * Split a page's <script> elements at the end of its <head>.
 * @param {string} html comment-blanked markup
 * @returns {{head:Array, body:Array}} the parsed scripts on each side
 */
function scriptsByPart(html) {
  const end = html.search(/<\/head\s*>/i);
  const all = parseScripts(html);
  return {
    head: all.filter(function (tag) { return end !== -1 && tag.index < end; }),
    body: all.filter(function (tag) { return end === -1 || tag.index > end; })
  };
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
    // The block at the end of the body. What a page loads in its <head> is
    // check (h)'s, so it is neither part of this order nor an extra here.
    const scripts = scriptsByPart(page.html).body;
    const srcs = scripts.map(function (tag) { return tag.attrs.src || ''; });

    if (Object.prototype.hasOwnProperty.call(MINIMAL_PAGES, page.name)) {
      // 404.html has its own, shorter list. Only external scripts are load
      // order; whether an inline body may exist at all is check (c)'s hash
      // rule, not a question of ordering.
      const expected = MINIMAL_PAGES[page.name];
      const external = srcs.filter(function (src) { return src !== ''; });
      if (external.join('|') !== expected.join('|')) {
        problems.push(page.rel + ' loads [' + external.join(', ') + '] but must load exactly [' +
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

  // The one exception to "no inline scripts": a body whose CSP hash the policy
  // in firebase.json explicitly lists. That is exactly the rule the browser
  // itself applies, so this check can never drift from what actually ships —
  // and editing a hash-allowed script without recomputing its hash fails here
  // for the same reason it would fail in the browser. (404.html's link
  // resolver is the only such script; it cannot be an external file because a
  // relative src breaks on the nested URLs it exists to fix.)
  const crypto = require('node:crypto');
  const csp = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'))
    .hosting.headers.flatMap(function (h) { return h.headers; })
    .find(function (h) { return h.key === 'Content-Security-Policy'; }).value;
  const hashAllowed = function (body) {
    const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    return csp.indexOf("'sha256-" + hash + "'") !== -1;
  };

  PAGES.forEach(function (page) {
    // Inline <script> bodies: blocked by script-src 'self' unless hash-listed.
    parseScripts(page.html).forEach(function (tag) {
      const line = lineAt(page.html, tag.index);
      if (!tag.attrs.src) {
        if (!hashAllowed(tag.body)) {
          problems.push(page.rel + ':' + line + ' has an inline <script> whose hash the CSP does not list' +
            ' (inline scripts are CSP-blocked; if this one is intentional, add its sha256 to firebase.json' +
            ' and the synced meta tags)');
        }
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
  //
  // Everything Hosting deploys, not a list of directories and extensions: this
  // walked '', 'css' and 'js' for five extensions, so an image or font added in
  // its own folder shipped uncached with this check green. Measured: a
  // public/img/hero.png the landing page linked passed. Skipped here is what
  // firebase.json's "ignore" keeps off Hosting — dotfiles, node_modules and
  // *.test.js — because what is never deployed cannot be precached.
  const expected = [];
  (function walk(dir) {
    fs.readdirSync(path.join(PUBLIC_DIR, dir)).forEach(function (name) {
      const rel = dir ? dir + '/' + name : name;
      if (name.charAt(0) === '.' || name === 'node_modules' || /\.test\.js$/.test(name)) return;
      if (fs.statSync(path.join(PUBLIC_DIR, rel)).isDirectory()) { walk(rel); return; }
      if (rel === 'sw.js') return;
      expected.push(rel);
    });
  })('');
  // A walk that stopped finding things would pass by checking nothing.
  assert.ok(expected.length >= listed.length,
    'the walk of public/ found ' + expected.length + ' files, fewer than the ' + listed.length + ' CORE lists');
  expected.forEach(function (rel) {
    if (listed.indexOf(rel) === -1) {
      problems.push('public/' + rel + ' is not in sw.js CORE — it will not be available offline');
    }
  });

  assert.equal(problems.length, 0, report('Service worker precache problems:', problems));
});

test('(g) every glyph the stylesheets generate has alternative text', function () {
  // Generated content is read aloud, so a decorative glyph is noise and a
  // meaningful one needs words: the brand link was "♥ Zero Cost Dating", and a
  // missing plan feature was a bare "✕". Each glyph is declared twice — plain,
  // then with alternative text after the slash, which a browser that does not
  // know the form ignores (style.css explains, above .nav-brand::before). A
  // glyph declared only plainly fails here; '' alternative text is the honest
  // way to say "decoration".
  const problems = [];
  let glyphs = 0;
  ['style.css', 'components.css'].forEach(function (name) {
    const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css', name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = rule.exec(css)) !== null) {
      const plain = /(?:^|[;\s])content\s*:\s*('(?:[^'\\\n]|\\.)+'|"(?:[^"\\\n]|\\.)+")\s*;/.exec(m[2]);
      if (!plain) continue;
      glyphs += 1;
      const literal = plain[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const alt = new RegExp('content\\s*:\\s*' + literal + '\\s*/\\s*(?:\'[^\'\\n]*\'|"[^"\\n]*")\\s*;');
      if (!alt.test(m[2])) {
        problems.push(name + ' ' + m[1].trim().replace(/\s+/g, ' ') + ': content ' + plain[1] +
          ' has no alternative text — add content: ' + plain[1] + " / '…'; after it");
      }
    }
  });
  // Fourteen today; a parser that stopped finding them would pass by checking nothing.
  assert.ok(glyphs >= 14, 'found only ' + glyphs + ' generated glyphs in the stylesheets');
  assert.equal(problems.length, 0, report('Generated glyphs a screen reader reads raw:', problems));
});

test('(h) every page that themes itself applies the stored theme from <head>, with app.js\'s key', function () {
  // A theme chosen in Settings is applied by app.js, at the end of the body,
  // and the body is painted before that runs: with dark chosen on a light OS,
  // settings painted light at 52ms and turned dark at 123ms. theme-boot.js
  // applies it from <head> instead, which only works on a page that loads it
  // there and blocking (a defer or async copy can run after the paint it is
  // there to precede), and only while it reads the key app.js writes and
  // knows every theme app.js offers. 404.html runs no script and follows the
  // OS alone. e2e/specs/06-layout.e2e.js watches the paint itself.
  const problems = [];
  PAGES.forEach(function (page) {
    const head = scriptsByPart(page.html).head;
    const minimal = Object.prototype.hasOwnProperty.call(MINIMAL_PAGES, page.name);
    // On 404.html only external scripts are counted, as (b) counts them
    // there: whether an inline body may exist on that page is (c)'s hash rule.
    const srcs = head.map(function (tag) { return tag.attrs.src || '<inline>'; })
      .filter(function (src) { return !minimal || src !== '<inline>'; });
    const expected = minimal ? [] : HEAD_SCRIPTS;
    if (srcs.join('|') !== expected.join('|')) {
      problems.push(page.rel + ' loads [' + srcs.join(', ') + '] in <head>; expected [' + expected.join(', ') + ']');
    }
    head.forEach(function (tag) {
      if ('defer' in tag.attrs || 'async' in tag.attrs) {
        problems.push(page.rel + ':' + lineAt(page.html, tag.index) + ' loads "' + tag.attrs.src +
          '" defer/async, so it may run after the first paint');
      }
    });
  });

  const app = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'app.js'), 'utf8');
  const boot = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'theme-boot.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const key = /const THEME_KEY = '([^']+)';/.exec(app);
  const themes = /const THEMES = \{([^}]*)\};/.exec(app);
  assert.ok(key && themes, 'app.js no longer declares `const THEME_KEY = \'…\';` and `const THEMES = { … };`');
  if (boot.indexOf("getItem('" + key[1] + "')") === -1) {
    problems.push('theme-boot.js does not read app.js\'s THEME_KEY, "' + key[1] + '"');
  }
  const offered = themes[1].split(',').map(function (entry) { return entry.split(':')[0].trim(); })
    .filter(function (name) { return name && name !== 'system'; });
  assert.ok(offered.length >= 2, 'found only ' + offered.length + ' themes besides system in app.js THEMES');
  offered.forEach(function (name) {
    if (boot.indexOf("'" + name + "'") === -1) {
      problems.push('theme-boot.js never applies "' + name + '", a theme app.js offers');
    }
  });

  assert.equal(problems.length, 0, report('The stored theme would miss the first paint:', problems));
});

test('the plans page arrives with a placeholder for each usage row subscription.js draws', function () {
  // subscription.html holds today's usage open with rows in the shape the
  // script draws, so the plan cards below are painted where they will stay
  // (the page explains, above #usage-list). The rows are written down twice,
  // here and as USAGE_ROWS, and a placeholder short of a row moves the cards
  // again by that row's height on every load.
  const html = blankHtmlComments(fs.readFileSync(path.join(PUBLIC_DIR, 'subscription.html'), 'utf8'));
  const start = html.indexOf('id="usage-list"');
  const end = html.indexOf('id="usage-reset"');
  assert.ok(start !== -1 && end > start, 'subscription.html has #usage-list followed by #usage-reset');
  const held = [];
  const row = /<div class="spread"><span>([^<]+)<\/span>/g;
  let m;
  const block = html.slice(start, end);
  while ((m = row.exec(block)) !== null) held.push(m[1]);

  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'subscription.js'), 'utf8');
  const rows = /const USAGE_ROWS = \[([\s\S]*?)\];/.exec(js);
  assert.ok(rows, 'subscription.js declares `const USAGE_ROWS = [ … ];`');
  const drawn = [];
  const label = /label: '([^']+)'/g;
  while ((m = label.exec(rows[1])) !== null) drawn.push(m[1]);

  assert.ok(drawn.length > 0, 'found no labels in USAGE_ROWS');
  assert.deepEqual(held, drawn, 'the placeholder rows in subscription.html are not the rows USAGE_ROWS draws');
});

test('the matches list pane ships its cards visible and leaves the loading state to the stylesheet', function () {
  // A page and its scripts can come from two deploys: Hosting cached scripts
  // for an hour against pages it did not, and GitHub Pages still caches every
  // file for ten minutes. The conversation card once shipped `hidden` for the
  // new matches.js to reveal, and under the old one it never was: no
  // conversations, nothing to tap. .list-skeleton (components.css) holds the
  // cards back while the loading card shows, whichever script is running.
  const html = blankHtmlComments(fs.readFileSync(path.join(PUBLIC_DIR, 'matches.html'), 'utf8'));
  const classOf = function (id) {
    const tag = new RegExp('<[a-z]+\\b[^>]*\\bid="' + id + '"[^>]*>').exec(html);
    assert.ok(tag, 'matches.html has #' + id);
    const cls = /\bclass="([^"]*)"/.exec(tag[0]);
    return cls ? cls[1].split(/\s+/) : [];
  };
  assert.ok(classOf('list-loading').indexOf('list-skeleton') !== -1, '#list-loading is not a .list-skeleton');
  const card = classOf('conversations-card');
  assert.ok(card.indexOf('hidden') === -1,
    '#conversations-card ships hidden, so only a matches.js of the same deploy can ever show it');
  assert.ok(card.indexOf('list-after-load') !== -1,
    '#conversations-card is not a .list-after-load, so nothing keeps it back while the list loads');
});
