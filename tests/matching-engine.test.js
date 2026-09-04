/* ==========================================================================
   Zero Cost AI Dating — matching engine tests
   Runs with `node --test`. No dependencies, no fixtures on disk: every
   profile used here is hand-built so the maths stays checkable by eye.
   ========================================================================== */
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const M = require('../public/js/matching-engine.js');

  const I = M._internal;
  const NOW = '2026-03-01T12:00:00.000Z';
  const HOURS_6 = '2026-03-01T06:00:00.000Z';

  /* ----------------------------------------------------------------------
     Fixtures
     ---------------------------------------------------------------------- */

  /** Build a complete UserDoc-shaped fixture with sane defaults. */
  function mkUser(uid, over) {
    const o = over || {};
    return {
      uid: uid,
      email: uid + '@example.com',
      displayName: uid,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastActiveAt: o.lastActiveAt || NOW,
      profileComplete: o.profileComplete === undefined ? true : o.profileComplete,
      plan: o.plan || 'free',
      planSince: null,
      profile: Object.assign({
        birthdate: '1995-01-01',
        age: 30,
        gender: 'woman',
        pronouns: 'she/her',
        bio: '',
        photos: [],
        interests: [],
        personality: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, stability: 50 },
        location: null,
        showAge: true,
        showDistance: true
      }, o.profile),
      preferences: Object.assign({
        interestedIn: [],
        ageMin: 18,
        ageMax: 100,
        maxDistanceKm: 500,
        notifications: true,
        theme: 'system',
        discoverable: true
      }, o.preferences),
      learning: o.learning || { interestAffinity: {}, likeCount: 0, passCount: 0 },
      usage: { date: '2026-03-01', likes: 0, superLikes: 0, rewinds: 0 },
      blocked: o.blocked || []
    };
  }

  // The golden pair: two Portland people with real overlap.
  const ALEX = mkUser('alex', {
    profile: {
      gender: 'woman',
      age: 31,
      bio: 'Weekend climber and slow-cooking obsessive. I collect vinyl and take the long way home.',
      interests: ['hiking', 'live-music', 'cooking', 'yoga'],
      personality: { openness: 78, conscientiousness: 62, extraversion: 55, agreeableness: 74, stability: 66 },
      location: { label: 'Portland', lat: 45.5152, lng: -122.6784 }
    },
    preferences: { interestedIn: ['man', 'nonbinary'], ageMin: 26, ageMax: 40, maxDistanceKm: 50 }
  });

  const RILEY = mkUser('riley', {
    lastActiveAt: HOURS_6,
    profile: {
      gender: 'man',
      age: 33,
      bio: 'Climbing on Saturdays, cooking for friends on Sundays. Vinyl over playlists, always.',
      interests: ['hiking', 'live-music', 'cooking', 'cycling'],
      personality: { openness: 82, conscientiousness: 58, extraversion: 60, agreeableness: 79, stability: 71 },
      location: { label: 'Portland', lat: 45.5231, lng: -122.6765 }
    },
    preferences: { interestedIn: ['woman'], ageMin: 25, ageMax: 39, maxDistanceKm: 60 }
  });

  const FILLER = [
    mkUser('f1', { profile: { bio: 'I run marathons and read long history books.' } }),
    mkUser('f2', { profile: { bio: 'Dog person, board games, genuinely terrible at chess.' } }),
    mkUser('f3', { profile: { bio: 'Painting badly, gardening worse, happy about both.' } })
  ];

  const CORPUS = M.buildCorpus([ALEX, RILEY].concat(FILLER));
  const OPTS = { corpus: CORPUS, now: NOW };

  /** Deep clone so no test can leak state into another. */
  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** Float comparison helper. */
  function near(actual, expected, epsilon) {
    assert.ok(
      Math.abs(actual - expected) <= (epsilon === undefined ? 1e-9 : epsilon),
      'expected ' + actual + ' to be within ' + epsilon + ' of ' + expected
    );
  }

  /* ----------------------------------------------------------------------
     Public surface
     ---------------------------------------------------------------------- */

  test('exposes the documented surface both ways', function () {
    assert.equal(M.VERSION, '1.0.0');
    assert.equal(typeof M.buildCorpus, 'function');
    assert.equal(typeof M.scoreCandidate, 'function');
    assert.equal(typeof M.rankCandidates, 'function');
    assert.equal(typeof M.updateLearning, 'function');
    assert.equal(typeof M.icebreakers, 'function');
    assert.equal(typeof M.compatibilityLabel, 'function');
    assert.equal(typeof M.explain, 'function');
    assert.equal(globalThis.ZC.matching, M, 'attaches itself to the ZC global too');
  });

  test('default weights sum to 1', function () {
    const keys = Object.keys(M.DEFAULT_WEIGHTS);
    assert.equal(keys.length, 7);
    let sum = 0;
    keys.forEach(function (k) { sum += M.DEFAULT_WEIGHTS[k]; });
    near(sum, 1, 1e-12);
    assert.equal(M.DEFAULT_WEIGHTS.interests, 0.28);
    assert.equal(M.DEFAULT_WEIGHTS.affinity, 0.07);
  });

  /* ----------------------------------------------------------------------
     Hard filters — §5.2
     ---------------------------------------------------------------------- */

  test('hard filter: self', function () {
    const r = M.scoreCandidate(ALEX, ALEX, OPTS);
    assert.equal(r.hardFail, 'self');
    assert.equal(r.score, 0);
    assert.deepEqual(r.reasons, []);
  });

  test('hard filter: blocked in either direction', function () {
    const meBlocks = clone(ALEX);
    meBlocks.blocked = ['riley'];
    assert.equal(M.scoreCandidate(meBlocks, RILEY, OPTS).hardFail, 'blocked');

    const theyBlock = clone(RILEY);
    theyBlock.blocked = ['alex'];
    assert.equal(M.scoreCandidate(ALEX, theyBlock, OPTS).hardFail, 'blocked');
  });

  test('hard filter: already swiped via excludeIds', function () {
    const r = M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, excludeIds: ['riley'] });
    assert.equal(r.hardFail, 'swiped');
    assert.equal(M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, excludeIds: ['someone-else'] }).hardFail, null);
  });

  test('hard filter: not discoverable', function () {
    const hidden = clone(RILEY);
    hidden.preferences.discoverable = false;
    assert.equal(M.scoreCandidate(ALEX, hidden, OPTS).hardFail, 'not-discoverable');
  });

  test('hard filter: incomplete profile or missing age', function () {
    const unfinished = clone(RILEY);
    unfinished.profileComplete = false;
    assert.equal(M.scoreCandidate(ALEX, unfinished, OPTS).hardFail, 'incomplete');

    const ageless = clone(RILEY);
    ageless.profile.age = null;
    assert.equal(M.scoreCandidate(ALEX, ageless, OPTS).hardFail, 'incomplete');
  });

  test('hard filter: gender is mutual', function () {
    // Their gender is not in my list.
    const meWomenOnly = clone(ALEX);
    meWomenOnly.preferences.interestedIn = ['woman'];
    assert.equal(M.scoreCandidate(meWomenOnly, RILEY, OPTS).hardFail, 'gender');

    // My gender is not in their list.
    const theyWantMen = clone(RILEY);
    theyWantMen.preferences.interestedIn = ['man'];
    assert.equal(M.scoreCandidate(ALEX, theyWantMen, OPTS).hardFail, 'gender');

    // Empty lists mean "open to all" on both sides.
    const openMe = clone(ALEX);
    const openThem = clone(RILEY);
    openMe.preferences.interestedIn = [];
    openThem.preferences.interestedIn = [];
    assert.equal(M.scoreCandidate(openMe, openThem, OPTS).hardFail, null);
  });

  test('hard filter: age range is mutual', function () {
    // They are older than my ceiling.
    const narrowMe = clone(ALEX);
    narrowMe.preferences.ageMax = 32;
    assert.equal(M.scoreCandidate(narrowMe, RILEY, OPTS).hardFail, 'age');

    // I am younger than their floor.
    const pickyThem = clone(RILEY);
    pickyThem.preferences.ageMin = 35;
    assert.equal(M.scoreCandidate(ALEX, pickyThem, OPTS).hardFail, 'age');

    // Comfortably inside both ranges.
    assert.equal(M.scoreCandidate(ALEX, RILEY, OPTS).hardFail, null);
  });

  test('hard filter: distance respects the tighter limit and the "anywhere" escape hatch', function () {
    const farAway = clone(RILEY);
    farAway.profile.location = { label: 'Seattle', lat: 47.6062, lng: -122.3321 };

    // ~233 km apart; my limit is 50.
    const r = M.scoreCandidate(ALEX, farAway, OPTS);
    assert.equal(r.hardFail, 'distance');
    assert.ok(r.distanceKm > 200 && r.distanceKm < 300, 'distance still reported on a rejected card');

    // 500 on both sides means "anywhere" and must never hard-fail.
    const anywhereMe = clone(ALEX);
    anywhereMe.preferences.maxDistanceKm = 500;
    const anywhereThem = clone(farAway);
    anywhereThem.preferences.maxDistanceKm = 500;
    const roaming = M.scoreCandidate(anywhereMe, anywhereThem, OPTS);
    assert.equal(roaming.hardFail, null);
    // ~233 km against a 500 km cap: allowed through, but clearly penalised.
    assert.ok(roaming.breakdown.distance > 0.5 && roaming.breakdown.distance < 0.75, 'got ' + roaming.breakdown.distance);
    assert.ok(roaming.breakdown.distance < M.scoreCandidate(ALEX, RILEY, OPTS).breakdown.distance);

    // One tight limit is enough to rule the pair out.
    assert.equal(M.scoreCandidate(anywhereMe, farAway, OPTS).hardFail, 'distance');

    // The candidate's own tighter limit counts too.
    const tightThem = clone(RILEY);
    tightThem.profile.location = { label: 'Seattle', lat: 47.6062, lng: -122.3321 };
    tightThem.preferences.maxDistanceKm = 20;
    assert.equal(M.scoreCandidate(anywhereMe, tightThem, OPTS).hardFail, 'distance');
  });

  test('hard filters are applied in the documented order', function () {
    const both = clone(RILEY);
    both.blocked = ['alex'];
    both.preferences.discoverable = false;
    // blocked (2) beats not-discoverable (4) and swiped (3).
    assert.equal(M.scoreCandidate(ALEX, both, { corpus: CORPUS, now: NOW, excludeIds: ['riley'] }).hardFail, 'blocked');
    assert.equal(M.scoreCandidate(ALEX, ALEX, { corpus: CORPUS, now: NOW, excludeIds: ['alex'] }).hardFail, 'self');
  });

  /* ----------------------------------------------------------------------
     Neutral / missing-data paths — §5.3
     ---------------------------------------------------------------------- */

  test('missing location is neutral, never a hard fail', function () {
    const nowhere = clone(RILEY);
    nowhere.profile.location = null;
    const r = M.scoreCandidate(ALEX, nowhere, OPTS);
    assert.equal(r.hardFail, null);
    assert.equal(r.distanceKm, null);
    assert.equal(r.breakdown.distance, 0.5);
    assert.equal(r.reasons.filter(function (x) { return x.kind === 'distance'; }).length, 0);
  });

  test('missing personality and interests fall back cleanly', function () {
    const bare = clone(RILEY);
    bare.profile.personality = null;
    bare.profile.interests = [];
    const r = M.scoreCandidate(ALEX, bare, OPTS);
    assert.equal(r.breakdown.personality, 0.5);
    assert.equal(r.breakdown.interests, 0);
    assert.deepEqual(r.shared.interests, []);
  });

  test('missing or unparseable lastActiveAt scores 0.3', function () {
    assert.equal(I.activityScore(undefined, NOW), 0.3);
    assert.equal(I.activityScore('not-a-date', NOW), 0.3);
    assert.equal(I.activityScore(NOW, undefined), 0.3);
    assert.equal(I.activityScore(NOW, NOW), 1);
    near(I.activityScore('2026-02-22T12:00:00.000Z', NOW), 0.5, 1e-12);
  });

  /* ----------------------------------------------------------------------
     Determinism and bounds
     ---------------------------------------------------------------------- */

  test('scoring is deterministic', function () {
    const a = M.scoreCandidate(ALEX, RILEY, OPTS);
    const b = M.scoreCandidate(ALEX, RILEY, OPTS);
    assert.equal(a.score, b.score);
    assert.deepEqual(a.breakdown, b.breakdown);
    assert.deepEqual(a.reasons, b.reasons);
    assert.equal(JSON.stringify(a.shared), JSON.stringify(b.shared));
  });

  test('scores stay inside 0..100 across a spread of inputs', function () {
    const variants = [];
    [0, 100].forEach(function (v) {
      [[], ['hiking'], ['hiking', 'live-music', 'cooking', 'cycling']].forEach(function (tags) {
        const u = clone(RILEY);
        u.profile.personality = { openness: v, conscientiousness: v, extraversion: v, agreeableness: v, stability: v };
        u.profile.interests = tags;
        u.profile.age = v === 0 ? 27 : 39;
        variants.push(u);
      });
    });
    variants.push(mkUser('empty-ish', { profile: { age: 30, bio: '', interests: [], personality: null } }));

    variants.forEach(function (candidate) {
      const r = M.scoreCandidate(ALEX, candidate, OPTS);
      assert.ok(r.score >= 0 && r.score <= 100, 'score in range: ' + r.score);
      assert.equal(Math.round(r.score * 10) / 10, r.score, 'score rounded to 1dp');
      Object.keys(r.breakdown).forEach(function (key) {
        assert.ok(r.breakdown[key] >= 0 && r.breakdown[key] <= 1, key + ' in 0..1');
      });
    });
  });

  test('scoring does not mutate its inputs', function () {
    const me = clone(ALEX);
    const them = clone(RILEY);
    const before = JSON.stringify([me, them]);
    M.scoreCandidate(me, them, OPTS);
    assert.equal(JSON.stringify([me, them]), before);
  });

  /* ----------------------------------------------------------------------
     Component maths — §5.3
     ---------------------------------------------------------------------- */

  test('personalityScore is symmetric and bounded', function () {
    const a = { openness: 80, conscientiousness: 20, extraversion: 65, agreeableness: 40, stability: 90 };
    const b = { openness: 35, conscientiousness: 75, extraversion: 30, agreeableness: 55, stability: 10 };
    assert.equal(I.personalityScore(a, b), I.personalityScore(b, a));
    assert.ok(I.personalityScore(a, b) >= 0 && I.personalityScore(a, b) <= 1);
    assert.equal(I.personalityScore(a, a), I.personalityScore(a, a));
    assert.equal(I.personalityScore(null, b), 0.5);
    assert.equal(I.personalityScore(a, undefined), 0.5);

    // Identical vectors: every similarity axis is 1, stability adds the shared level.
    const same = { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, stability: 50 };
    near(I.personalityScore(same, same), 0.25 + 0.15 + 0.20 + 0.25 + 0.15 * 0.75, 1e-12);

    // Extraversion tolerates a 25-point gap completely.
    const eA = { openness: 50, conscientiousness: 50, extraversion: 20, agreeableness: 50, stability: 50 };
    const eB = { openness: 50, conscientiousness: 50, extraversion: 45, agreeableness: 50, stability: 50 };
    near(I.personalityScore(eA, eB), I.personalityScore(eA, eA), 1e-12);
  });

  test('weightedJaccard handles empty and disjoint sets', function () {
    assert.equal(I.weightedJaccard([], ['hiking']), 0);
    assert.equal(I.weightedJaccard(['hiking'], []), 0);
    assert.equal(I.weightedJaccard([], []), 0);
    assert.equal(I.weightedJaccard(null, undefined), 0);
    assert.equal(I.weightedJaccard(['hiking'], ['chess']), 0, 'no overlap and no known categories');
    near(I.weightedJaccard(['hiking'], ['hiking']), 0.75, 1e-12);
    near(I.weightedJaccard(['a', 'b'], ['b', 'c']), 0.75 * (1 / 3), 1e-12);
    // Duplicates must not inflate the union.
    near(I.weightedJaccard(['a', 'a', 'b'], ['b', 'a']), 0.75, 1e-12);
  });

  test('weightedJaccard adds the category bonus when tag metadata is supplied', function () {
    const tags = [
      { slug: 'hiking', label: 'Hiking', emoji: '🥾', category: 'outdoors' },
      { slug: 'camping', label: 'Camping', emoji: '⛺', category: 'outdoors' }
    ];
    // Different tags, same category: base 0, bonus 0.25 * 0.5.
    near(I.weightedJaccard(['hiking'], ['camping'], tags), 0.125, 1e-12);
    near(I.weightedJaccard(['hiking'], ['hiking'], tags), 0.875, 1e-12);
  });

  test('distanceScore decays and clamps', function () {
    assert.equal(I.distanceScore(null), 0.5);
    assert.equal(I.distanceScore(undefined, 50), 0.5);
    assert.equal(I.distanceScore(0, 50), 1);
    assert.equal(I.distanceScore(50, 50), 0);
    assert.equal(I.distanceScore(400, 50), 0);
    near(I.distanceScore(25, 100), 1 - Math.pow(0.25, 1.5), 1e-12);
    // A cap beyond "anywhere" is treated as 500.
    assert.equal(I.distanceScore(500, 5000), I.distanceScore(500, 500));
  });

  test('ageScore is symmetric with a 20-year floor', function () {
    assert.equal(I.ageScore(30, 30), 1);
    assert.equal(I.ageScore(30, 50), 0);
    assert.equal(I.ageScore(30, 90), 0);
    assert.equal(I.ageScore(30, 40), I.ageScore(40, 30));
    near(I.ageScore(30, 40), 0.5, 1e-12);
    assert.equal(I.ageScore(null, 30), 0.5);
    assert.equal(I.ageScore(30, undefined), 0.5);
  });

  test('affinityScore maps -1..1 onto 0..1', function () {
    const learning = { interestAffinity: { hiking: 1, chess: -1 }, likeCount: 3, passCount: 1 };
    assert.equal(I.affinityScore(learning, ['hiking']), 1);
    assert.equal(I.affinityScore(learning, ['chess']), 0);
    assert.equal(I.affinityScore(learning, ['hiking', 'chess']), 0.5);
    assert.equal(I.affinityScore(learning, ['unknown-tag']), 0.5, 'unseen tags read as 0');
    assert.equal(I.affinityScore(learning, []), 0.5);
    assert.equal(I.affinityScore(null, ['hiking']), 0.5);
    assert.equal(I.affinityScore({ interestAffinity: {} }, ['hiking']), 0.5);
  });

  /* ----------------------------------------------------------------------
     Text model — §5.3
     ---------------------------------------------------------------------- */

  test('tokenize lowercases, strips diacritics and drops short words', function () {
    assert.deepEqual(I.tokenize('Café CAFÉ café'), ['cafe', 'cafe', 'cafe']);
    assert.deepEqual(I.tokenize('Jag älskar naïve résumés'), ['jag', 'alskar', 'naive', 'resume']);
    assert.deepEqual(I.tokenize('I go to my gym'), ['gym'], 'sub-3-character words are dropped');
    assert.deepEqual(I.tokenize(''), []);
    assert.deepEqual(I.tokenize(null), []);
    assert.deepEqual(I.tokenize('日本語 only'), [], 'non-latin script drops out with the split rule');
  });

  test('tokenize drops stopwords, including contracted forms', function () {
    assert.ok(I.STOPWORDS.has('the'));
    assert.ok(I.STOPWORDS.has('because'));
    assert.ok(I.STOPWORDS.has("don't"));
    assert.ok(I.STOPWORDS.size >= 120, 'ships a real stopword list, got ' + I.STOPWORDS.size);
    assert.deepEqual(I.tokenize("The dog and the cat because they don't care"), ['dog', 'cat', 'care']);
  });

  test('tokenize applies the light stemmer', function () {
    assert.deepEqual(I.tokenize('stories'), ['story']);
    assert.deepEqual(I.tokenize('classes'), ['class']);
    assert.deepEqual(I.tokenize('records'), ['record']);
    assert.deepEqual(I.tokenize('grass'), ['grass'], 'a genuine double-s ending survives');
    assert.deepEqual(I.tokenize('climbing'), ['climb']);
    assert.deepEqual(I.tokenize('cooked'), ['cook']);
    assert.deepEqual(I.tokenize('baked'), ['baked'], 'stems shorter than 4 chars are left alone');
    assert.deepEqual(I.tokenize('recordings'), ['record']);
    assert.deepEqual(I.tokenize('climb climbs climbing'), ['climb', 'climb', 'climb']);
  });

  test('termFreq counts occurrences', function () {
    const tf = I.termFreq(['vinyl', 'vinyl', 'climb']);
    assert.equal(tf.vinyl, 2);
    assert.equal(tf.climb, 1);
    assert.equal(tf.missing, undefined);
    assert.equal(I.termFreq('vinyl vinyl climb').vinyl, 2, 'accepts raw text too');

    // Bios are user text: prototype keys must behave like any other word.
    const risky = I.termFreq(I.tokenize('constructor constructor hasOwnProperty'));
    assert.equal(risky.constructor, 2);
    assert.equal(risky.hasownproperty, 1);
    const vec = I.tfidfVector(I.tokenize('constructor'), M.buildCorpus([{ profile: { bio: 'constructor' } }]));
    assert.equal(typeof vec.constructor, 'number');
  });

  test('buildCorpus produces the documented idf', function () {
    const corpus = M.buildCorpus([
      { profile: { bio: 'vinyl records forever' } },
      { profile: { bio: 'vinyl chairs' } },
      { profile: { bio: 'nothing in common here' } }
    ]);
    assert.equal(corpus.docCount, 3);
    near(corpus.idf.vinyl, Math.log(4 / 3) + 1, 1e-12);
    near(corpus.idf.chair, Math.log(4 / 2) + 1, 1e-12);
    assert.equal(corpus.idf['never-seen'], undefined);
    assert.equal(M.buildCorpus(null).docCount, 0);
    assert.deepEqual(Object.keys(M.buildCorpus([]).idf), []);
  });

  test('tfidfVector weights rare terms above common ones', function () {
    const corpus = M.buildCorpus([
      { profile: { bio: 'vinyl records forever' } },
      { profile: { bio: 'vinyl chairs' } },
      { profile: { bio: 'vinyl everywhere' } },
      { profile: { bio: 'kayaking alone' } }
    ]);
    const vec = I.tfidfVector(I.tokenize('vinyl kayaking'), corpus);
    assert.ok(vec.kayak > vec.vinyl, 'the rarer token carries more weight');
    const plain = I.tfidfVector(I.tokenize('vinyl kayaking'));
    assert.equal(plain.vinyl, 1);
    assert.equal(plain.kayak, 1, 'no corpus falls back to raw term frequency');
  });

  test('cosine handles identical, scaled, orthogonal and empty vectors', function () {
    const a = { climb: 2, vinyl: 1 };
    near(I.cosine(a, a), 1, 1e-12);
    near(I.cosine(a, { climb: 20, vinyl: 10 }), 1, 1e-12);
    assert.ok(I.cosine(a, a) <= 1, 'never exceeds 1');
    assert.equal(I.cosine(a, { chess: 5 }), 0);
    assert.equal(I.cosine(a, {}), 0);
    assert.equal(I.cosine({}, {}), 0);
    assert.equal(I.cosine(null, a), 0);
    assert.equal(I.cosine(a, { climb: 2, vinyl: 1 }), I.cosine({ climb: 2, vinyl: 1 }, a), 'symmetric');
    const partial = I.cosine(a, { climb: 1 });
    assert.ok(partial > 0 && partial < 1);
  });

  test('an empty bio on either side scores 0 for bio', function () {
    const silent = clone(RILEY);
    silent.profile.bio = '';
    assert.equal(M.scoreCandidate(ALEX, silent, OPTS).breakdown.bio, 0);

    const quietMe = clone(ALEX);
    quietMe.profile.bio = '';
    assert.equal(M.scoreCandidate(quietMe, RILEY, OPTS).breakdown.bio, 0);
  });

  /* ----------------------------------------------------------------------
     Weights and adaptive learning — §5.3
     ---------------------------------------------------------------------- */

  test('weights are renormalised when adaptive is off', function () {
    const r = M.scoreCandidate(ALEX, RILEY, OPTS);
    assert.equal(r.breakdown.affinity, 0.5, 'still reported as neutral');

    const keys = ['interests', 'bio', 'personality', 'distance', 'age', 'activity'];
    let sum = 0;
    keys.forEach(function (k) { sum += M.DEFAULT_WEIGHTS[k]; });
    let total = 0;
    keys.forEach(function (k) { total += (M.DEFAULT_WEIGHTS[k] / sum) * r.breakdown[k]; });
    assert.equal(r.score, Math.round(total * 1000) / 10, 'affinity carries no weight at all');
  });

  test('adaptive scoring uses the full weight set and cannot penalise a free user', function () {
    const learner = clone(ALEX);
    learner.learning = { interestAffinity: { hiking: 0.9, cooking: 0.8, cycling: 0.7, 'live-music': 0.6 }, likeCount: 9, passCount: 2 };

    const off = M.scoreCandidate(learner, RILEY, OPTS);
    const on = M.scoreCandidate(learner, RILEY, { corpus: CORPUS, now: NOW, adaptive: true });
    assert.ok(on.breakdown.affinity > 0.5, 'liked tags push affinity up');
    assert.ok(on.score > off.score, 'a positive affinity should raise the score');

    let total = 0;
    Object.keys(M.DEFAULT_WEIGHTS).forEach(function (k) { total += M.DEFAULT_WEIGHTS[k] * on.breakdown[k]; });
    assert.equal(on.score, Math.round(total * 1000) / 10);

    // Adaptive on but no learning data at all behaves exactly like adaptive off.
    const blank = M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, adaptive: true });
    assert.equal(blank.score, M.scoreCandidate(ALEX, RILEY, OPTS).score);
  });

  test('custom weights are honoured and renormalised', function () {
    const only = { interests: 1, bio: 0, personality: 0, distance: 0, age: 0, activity: 0, affinity: 0 };
    const r = M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, weights: only });
    near(r.score, Math.round(r.breakdown.interests * 1000) / 10, 1e-9);

    // Weights that do not sum to 1 still produce a bounded score.
    const daft = M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, weights: { interests: 9, bio: 9 } });
    assert.ok(daft.score >= 0 && daft.score <= 100);
  });

  /* ----------------------------------------------------------------------
     Reasons — §5.4
     ---------------------------------------------------------------------- */

  /* ----------------------------------------------------------------------
     The two display switches, honoured by the reasons as well — §5.3
     ---------------------------------------------------------------------- */

  // profile.html tells people, in as many words, that showAge and showDistance
  // are "display-only… turning them off changes what people read, not who you
  // are shown to". Both halves of that sentence are promises, and both are
  // checked here, because the reasons used to keep only the second one: every
  // other surface honoured the switches — dashboard's ageOf returns null, its
  // distanceText returns '' — while the reason list printed "Same age" and
  // "Just 1 km away" directly underneath the fields it had just suppressed, to
  // the same precision. A viewer who knows their own age learns the other
  // person's exactly.
  const NEAR = { label: 'Portland', lat: 45.52, lng: -122.68 };
  const ALSO_NEAR = { label: 'Portland', lat: 45.529, lng: -122.68 };

  /**
   * @param {Object} [over] profile overrides for the candidate
   * @returns {Object} reason kinds the candidate would have shown about them
   */
  function kindsFor(over) {
    const me = mkUser('me', { profile: { age: 30, location: NEAR } });
    const them = mkUser('them', { profile: Object.assign({ age: 30, location: ALSO_NEAR }, over || {}) });
    return M.scoreCandidate(me, them, OPTS).reasons.map(function (r) { return r.kind; });
  }

  test('a candidate showing both age and distance gets both reasons', function () {
    const kinds = kindsFor({ showAge: true, showDistance: true });
    // Without this the two checks below would pass on a build that emitted no
    // age or distance reason at all, for any candidate.
    assert.ok(kinds.indexOf('distance') !== -1, 'distance reason: ' + kinds.join(', '));
    assert.ok(kinds.indexOf('age') !== -1, 'age reason: ' + kinds.join(', '));
  });

  test('showDistance: false suppresses the distance reason', function () {
    const kinds = kindsFor({ showDistance: false });
    assert.equal(kinds.indexOf('distance'), -1,
      'a profile that hides its distance must not have it republished as a reason: ' + kinds.join(', '));
  });

  test('showAge: false suppresses the age reason', function () {
    const kinds = kindsFor({ showAge: false });
    assert.equal(kinds.indexOf('age'), -1,
      'a profile that hides its age must not have it republished as a reason: ' + kinds.join(', '));
  });

  test('a profile predating the switches is treated as showing, not hiding', function () {
    const stored = mkUser('them', { profile: { age: 30, location: ALSO_NEAR } });
    delete stored.profile.showAge;
    delete stored.profile.showDistance;
    const me = mkUser('me', { profile: { age: 30, location: NEAR } });
    const kinds = M.scoreCandidate(me, stored, OPTS).reasons.map(function (r) { return r.kind; });
    // Absent is not off. A document written before these fields existed must
    // not go quiet on its owner's behalf; normalizeUser defaults both to true.
    assert.ok(kinds.indexOf('distance') !== -1 && kinds.indexOf('age') !== -1, kinds.join(', '));
  });

  test('the switches change what is said, never the score or the ranking', function () {
    const me = mkUser('me', { profile: { age: 30, location: NEAR } });
    const shown = mkUser('them', { profile: { age: 30, location: ALSO_NEAR, showAge: true, showDistance: true } });
    const hidden = mkUser('them', { profile: { age: 30, location: ALSO_NEAR, showAge: false, showDistance: false } });
    const a = M.scoreCandidate(me, shown, OPTS);
    const b = M.scoreCandidate(me, hidden, OPTS);
    // The other half of the promise: "your age and your city still take part in
    // matching". Hiding them must not quietly cost somebody their matches, so
    // the score and every component behind it have to be identical.
    assert.equal(a.score, b.score);
    assert.deepEqual(a.breakdown, b.breakdown);
    assert.equal(a.distanceKm, b.distanceKm);
  });

  test('reasons are specific, capped at four, and never empty-handed', function () {
    const r = M.scoreCandidate(ALEX, RILEY, OPTS);
    const kinds = ['interests', 'personality', 'bio', 'distance', 'age', 'activity'];
    assert.ok(r.reasons.length > 0 && r.reasons.length <= 4);
    r.reasons.forEach(function (reason) {
      assert.ok(kinds.indexOf(reason.kind) !== -1, 'known kind: ' + reason.kind);
      assert.equal(typeof reason.icon, 'string');
      assert.ok(reason.icon.length > 0);
      assert.ok(reason.text.length > 8, 'reason reads like a sentence: ' + reason.text);
      assert.ok(reason.text.indexOf('{') === -1 && reason.text.indexOf('}') === -1, 'no unfilled placeholder');
      assert.ok(reason.text.indexOf('undefined') === -1);
    });

    const interests = r.reasons.filter(function (x) { return x.kind === 'interests'; })[0];
    assert.ok(interests, 'three shared tags must produce an interests reason');
    assert.equal(interests.text, 'You both love Hiking, Live Music and Cooking');
    assert.equal(interests.icon, '✨');
  });

  test('the interests reason caps at three labels and counts the rest', function () {
    const many = clone(ALEX);
    many.profile.interests = ['hiking', 'live-music', 'cooking', 'yoga', 'cycling'];
    const alsoMany = clone(RILEY);
    alsoMany.profile.interests = ['hiking', 'live-music', 'cooking', 'yoga', 'cycling'];
    const r = M.scoreCandidate(many, alsoMany, OPTS);
    const text = r.reasons.filter(function (x) { return x.kind === 'interests'; })[0].text;
    assert.equal(text, 'You both love Hiking, Live Music and Cooking +2 more');
  });

  test('the age reason pluralises and the distance reason rounds', function () {
    const twin = clone(RILEY);
    twin.profile.age = 31;
    const same = M.scoreCandidate(ALEX, twin, OPTS);
    assert.equal(same.reasons.filter(function (x) { return x.kind === 'age'; })[0].text, 'Same age');

    const oneYear = clone(RILEY);
    oneYear.profile.age = 32;
    const near1 = M.scoreCandidate(ALEX, oneYear, OPTS);
    assert.equal(near1.reasons.filter(function (x) { return x.kind === 'age'; })[0].text, 'Only 1 year apart');

    // Under a kilometre reads as a phrase, not "0 km".
    const closeBy = M.scoreCandidate(ALEX, RILEY, OPTS);
    assert.equal(closeBy.reasons.filter(function (x) { return x.kind === 'distance'; })[0].text, 'Less than a km away');

    const acrossTown = clone(RILEY);
    acrossTown.profile.location = { label: 'Portland', lat: 45.5872, lng: -122.6784 };
    const far = M.scoreCandidate(ALEX, acrossTown, OPTS);
    assert.equal(far.reasons.filter(function (x) { return x.kind === 'distance'; })[0].text, 'Just 8 km away');
  });

  test('the bio reason quotes the candidate\'s own words', function () {
    const r = M.scoreCandidate(ALEX, RILEY, { corpus: CORPUS, now: NOW, weights: { interests: 0, personality: 0, distance: 0, age: 0, activity: 0 } });
    const bio = r.reasons.filter(function (x) { return x.kind === 'bio'; })[0];
    assert.ok(bio, 'shared bio tokens must surface');
    assert.ok(/^Your bios both mention /.test(bio.text));
    assert.ok(/vinyl/i.test(bio.text) || /cook/i.test(bio.text), 'quotes a real shared word: ' + bio.text);
    assert.deepEqual(r.shared.tokens.slice().sort(), ['cook', 'vinyl']);
  });

  test('a stale profile gets no activity reason', function () {
    const stale = clone(RILEY);
    stale.lastActiveAt = '2026-01-01T00:00:00.000Z';
    const r = M.scoreCandidate(ALEX, stale, OPTS);
    assert.equal(r.reasons.filter(function (x) { return x.kind === 'activity'; }).length, 0);
    assert.ok(r.breakdown.activity < 0.2);

    const fresh = M.scoreCandidate(ALEX, RILEY, OPTS);
    assert.equal(fresh.reasons.filter(function (x) { return x.kind === 'activity'; }).length <= 1, true);
  });

  /* ----------------------------------------------------------------------
     Ranking — §5.1
     ---------------------------------------------------------------------- */

  test('rankCandidates drops hard fails and sorts by score', function () {
    const blocked = clone(RILEY);
    blocked.uid = 'blocked-one';
    blocked.blocked = ['alex'];

    const weak = mkUser('weak', {
      lastActiveAt: '2026-01-05T00:00:00.000Z',
      profile: { age: 39, gender: 'man', bio: 'Chess, spreadsheets, silence.', interests: ['chess'], personality: { openness: 10, conscientiousness: 90, extraversion: 5, agreeableness: 20, stability: 15 }, location: { label: 'Portland', lat: 45.51, lng: -122.68 } },
      preferences: { interestedIn: ['woman'], ageMin: 18, ageMax: 100, maxDistanceKm: 500 }
    });

    const ranked = M.rankCandidates(ALEX, [weak, blocked, RILEY], OPTS);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].uid, 'riley');
    assert.equal(ranked[1].uid, 'weak');
    assert.ok(ranked[0].score > ranked[1].score);
    ranked.forEach(function (r) { assert.equal(r.hardFail, null); });

    const withFails = M.rankCandidates(ALEX, [weak, blocked, RILEY], { corpus: CORPUS, now: NOW, includeHardFails: true });
    assert.equal(withFails.length, 3);
    assert.equal(withFails[withFails.length - 1].hardFail, 'blocked');
  });

  test('rankCandidates breaks ties deterministically', function () {
    // Identical twins: equal scores, so the uid decides.
    const twinB = clone(RILEY);
    twinB.uid = 'bravo';
    const twinA = clone(RILEY);
    twinA.uid = 'alpha';
    const ranked = M.rankCandidates(ALEX, [twinB, twinA], OPTS);
    assert.equal(ranked[0].score, ranked[1].score);
    assert.equal(ranked[0].uid, 'alpha');
    assert.equal(ranked[1].uid, 'bravo');

    // With activity weighted out, the more recently active profile wins first.
    const older = clone(RILEY);
    older.uid = 'aaa-older';
    older.lastActiveAt = '2026-02-01T00:00:00.000Z';
    const newer = clone(RILEY);
    newer.uid = 'zzz-newer';
    newer.lastActiveAt = NOW;
    const noActivity = { corpus: CORPUS, now: NOW, weights: { activity: 0 } };
    const byRecency = M.rankCandidates(ALEX, [older, newer], noActivity);
    assert.equal(byRecency[0].score, byRecency[1].score);
    assert.equal(byRecency[0].uid, 'zzz-newer');

    // Ordering is stable across repeated runs and input orders.
    const again = M.rankCandidates(ALEX, [twinA, twinB], OPTS);
    assert.deepEqual(again.map(function (r) { return r.uid; }), ranked.map(function (r) { return r.uid; }));
    assert.deepEqual(M.rankCandidates(ALEX, [], OPTS), []);
    assert.deepEqual(M.rankCandidates(ALEX, null, OPTS), []);
  });

  /* ----------------------------------------------------------------------
     Learning — §5.5
     ---------------------------------------------------------------------- */

  test('updateLearning rewards likes and is pure', function () {
    const before = { interestAffinity: {}, likeCount: 0, passCount: 0 };
    const after = M.updateLearning(before, RILEY, 'like');
    assert.notEqual(after, before, 'returns a new object');
    assert.deepEqual(before.interestAffinity, {}, 'input untouched');
    assert.equal(after.likeCount, 1);
    assert.equal(after.passCount, 0);
    assert.equal(after.interestAffinity.hiking, 0.15);
    assert.equal(after.interestAffinity.cooking, 0.15);
    assert.equal(Object.keys(after.interestAffinity).length, 4);
  });

  test('super likes learn faster than likes', function () {
    const like = M.updateLearning(null, RILEY, 'like');
    const superLike = M.updateLearning(null, RILEY, 'super');
    assert.equal(superLike.interestAffinity.hiking, 0.225);
    assert.ok(superLike.interestAffinity.hiking > like.interestAffinity.hiking);
    assert.equal(superLike.likeCount, 1, 'a super like counts as a like');
  });

  test('passes push affinity down and count separately', function () {
    const after = M.updateLearning({ interestAffinity: {}, likeCount: 4, passCount: 1 }, RILEY, 'pass');
    assert.equal(after.passCount, 2);
    assert.equal(after.likeCount, 4);
    assert.equal(after.interestAffinity.hiking, -0.0525);
    const unknown = M.updateLearning(after, RILEY, 'noop');
    assert.equal(unknown.likeCount, 4);
    assert.equal(unknown.passCount, 2, 'an unrecognised action changes nothing');
  });

  test('affinity stays clamped to [-1, 1] and rounds to 4dp', function () {
    let learning = { interestAffinity: {}, likeCount: 0, passCount: 0 };
    for (let i = 0; i < 200; i++) learning = M.updateLearning(learning, RILEY, 'super');
    Object.keys(learning.interestAffinity).forEach(function (slug) {
      const v = learning.interestAffinity[slug];
      assert.ok(v <= 1 && v >= -1, slug + ' clamped');
      assert.equal(Math.round(v * 10000) / 10000, v, 'rounded to 4dp');
    });
    assert.ok(learning.interestAffinity.hiking > 0.99);

    let down = { interestAffinity: { hiking: -5, cooking: 5 }, likeCount: 0, passCount: 0 };
    for (let j = 0; j < 200; j++) down = M.updateLearning(down, RILEY, 'pass');
    assert.ok(down.interestAffinity.hiking >= -1);
    assert.ok(down.interestAffinity.cooking >= -1 && down.interestAffinity.cooking <= 1);
  });

  test('updateLearning prunes noise and caps the map at 60 entries', function () {
    const noisy = M.updateLearning(
      { interestAffinity: { 'barely-there': 0.004, real: 0.4 }, likeCount: 1, passCount: 0 },
      mkUser('x', { profile: { interests: ['fresh'] } }),
      'like'
    );
    assert.equal(noisy.interestAffinity['barely-there'], undefined, 'sub-0.01 entries are pruned');
    assert.equal(noisy.interestAffinity.real, 0.4);
    assert.equal(noisy.interestAffinity.fresh, 0.15);

    const big = { interestAffinity: {}, likeCount: 0, passCount: 0 };
    for (let i = 0; i < 70; i++) big.interestAffinity['tag-' + i] = (i + 1) / 100;
    const capped = M.updateLearning(big, mkUser('y', { profile: { interests: ['tag-69'] } }), 'like');
    assert.equal(Object.keys(capped.interestAffinity).length, 60);
    assert.equal(capped.interestAffinity['tag-0'], undefined, 'weakest opinions are dropped first');
    assert.ok(capped.interestAffinity['tag-69'] > 0.7, 'strongest opinions survive and keep learning');
  });

  /* ----------------------------------------------------------------------
     Icebreakers, labels, explanations — §5.6
     ---------------------------------------------------------------------- */

  test('icebreakers are grounded, unique and fully formed', function () {
    const lines = M.icebreakers(ALEX, RILEY);
    assert.equal(lines.length, 3);
    assert.equal(new Set(lines).size, 3, 'no duplicates');
    lines.forEach(function (line) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 12);
      assert.ok(line.indexOf('{') === -1 && line.indexOf('}') === -1, 'no unfilled placeholder: ' + line);
      assert.ok(line.indexOf('undefined') === -1, 'no undefined: ' + line);
      assert.ok(/[?.]$/.test(line.trim()), 'reads as a finished sentence: ' + line);
    });
    assert.ok(lines[0].indexOf('Hiking') !== -1, 'leads with a shared interest');
    assert.deepEqual(M.icebreakers(ALEX, RILEY), lines, 'deterministic');
  });

  test('icebreakers fall back to generic openers when nothing is shared', function () {
    const stranger = mkUser('stranger', { profile: { age: 30, bio: '', interests: [], personality: null, location: null } });
    const lines = M.icebreakers(ALEX, stranger, { count: 4 });
    assert.equal(lines.length, 4);
    assert.equal(new Set(lines).size, 4);
    lines.forEach(function (line) {
      assert.ok(line.indexOf('{') === -1 && line.indexOf('}') === -1);
      assert.ok(line.length > 12);
    });
    assert.equal(M.icebreakers(ALEX, RILEY, { count: 1 }).length, 1);
    assert.ok(M.icebreakers(null, null).length >= 1, 'never returns nothing');
  });

  test('icebreakers use a shared city and a candidate\'s own words', function () {
    const local = clone(RILEY);
    local.profile.interests = [];
    const lines = M.icebreakers(ALEX, local, { count: 5 });
    assert.ok(lines.some(function (l) { return l.indexOf('Fellow Portland person') === 0; }));
    assert.ok(lines.some(function (l) { return /^Your bio mentions /.test(l); }));

    const elsewhere = clone(RILEY);
    elsewhere.profile.interests = [];
    elsewhere.profile.bio = '';
    elsewhere.profile.location = { label: 'Lisbon', lat: 38.7223, lng: -9.1393 };
    const away = M.icebreakers(ALEX, elsewhere, { count: 3 });
    assert.ok(away.some(function (l) { return l.indexOf('Lisbon') !== -1; }));
  });

  test('compatibilityLabel bands the whole range', function () {
    assert.equal(M.compatibilityLabel(92).label, 'Exceptional match');
    assert.equal(M.compatibilityLabel(85).tone, 'excellent');
    assert.equal(M.compatibilityLabel(74).label, 'Strong match');
    assert.equal(M.compatibilityLabel(60).label, 'Good match');
    assert.equal(M.compatibilityLabel(41).label, 'Worth a look');
    assert.equal(M.compatibilityLabel(12).label, 'Long shot');
    assert.equal(M.compatibilityLabel(0).tone, 'low');
    assert.equal(typeof M.compatibilityLabel(undefined).label, 'string');
    [0, 25, 50, 75, 100].forEach(function (n) {
      const band = M.compatibilityLabel(n);
      assert.ok(band.label.length > 0 && band.tone.length > 0);
    });
  });

  test('explain writes one readable sentence', function () {
    const r = M.scoreCandidate(ALEX, RILEY, OPTS);
    const line = M.explain(r);
    assert.ok(line.indexOf(M.compatibilityLabel(r.score).label) === 0);
    assert.ok(line.indexOf(String(r.score)) !== -1);
    assert.ok(/\.$/.test(line));
    assert.equal(line.indexOf('{'), -1);

    const rejected = M.scoreCandidate(ALEX, ALEX, OPTS);
    assert.ok(M.explain(rejected).indexOf('Not shown') === 0);
    assert.ok(/own profile/.test(M.explain(rejected)));
    assert.equal(typeof M.explain(null), 'string');

    const bland = M.explain({ score: 50, hardFail: null, reasons: [] });
    assert.ok(bland.length > 20 && /\.$/.test(bland));
  });

  /* ----------------------------------------------------------------------
     Golden end-to-end case
     ---------------------------------------------------------------------- */

  test('golden case: two well-matched Portland profiles', function () {
    const r = M.scoreCandidate(ALEX, RILEY, OPTS);

    assert.equal(r.uid, 'riley');
    assert.equal(r.profile, RILEY);
    assert.equal(r.hardFail, null);
    assert.ok(r.score >= 60 && r.score <= 75, 'score lands in the expected band, got ' + r.score);
    assert.deepEqual(r.shared.interests, ['hiking', 'live-music', 'cooking']);
    assert.ok(r.distanceKm !== null && r.distanceKm < 2);

    near(r.breakdown.interests, 0.75 * (3 / 5), 1e-12);
    assert.ok(r.breakdown.personality > 0.9, 'very compatible personalities');
    assert.ok(r.breakdown.bio > 0.1, 'bios genuinely overlap');
    assert.ok(r.breakdown.distance > 0.99);
    near(r.breakdown.age, 1 - 2 / 20, 1e-12);
    assert.ok(r.breakdown.activity > 0.9, 'active six hours ago');
    assert.equal(r.breakdown.affinity, 0.5);

    assert.equal(r.reasons.length, 4);
    assert.deepEqual(
      r.reasons.map(function (x) { return x.kind; }),
      ['personality', 'distance', 'interests', 'age'],
      'reasons are ordered by how much they moved the score'
    );
    assert.equal(M.explain(r), 'Good match (' + r.score + '%) — very similar outlook — you match closely on openness and warmth, and less than a km away.');
  });
})();
