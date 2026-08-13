#!/usr/bin/env node
/* ==========================================================================
   Zero Cost AI Dating — matching engine benchmark
   Measures what a page actually pays to build a deck: ZC.matching.buildCorpus
   over the candidate pool, ZC.matching.rankCandidates against a prebuilt
   corpus, and the two back to back the way dashboard.js does them on load.
   Node is dev-only: this script never runs in production.

     node scripts/bench-matching.js                 the default ladder
     node scripts/bench-matching.js --sizes=60,500  measure those sizes
     node scripts/bench-matching.js --json          machine-readable output
     node scripts/bench-matching.js --seed=0x1234   a different synthetic pool

   The candidate pool is synthesised from a seeded PRNG (never Math.random),
   so two runs on one machine measure the same work: same bios, same tags,
   same coordinates, same activity spread. Bios are spliced out of the real
   seed/profiles.json corpus, which keeps word lengths and vocabulary honest —
   the one thing it understates is vocabulary *breadth*, since 10,000 spliced
   bios can only ever contain the words 32 real ones used. That inflates
   nothing in the per-candidate cost, which is where the time goes.

   The pool is also generated to clear the hard filters: a candidate that
   fails one costs almost nothing, so a pool full of them would measure the
   early-out rather than the scoring path. The table prints how many of each
   pool actually scored so the numbers cannot flatter themselves quietly.
   ========================================================================== */
'use strict';

const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------------
   1. Paths and the engine under test
   ------------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'seed', 'profiles.json');

// Load order matters: seed-data.js publishes ZC.INTEREST_BY_SLUG on the
// global, which is exactly how the engine finds the tag table in the browser.
// Requiring it first means the benchmark exercises the same lookup path a
// page does, rather than the fallback one.
const seed = require(SEED_PATH);
require(path.join(ROOT, 'public', 'js', 'seed-data.js'));
const matching = require(path.join(ROOT, 'public', 'js', 'matching-engine.js'));

const DEFAULT_SIZES = [32, 100, 500, 2000, 10000];

// Fixed clock and PRNG seed: the whole point is that a re-run reproduces its
// own numbers, so nothing in here may read the wall clock or Math.random.
const NOW = '2026-08-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const PRNG_SEED = 0x5eed5eed;

/* ------------------------------------------------------------------------
   2. Seeded randomness
   ------------------------------------------------------------------------ */

/**
 * mulberry32 — a 32-bit PRNG small enough to read in one sitting and stable
 * across Node versions, which `Math.random` explicitly is not.
 * @param {number} seedValue any 32-bit integer
 * @returns {function(): number} generator of floats in [0, 1)
 */
function makeRandom(seedValue) {
  let a = seedValue >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Integer in [lo, hi] inclusive.
 * @param {function(): number} random generator
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number}
 */
function intBetween(random, lo, hi) {
  return lo + Math.floor(random() * (hi - lo + 1));
}

/**
 * One element of a list.
 * @param {function(): number} random generator
 * @param {Array} list non-empty list
 * @returns {*}
 */
function pick(random, list) {
  return list[Math.floor(random() * list.length)];
}

/* ------------------------------------------------------------------------
   3. Synthesising a realistic candidate pool
   ------------------------------------------------------------------------ */

// Word runs are spliced from the real bios, so a generated bio reads like
// nonsense but tokenises like the real thing: same vocabulary, same
// contractions and proper nouns, same rough length.
const BIO_WORDS = seed.profiles.map(function (profile) {
  return String(profile.profile.bio).split(/\s+/).filter(Boolean);
});
const BIO_LENGTHS = seed.profiles.map(function (profile) {
  return String(profile.profile.bio).length;
});
const MIN_BIO_CHARS = Math.min.apply(null, BIO_LENGTHS);
const MAX_BIO_CHARS = Math.max.apply(null, BIO_LENGTHS);

const TAG_SLUGS = seed.interests.map(function (tag) { return tag.slug; });
const GENDERS = ['woman', 'man', 'nonbinary'];
const ME_GENDER = 'woman';
const ME_AGE = 31;

// A single metro area, because that is the shape a discovery page returns:
// listCandidates walks people near you, not the whole planet. Anchors are
// real coordinates from the seed; candidates are jittered around them.
const ANCHORS = [
  { label: 'Portland, OR', lat: 45.5152, lng: -122.6784 },
  { label: 'Vancouver, WA', lat: 45.6387, lng: -122.6615 },
  { label: 'Beaverton, OR', lat: 45.4871, lng: -122.8037 }
];
const JITTER_DEG = 0.18; // ~20 km at this latitude

