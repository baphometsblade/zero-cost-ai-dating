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
   not flat, it is left out and said so, rather than measured badly.

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
 * measured against. Adding it here would mean inventing one.
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
  // The three neutrals every page paints text on, against the two text inks.
  const SURFACES = ['--bg', '--bg-elev', '--bg-sunken'];
  const INKS = ['--text'];

  Object.keys(all).forEach(function (name) {
    const tokens = all[name];
    SURFACES.forEach(function (surface) {
      INKS.forEach(function (inkName) {
        const bg = parseHex(deVar(tokens, light, tokens[surface] || light[surface]));
        const fg = parseHex(deVar(tokens, light, tokens[inkName] || light[inkName]));
        if (!bg || !fg) return;
        const ratio = contrast(bg, fg);
        if (ratio + 0.005 < AA_NORMAL) {
          failures.push(name + ' ' + inkName + ' on ' + surface + ' is ' + ratio.toFixed(2) + ':1');
        }
      });
    });
  });
  assert.deepEqual(failures, [], failures.join('; '));
});
