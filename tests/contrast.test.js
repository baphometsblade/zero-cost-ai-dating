/* ==========================================================================
   Zero Cost AI Dating — contrast on the surfaces that are a flat colour

   This app is used at arm's length, on a phone, in whatever light the person
   happens to be standing in, and it ships a light theme and a dark one. Text
   that is merely *nearly* readable in one of them is a defect, and it is the
   kind nobody files a bug about — they just squint, or leave.

   What is checked here is narrow, and the narrowness is the point. A contrast
   ratio can only be computed where both sides are known, flat colours. This
   design leans hard on gradients (`.btn-primary`, `.badge-premium`, the hero
   title's clipped text), on translucent panels over photographs (the swipe
   card's reasons, which are white-on-glass with a backdrop blur), and on
   `color-mix`. None of those have a second colour to measure against — a
   browser-side sweep of computed styles reports their background as
   `transparent`, walks up to the page behind them, and produces confident
   nonsense. An earlier version of this check did exactly that and claimed 120
   failures across the two themes, of which one was real.

   So this reads the palette instead: every custom property in each of the
   three token blocks (`:root`, the `prefers-color-scheme: dark` media query,
   and the `[data-theme="dark"]` override), then the fill/ink pairs the
   stylesheet actually puts together on a flat surface. Where the pairing is
   not flat, it is left out and said so, rather than measured badly. The one
   kind of gradient that IS measurable — a label on a fill that runs between
   two flat colours — is measured at its worst point, in the last section.

   It found one thing, which is why it exists. `.btn-danger` was `color: #fff`
   on `background: var(--danger)`. Light's `#dc3545` takes white at 4.53:1;
   dark's `#f2707b` is a pale pink and takes it at 2.85:1. The button that
   fails is the one that deletes your account. The stylesheet already had the
   convention for fixing it — `--on-ok` exists because dark's mint fill needs
   near-black ink — and had reasoned explicitly that `--danger` needed no such
   pair, which was true of the question it asked (is danger readable *as* text)
   and not of the one it did not (what is readable *on* a danger fill).
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

/** WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large. Everything here is normal. */
const AA_NORMAL = 4.5;

/**
 * The fill/ink pairs the stylesheet puts on a flat surface, each named by the
 * rule that pairs them so a failure says where to look.
 *
 * Deliberately hand-listed rather than derived. Deriving it would mean parsing
 * the cascade, and a parser that quietly stopped finding rules would report
 * green forever — the exact false pass the rest of this project refuses. A
 * short list that a person has to extend when they add a filled button is the
 * honest trade.
 *
 * `.btn-primary` is absent on purpose: its fill is a linear-gradient between
 * two tokens, so there is no single background colour for `--on-brand` to be
 * measured against, and adding it here would mean inventing one. It is
 * measured instead along its gradient, with every other label on a two-stop
 * fill, at the end of this file.
 */
const FLAT_PAIRS = [
  { rule: '.btn-danger', fill: '--danger', ink: '--on-danger' },
  { rule: '.btn-success', fill: '--ok-ink', ink: '--on-ok' }
];

/**
 * Pull one theme's custom properties out of a block of CSS.
 * @param {string} block the text between a selector's braces
 * @returns {Object<string,string>} property name (with --) to value
 */
function tokensIn(block) {
  const out = {};
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = pattern.exec(block)) !== null) out[match[1]] = match[2].trim();
  return out;
}

/**
 * The three places this stylesheet defines a palette. A theme that stopped
 * being found would silently check nothing, so each is asserted to exist and
 * to carry a plausible number of tokens.
 * @returns {Object<string,Object>} theme name to its tokens
 */
