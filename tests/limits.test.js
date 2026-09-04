/* ==========================================================================
   Zero Cost AI Dating — the form's limits and the server's limits are one set

   Every bound in this project is written down twice. `public/js/profile.js`
   enforces it while you type, with a message naming the limit; `firestore.rules`
   enforces it on the write, because a client-side limit is a courtesy and not a
   control. Neither copy knows about the other.

   Drift between them has two shapes and only one of them is loud.

   If the *rules* tighten below the form, the form accepts a profile and the save
   comes back `permission-denied` with nothing to point at — the failure this
   project already had once, when the projection wrote `lastActiveAt: null` and
   the rules accepted that key only as a string. The user sees "could not save"
   and has no way to find out which field.

   If the *form* tightens below the rules, nothing breaks. That is the quiet one:
   the form is now the only thing enforcing a limit the rules would have caught,
   and a tampered client is under no obligation to run it.

   So this file reads the two files and compares them. The form's limit must
   never exceed the rule's, and where the rule's cap is *derived* from the form's
   — six photo links at the length the form allows — the two must be equal, or
   the derivation has quietly stopped being one.
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EDITOR = fs.readFileSync(path.join(ROOT, 'public/js/profile.js'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

/**
 * `firestore.rules` with its comments blanked, keeping line structure.
 *
 * The coverage check below asks whether a key is mentioned anywhere in its
 * validator, and a comment is not a validator. Deleting a rule and leaving
 * `// TODO: validate 'personality' here.` behind is the likeliest shape a real
 * edit takes, and against the raw text that reads as covered — verified, not
 * assumed: the check passed with the validator gone and the comment in place.
 *
 * `tests/injection.test.js` blanks comments for the same reason, so a sink named
 * in prose is not mistaken for one in use. This file has no block comments and
 * no string literal containing `//`, both asserted below, so a line-comment strip
 * is sound here and would stop being sound quietly otherwise.
 */
