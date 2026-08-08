#!/usr/bin/env node
/* ==========================================================================
   Zero Cost AI Dating — seed bundler
   Turns the hand-authored seed/profiles.json into public/js/seed-data.js, the
   classic script the browser loads (there is no bundler at runtime, so the
   data has to ship as plain JS). Node is dev-only: this script never runs in
   production.

     node scripts/build-seed.js            regenerate public/js/seed-data.js
     node scripts/build-seed.js --check    exit 1 if the generated file drifted

   The rendering is deterministic — same JSON in, byte-identical JS out — which
   is what lets `--check` (and tests/seed.test.js) detect a stale bundle.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------------
   1. Paths
   ------------------------------------------------------------------------ */

const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'seed', 'profiles.json');
const OUT_PATH = path.join(ROOT, 'public', 'js', 'seed-data.js');

/* ------------------------------------------------------------------------
   2. Reading and checking the source of truth
   ------------------------------------------------------------------------ */

/**
 * Read and parse seed/profiles.json.
 * @param {string} [file=SEED_PATH] path to the seed JSON
 * @returns {{version:number, ageAsOf:string, interests:Object[], profiles:Object[],
 *   inboundLikes:Object[]|undefined, conversations:Object[]|undefined}} parsed seed
 * @throws {Error} when the file is missing, unparseable or structurally wrong
 */
function readSeed(file) {
  const target = file || SEED_PATH;
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    throw new Error('cannot read ' + path.relative(ROOT, target) + ': ' + err.message);
  }

  let seed;
  try {
    seed = JSON.parse(raw);
  } catch (err) {
    throw new Error(path.relative(ROOT, target) + ' is not valid JSON: ' + err.message);
  }

  assertShape(seed, path.relative(ROOT, target));
  assertRelationships(seed, path.relative(ROOT, target));
  return seed;
}

/**
 * Guard the handful of invariants the renderer itself depends on. Deep schema
 * validation is the job of tests/seed.test.js; this only stops the generator
 * from emitting nonsense.
 * @param {Object} seed parsed seed document
 * @param {string} label file name used in error messages
 * @returns {void}
 */
function assertShape(seed, label) {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    throw new Error(label + ' must be a JSON object');
  }
  if (!Number.isInteger(seed.version)) {
    throw new Error(label + ' is missing an integer "version"');
  }
  if (!Array.isArray(seed.interests) || !seed.interests.length) {
    throw new Error(label + ' is missing a non-empty "interests" array');
  }
  if (!Array.isArray(seed.profiles) || !seed.profiles.length) {
    throw new Error(label + ' is missing a non-empty "profiles" array');
  }
  seed.interests.forEach(function (tag, i) {
    if (!tag || typeof tag.slug !== 'string' || !tag.slug) {
      throw new Error(label + ': interests[' + i + '] has no slug');
    }
  });
  seed.profiles.forEach(function (profile, i) {
    if (!profile || typeof profile.uid !== 'string' || !profile.uid) {
      throw new Error(label + ': profiles[' + i + '] has no uid');
    }
  });
}

/**
 * Check one "hours before seed time" offset.
 * @param {*} value candidate offset
 * @param {string} where dotted path used in the error message
 * @param {string} label file name used in error messages
 * @returns {void}
 * @throws {Error} when the offset is not a finite number >= 0
 */
function assertOffset(value, where, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(label + ': ' + where + ' must be a finite number of hours >= 0');
  }
}

/**
 * Check that a relationship points at a real seeded person who is not the demo
 * account itself — every relationship in the file is *between* demo-you and
 * somebody else, so a self-reference would seed a swipe from demo-you to
 * demo-you.
 * @param {Object} known set of uids present in "profiles", as a lookup map
 * @param {*} uid candidate uid
 * @param {string} where dotted path used in the error message
 * @param {string} label file name used in error messages
 * @returns {void}
 * @throws {Error} when the uid is unknown or is 'demo-you'
 */