function themes() {
  // The dark palette is scoped `:root:not([data-theme='light'])` inside the
  // media query, so an explicit light choice wins over the system preference.
  const root = /(?:^|\n):root\s*\{([\s\S]*?)\n\}/.exec(CSS);
  const media = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme=['"]light['"]\]\)\s*\{([\s\S]*?)\n  \}/.exec(CSS);
  const attr = /(?:^|\n):root\[data-theme=['"]dark['"]\]\s*\{([\s\S]*?)\n\}/.exec(CSS);
  assert.ok(root, 'no :root block found in style.css — this test is checking nothing');
  assert.ok(media, 'no prefers-color-scheme: dark block found');
  assert.ok(attr, 'no [data-theme="dark"] block found');
  return {
    light: tokensIn(root[1]),
    'dark (system)': tokensIn(media[1]),
    'dark (chosen)': tokensIn(attr[1])
  };
}

/**
 * Follow a token that is defined as another token. The dark palette aliases
 * rather than restates in places — `--ok-ink: var(--ok)` — and an alias is
 * still a flat colour, so it is resolved rather than treated as unmeasurable.
 * Bounded, because a palette that referred to itself in a loop would otherwise
 * hang the suite instead of failing it.
 * @param {Object<string,string>} tokens the theme being read
 * @param {Object<string,string>} light the light palette, for inherited values
 * @param {string} raw a token value, possibly `var(--other)`
 * @returns {string} a value that is no longer a var() reference, or the last
 *   thing it resolved to when the chain is too deep
 */
function deVar(tokens, light, raw) {
  let value = raw;
  for (let hops = 0; hops < 8; hops++) {
    const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(String(value).trim());
    if (!ref) return value;
    const next = tokens[ref[1]] || light[ref[1]];
    if (next === undefined) return value;
    value = next;
  }
  return value;
}

/**
 * @param {string} hex #rgb or #rrggbb
 * @returns {{r:number,g:number,b:number}|null} null when it is not a plain hex
 */
function parseHex(hex) {
  const value = String(hex).trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) {
    return { r: parseInt(short[1] + short[1], 16), g: parseInt(short[2] + short[2], 16), b: parseInt(short[3] + short[3], 16) };
  }
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!long) return null;
  return { r: parseInt(long[1], 16), g: parseInt(long[2], 16), b: parseInt(long[3], 16) };
}

/** Relative luminance, per WCAG 2.1. */
function luminance(rgb) {
  const channel = function (raw) {
    const v = raw / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** Contrast ratio between two hex colours, 1 to 21. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('the palette defines every ink a flat fill needs, in every theme', function () {
  const all = themes();
  const missing = [];
  Object.keys(all).forEach(function (name) {
    // The dark blocks override the light palette rather than restating it, so
    // a token they do not mention is inherited and correct. Only the light
    // :root has to carry the complete set.
    if (name !== 'light') return;
    FLAT_PAIRS.forEach(function (pair) {
      if (!all[name][pair.fill]) missing.push(name + ' has no ' + pair.fill);
      if (!all[name][pair.ink]) missing.push(name + ' has no ' + pair.ink);
    });
  });
  assert.deepEqual(missing, [], missing.join('; '));
});

test('text on a flat status fill clears WCAG AA in light and in both darks', function () {
  const all = themes();
  const light = all.light;
  const failures = [];
  const measured = [];

  Object.keys(all).forEach(function (name) {
    const tokens = all[name];
    FLAT_PAIRS.forEach(function (pair) {
      // Unstated in a dark block means inherited from :root.
      const fillRaw = deVar(tokens, light, tokens[pair.fill] || light[pair.fill]);
      const inkRaw = deVar(tokens, light, tokens[pair.ink] || light[pair.ink]);
      const fill = parseHex(fillRaw);
      const ink = parseHex(inkRaw);
      if (!fill || !ink) {
        // Not a flat colour any more. Saying so is the point: this test must
        // never quietly stop measuring a pair it used to cover.
        failures.push(name + ' ' + pair.rule + ': ' + pair.fill + ' or ' + pair.ink +
          ' is no longer a plain hex (' + fillRaw + ' / ' + inkRaw + '), so this ' +
          'check can no longer measure it — either restore a flat colour or move ' +
          'the pair out of FLAT_PAIRS deliberately.');
        return;
      }
      const ratio = contrast(fill, ink);
      measured.push(name + ' ' + pair.rule + ' ' + ratio.toFixed(2) + ':1');
      if (ratio + 0.005 < AA_NORMAL) {
        failures.push(name + ' ' + pair.rule + ': ' + inkRaw + ' on ' + fillRaw +
          ' is ' + ratio.toFixed(2) + ':1, below the ' + AA_NORMAL + ':1 AA needs for normal text');
      }
    });
  });

  assert.deepEqual(failures, [], failures.join('\n  ') + '\n  measured: ' + measured.join(', '));
  // A run that measured nothing is not a passing run — the same guard the
  // browser and emulator runners carry.
  assert.ok(measured.length >= FLAT_PAIRS.length * 3,
    'expected at least ' + (FLAT_PAIRS.length * 3) + ' measurements, made ' + measured.length);
});

test('body text clears AA against the surface it sits on, in every theme', function () {
  const all = themes();
  const light = all.light;
  const failures = [];
  const measured = [];
  // The three neutrals every page paints text on, against all three text inks.
  //
  // This said "the two text inks" over a list of one, and measured `--text`
  // alone — which is 14.47:1 at its worst, a bound the data never approaches.
  // The inks that actually sit near 4.5 were the two it skipped: `--text-muted`
  // colours 30 rules across the two stylesheets and `--text-faint` 14, and
  // `.chat-day` in components.css pairs `--text-faint` on `--bg-sunken` at
  // 4.78:1 — 0.28 above the bound. The palette itself claims that number
  // (style.css: "this clears 4.5:1 on all three neutrals (4.78:1 on the
  // darkest)") and nothing executed it. Verified by mutation: dropping either
  // ink to 1.2:1 left the whole suite green.
  const SURFACES = ['--bg', '--bg-elev', '--bg-sunken'];
  const INKS = ['--text', '--text-muted', '--text-faint'];

  Object.keys(all).forEach(function (name) {
    const tokens = all[name];
    SURFACES.forEach(function (surface) {
      INKS.forEach(function (inkName) {
        const bgRaw = deVar(tokens, light, tokens[surface] || light[surface]);
        const fgRaw = deVar(tokens, light, tokens[inkName] || light[inkName]);
        const bg = parseHex(bgRaw);
        const fg = parseHex(fgRaw);
        if (!bg || !fg) {
          // A failure, not a `return`. This was a silent skip, which meant a
          // palette that stopped being plain hex took the gate down with it
          // without reddening anything: rewriting `--text` as an rgb() triple
          // left body text entirely unmeasured and the suite green.
          failures.push(name + ' ' + inkName + ' on ' + surface + ': ' + fgRaw + ' or ' +
            bgRaw + ' is no longer a plain hex, so this check can no longer measure ' +
            'it — either restore a flat colour or drop the token from INKS deliberately.');
          return;
        }
        const ratio = contrast(bg, fg);
        measured.push(name + ' ' + inkName + ' on ' + surface + ' ' + ratio.toFixed(2) + ':1');
        if (ratio + 0.005 < AA_NORMAL) {
          failures.push(name + ' ' + inkName + ' on ' + surface + ' is ' + ratio.toFixed(2) + ':1');
        }
      });
    });
  });

  assert.deepEqual(failures, [], failures.join('\n  ') + '\n  measured: ' + measured.join(', '));
  // The same vacuity guard the sibling above carries, and for the same reason:
  // a run that measured nothing is not a passing run.
  assert.ok(measured.length >= SURFACES.length * INKS.length * Object.keys(all).length,
    'expected at least ' + (SURFACES.length * INKS.length * Object.keys(all).length) +
    ' measurements, made ' + measured.length);
});

/* ------------------------------------------------------------------------
   The deck's action glyphs, at rest and on hover

   Each of the four action buttons is a single glyph and nothing else, so the
   glyph IS the control's label: there is no text beside it to read instead.
   components.css says each is "coloured with the ink token rather than the
   fill one", and that was true of two of the four. The star took
   --accent-500, a fill, and measured 4.08:1 on its own hover tint in the light
   theme — under the 4.5:1 a 20px glyph has to clear. Nothing measured it,
   because every check above is about text tokens on page surfaces.

   This reads the four rules rather than restating them, so a glyph that
   changes its token, its size or its hover tint is measured as it now is.
   The threshold follows WCAG's size rule: under 24px a glyph is normal text
   and needs 4.5:1; at 24px and above it is large text and needs 3:1.
   ------------------------------------------------------------------------ */

const COMPONENTS = fs.readFileSync(path.join(ROOT, 'public', 'css', 'components.css'), 'utf8');

/** The deck's single-glyph controls, by their modifier class. */
const GLYPHS = ['action-rewind', 'action-pass', 'action-super', 'action-like'];

/**
 * The declarations of one rule, by exact selector.
 * @param {string} selector e.g. '.action-super'
 * @returns {string|null} the text between its braces
 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\:]/g, '\\$&');
  const match = new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}').exec(COMPONENTS);
  return match ? match[1] : null;
}

/** One declaration's value out of a rule body, or null. */
function declared(body, property) {
  if (!body) return null;
  const match = new RegExp('(?:^|[;\\s])' + property + '\\s*:\\s*([^;]+);').exec(body);
  return match ? match[1].trim() : null;
}

/** A colour, as hex or rgb()/rgba(), with its alpha. Null when it is neither. */
function parseColour(value) {
  const hex = parseHex(value);
  if (hex) return { r: hex.r, g: hex.g, b: hex.b, a: 1 };
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(String(value).trim());
  if (!rgb) return null;
  return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
}

/** A translucent colour composited onto an opaque one. */
function onto(top, under) {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

test('every deck action glyph clears the threshold its size calls for, at rest and on hover, in every theme', function () {
  const all = themes();
  const light = all.light;
  const base = ruleBody('.action-btn');
  assert.ok(base, 'no .action-btn rule found in components.css — this test is checking nothing');
  const baseSize = parseFloat(declared(base, 'font-size'));
  const restingBg = declared(base, 'background');
  assert.ok(baseSize > 0 && /^var\(/.test(restingBg || ''),
    '.action-btn no longer declares a px font-size and a token background: ' + baseSize + ', ' + restingBg);

  const failures = [];
  let measured = 0;
  GLYPHS.forEach(function (name) {
    const rest = ruleBody('.' + name);
    const hover = ruleBody('.' + name + ':hover:not([disabled])');
    const ink = declared(rest, 'color');
    const tint = declared(hover, 'background');
    const size = parseFloat(declared(rest, 'font-size')) || baseSize;
    if (!ink || !tint) {
      failures.push('.' + name + ': its colour or its hover background could not be found');
      return;
    }
    const needed = size >= 24 ? 3 : 4.5;
    Object.keys(all).forEach(function (theme) {
      const tokens = all[theme];
      const resolve = function (raw) {
        const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
        return parseColour(deVar(tokens, light, ref ? (tokens[ref[1]] || light[ref[1]]) : raw));
      };
      const fg = resolve(ink);
      const surface = resolve(restingBg);
      const wash = resolve(tint);
      if (!fg || !surface || !wash || surface.a !== 1) {
        // Unmeasurable is a failure, not a pass: a colour this cannot read is
        // exactly the case that used to make the whole gate quietly vacuous.
        failures.push(theme + ' .' + name + ': unmeasurable (' + ink + ' / ' + restingBg + ' / ' + tint + ')');
        return;
      }
      const hoverBg = onto(wash, surface);
      [['at rest', surface], ['on hover', hoverBg]].forEach(function (state) {
        const ratio = contrast(onto(fg, state[1]), state[1]);
        measured += 1;
        if (ratio < needed) {
          failures.push(theme + ' .' + name + ' ' + state[0] + ': ' + ratio.toFixed(2) + ':1 for a ' + size +
            'px glyph, needs ' + needed + ':1 (' + ink + ')');
        }
      });
    });
  });

  assert.deepEqual(failures, [], 'deck glyphs below contrast:\n  - ' + failures.join('\n  - '));
  assert.equal(measured, GLYPHS.length * Object.keys(all).length * 2,
    'measured ' + measured + ' glyph pairs; expected every glyph, theme and state');
});

/* ------------------------------------------------------------------------
   Labels on a two-stop gradient

   The filled treatments — the primary and send buttons, your own chat
   bubbles, the "how it works" numerals, the plan ribbon and the premium
   badge — write their label on a linear-gradient between two flat colours.
   None of them has one background colour, which is why FLAT_PAIRS leaves
   them out. Each does have a worst one, and a contrast bound needs nothing
   more: the label has to clear the threshold against every point of its
   fill, so this walks each gradient in every theme and keeps the lowest
   ratio it meets.

   It walks the whole line rather than checking the two stops, because the
   darkest point of a gradient need not be a stop. Black text clears 6.7:1
   against both ends of a #ff00ff-to-#00ff00 fill and about 5.3:1 at its
   middle. The dark theme writes near-black ink on bright fills, which is
   exactly the case the stops alone would under-measure.

   Unlike FLAT_PAIRS, the rules are found rather than listed: every rule in
   either stylesheet whose background is a two-stop linear-gradient and that
   sets a colour is measured, so the next filled control is covered without
   anyone remembering to add it. The risk in deriving — a parser that quietly
   stops finding anything — is what MEASURED_AT_LEAST is for: it names the
   rules this must keep measuring, and fails when one of them is not.
   ------------------------------------------------------------------------ */

/** Rules that must be among those measured, so the sweep cannot go vacuous. */
const MEASURED_AT_LEAST = ['.btn-primary', '.chat-send', '.msg-me .msg-text', '.step-num', '.plan-ribbon', '.badge-premium'];

/**
 * Rules the sweep finds but must not hold to a text threshold, each with the
 * reason. An exemption that no longer matches a rule fails the test, so this
 * cannot outlive what it excuses.
 */
const GRADIENT_EXEMPT = {
  // White on its lighter stop is 2.72:1 in light and 2.04:1 in both darks,
  // and that is allowed: the heart is part of the wordmark, and WCAG 1.4.3
  // exempts text that is part of a logo or brand name.
  '.nav-brand::before': 'the logo mark'
};

/** How many points along each gradient are measured, both ends included. */
const GRADIENT_STEPS = 100;

/**
 * Every rule in both stylesheets that writes text on a two-stop linear
 * gradient, as written: the two stops and the ink are still token references.
 * @returns {{sheet:string, selector:string, from:string, to:string, ink:string, px:number|null}[]}
 */
function gradientLabels() {
  const sheets = { 'style.css': CSS, 'components.css': COMPONENTS };
  const stop = '([^,()]+(?:\\([^()]*\\))?)';
  const twoStops = new RegExp('^linear-gradient\\(\\s*(?:-?[\\d.]+deg|to [a-z ]+)\\s*,\\s*' + stop + '\\s*,\\s*' + stop + '\\s*\\)$', 'i');
  const found = [];
  Object.keys(sheets).forEach(function (sheet) {
    // Comments first: a rule that has been commented out is not one the
    // browser applies, and a selector in prose is not a selector.
    const css = sheets[sheet].replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = rule.exec(css)) !== null) {
      const fill = twoStops.exec(declared(match[2], 'background') || '');
      const ink = declared(match[2], 'color');
      if (!fill || !ink) continue;
      // Text clipped to its own gradient — the match heading, and the hero
      // title, whose first stop has a position and so never matches above —
      // is the opposite case: there the gradient IS the ink, and what it sits
      // on is the page or the burst overlay, which this file cannot know.
      // The header names clipped text as unmeasurable; this is where that
      // decision is made, by its mechanism rather than by a list of names.
      if (declared(match[2], 'background-clip') === 'text') continue;
      const size = /^([\d.]+)px$/.exec(declared(match[2], 'font-size') || '');
      found.push({
        sheet: sheet,
        selector: match[1].trim().replace(/\s+/g, ' '),
        from: fill[1].trim(),
        to: fill[2].trim(),
        ink: ink,
        px: size ? Number(size[1]) : null
      });
    }
  });
  return found;
}

test('every label on a two-stop gradient clears AA at the worst point of its fill, in every theme', function () {
  const all = themes();
  const light = all.light;
  const labels = gradientLabels();
  const failures = [];
  const measured = [];

  labels.forEach(function (label) {
    if (GRADIENT_EXEMPT[label.selector]) return;
    // A size this cannot read as px is held to the normal-text bound, which
    // is the stricter of the two: unknown never makes the check easier.
    const needed = label.px !== null && label.px >= 24 ? 3 : AA_NORMAL;
    Object.keys(all).forEach(function (theme) {
      const tokens = all[theme];
      const resolve = function (raw) {
        const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
        return parseColour(deVar(tokens, light, ref ? (tokens[ref[1]] || light[ref[1]]) : raw));
      };
      const from = resolve(label.from);
      const to = resolve(label.to);
      const ink = resolve(label.ink);
      if (!from || !to || !ink || from.a !== 1 || to.a !== 1 || ink.a !== 1) {
        // A translucent stop sits over whatever is behind it, which this file
        // cannot know. Unmeasurable is reported, never passed.
        failures.push(theme + ' ' + label.selector + ' (' + label.sheet + '): unmeasurable (' +
          label.ink + ' on ' + label.from + ' → ' + label.to + ') — make the stops and ink opaque ' +
          'colours or exempt the rule in GRADIENT_EXEMPT with the reason');
        return;
      }
      // CSS interpolates a gradient between two colours in sRGB, so the fill
      // at t is the straight line between the stops' channel values.
      let worst = Infinity;
      let at = 0;
      for (let step = 0; step <= GRADIENT_STEPS; step++) {
        const t = step / GRADIENT_STEPS;
        const point = { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t };
        const ratio = contrast(point, ink);
        if (ratio < worst) {
          worst = ratio;
          at = t;
        }
      }
      measured.push(theme + ' ' + label.selector + ' ' + worst.toFixed(2) + ':1');
      if (worst + 0.005 < needed) {
        failures.push(theme + ' ' + label.selector + ' (' + label.sheet + '): ' + label.ink + ' on ' +
          label.from + ' → ' + label.to + ' falls to ' + worst.toFixed(2) + ':1 at ' +
          Math.round(at * 100) + '% of the fill, below the ' + needed + ':1 it needs');
      }
    });
  });

  MEASURED_AT_LEAST.forEach(function (selector) {
    if (!labels.some(function (label) { return label.selector === selector; })) {
      failures.push(selector + ' is no longer found as text on a two-stop gradient, so nothing ' +
        'measures it — if its fill changed shape on purpose, take it out of MEASURED_AT_LEAST');
    }
  });
  Object.keys(GRADIENT_EXEMPT).forEach(function (selector) {
    if (!labels.some(function (label) { return label.selector === selector; })) {
      failures.push('GRADIENT_EXEMPT excuses ' + selector + ', which no longer paints text on a ' +
        'two-stop gradient — drop the exemption');
    }
  });

  assert.deepEqual(failures, [], 'labels on gradients:\n  - ' + failures.join('\n  - ') +
    '\n  measured: ' + measured.join(', '));
  assert.ok(measured.length >= MEASURED_AT_LEAST.length * Object.keys(all).length,
    'measured ' + measured.length + ' gradient labels; expected at least ' +
    (MEASURED_AT_LEAST.length * Object.keys(all).length));
});