const RULES_CODE = (function () {
  assert.equal(RULES.indexOf('/*'), -1,
    'firestore.rules has gained a block comment; this strip only handles line ' +
    'comments and would leave prose in the text the coverage check scans');
  return RULES.split('\n').map(function (line) {
    // Quote-aware, so a `//` inside a string literal is code and stays.
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") quoted = !quoted;
      else if (!quoted && line[i] === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}());

/**
 * A numeric `const NAME = 123;` from the profile editor.
 * @param {string} name the constant's name
 * @returns {number} its value
 */
function editorConst(name) {
  // Anchored to the start of a line so a commented-out constant — `// const BIO_MAX = 600;`
  // left behind by an edit — is not read as the live one.
  const found = new RegExp('^\\s*const ' + name + ' = (\\d+);', 'm').exec(EDITOR);
  assert.ok(found, 'public/js/profile.js has no `const ' + name + ' = <number>;` — ' +
    'this test is comparing nothing. If the constant was renamed, rename it here too.');
  return Number(found[1]);
}

/**
 * Every number a pattern captures out of firestore.rules, asserted to agree.
 *
 * The bounds live twice over in that file — once for the private `users/{uid}`
 * document and once for the world-readable `discovery/{uid}` projection, because
 * a rules function cannot cross a `match` block. Two copies that disagree is a
 * real failure mode here and not a hypothetical: the projection's key list and
 * the private document's have drifted before.
 *
 * @param {string} what a human name for the bound, used in failure messages
 * @param {RegExp} pattern global, with the number as group 1
 * @param {number} expectCopies how many times it must appear
 * @returns {number} the agreed value
 */
function ruleCap(what, pattern, expectCopies) {
  // RULES_CODE, not RULES. A bound deleted from the rule and left behind in a comment
  // explaining the deletion still counts against the raw text — and this file's comments
  // quote rule expressions verbatim all the time, so that is the ordinary shape of an
  // edit here rather than an exotic one. The check two tests down was fixed for exactly
  // this and these two were left scanning prose.
  const found = [...RULES_CODE.matchAll(pattern)].map(function (m) { return Number(m[1]); });
  assert.equal(found.length, expectCopies,
    'expected ' + expectCopies + ' copies of the ' + what + ' bound in firestore.rules, found ' +
    found.length + '. Either a rule was removed, or its text changed and this pattern no ' +
    'longer finds it — which would leave this test silently checking less than it says.');
  assert.equal(new Set(found).size, 1,
    'firestore.rules states the ' + what + ' bound as ' + JSON.stringify(found) + '. The private ' +
    'document and the public projection have to agree, or a profile that saves privately ' +
    'cannot be published — or, worse, the public copy is the looser of the two.');
  return found[0];
}

test('no limit the profile editor accepts is one firestore.rules refuses', function () {
  const pairs = [
    {
      what: 'bio length',
      editor: editorConst('BIO_MAX'),
      rule: ruleCap('bio length', /p\.bio is string && p\.bio\.size\(\) <= (\d+)/g, 2)
    },
    {
      what: 'pronoun length',
      editor: editorConst('PRONOUN_MAX'),
      rule: ruleCap('pronoun length', /p\.pronouns is string && p\.pronouns\.size\(\) <= (\d+)/g, 2)
    },
    {
      what: 'interest count',
      editor: editorConst('MAX_INTERESTS'),
      rule: ruleCap('interest count', /p\.interests is list && p\.interests\.size\(\) <= (\d+)/g, 2)
    },
    {
      what: 'photo count',
      editor: editorConst('MAX_PHOTOS'),
      rule: ruleCap('photo count', /p\.photos is list && p\.photos\.size\(\) <= (\d+)/g, 2)
    },
    {
      what: 'location label length',
      editor: editorConst('LABEL_MAX'),
      rule: ruleCap('location label length', /loc\.label is string && loc\.label\.size\(\) <= (\d+)/g, 2)
    },
    {
      what: 'oldest age',
      editor: editorConst('MAX_AGE'),
      rule: ruleCap('oldest age', /p\.age is number && p\.age >= 18 && p\.age <= (\d+)/g, 2)
    }
  ];

  const wrong = pairs.filter(function (p) { return p.editor > p.rule; });
  assert.deepEqual(wrong.map(function (p) { return p.what; }), [],
    wrong.map(function (p) {
      return 'public/js/profile.js accepts a ' + p.what + ' of ' + p.editor +
        ', which firestore.rules caps at ' + p.rule + ' — every save at that size is ' +
        'refused, and the message the user gets says "permission", not which field.';
    }).join('\n'));
});

test('the photo-link cap in the rules is exactly six of what the editor allows', function () {
  // This one is a derivation rather than a comparison, and it is the reason
  // MAX_PHOTO_URL exists at all. Rules cannot walk a list, so the photo bound is
  // written against the whole list joined — six links' worth of characters, in
  // whatever proportion. The editor is what makes that a limit a person can see:
  // it refuses one over-long link while they are pasting it, with the number in
  // the message, instead of letting six of them add up to a refusal at save time.
  //
  // If either number moves alone the two stop describing the same limit: raise
  // MAX_PHOTO_URL and six legal links no longer fit; lower it and the rule is
  // quietly looser than the only thing anybody sees.
  const perLink = editorConst('MAX_PHOTO_URL');
  const count = editorConst('MAX_PHOTOS');
  const joined = ruleCap('joined photo length', /listCharsOk\(p\.photos, (\d+)\)/g, 2);

  assert.equal(perLink * count, joined,
    'firestore.rules allows ' + joined + ' characters across all photo links, but the editor ' +
    'allows ' + count + ' links of ' + perLink + ' = ' + (perLink * count) + '. ' +
    (perLink * count > joined
      ? 'A profile the editor accepts would be refused on save.'
      : 'The rule is looser than the editor, so the editor is the only thing enforcing it.'));
});

test('every key a closed allowlist admits is one something validates', function () {
  // `keys().hasOnly([...])` decides which fields a document may have. It says
  // nothing about what any of them may contain, so a key that appears on the list
  // and nowhere else in its validator is a field the rules accept unexamined —
  // which, at Firestore's 1 MiB per document, means any size and any type.
  //
  // This has happened twice. `discovery/{uid}`'s `location` was on the list with
  // no validator at all, in the one world-readable collection, and was found by
  // eye. `personality` had the identical defect three lines away, survived that
  // pass and several since, and was found by this check — which is the argument
  // for asking the question mechanically rather than carefully.
  //
  // Three things the first version of this check got wrong, each found by an audit
  // rather than by the check itself, and each fixed below:
  //   1. it keyed declarations by NAME, so the two `personalityOk`s and the two
  //      `locationOk`s (one per match block, because a rules function cannot cross
  //      one) collapsed into one entry each and the private copies were never read;
  //   2. it only looked inside `function` bodies, so the closed key list written
  //      inline in the messages `allow create` was outside its scope entirely —
  //      the one list standing between a 1000-character cap and a 1 MiB message;
  //   3. it accepted a key as validated when the only place it appeared was a
  //      sibling `hasAll([...])`, which asserts presence and bounds nothing.
  const decls = [...RULES_CODE.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\}/g)]
    .map(function (m) { return { name: m[1], body: m[3], start: m.index, end: m.index + m[0].length }; });

  // Exact, not a floor. A floor of 15 sat happily at 25 while two declarations were
  // being silently dropped; the count it should have been was 27.
  const declared = (RULES_CODE.match(/^\s*function\s+\w+\s*\(/gm) || []).length;
  assert.equal(decls.length, declared,
    'captured ' + decls.length + ' rules function bodies but firestore.rules declares ' +
    declared + '. The body pattern is not matching them all, which would leave this ' +
    'test checking less than it says.');

  const byName = new Map(decls.map(function (d) { return [d.name, d.body]; }));

  // Every closed key list in the file, wherever it is written — inside a validator
  // or inline in an `allow` statement.
  const sites = [...RULES_CODE.matchAll(/(\w+(?:\.\w+)*)\.keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/g)];
  assert.ok(sites.length >= 10,
    'found only ' + sites.length + ' closed key lists in firestore.rules — the pattern ' +
    'is no longer finding them, which would make this test vacuous');

  const unexamined = [];
  sites.forEach(function (list) {
    const receiver = list[1];
    const keys = [...list[2].matchAll(/'([^']+)'/g)].map(function (m) { return m[1]; });
    const owner = decls.filter(function (d) { return list.index > d.start && list.index < d.end; })[0];
    const where = owner ? owner.name : 'allow statement';

    // The text that may validate these keys: the enclosing validator if there is
    // one, otherwise the enclosing `match` block, which is where an inline list
    // lives and where its neighbouring clauses are.
    let covering = owner ? owner.body : blockAround(list.index);

    // Plus the body of anything the validator hands the WHOLE document to. No
    // validator does that today — `bookkeepingOk(d)` was the one and it was
    // inlined — so this contributes nothing at present. It is kept so that
    // reintroducing a wrapper does not make three fields look unexamined.
    if (owner) {
      for (const call of owner.body.matchAll(new RegExp('\\b(\\w+)\\(' + receiver + '\\)', 'g'))) {
        if (byName.has(call[1])) covering += byName.get(call[1]);
      }
    }

    // ...and the `allow` statements of the match block, which is where a constraint
    // that cannot be written as a field test goes: `userDocOk` says nothing about
    // `uid` because `allow create` pins it to the document id and `allow update`
    // freezes it. The allow lines only, never the sibling functions — a key
    // validated in some other function of the same block is not validated here.
    covering += allowsAround(list.index);

    // The strips come LAST, after every append, and that ordering is the point.
    // Done before them, the `allow` text appended above re-introduces the very
    // allowlist just removed — because a list written inline in an `allow` IS part
    // of that statement. Stripping first made this check blind to exactly the site
    // it had just been widened to reach, which is the same shape of bug it exists
    // to find, one level up.
    //
    // Minus the allowlist itself, and minus any `hasAll` beside it: `hasAll`
    // asserts a key is PRESENT and says nothing about its type or size — exactly
    // the hazard this check reports — so a key named only there is not validated.
    covering = covering.split(list[0]).join('');
    covering = covering.replace(/keys\(\)\.hasAll\(\[[\s\S]*?\]\)/g, '');

    keys.forEach(function (key) {
      const named = covering.indexOf("'" + key + "'") !== -1;
      const read = new RegExp('\\.' + key + '\\b').test(covering);
      if (!named && !read) unexamined.push(where + ' → ' + key);
    });
  });

  assert.deepEqual(unexamined, [],
    'these keys are on a closed allowlist and nothing in the validator looks at them:\n  ' +
    unexamined.join('\n  ') + '\nA key the rules admit and never examine is a field of any ' +
    'type and any size, up to Firestore\'s 1 MiB per document.');

  /** The innermost `match` block containing an offset, whole. */
  function blockAround(offset) {
    const span = spanAround(offset);
    return span ? RULES_CODE.slice(span[0], span[1]) : '';
  }

  /**
   * The `allow` statements of the innermost `match` block containing an offset.
   * @param {number} offset a position inside RULES_CODE
   * @returns {string} those statements, concatenated
   */
  function allowsAround(offset) {
    const span = spanAround(offset);
    if (!span) return '';
    const block = RULES_CODE.slice(span[0], span[1]);
    return [...block.matchAll(/\ballow\s[^;]*;/g)].map(function (m) { return m[0]; }).join('\n');
  }

  /** [start, end) of the innermost `match` block containing an offset. */
  function spanAround(offset) {
    let best = null;
    // Anchored on the block-opening brace at end of line: a path segment like
    // `/users/{uid}` carries braces of its own, and scanning from the first one
    // closes the "block" at the end of the path parameter — which silently found
    // no allow statements at all rather than failing.
    for (const open of RULES_CODE.matchAll(/^[ \t]*match\s+[^\n]*\{[ \t]*$/gm)) {
      const start = open.index;
      if (start > offset) break;
      const end = closeOf(start + open[0].lastIndexOf('{'));
      if (end > offset && (best === null || start > best[0])) best = [start, end];
    }
    return best;
  }

  /** The offset of the `}` closing the brace at `open`. */
  function closeOf(open) {
    let depth = 0;
    for (let i = open; i < RULES_CODE.length; i += 1) {
      if (RULES_CODE[i] === '{') depth += 1;
      else if (RULES_CODE[i] === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return RULES_CODE.length;
  }
});

test('every list whose length the rules bound also has its contents bounded', function () {
  // `size()` counts elements and says nothing about what is in them, so a list
  // capped at six could still carry a megabyte in one element and pass. Each of
  // these was exactly that until `listCharsOk` was added, and the failure mode is
  // silent: nothing breaks, the document just grows without limit.
  //
  // This is the check that keeps a *new* bounded list from being added with only
  // half the bound. It finds every `X.size() <= n` in the file and asks whether
  // the same expression is measured by listCharsOk somewhere too.
  //
  // Only variable-length lists. `matches.users` is `size() == 2` and its two
  // elements are addressed by index and pinned to the document id, so Firestore's
  // own 1500-byte id limit bounds them; a list that names its elements does not
  // need to be measured as a whole.
  // Counted per occurrence, not per name. Most of these bounds appear twice —
  // once for `users/{uid}` and once for the `discovery/{uid}` projection — and a
  // set-membership test would call `f.interestedIn` measured on the strength of
  // the copy in the *other* match block. Deleting one of the two was invisible
  // when this check was first written, which is the drift it is here to catch.
  const sized = tally(/([A-Za-z][\w.]*(?:\(\))?)\s+is list && \1\.size\(\) <= \d+/g);
  const total = [...sized.values()].reduce(function (n, c) { return n + c; }, 0);
  assert.ok(total >= 5, 'found only ' + total + ' bounded lists in firestore.rules — ' +
    'the pattern has probably stopped matching, which would make this test vacuous');

  // Skipping listCharsOk's own definition, whose parameter is not a list anybody wrote.
  const measured = tally(/(?<!function )listCharsOk\(([^,]+),/g);

  const short = [...sized.keys()]
    .filter(function (expr) { return (measured.get(expr) || 0) < sized.get(expr); })
    .map(function (expr) {
      return expr + ' (bounded by length ' + sized.get(expr) + '×, by contents ' +
        (measured.get(expr) || 0) + '×)';
    });
  assert.deepEqual(short, [],
    'these lists have their length bounded but not their contents: ' + JSON.stringify(short) +
    '. A list of six elements is not a bounded field — one element can be a megabyte. ' +
    'Add listCharsOk(<the list>, <total characters>) beside the size() check.');

  /** How many times each capture-group-1 value appears. */
  function tally(pattern) {
    const counts = new Map();
    for (const m of RULES_CODE.matchAll(pattern)) {
      const key = m[1].trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
});