function assertPartner(known, uid, where, label) {
  if (typeof uid !== 'string' || !known[uid]) {
    throw new Error(label + ': ' + where + ' references unknown uid ' + JSON.stringify(uid));
  }
  if (uid === 'demo-you') {
    throw new Error(label + ': ' + where + ' must name somebody other than demo-you');
  }
}

/**
 * Validate the optional demo relationship arrays. They are what turns the
 * bundled cast into a demo with inbound likes, a match and a live chat, so a
 * dangling uid here would seed a swipe or a message nobody can render. An older
 * seed file that predates them still builds — both arrays default to empty.
 * @param {Object} seed parsed seed document
 * @param {string} label file name used in error messages
 * @returns {void}
 * @throws {Error} on a bad shape, an unknown or self-referencing uid, a bad
 *   offset, a message from a non-participant, or messages that are not ordered
 *   oldest-first
 */
function assertRelationships(seed, label) {
  if (seed.inboundLikes !== undefined && !Array.isArray(seed.inboundLikes)) {
    throw new Error(label + ': "inboundLikes" must be an array when present');
  }
  if (seed.conversations !== undefined && !Array.isArray(seed.conversations)) {
    throw new Error(label + ': "conversations" must be an array when present');
  }

  const known = {};
  seed.profiles.forEach(function (profile) { known[profile.uid] = true; });

  (seed.inboundLikes || []).forEach(function (like, i) {
    const where = 'inboundLikes[' + i + ']';
    if (!like || typeof like !== 'object') throw new Error(label + ': ' + where + ' must be an object');
    assertPartner(known, like.from, where + '.from', label);
    if (like.action !== 'like' && like.action !== 'super') {
      throw new Error(label + ': ' + where + '.action must be "like" or "super"');
    }
    assertOffset(like.offsetHours, where + '.offsetHours', label);
  });

  (seed.conversations || []).forEach(function (conversation, i) {
    const where = 'conversations[' + i + ']';
    if (!conversation || typeof conversation !== 'object') {
      throw new Error(label + ': ' + where + ' must be an object');
    }
    assertPartner(known, conversation.with, where + '.with', label);
    assertOffset(conversation.matchedOffsetHours, where + '.matchedOffsetHours', label);
    if (!Array.isArray(conversation.messages)) {
      throw new Error(label + ': ' + where + '.messages must be an array');
    }

    // Messages are stored oldest first, so their offsets count strictly down.
    let previous = Infinity;
    conversation.messages.forEach(function (message, j) {
      const at = where + '.messages[' + j + ']';
      if (!message || typeof message !== 'object') throw new Error(label + ': ' + at + ' must be an object');
      if (message.from !== 'demo-you' && message.from !== conversation.with) {
        throw new Error(label + ': ' + at + '.from must be "demo-you" or "' + conversation.with + '"');
      }
      if (typeof message.text !== 'string' || !message.text.length || message.text.length > 1000) {
        throw new Error(label + ': ' + at + '.text must be a string of 1-1000 characters');
      }
      assertOffset(message.offsetHours, at + '.offsetHours', label);
      if (message.offsetHours > conversation.matchedOffsetHours) {
        throw new Error(label + ': ' + at + '.offsetHours predates the match');
      }
      if (message.offsetHours >= previous) {
        throw new Error(label + ': ' + at + '.offsetHours must be smaller than the message before it');
      }
      previous = message.offsetHours;
    });
  });
}

/* ------------------------------------------------------------------------
   3. Formatting helpers
   ------------------------------------------------------------------------ */

/**
 * Render a flat object on a single line, preserving key order.
 * @param {Object} obj object with JSON-safe scalar values
 * @returns {string} e.g. `{ "slug": "hiking", "label": "Hiking" }`
 */
function inlineObject(obj) {
  const pairs = Object.keys(obj).map(function (key) {
    return JSON.stringify(key) + ': ' + JSON.stringify(obj[key]);
  });
  return '{ ' + pairs.join(', ') + ' }';
}

