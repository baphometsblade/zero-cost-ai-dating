/* ==========================================================================
   Zero Cost AI Dating — the matching engine
   A small, dependency-free recommender that runs entirely on the device: a
   TF-IDF/cosine model over bios, a weighted Jaccard over interests, vector
   compatibility over the personality axes, plus geo/age/recency signals and an
   optional per-user affinity model learned from swipes.
   Every function here is pure: no network, no storage, no DOM, and no clock
   reads inside scoring (pass `now` through opts so tests stay deterministic).
   Exposes: ZC.matching in the browser, module.exports in Node.
   ========================================================================== */
(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ZC = root.ZC || {};
  root.ZC.matching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------------
     1. Constants
     ------------------------------------------------------------------------ */

  const VERSION = '1.0.0';

  /** Component weights. Sums to exactly 1. Frozen: callers pass overrides in opts. */
  const DEFAULT_WEIGHTS = Object.freeze({
    interests: 0.28,
    bio: 0.16,
    personality: 0.22,
    distance: 0.14,
    age: 0.08,
    activity: 0.05,
    affinity: 0.07
  });

  const COMPONENTS = ['interests', 'bio', 'personality', 'distance', 'age', 'activity', 'affinity'];

  // Personality: the five axes, how much each one matters, and the words a
  // human would actually use for them.
  const AXES = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'stability'];
  const AXIS_WEIGHTS = {
    openness: 0.25,
    conscientiousness: 0.15,
    extraversion: 0.20,
    agreeableness: 0.25,
    stability: 0.15
  };
  const AXIS_LABELS = {
    openness: 'openness',
    conscientiousness: 'reliability',
    extraversion: 'social energy',
    agreeableness: 'warmth',
    stability: 'emotional steadiness'
  };

  // Learning model.
  const LEARNING_RATE = 0.15;
  const SUPER_MULTIPLIER = 1.5;
  const PASS_DAMPING = 0.35;
  const AFFINITY_PRUNE = 0.01;
  const AFFINITY_CAP = 60;

  // Scoring odds and ends.
  const NEUTRAL = 0.5;
  const ANYWHERE_KM = 500;
  const EARTH_RADIUS_KM = 6371;
  const DAY_MS = 86400000;
  const MAX_REASONS = 4;

  // Reasons are sorted by "strength", which is simply how much that component
  // actually contributed to the score (weight × component). Ties fall back to
  // this listed order, which is also the order of the default weights.
  const REASON_ORDER = ['interests', 'personality', 'bio', 'distance', 'age', 'activity'];

  // Compatibility bands, highest first.
  const LABEL_BANDS = [
    { min: 85, label: 'Exceptional match', tone: 'excellent' },
    { min: 70, label: 'Strong match', tone: 'strong' },
    { min: 55, label: 'Good match', tone: 'good' },
    { min: 40, label: 'Worth a look', tone: 'fair' },
    { min: -Infinity, label: 'Long shot', tone: 'low' }
  ];

  // Plain-English sentences for every hard filter, used by explain().
  const HARD_FAIL_COPY = {
    self: 'this is your own profile',
    blocked: 'one of you has blocked the other',
    swiped: 'you have already seen this profile',
    'not-discoverable': 'they have paused being shown in Discover',
    incomplete: 'their profile is not finished yet',
    gender: 'you are not in each other’s dating preferences',
    age: 'you are outside each other’s age preferences',
    distance: 'they are further away than your distance limit allows'
  };

  /**
   * ~130 English function words. Anything in here carries no signal about who a
   * person is, so it never reaches the TF-IDF vectors.
   */
  const STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are',
    'aren', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
    'came', 'can', 'cannot', 'come', 'could', 'did', 'does', 'doing', 'don', 'down',
    'during', 'each', 'else', 'even', 'ever', 'every', 'few', 'for', 'from', 'further',
    'get', 'gets', 'getting', 'going', 'gone', 'got', 'had', 'has', 'have', 'having',
    'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however',
    'into', 'its', 'itself', 'just', 'like', 'lot', 'lots', 'made', 'make', 'many',
    'maybe', 'me', 'might', 'mine', 'more', 'most', 'much', 'must', 'my', 'myself',
    'never', 'nor', 'not', 'now', 'off', 'once', 'one', 'only', 'onto', 'or', 'other',
    'others', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'per', 'pretty',
    'quite', 'rather', 'really', 'said', 'same', 'says', 'she', 'should', 'since',
    'some', 'someone', 'something', 'still', 'such', 'sure', 'take', 'than', 'that',
    'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they',
    'thing', 'things', 'this', 'those', 'though', 'through', 'too', 'two', 'under',
    'until', 'upon', 'use', 'used', 'very', 'want', 'was', 'way', 'were', 'what',
    'when', 'where', 'whether', 'which', 'while', 'who', 'whom', 'why', 'will',
    'with', 'without', 'would', 'yet', 'you', 'your', 'yours', 'yourself',
    // contracted forms survive tokenisation because apostrophes stay inside words
    'can\'t', 'didn\'t', 'doesn\'t', 'don\'t', 'he\'s', 'here\'s', 'i\'d', 'i\'ll',
    'i\'m', 'i\'ve', 'isn\'t', 'it\'s', 'let\'s', 'she\'s', 'that\'s', 'there\'s',
    'they\'re', 'we\'re', 'we\'ve', 'won\'t', 'you\'re', 'you\'ve'
  ]);

  // Icebreaker openers keyed by interest category, with a catch-all.
  const CATEGORY_OPENERS = {
    outdoors: 'what’s the best spot you’ve found this year?',
    arts: 'what’s the last one that really stuck with you?',
    food: 'what’s the best thing you’ve eaten lately?',
    music: 'what’s been on repeat for you?',
    fitness: 'how often do you actually get out there?',
    tech: 'what are you tinkering with at the moment?',
    travel: 'where did it take you last?',
    homebody: 'what does your ideal slow Sunday look like?',
    social: 'who do you usually drag along?',
    mindful: 'how did you get into it?'
  };
  // Used when the tag table is not loaded, cycled so three shared tags do not
  // produce three identical questions.
  const DEFAULT_OPENERS = [
    'how did you get into it?',
    'what got you hooked?',
    'what would you tell someone who is just starting out?'
  ];

  // Personality-flavoured openers, checked in this order.
  const PERSONALITY_OPENERS = [
    { axis: 'openness', high: true, text: 'What’s something you’ve completely changed your mind about?' },
    { axis: 'extraversion', high: true, text: 'What’s the best night out you’ve had this year?' },
    { axis: 'extraversion', high: false, text: 'What’s your ideal Sunday — the honest version?' },
    { axis: 'conscientiousness', high: true, text: 'What are you quietly working towards at the moment?' },
    { axis: 'agreeableness', high: true, text: 'Who do you always call first with good news?' },
    { axis: 'stability', high: true, text: 'What’s a small thing that reliably puts you in a good mood?' }
  ];

  const GENERIC_OPENERS = [
    'What’s something you’re weirdly good at?',
    'Best thing you’ve done in the last month?',
    'Coffee, cocktail or a long walk — how should a first date go?',
    'What’s the last thing that made you laugh out loud?',
    'What are you looking forward to this week?'
  ];

  /* ------------------------------------------------------------------------
     2. Small numeric and shape helpers
     ------------------------------------------------------------------------ */

  /** Clamp n into [lo, hi]. */
  function clamp(n, lo, hi) {
    return n < lo ? lo : (n > hi ? hi : n);
  }

  /** Finite number or null. */
  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  /** Round to 1 decimal place. */
  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  /** Round to 4 decimal places. */
  function round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  /** Milliseconds for an ISO string / Date / epoch number, or null. */
  function toTime(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'number') return isFinite(value) ? value : null;
    if (typeof value === 'string' && value) {
      const t = Date.parse(value);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  /** The `profile` sub-document, always an object. */
  function prof(user) {
    return (user && typeof user.profile === 'object' && user.profile) || {};
  }

  /** The `preferences` sub-document, always an object. */
  function prefs(user) {
    return (user && typeof user.preferences === 'object' && user.preferences) || {};
  }

  /** De-duplicated, trimmed, non-empty strings from an arbitrary value. */
  function uniqueStrings(list) {
    if (!Array.isArray(list)) return [];
    const seen = Object.create(null);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (typeof v !== 'string') continue;
      const s = v.trim();
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  /** Great-circle distance in km between two {lat,lng} points, or null. */
  function haversine(a, b) {
    if (!a || !b) return null;
    const lat1 = num(a.lat);
    const lng1 = num(a.lng);
    const lat2 = num(b.lat);
    const lng2 = num(b.lng);
    if (lat1 === null || lng1 === null || lat2 === null || lng2 === null) return null;
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /* ------------------------------------------------------------------------
     3. Interest tag metadata
     The canonical tag table lives in seed-data.js (ZC.INTEREST_BY_SLUG). The
     engine must also run in Node with no seed loaded, so metadata lookups are
     best-effort: an explicit index wins, then the global table, then a
     prettified slug. Scores never depend on a table being present beyond the
     documented category bonus.
     ------------------------------------------------------------------------ */

  const GLOBAL_SCOPE = typeof globalThis !== 'undefined' ? globalThis : null;

  /** The ambient tag table, if seed-data.js has been loaded. */
  function globalTagIndex() {
    const zc = GLOBAL_SCOPE && GLOBAL_SCOPE.ZC;
    const map = zc && zc.INTEREST_BY_SLUG;
    return map && typeof map === 'object' ? map : null;
  }

  /**
   * Normalise a caller-supplied tag index (array of tags or slug-keyed map)
   * into a slug-keyed map, falling back to the ambient one.
   */
  function resolveTagIndex(supplied) {
    if (Array.isArray(supplied)) {
      const map = Object.create(null);
      supplied.forEach(function (tag) {
        if (tag && typeof tag.slug === 'string') map[tag.slug] = tag;
      });
      return map;
    }
    if (supplied && typeof supplied === 'object') return supplied;
    return globalTagIndex();
  }

  /** 'live-music' -> 'Live Music'. */
  function prettifySlug(slug) {
    return String(slug)
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(function (word) { return word.charAt(0).toUpperCase() + word.slice(1); })
      .join(' ');
  }

  /** Human label for a tag slug — never empty. */
  function labelForTag(slug, index) {
    const tag = index && index[slug];
    if (tag && typeof tag.label === 'string' && tag.label.trim()) return tag.label.trim();
    return prettifySlug(slug);
  }

  /** Category for a tag slug, or null when unknown. */
  function categoryForTag(slug, index) {
    const tag = index && index[slug];
    if (tag && typeof tag.category === 'string' && tag.category.trim()) return tag.category.trim();
    return null;
  }

  /* ------------------------------------------------------------------------
     4. Text model — tokenise, TF-IDF, cosine
     ------------------------------------------------------------------------ */

  const WORD_RE = /[\p{L}\p{N}'’]+/gu;
  const DIACRITIC_RE = /\p{Diacritic}/gu;

  /**
   * Light suffix stemmer: enough to collapse the obvious plurals and verb
   * forms in a dating bio without dragging in a full Porter implementation.
   */
  function stem(word) {
    let w = word;
    if (w.length > 3 && w.slice(-2) === "'s") w = w.slice(0, -2);
    if (w.length > 4 && w.slice(-3) === 'ies') return w.slice(0, -3) + 'y';
    if (w.length > 4 && w.slice(-4) === 'sses') return w.slice(0, -2);
    if (w.length > 3 && w.slice(-1) === 's' && w.slice(-2) !== 'ss') w = w.slice(0, -1);
    if (w.length > 3 && w.slice(-3) === 'ing' && w.length - 3 >= 4) return w.slice(0, -3);
    if (w.length > 2 && w.slice(-2) === 'ed' && w.length - 2 >= 4) return w.slice(0, -2);
    return w;
  }

  /**
   * Scan text into {token, surface} pairs: `token` is the normalised stem used
   * for maths, `surface` is the original spelling so reasons and icebreakers
   * can quote the person's own words back at them.
   * @param {string} text
   * @returns {{token: string, surface: string}[]}
   */
  function scanTokens(text) {
    const out = [];
    if (typeof text !== 'string' || !text) return out;
    let match;
    WORD_RE.lastIndex = 0;
    while ((match = WORD_RE.exec(text)) !== null) {
      const surface = match[0].replace(/^['’]+|['’]+$/g, '');
      if (!surface) continue;
      const normalised = surface
        .normalize('NFD')
        .replace(DIACRITIC_RE, '')
        .replace(/’/g, "'")
        .toLowerCase();
      // Split rule from the contract: anything that is not a-z, 0-9 or an
      // apostrophe is a separator (so non-Latin scripts drop out here).
      const parts = normalised.split(/[^a-z0-9']+/);
      for (let i = 0; i < parts.length; i++) {
        const raw = parts[i].replace(/^'+|'+$/g, '');
        if (raw.length < 3) continue;
        if (STOPWORDS.has(raw)) continue;
        const token = stem(raw);
        if (token.length < 3) continue;
        out.push({ token: token, surface: parts.length === 1 ? surface : parts[i] });
      }
    }
    return out;
  }

  /**
   * Best original spelling for each token in a scan. A lower-case occurrence
   * wins over a capitalised one so a word that merely started a sentence is not
   * quoted back with a stray capital, while real proper nouns keep theirs.
   * @param {{token: string, surface: string}[]} scan
   * @returns {Object<string, string>} token -> surface
   */
  function surfaceIndex(scan) {
    const map = Object.create(null);
    scan.forEach(function (pair) {
      const current = map[pair.token];
      if (current === undefined) {
        map[pair.token] = pair.surface;
        return;
      }
      const currentIsUpper = current.charAt(0) !== current.charAt(0).toLowerCase();
      const nextIsLower = pair.surface.charAt(0) === pair.surface.charAt(0).toLowerCase();
      if (currentIsUpper && nextIsLower) map[pair.token] = pair.surface;
    });
    return map;
  }

  /**
   * Tokenise a bio into normalised, stemmed terms.
   * @param {string} text raw bio
   * @returns {string[]} tokens in document order (duplicates kept)
   */
  function tokenize(text) {
    return scanTokens(text).map(function (pair) { return pair.token; });
  }

  /**
   * Count term occurrences.
   * @param {string[]|string} tokens token array (or raw text, which is tokenised)
   * @returns {Object<string, number>} token -> count
   */
  function termFreq(tokens) {
    const list = Array.isArray(tokens) ? tokens : tokenize(tokens);
    const tf = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (typeof t !== 'string' || !t) continue;
      tf[t] = (tf[t] || 0) + 1;
    }
    return tf;
  }

  /**
   * Bio text for a profile-ish input: a UserDoc, a `{bio}` object or a string.
   * @param {*} input
   * @returns {string}
   */
  function bioOf(input) {
    if (typeof input === 'string') return input;
    if (!input || typeof input !== 'object') return '';
    const p = prof(input);
    if (typeof p.bio === 'string') return p.bio;
    if (typeof input.bio === 'string') return input.bio;
    return '';
  }

  /**
   * Build the IDF table used by the bio model.
   * Every entry passed in counts as one document, so `docCount` matches the
   * corpus you handed over even when some bios are empty.
   * @param {Array} profiles UserDocs (or plain strings / {bio} objects)
   * @returns {{idf: Object<string, number>, docCount: number}}
   */
  function buildCorpus(profiles) {
    const list = Array.isArray(profiles) ? profiles : [];
    const df = Object.create(null);
    let docCount = 0;

    list.forEach(function (entry) {
      docCount++;
      const seen = Object.create(null);
      tokenize(bioOf(entry)).forEach(function (token) {
        if (seen[token]) return;
        seen[token] = true;
        df[token] = (df[token] || 0) + 1;
      });
    });

    const idf = Object.create(null);
    Object.keys(df).forEach(function (token) {
      idf[token] = Math.log((docCount + 1) / (df[token] + 1)) + 1;
    });

    return { idf: idf, docCount: docCount };
  }

  /** IDF weight for a token, including tokens the corpus has never seen. */
  function idfFor(token, corpus) {
    if (!corpus || !corpus.idf) return 1;
    const known = corpus.idf[token];
    if (typeof known === 'number' && isFinite(known)) return known;
    const docCount = num(corpus.docCount) || 0;
    return Math.log(docCount + 1) + 1;
  }

  /**
   * TF-IDF vector for a bio.
   * @param {string[]|string} tokens tokens or raw text
   * @param {{idf: Object, docCount: number}} [corpus] omit for a plain TF vector
   * @returns {Object<string, number>} token -> weight
   */
  function tfidfVector(tokens, corpus) {
    const tf = termFreq(tokens);
    const vec = Object.create(null);
    Object.keys(tf).forEach(function (token) {
      vec[token] = tf[token] * idfFor(token, corpus);
    });
    return vec;
  }

  /**
   * Cosine similarity of two sparse vectors.
   * @param {Object<string, number>} a
   * @param {Object<string, number>} b
   * @returns {number} 0..1 for non-negative vectors
   */
  function cosine(a, b) {
    if (!a || !b) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    Object.keys(a).forEach(function (key) {
      const va = num(a[key]);
      if (va === null) return;
      normA += va * va;
      const vb = num(b[key]);
      if (vb !== null) dot += va * vb;
    });
    Object.keys(b).forEach(function (key) {
      const vb = num(b[key]);
      if (vb !== null) normB += vb * vb;
    });
    if (normA <= 0 || normB <= 0) return 0;
    return clamp(dot / (Math.sqrt(normA) * Math.sqrt(normB)), 0, 1);
  }

  /* ------------------------------------------------------------------------
     5. Component scores — each returns 0..1
     ------------------------------------------------------------------------ */

  /** Distinct categories covered by a set of slugs. */
  function categorySet(slugs, index) {
    const set = new Set();
    slugs.forEach(function (slug) {
      const cat = categoryForTag(slug, index);
      if (cat) set.add(cat);
    });
    return set;
  }

  /**
   * Interest overlap: Jaccard over slugs plus a bonus for sharing whole
   * categories, so "both outdoorsy" counts even when the exact tags differ.
   * @param {string[]} a my interest slugs
   * @param {string[]} b their interest slugs
   * @param {Object} [tagIndex] slug -> tag metadata (for the category bonus)
   * @returns {number} 0..1 (0 when either side has no interests)
   */
  function weightedJaccard(a, b, tagIndex) {
    const setA = uniqueStrings(a);
    const setB = uniqueStrings(b);
    if (!setA.length || !setB.length) return 0;

    const index = resolveTagIndex(tagIndex);
    const lookup = new Set(setB);
    let intersection = 0;
    setA.forEach(function (slug) { if (lookup.has(slug)) intersection++; });
    const union = setA.length + setB.length - intersection;
    const base = union > 0 ? intersection / union : 0;

    const catsA = categorySet(setA, index);
    const catsB = categorySet(setB, index);
    let sharedCats = 0;
    catsA.forEach(function (cat) { if (catsB.has(cat)) sharedCats++; });
    const catBonus = 0.5 * (sharedCats / Math.max(1, Math.min(catsA.size, catsB.size)));

    return clamp(0.75 * base + 0.25 * catBonus, 0, 1);
  }

  /** Per-axis compatibility, used by both personalityScore and the reasons. */
  function axisScores(a, b) {
    const pa = a && typeof a === 'object' ? a : {};
    const pb = b && typeof b === 'object' ? b : {};
    const out = Object.create(null);

    AXES.forEach(function (axis) {
      const va = num(pa[axis]);
      const vb = num(pb[axis]);
      if (va === null || vb === null) {
        out[axis] = NEUTRAL;
        return;
      }
      const gap = Math.abs(va - vb);
      if (axis === 'extraversion') {
        // Tolerant: a moderate gap between an introvert and an extravert is
        // fine, only the extremes are penalised.
        out[axis] = clamp(1 - Math.max(0, gap - 25) / 75, 0, 1);
      } else if (axis === 'stability') {
        // Half similarity, half "are you both in a steady place".
        out[axis] = clamp(0.5 * (1 - gap / 100) + 0.5 * ((va + vb) / 200), 0, 1);
      } else {
        out[axis] = clamp(1 - gap / 100, 0, 1);
      }
    });

    return out;
  }

  /**
   * Weighted personality compatibility. Symmetric in its arguments.
   * @param {Object} a my personality vector
   * @param {Object} b their personality vector
   * @returns {number} 0..1 (0.5 when either side has no data)
   */
  function personalityScore(a, b) {
    const axes = axisScores(a, b);
    let total = 0;
    AXES.forEach(function (axis) { total += AXIS_WEIGHTS[axis] * axes[axis]; });
    return clamp(total, 0, 1);
  }

  /**
   * Distance decay. Falls away faster than linearly so "across town" and
   * "across the country" do not look alike.
   * @param {number|null} km great-circle distance
   * @param {number} [capKm=500] the tighter of the two distance limits
   * @returns {number} 0..1 (0.5 when either location is missing)
   */
  function distanceScore(km, capKm) {
    const d = num(km);
    if (d === null) return NEUTRAL;
    let cap = num(capKm);
    if (cap === null || cap <= 0) cap = ANYWHERE_KM;
    cap = Math.min(cap, ANYWHERE_KM);
    return clamp(1 - Math.pow(Math.max(0, d) / cap, 1.5), 0, 1);
  }

  /**
   * Age closeness — a 20-year gap is the floor.
   * @param {number|null} ageA
   * @param {number|null} ageB
   * @returns {number} 0..1 (0.5 when either age is missing)
   */
  function ageScore(ageA, ageB) {
    const a = num(ageA);
    const b = num(ageB);
    if (a === null || b === null) return NEUTRAL;
    return clamp(1 - Math.min(1, Math.abs(a - b) / 20), 0, 1);
  }

  /**
   * Recency of activity, halving roughly every week.
   * @param {string|Date|number} lastActiveAt
   * @param {string|Date|number} now reference time (never read from the clock here)
   * @returns {number} 0..1 (0.3 when the timestamp is missing or unparseable)
   */
  function activityScore(lastActiveAt, now) {
    const then = toTime(lastActiveAt);
    const ref = toTime(now);
    if (then === null || ref === null) return 0.3;
    const days = Math.max(0, (ref - then) / DAY_MS);
    return clamp(1 / (1 + days / 7), 0, 1);
  }

  /** True when a learning doc actually holds signal worth using. */
  function hasLearningSignal(learning) {
    const map = learning && typeof learning.interestAffinity === 'object' && learning.interestAffinity;
    if (!map) return false;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
      const v = num(map[keys[i]]);
      if (v !== null && v !== 0) return true;
    }
    return false;
  }

  /**
   * How well a candidate's tags line up with what I have liked before.
   * @param {Object} learning my `learning` sub-document
   * @param {string[]} tags the candidate's interest slugs
   * @returns {number} 0..1 (0.5 with no learning data or no tags)
   */
  function affinityScore(learning, tags) {
    const slugs = uniqueStrings(tags);
    if (!slugs.length || !hasLearningSignal(learning)) return NEUTRAL;
    const map = learning.interestAffinity;
    let total = 0;
    slugs.forEach(function (slug) {
      const v = num(map[slug]);
      total += v === null ? 0 : clamp(v, -1, 1);
    });
    return clamp((total / slugs.length + 1) / 2, 0, 1);
  }

  /* ------------------------------------------------------------------------
     6. Weights
     ------------------------------------------------------------------------ */

  /**
   * Merge caller weights over the defaults, drop affinity when the adaptive
   * model is off, and rescale so the set always sums to 1 — a free-plan user
   * must never be quietly penalised for having no learning data.
   */
  function effectiveWeights(supplied, useAffinity) {
    const merged = {};
    COMPONENTS.forEach(function (key) {
      const custom = supplied && typeof supplied === 'object' ? num(supplied[key]) : null;
      const value = custom === null ? DEFAULT_WEIGHTS[key] : custom;
      merged[key] = value > 0 ? value : 0;
    });
    if (!useAffinity) merged.affinity = 0;

    let sum = 0;
    COMPONENTS.forEach(function (key) { sum += merged[key]; });
    if (sum <= 0) return effectiveWeights(null, false);

    const out = {};
    COMPONENTS.forEach(function (key) { out[key] = merged[key] / sum; });
    return out;
  }

  /* ------------------------------------------------------------------------
     7. Reasons — the sentence a person actually reads
     ------------------------------------------------------------------------ */

  /** "a", "a and b", "a, b and c" — no Oxford comma. */
  function joinList(items) {
    if (items.length <= 1) return items[0] || '';
    if (items.length === 2) return items[0] + ' and ' + items[1];
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /**
   * The two axes the pair agree on most, ranked the same way reasons are:
   * by contribution (axis weight × axis score), so the tolerant extraversion
   * axis does not crowd out the traits that carry more of the score.
   */
  function bestAxes(axes) {
    return AXES.slice()
      .sort(function (a, b) {
        const diff = (AXIS_WEIGHTS[b] * axes[b]) - (AXIS_WEIGHTS[a] * axes[a]);
        if (diff !== 0) return diff;
        return AXES.indexOf(a) - AXES.indexOf(b);
      })
      .slice(0, 2)
      .map(function (axis) { return AXIS_LABELS[axis]; });
  }

  /**
   * Turn a breakdown into at most four specific, human sentences.
   * Every branch is guarded: a reason is only emitted when the thing it talks
   * about actually exists, so no template can ship with a hole in it.
   */
  function buildReasons(ctx) {
    const b = ctx.breakdown;
    const found = [];

    // Shared interests — the strongest signal we can state plainly.
    if (b.interests >= 0.2 && ctx.sharedLabels.length) {
      const head = ctx.sharedLabels.slice(0, 3);
      const extra = ctx.sharedLabels.length - head.length;
      found.push({
        kind: 'interests',
        icon: '✨',
        text: 'You both love ' + joinList(head) + (extra > 0 ? ' +' + extra + ' more' : '')
      });
    }

    // Personality — name the two axes that line up best.
    if (b.personality >= 0.78 && ctx.hasPersonality) {
      const pair = bestAxes(ctx.axes);
      found.push({
        kind: 'personality',
        icon: '🧭',
        text: 'Very similar outlook — you match closely on ' + pair[0] + ' and ' + pair[1]
      });
    }

    // Bio overlap — quote their own words, not the stems.
    if (b.bio >= 0.15 && ctx.sharedSurfaces.length) {
      found.push({
        kind: 'bio',
        icon: '💬',
        text: 'Your bios both mention ' + joinList(ctx.sharedSurfaces.slice(0, 2))
      });
    }

    // Distance — only worth saying when it is genuinely close.
    if (ctx.distanceKm !== null && ctx.distanceKm <= 25) {
      found.push({
        kind: 'distance',
        icon: '📍',
        text: ctx.distanceKm < 1
          ? 'Less than a km away'
          : 'Just ' + Math.round(ctx.distanceKm) + ' km away'
      });
    }

    // Age.
    if (ctx.ageGap !== null && ctx.ageGap <= 3) {
      found.push({
        kind: 'age',
        icon: '🎂',
        text: ctx.ageGap === 0
          ? 'Same age'
          : 'Only ' + ctx.ageGap + (ctx.ageGap === 1 ? ' year apart' : ' years apart')
      });
    }

    // Recency.
    if (b.activity >= 0.7 && ctx.activityDays !== null) {
      found.push({
        kind: 'activity',
        icon: '⚡',
        text: ctx.activityDays < 1 ? 'Active today' : 'Active this week'
      });
    }

    // Strongest first — "strongest" meaning the component that actually moved
    // the score the most — with the documented order as the tie-break.
    return found
      .map(function (reason, i) {
        return {
          reason: reason,
          strength: ctx.weights[reason.kind] * b[reason.kind],
          seq: REASON_ORDER.indexOf(reason.kind) * 100 + i
        };
      })
      .sort(function (x, y) {
        if (y.strength !== x.strength) return y.strength - x.strength;
        return x.seq - y.seq;
      })
      .slice(0, MAX_REASONS)
      .map(function (entry) {
        return { icon: entry.reason.icon, text: entry.reason.text, kind: entry.reason.kind };
      });
  }

  /* ------------------------------------------------------------------------
     8. Scoring
     ------------------------------------------------------------------------ */

  /** A zero result for a candidate that failed a hard filter. */
  function failedResult(candidate, hardFail, distanceKm) {
    const breakdown = {};
    COMPONENTS.forEach(function (key) { breakdown[key] = 0; });
    return {
      uid: (candidate && typeof candidate.uid === 'string') ? candidate.uid : '',
      profile: candidate || null,
      score: 0,
      hardFail: hardFail,
      breakdown: breakdown,
      shared: { interests: [], tokens: [] },
      distanceKm: distanceKm === undefined ? null : distanceKm,
      reasons: []
    };
  }

  /** Mutual gender check — an empty or absent list means "open to all". */
  function genderMismatch(me, candidate) {
    const myList = uniqueStrings(prefs(me).interestedIn);
    const theirList = uniqueStrings(prefs(candidate).interestedIn);
    const myGender = prof(me).gender;
    const theirGender = prof(candidate).gender;
    if (myList.length && typeof theirGender === 'string' && myList.indexOf(theirGender) === -1) return true;
    if (theirList.length && typeof myGender === 'string' && theirList.indexOf(myGender) === -1) return true;
    return false;
  }

  /** Mutual age-range check. */
  function ageMismatch(me, candidate) {
    const myAge = num(prof(me).age);
    const theirAge = num(prof(candidate).age);
    const myMin = num(prefs(me).ageMin);
    const myMax = num(prefs(me).ageMax);
    const theirMin = num(prefs(candidate).ageMin);
    const theirMax = num(prefs(candidate).ageMax);
    if (theirAge !== null) {
      if (myMin !== null && theirAge < myMin) return true;
      if (myMax !== null && theirAge > myMax) return true;
    }
    if (myAge !== null) {
      if (theirMin !== null && myAge < theirMin) return true;
      if (theirMax !== null && myAge > theirMax) return true;
    }
    return false;
  }

  /** The tighter of two distance limits, defaulting to "anywhere". */
  function distanceCap(me, candidate) {
    const mine = num(prefs(me).maxDistanceKm);
    const theirs = num(prefs(candidate).maxDistanceKm);
    return Math.min(mine === null ? ANYWHERE_KM : mine, theirs === null ? ANYWHERE_KM : theirs);
  }

  /**
   * Score one candidate against me.
   * @param {Object} me my UserDoc
   * @param {Object} candidate their UserDoc
   * @param {Object} [opts] { corpus, now, weights, excludeIds, includeHardFails, adaptive, tagIndex }
   * @returns {Object} Result — see the contract, §5.1
   */
  function scoreCandidate(me, candidate, opts) {
    const o = opts || {};
    const now = o.now || new Date().toISOString();
    const corpus = o.corpus || null;
    const index = resolveTagIndex(o.tagIndex);
    const myProfile = prof(me);
    const theirProfile = prof(candidate);

    // Distance is computed up front: it is useful even on a rejected card.
    const km = haversine(myProfile.location, theirProfile.location);

    // --- Hard filters, in the contract's order. First hit wins. ---
    if (!candidate || typeof candidate !== 'object') return failedResult(candidate, 'incomplete', null);
    if (me && candidate.uid && me.uid === candidate.uid) return failedResult(candidate, 'self', km);

    const myBlocks = uniqueStrings(me && me.blocked);
    const theirBlocks = uniqueStrings(candidate.blocked);
    if (myBlocks.indexOf(candidate.uid) !== -1 || (me && theirBlocks.indexOf(me.uid) !== -1)) {
      return failedResult(candidate, 'blocked', km);
    }

    const excluded = Array.isArray(o.excludeIds) ? o.excludeIds : [];
    if (excluded.indexOf(candidate.uid) !== -1) return failedResult(candidate, 'swiped', km);

    if (prefs(candidate).discoverable === false) return failedResult(candidate, 'not-discoverable', km);

    if (!candidate.profileComplete || num(theirProfile.age) === null) {
      return failedResult(candidate, 'incomplete', km);
    }

    if (genderMismatch(me, candidate)) return failedResult(candidate, 'gender', km);
    if (ageMismatch(me, candidate)) return failedResult(candidate, 'age', km);

    const cap = distanceCap(me, candidate);
    if (km !== null && cap < ANYWHERE_KM && km > cap) return failedResult(candidate, 'distance', km);

    // --- Component scores ---
    const myTags = uniqueStrings(myProfile.interests);
    const theirTags = uniqueStrings(theirProfile.interests);
    const theirTagSet = new Set(theirTags);
    const sharedInterests = myTags.filter(function (slug) { return theirTagSet.has(slug); });

    const myBio = typeof myProfile.bio === 'string' ? myProfile.bio : '';
    const theirBio = typeof theirProfile.bio === 'string' ? theirProfile.bio : '';
    const myScan = scanTokens(myBio);
    const theirScan = scanTokens(theirBio);

    let bio = 0;
    if (myScan.length && theirScan.length) {
      bio = cosine(
        tfidfVector(myScan.map(function (p) { return p.token; }), corpus),
        tfidfVector(theirScan.map(function (p) { return p.token; }), corpus)
      );
    }

    // Shared bio terms, most distinctive first — these drive the bio reason.
    const mySet = new Set(myScan.map(function (p) { return p.token; }));
    const surfaces = surfaceIndex(theirScan);
    const seenShared = Object.create(null);
    const sharedTokens = [];
    theirScan.forEach(function (pair) {
      if (!mySet.has(pair.token) || seenShared[pair.token]) return;
      seenShared[pair.token] = true;
      sharedTokens.push(pair.token);
    });
    sharedTokens.sort(function (a, b) {
      const diff = idfFor(b, corpus) - idfFor(a, corpus);
      if (diff !== 0) return diff;
      return a < b ? -1 : (a > b ? 1 : 0);
    });

    const axes = axisScores(myProfile.personality, theirProfile.personality);
    const useAffinity = o.adaptive === true && hasLearningSignal(me && me.learning);

    const breakdown = {
      interests: weightedJaccard(myTags, theirTags, index),
      bio: bio,
      personality: personalityScore(myProfile.personality, theirProfile.personality),
      distance: distanceScore(km, Math.min(cap, ANYWHERE_KM)),
      age: ageScore(myProfile.age, theirProfile.age),
      activity: activityScore(candidate.lastActiveAt, now),
      affinity: useAffinity ? affinityScore(me.learning, theirTags) : NEUTRAL
    };

    const weights = effectiveWeights(o.weights, useAffinity);
    let total = 0;
    COMPONENTS.forEach(function (key) { total += weights[key] * breakdown[key]; });
    const score = round1(clamp(total * 100, 0, 100));

    // --- Reasons ---
    const myAge = num(myProfile.age);
    const theirAge = num(theirProfile.age);
    const activeAt = toTime(candidate.lastActiveAt);
    const nowMs = toTime(now);
    const reasons = buildReasons({
      breakdown: breakdown,
      weights: weights,
      sharedLabels: sharedInterests.map(function (slug) { return labelForTag(slug, index); }),
      hasPersonality: !!myProfile.personality && !!theirProfile.personality,
      axes: axes,
      sharedSurfaces: sharedTokens.map(function (token) { return surfaces[token]; }),
      distanceKm: km,
      ageGap: (myAge === null || theirAge === null) ? null : Math.abs(myAge - theirAge),
      activityDays: (activeAt === null || nowMs === null) ? null : Math.max(0, (nowMs - activeAt) / DAY_MS)
    });

    return {
      uid: typeof candidate.uid === 'string' ? candidate.uid : '',
      profile: candidate,
      score: score,
      hardFail: null,
      breakdown: breakdown,
      shared: { interests: sharedInterests, tokens: sharedTokens },
      distanceKm: km,
      reasons: reasons
    };
  }

  /**
   * Score and order a whole deck.
   * Hard-failed candidates are dropped unless `opts.includeHardFails` is set.
   * Sorted by score desc, then most-recently-active, then uid — fully
   * deterministic for a given input set.
   * @param {Object} me my UserDoc
   * @param {Object[]} candidates their UserDocs
   * @param {Object} [opts] same options as scoreCandidate
   * @returns {Object[]} Result[]
   */
  function rankCandidates(me, candidates, opts) {
    const o = opts || {};
    const list = Array.isArray(candidates) ? candidates : [];
    const results = [];

    list.forEach(function (candidate) {
      const result = scoreCandidate(me, candidate, o);
      if (result.hardFail && !o.includeHardFails) return;
      results.push(result);
    });

    return results.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      const ta = toTime(a.profile && a.profile.lastActiveAt);
      const tb = toTime(b.profile && b.profile.lastActiveAt);
      if ((tb || 0) !== (ta || 0)) return (tb || 0) - (ta || 0);
      return a.uid < b.uid ? -1 : (a.uid > b.uid ? 1 : 0);
    });
  }

  /* ------------------------------------------------------------------------
     9. Learning
     ------------------------------------------------------------------------ */

  /**
   * Fold one swipe into the affinity model. Pure — returns a new object.
   * Likes pull a tag's affinity towards +1, passes push it down gently; the map
   * is pruned and capped so the user document stays small.
   * @param {Object} learning previous `learning` sub-document
   * @param {Object} candidate the swiped UserDoc
   * @param {'like'|'super'|'pass'} action
   * @returns {Object} new learning sub-document
   */
  function updateLearning(learning, candidate, action) {
    const base = (learning && typeof learning === 'object') ? learning : {};
    const next = Object.assign({}, base);

    // Copy the existing map, dropping anything non-numeric.
    const map = Object.create(null);
    const prev = (base.interestAffinity && typeof base.interestAffinity === 'object') ? base.interestAffinity : {};
    Object.keys(prev).forEach(function (slug) {
      const v = num(prev[slug]);
      if (v !== null) map[slug] = clamp(v, -1, 1);
    });

    let likeCount = Math.max(0, Math.floor(num(base.likeCount) || 0));
    let passCount = Math.max(0, Math.floor(num(base.passCount) || 0));
    const tags = uniqueStrings(prof(candidate).interests);

    if (action === 'like' || action === 'super') {
      const rate = action === 'super' ? LEARNING_RATE * SUPER_MULTIPLIER : LEARNING_RATE;
      tags.forEach(function (slug) {
        const a = map[slug] || 0;
        map[slug] = a + rate * (1 - a);
      });
      likeCount++;
    } else if (action === 'pass') {
      tags.forEach(function (slug) {
        const a = map[slug] || 0;
        map[slug] = a - LEARNING_RATE * PASS_DAMPING * (1 + a);
      });
      passCount++;
    }

    // Clamp, round and prune the noise floor.
    const pruned = Object.create(null);
    Object.keys(map).forEach(function (slug) {
      const value = round4(clamp(map[slug], -1, 1));
      if (Math.abs(value) < AFFINITY_PRUNE) return;
      pruned[slug] = value;
    });

    // Cap the map, keeping the strongest opinions.
    let keys = Object.keys(pruned);
    if (keys.length > AFFINITY_CAP) {
      keys = keys.sort(function (a, b) {
        const diff = Math.abs(pruned[b]) - Math.abs(pruned[a]);
        if (diff !== 0) return diff;
        return a < b ? -1 : 1;
      }).slice(0, AFFINITY_CAP);
    }

    const capped = Object.create(null);
    keys.sort().forEach(function (slug) { capped[slug] = pruned[slug]; });

    next.interestAffinity = capped;
    next.likeCount = likeCount;
    next.passCount = passCount;
    return next;
  }

  /* ------------------------------------------------------------------------
     10. Icebreakers, labels and explanations
     ------------------------------------------------------------------------ */

  /**
   * Opening question for a shared interest, category-flavoured when the tag
   * table is available.
   */
  function interestOpener(slug, index, position) {
    const label = labelForTag(slug, index);
    const category = categoryForTag(slug, index);
    const tail = (category && CATEGORY_OPENERS[category]) ||
      DEFAULT_OPENERS[position % DEFAULT_OPENERS.length];
    return 'You’re into ' + label + ' too — ' + tail;
  }

  /** Opening question built from their strongest personality trait. */
  function personalityOpener(personality) {
    if (!personality || typeof personality !== 'object') return null;
    for (let i = 0; i < PERSONALITY_OPENERS.length; i++) {
      const rule = PERSONALITY_OPENERS[i];
      const value = num(personality[rule.axis]);
      if (value === null) continue;
      if (rule.high ? value >= 65 : value <= 35) return rule.text;
    }
    return null;
  }

  /**
   * Suggested opening messages, best-grounded first: shared interests, then
   * something from their bio, then their city, then personality, then generic.
   * Deterministic for a given pair — no randomness anywhere.
   * @param {Object} me my UserDoc
   * @param {Object} other their UserDoc
   * @param {{count?: number}} [opts]
   * @returns {string[]} unique, fully-formed sentences
   */
  function icebreakers(me, other, opts) {
    const o = opts || {};
    const count = Math.max(1, Math.floor(num(o.count) === null ? 3 : o.count));
    const index = resolveTagIndex(o.tagIndex);
    const myProfile = prof(me);
    const theirProfile = prof(other);
    const pool = [];

    // 1. Shared interests.
    const theirTags = uniqueStrings(theirProfile.interests);
    const theirSet = new Set(theirTags);
    uniqueStrings(myProfile.interests)
      .filter(function (slug) { return theirSet.has(slug); })
      .forEach(function (slug, i) { pool.push(interestOpener(slug, index, i)); });

    // 2. Something they wrote in their bio.
    const mineTokens = new Set(tokenize(typeof myProfile.bio === 'string' ? myProfile.bio : ''));
    const theirScan = scanTokens(typeof theirProfile.bio === 'string' ? theirProfile.bio : '');
    const theirSurfaces = surfaceIndex(theirScan);
    const seenSurface = Object.create(null);
    theirScan.forEach(function (pair) {
      if (!mineTokens.has(pair.token) || seenSurface[pair.token]) return;
      seenSurface[pair.token] = true;
      pool.push('Your bio mentions ' + theirSurfaces[pair.token] + '. How did that become your thing?');
    });

    // 3. Their city.
    const theirPlace = theirProfile.location && typeof theirProfile.location.label === 'string'
      ? theirProfile.location.label.trim()
      : '';
    const myPlace = myProfile.location && typeof myProfile.location.label === 'string'
      ? myProfile.location.label.trim()
      : '';
    if (theirPlace) {
      pool.push(myPlace && myPlace.toLowerCase() === theirPlace.toLowerCase()
        ? 'Fellow ' + theirPlace + ' person — got a coffee spot I should know about?'
        : 'What’s the best thing about ' + theirPlace + '? I keep meaning to visit.');
    }

    // 4. Personality flavour, then plain generics.
    const flavoured = personalityOpener(theirProfile.personality);
    if (flavoured) pool.push(flavoured);
    GENERIC_OPENERS.forEach(function (line) { pool.push(line); });

    // Unique, complete sentences only — a template with a hole in it never ships.
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < pool.length && out.length < count; i++) {
      const line = pool[i];
      if (typeof line !== 'string') continue;
      const text = line.trim();
      if (!text || seen[text]) continue;
      if (text.indexOf('{') !== -1 || text.indexOf('}') !== -1 || text.indexOf('undefined') !== -1) continue;
      seen[text] = true;
      out.push(text);
    }
    return out;
  }

  /**
   * Band a 0..100 score into a label and a tone key for the UI.
   * @param {number} score
   * @returns {{label: string, tone: string}}
   */
  function compatibilityLabel(score) {
    const value = num(score) === null ? 0 : clamp(score, 0, 100);
    for (let i = 0; i < LABEL_BANDS.length; i++) {
      if (value >= LABEL_BANDS[i].min) return { label: LABEL_BANDS[i].label, tone: LABEL_BANDS[i].tone };
    }
    return { label: LABEL_BANDS[LABEL_BANDS.length - 1].label, tone: LABEL_BANDS[LABEL_BANDS.length - 1].tone };
  }

  /** Lowercase the first letter of a sentence fragment so it can be joined on. */
  function lowerFirst(text) {
    if (!text) return '';
    // Leave acronym-ish starts alone.
    if (text.length > 1 && text[1] === text[1].toUpperCase() && /[A-Z]/.test(text[1])) return text;
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  /**
   * One sentence explaining a Result, suitable for a tooltip or a card footer.
   * @param {Object} result a scoreCandidate() result
   * @returns {string}
   */
  function explain(result) {
    if (!result || typeof result !== 'object') return 'No match data available.';

    if (result.hardFail) {
      const why = HARD_FAIL_COPY[result.hardFail] || 'they do not fit your filters';
      return 'Not shown — ' + why + '.';
    }

    const band = compatibilityLabel(result.score);
    const head = band.label + ' (' + round1(num(result.score) || 0) + '%)';
    const reasons = Array.isArray(result.reasons) ? result.reasons : [];

    if (!reasons.length) return head + ' — nothing stands out yet, but the basics line up.';
    if (reasons.length === 1) return head + ' — ' + lowerFirst(reasons[0].text) + '.';
    return head + ' — ' + lowerFirst(reasons[0].text) + ', and ' + lowerFirst(reasons[1].text) + '.';
  }

  /* ------------------------------------------------------------------------
     11. Public surface
     ------------------------------------------------------------------------ */

  return {
    VERSION: VERSION,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    buildCorpus: buildCorpus,
    scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates,
    updateLearning: updateLearning,
    icebreakers: icebreakers,
    compatibilityLabel: compatibilityLabel,
    explain: explain,
    _internal: {
      tokenize: tokenize,
      termFreq: termFreq,
      tfidfVector: tfidfVector,
      cosine: cosine,
      weightedJaccard: weightedJaccard,
      personalityScore: personalityScore,
      distanceScore: distanceScore,
      ageScore: ageScore,
      activityScore: activityScore,
      affinityScore: affinityScore,
      STOPWORDS: STOPWORDS
    }
  };
});
