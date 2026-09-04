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
 * A numeric `const NAME = 123;` from the profile editor.
 * @param {string} name the constant's name
 * @returns {number} its value
 */
function editorConst(name) {
  const found = new RegExp('\\bconst ' + name + ' = (\\d+);').exec(EDITOR);
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
  const found = [...RULES.matchAll(pattern)].map(function (m) { return Number(m[1]); });
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
  const bodies = new Map();
  for (const m of RULES.matchAll(/function\s+(\w+)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\s*\}/g)) {
    bodies.set(m[1], m[3]);
  }
  assert.ok(bodies.size >= 15, 'found only ' + bodies.size + ' rules functions — the pattern has ' +
    'probably stopped matching, which would make this test vacuous');

  const unexamined = [];
  let listsChecked = 0;
  for (const [name, body] of bodies) {
    for (const list of body.matchAll(/(\w+)\.keys\(\)\.hasOnly\(\[([\s\S]*?)\]\)/g)) {
      listsChecked += 1;
      const receiver = list[1];
      const keys = [...list[2].matchAll(/'([^']+)'/g)].map(function (m) { return m[1]; });

      // The validator's own text, minus the allowlist itself — plus the body of
      // anything it hands the whole document to. `userDocOk` delegates `learning`,
      // `usage` and `blocked` wholesale to `bookkeepingOk(d)`, and a check that did
      // not follow that would report three fields as unexamined that are not.
      let covering = body.split(list[0]).join('');
      for (const call of body.matchAll(new RegExp('\\b(\\w+)\\(' + receiver + '\\)', 'g'))) {
        if (bodies.has(call[1])) covering += bodies.get(call[1]);
      }

      keys.forEach(function (key) {
        const named = covering.indexOf("'" + key + "'") !== -1;
        const read = new RegExp('\\.' + key + '\\b').test(covering);
        if (!named && !read) unexamined.push(name + ' → ' + key);
      });
    }
  }

  assert.ok(listsChecked >= 6, 'found only ' + listsChecked + ' closed key lists — ' +
    'the pattern is no longer finding them');
  assert.deepEqual(unexamined, [],
    'these keys are on a closed allowlist and nothing in the validator looks at them:\n  ' +
    unexamined.join('\n  ') + '\nA key the rules admit and never examine is a field of any ' +
    'type and any size, up to Firestore\'s 1 MiB per document.');
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
    for (const m of RULES.matchAll(pattern)) {
      const key = m[1].trim();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }
});