/**
 * Indent every line of a block by `spaces` columns.
 * @param {string} text multi-line text
 * @param {number} spaces indent width
 * @returns {string} indented text
 */
function indentBlock(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(function (line) {
    return line ? pad + line : line;
  }).join('\n');
}

/**
 * Render a `const NAME = [ … ];` declaration, collapsing the empty case onto
 * one line so an absent optional array does not emit a blank body.
 * @param {string} name binding name
 * @param {string} body pre-rendered, pre-indented element list ('' when empty)
 * @returns {string[]} lines to splice into the output
 */
function arrayDecl(name, body) {
  if (!body) return ['  const ' + name + ' = [];'];
  return ['  const ' + name + ' = [', body, '  ];'];
}

/* ------------------------------------------------------------------------
   4. Rendering public/js/seed-data.js
   ------------------------------------------------------------------------ */

/**
 * Render the generated browser bundle for a parsed seed document.
 * @param {Object} seed parsed seed/profiles.json
 * @returns {string} full contents of public/js/seed-data.js (ends with a newline)
 */
function render(seed) {
  const inboundLikes = seed.inboundLikes || [];
  const conversations = seed.conversations || [];

  const tagLines = seed.interests.map(function (tag) {
    return '    ' + inlineObject(tag);
  }).join(',\n');

  const profileBlocks = seed.profiles.map(function (profile) {
    return indentBlock(JSON.stringify(profile, null, 2), 4);
  }).join(',\n');

  const likeLines = inboundLikes.map(function (like) {
    return '    ' + inlineObject(like);
  }).join(',\n');

  const conversationBlocks = conversations.map(function (conversation) {
    return indentBlock(JSON.stringify(conversation, null, 2), 4);
  }).join(',\n');

  const lines = [
    '/* ==========================================================================',
    '   Zero Cost AI Dating — bundled seed data',
    '   GENERATED FILE — DO NOT EDIT BY HAND.',
    '   Source: seed/profiles.json (version ' + seed.version + ', ' +
      seed.interests.length + ' interest tags, ' + seed.profiles.length + ' profiles,',
    '   ' + inboundLikes.length + ' inbound likes, ' + conversations.length + ' conversations).',
    '   Regenerate with `npm run build:seed`; `npm run check:seed` fails when this',
    '   file has drifted from the JSON.',
    '',
    '   Every person in here is fictional. Nothing carries a timestamp: profiles',
    '   carry `lastActiveOffsetHours` and the relationships carry `offsetHours`,',
    '   both counted back from seed time, so the demo never looks abandoned.',
    '   ZC.store turns the offsets into real ISO dates when it seeds.',
    '   Exposes: ZC.SEED_VERSION, ZC.INTEREST_TAGS, ZC.INTEREST_BY_SLUG,',
    '   ZC.SEED_PROFILES, ZC.SEED_INBOUND_LIKES, ZC.SEED_CONVERSATIONS (and the',
    '   same object via module.exports under Node).',
    '   ========================================================================== */',
    '(function (root, factory) {',
    "  'use strict';",
    '',
    '  const api = factory();',
    "  if (typeof module === 'object' && module.exports) module.exports = api;",
    '  root.ZC = root.ZC || {};',
    '  root.ZC.SEED_VERSION = api.SEED_VERSION;',
    '  root.ZC.INTEREST_TAGS = api.INTEREST_TAGS;',
    '  root.ZC.INTEREST_BY_SLUG = api.INTEREST_BY_SLUG;',
    '  root.ZC.SEED_PROFILES = api.SEED_PROFILES;',
    '  root.ZC.SEED_INBOUND_LIKES = api.SEED_INBOUND_LIKES;',
    '  root.ZC.SEED_CONVERSATIONS = api.SEED_CONVERSATIONS;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this, function () {",
    "  'use strict';",
    '',
    '  // The canonical interest table: ' + seed.interests.length + ' tags across ' +
      countCategories(seed.interests) + ' categories.',
    '  // The slug is the stable identifier everything else keys off; label and',
    '  // emoji are display-only.',
    ...arrayDecl('INTEREST_TAGS', tagLines),
    '',
    '  // Slug -> tag lookup, built once so callers never scan the array.',
    '  const INTEREST_BY_SLUG = INTEREST_TAGS.reduce(function (map, tag) {',
    '    map[tag.slug] = tag;',
    '    return map;',
    '  }, {});',
    '',
    '  // The bundled demo cast. `demo-you` is first: it is the account',
    '  // ZC.auth.signInAsDemoUser() signs into.',
    ...arrayDecl('SEED_PROFILES', profileBlocks),
    '',
    '  // People who already swiped right on demo-you. Seeding these is what makes',
    '  // the premium "Who liked you" list real and puts a match one swipe away.',
    ...arrayDecl('SEED_INBOUND_LIKES', likeLines),
    '',
    '  // Matches demo-you already has: one with history, one still empty so the',
    '  // "no messages yet" state and its icebreakers are reachable on first run.',
    ...arrayDecl('SEED_CONVERSATIONS', conversationBlocks),
    '',
    '  return {',
    '    SEED_VERSION: ' + JSON.stringify(seed.version) + ',',
    '    INTEREST_TAGS: INTEREST_TAGS,',
    '    INTEREST_BY_SLUG: INTEREST_BY_SLUG,',
    '    SEED_PROFILES: SEED_PROFILES,',
    '    SEED_INBOUND_LIKES: SEED_INBOUND_LIKES,',
    '    SEED_CONVERSATIONS: SEED_CONVERSATIONS',
    '  };',
    '});',
    ''
  ];

  return lines.join('\n');
}