/**
 * Splice a bio out of the real corpus: contiguous runs of 5-11 words taken
 * from real bios, concatenated until the text is as long as a real one.
 * @param {function(): number} random generator
 * @returns {string} a bio of comparable length and vocabulary to the seed
 */
function makeBio(random) {
  const target = intBetween(random, MIN_BIO_CHARS, MAX_BIO_CHARS);
  const parts = [];
  let length = 0;
  while (length < target) {
    const source = pick(random, BIO_WORDS);
    const runLength = intBetween(random, 5, 11);
    const start = intBetween(random, 0, Math.max(0, source.length - runLength));
    const run = source.slice(start, start + runLength).join(' ');
    parts.push(run);
    length += run.length + 1;
  }
  const text = parts.join(' ').slice(0, target).replace(/[\s,.;:!?]+$/, '');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/**
 * 4-9 distinct interest slugs drawn from the real 48-tag table.
 * @param {function(): number} random generator
 * @returns {string[]}
 */
function makeInterests(random) {
  const count = intBetween(random, 4, 9);
  const chosen = [];
  const seen = Object.create(null);
  while (chosen.length < count) {
    const slug = pick(random, TAG_SLUGS);
    if (seen[slug]) continue;
    seen[slug] = true;
    chosen.push(slug);
  }
  return chosen;
}

/**
 * A full five-axis personality vector in the range the profile editor emits.
 * @param {function(): number} random generator
 * @returns {Object<string, number>}
 */
function makePersonality(random) {
  return {
    openness: intBetween(random, 20, 95),
    conscientiousness: intBetween(random, 20, 95),
    extraversion: intBetween(random, 20, 95),
    agreeableness: intBetween(random, 25, 95),
    stability: intBetween(random, 20, 95)
  };
}

/**
 * Last-seen timestamp, cubed towards "recently" — most people in a live deck
 * were active today, a long tail was not.
 * @param {function(): number} random generator
 * @returns {string} ISO timestamp before NOW
 */
function makeLastActive(random) {
  const r = random();
  const hoursAgo = Math.round(r * r * r * 720);
  return new Date(NOW_MS - hoursAgo * 3600000).toISOString();
}

/**
 * One synthetic candidate.
 * @param {function(): number} random generator
 * @param {number} i index, used for a stable uid
 * @returns {Object} a UserDoc shaped like the ones data-store.js returns
 */
function makeCandidate(random, i) {
  const anchor = pick(random, ANCHORS);
  const age = intBetween(random, 23, 44);
  return {
    uid: 'bench-' + String(i).padStart(6, '0'),
    displayName: 'Bench ' + i,
    profileComplete: true,
    plan: random() < 0.15 ? 'premium' : 'free',
    lastActiveAt: makeLastActive(random),
    blocked: [],
    profile: {
      age: age,
      // Every candidate is open to ME's gender and vice versa: the gender and
      // age filters are cheap early-outs, and a pool that trips them would
      // measure nothing.
      gender: pick(random, GENDERS),
      bio: makeBio(random),
      interests: makeInterests(random),
      personality: makePersonality(random),
      location: {
        label: anchor.label,
        lat: anchor.lat + (random() - 0.5) * JITTER_DEG,
        lng: anchor.lng + (random() - 0.5) * JITTER_DEG
      }
    },
    preferences: {
      interestedIn: [ME_GENDER].concat(GENDERS.filter(function (g) {
        return g !== ME_GENDER && random() < 0.4;
      })),
      ageMin: Math.min(age - intBetween(random, 2, 8), ME_AGE),
      ageMax: Math.max(age + intBetween(random, 4, 12), ME_AGE),
      maxDistanceKm: pick(random, [40, 60, 80, 120, 200]),
      discoverable: true
    }
  };
}

/**
 * The account doing the searching: deliberately wide preferences, a real bio
 * and a full tag list, sitting in the middle of the metro.
 * @returns {Object} a UserDoc
 */
function makeMe() {
  const me = seed.profiles[0];
  return {
    uid: 'bench-me',
    displayName: 'Bench Me',
    profileComplete: true,
    plan: 'free',
    lastActiveAt: NOW,
    blocked: [],
    profile: {
      age: ME_AGE,
      gender: ME_GENDER,
      bio: me.profile.bio,
      interests: me.profile.interests.slice(),
      personality: Object.assign({}, me.profile.personality),
      location: { label: 'Portland, OR', lat: 45.5152, lng: -122.6784 }
    },
    preferences: {
      interestedIn: [],
      ageMin: 18,
      ageMax: 99,
      maxDistanceKm: 200,
      discoverable: true
    }
  };
}

/**
 * Generate `count` candidates from one seeded stream, so the pool for size N
 * is the first N of the pool for any larger size and the ladder compares like
 * with like.
 * @param {number} count how many to generate
 * @param {number} [seed=PRNG_SEED] PRNG seed, so a run can compare pools
 * @returns {Object[]} UserDocs
 */
function makePool(count, seed) {
  const random = makeRandom(seed === undefined ? PRNG_SEED : seed);
  const pool = new Array(count);
  for (let i = 0; i < count; i++) pool[i] = makeCandidate(random, i);
  return pool;
}

/* ------------------------------------------------------------------------
   4. Timing
   ------------------------------------------------------------------------ */

/**
 * Time one call in milliseconds.
 * @param {function(): *} fn the work to measure
 * @returns {{ms: number, value: *}} elapsed time and whatever fn returned
 */
function timed(fn) {
  const start = process.hrtime.bigint();
  const value = fn();
  const end = process.hrtime.bigint();
  return { ms: Number(end - start) / 1e6, value: value };
}

/**
 * Median of a list of numbers (mean of the middle two when even).
 * @param {number[]} values at least one number
 * @returns {number}
 */
function median(values) {
  const sorted = values.slice().sort(function (a, b) { return a - b; });
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * How many timed repetitions a size gets. Small pools are noisy and cheap, so
 * they get many; 10,000 candidates is neither, so it gets few.
 * @param {number} size candidate count
 * @returns {number} repetitions, at least 5
 */
function repsFor(size) {
  return Math.max(5, Math.min(50, Math.round(20000 / size)));
}

/**
 * Measure one candidate count.
 * @param {Object} me the searching account
 * @param {Object[]} pool candidates (already the right length)
 * @returns {Object} one row of the report
 */
function measure(me, pool) {
  const reps = repsFor(pool.length);
  const rankOpts = { now: NOW, adaptive: false };

  // One full untimed round first: it pays for the lazy compilation and the
  // first-touch page faults that would otherwise land in run 1. Its results
  // are also what the report's "scored" and vocabulary columns count.
  const warmCorpus = matching.buildCorpus(pool.concat([me]));
  const warmRanked = matching.rankCandidates(me, pool, Object.assign({ corpus: warmCorpus }, rankOpts));

  const corpusRuns = [];
  const rankRuns = [];
  const bothRuns = [];

  for (let i = 0; i < reps; i++) {
    corpusRuns.push(timed(function () {
      return matching.buildCorpus(pool.concat([me]));
    }).ms);
  }

  const corpus = matching.buildCorpus(pool.concat([me]));
  for (let i = 0; i < reps; i++) {
    rankRuns.push(timed(function () {
      return matching.rankCandidates(me, pool, Object.assign({ corpus: corpus }, rankOpts));
    }).ms);
  }

  // The page's actual unit of work: corpus then ranking, nothing cached.
  for (let i = 0; i < reps; i++) {
    bothRuns.push(timed(function () {
      const built = matching.buildCorpus(pool.concat([me]));
      return matching.rankCandidates(me, pool, Object.assign({ corpus: built }, rankOpts));
    }).ms);
  }

  const both = median(bothRuns);
  return {
    candidates: pool.length,
    reps: reps,
    scored: warmRanked.length,
    vocabulary: Object.keys(warmCorpus.idf).length,
    buildCorpusMs: median(corpusRuns),
    rankCandidatesMs: median(rankRuns),
    bothMs: both,
    usPerCandidate: (both * 1000) / pool.length
  };
}

/* ------------------------------------------------------------------------
   5. Reporting
   ------------------------------------------------------------------------ */

/**
 * Right-align a value in a column.
 * @param {string|number} value cell contents
 * @param {number} width column width
 * @returns {string}
 */
function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/**
 * Format a duration with a sensible number of decimals for its magnitude.
 * @param {number} value milliseconds
 * @returns {string}
 */
function ms(value) {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

const COLUMNS = [
  { head: 'candidates', width: 10, cell: function (r) { return r.candidates; } },
  { head: 'buildCorpus', width: 14, cell: function (r) { return ms(r.buildCorpusMs) + ' ms'; } },
  { head: 'rankCandidates', width: 17, cell: function (r) { return ms(r.rankCandidatesMs) + ' ms'; } },
  { head: 'both', width: 12, cell: function (r) { return ms(r.bothMs) + ' ms'; } },
  { head: 'µs/candidate', width: 14, cell: function (r) { return r.usPerCandidate.toFixed(1); } },
  { head: 'scored', width: 14, cell: function (r) { return r.scored + '/' + r.candidates; } },
  { head: 'runs', width: 7, cell: function (r) { return r.reps; } }
];

/**
 * Print the human-readable report.
 * @param {Object[]} rows measurement rows
 * @param {Object} machine the environment the numbers came from
 * @returns {void}
 */
function printTable(rows, machine) {
  console.log('[bench-matching] ' + machine.cpu + ' × ' + machine.cores +
    ', Node ' + machine.node + ' on ' + machine.platform + '/' + machine.arch + '.');
  console.log('[bench-matching] median of the timed runs, one warm-up round discarded.');
  console.log('');
  console.log('  ' + COLUMNS.map(function (col) { return pad(col.head, col.width); }).join(''));
  console.log('  ' + COLUMNS.map(function (col) { return pad('-'.repeat(col.width - 1), col.width); }).join(''));
  rows.forEach(function (row) {
    console.log('  ' + COLUMNS.map(function (col) { return pad(col.cell(row), col.width); }).join(''));
  });
  console.log('');
  console.log('[bench-matching] "both" is the page\'s unit of work: buildCorpus then');
  console.log('[bench-matching] rankCandidates, the way dashboard.js does it on load.');
}

/* ------------------------------------------------------------------------
   6. CLI
   ------------------------------------------------------------------------ */

/**
 * Read --sizes=... off the command line.
 * @param {string[]} argv raw process arguments (process.argv.slice(2))
 * @returns {number[]} candidate counts, ascending
 * @throws {Error} when the flag is present but not a list of positive integers
 */
function parseSizes(argv) {
  const flag = argv.filter(function (arg) { return arg.indexOf('--sizes=') === 0; }).pop();
  if (flag === undefined) return DEFAULT_SIZES.slice();

  const sizes = flag.slice('--sizes='.length).split(',').map(function (part) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1) {
      throw new Error('--sizes wants a comma-separated list of positive integers, got ' + JSON.stringify(part));
    }
    return n;
  });
  if (!sizes.length) throw new Error('--sizes needs at least one size');
  return sizes.sort(function (a, b) { return a - b; });
}

/**
 * Read --seed=... off the command line. A fixed seed is what makes a run
 * reproducible, but pinning only one would measure a single synthetic pool
 * forever: changing it re-rolls every bio, tag set and coordinate, which is
 * how you check that a timing is a property of the engine rather than of one
 * lucky pool.
 * @param {string[]} argv raw process arguments (process.argv.slice(2))
 * @returns {number} the PRNG seed to synthesise the pool with
 * @throws {Error} when the flag is present but not a non-negative integer
 */
function parseSeed(argv) {
  const flag = argv.filter(function (arg) { return arg.indexOf('--seed=') === 0; }).pop();
  if (flag === undefined) return PRNG_SEED;

  const raw = flag.slice('--seed='.length).trim();
  // Accept 0x… so the default in this file can be pasted back in verbatim.
  const n = /^0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('--seed wants a non-negative integer, got ' + JSON.stringify(raw));
  }
  return n;
}

/**
 * Entry point: measure every requested size and report.
 * @param {string[]} argv raw process arguments (process.argv.slice(2))
 * @returns {number} process exit code
 */
function main(argv) {
  const json = argv.indexOf('--json') !== -1;
  let sizes;
  let seed;
  try {
    sizes = parseSizes(argv);
    seed = parseSeed(argv);
  } catch (err) {
    console.error('[bench-matching] ' + err.message);
    return 1;
  }

  const me = makeMe();
  // One pool, sliced: size N is always the first N candidates of the biggest
  // pool, so a row differs from the row above it only in how many there are.
  const pool = makePool(Math.max.apply(null, sizes), seed);
  const rows = sizes.map(function (size) { return measure(me, pool.slice(0, size)); });

  const machine = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: (os.cpus()[0] || {}).model || 'unknown CPU',
    cores: os.cpus().length
  };

  if (json) {
    console.log(JSON.stringify({
      engine: matching.VERSION,
      machine: machine,
      seed: seed,
      now: NOW,
      results: rows
    }, null, 2));
    return 0;
  }

  printTable(rows, machine);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  makeRandom: makeRandom,
  makePool: makePool,
  makeMe: makeMe,
  measure: measure,
  main: main
};