/**
 * Count the distinct categories in a tag table.
 * @param {Object[]} tags interest tags
 * @returns {number} number of distinct categories
 */
function countCategories(tags) {
  const seen = {};
  tags.forEach(function (tag) { seen[tag.category] = true; });
  return Object.keys(seen).length;
}

/* ------------------------------------------------------------------------
   5. CLI
   ------------------------------------------------------------------------ */

/**
 * Read the currently generated bundle, if any.
 * @param {string} file path to the generated file
 * @returns {string|null} file contents, or null when it does not exist
 */
function readCurrent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Entry point: regenerate the bundle, or verify it is up to date.
 * @param {string[]} argv raw process arguments (process.argv.slice(2))
 * @returns {number} process exit code
 */
function main(argv) {
  const check = argv.indexOf('--check') !== -1;
  let seed;
  try {
    seed = readSeed();
  } catch (err) {
    console.error('[build-seed] ' + err.message);
    return 1;
  }

  const expected = render(seed);
  const relative = path.relative(ROOT, OUT_PATH);
  const current = readCurrent(OUT_PATH);

  // --check never writes: it is the CI guard against a stale bundle.
  if (check) {
    if (current === null) {
      console.error('[build-seed] ' + relative + ' is missing — run `npm run build:seed`.');
      return 1;
    }
    if (current !== expected) {
      console.error('[build-seed] ' + relative + ' is out of date — run `npm run build:seed`.');
      return 1;
    }
    console.log('[build-seed] ' + relative + ' is up to date.');
    return 0;
  }

  if (current === expected) {
    console.log('[build-seed] ' + relative + ' already up to date.');
    return 0;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, expected, 'utf8');
  console.log('[build-seed] wrote ' + relative + ' (' + seed.interests.length +
    ' tags, ' + seed.profiles.length + ' profiles, ' + (seed.inboundLikes || []).length +
    ' inbound likes, ' + (seed.conversations || []).length + ' conversations).');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  SEED_PATH: SEED_PATH,
  OUT_PATH: OUT_PATH,
  readSeed: readSeed,
  render: render,
  main: main
};
