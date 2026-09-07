/* ==========================================================================
   What a deck load costs, and why it used to cost more every week.

   `listCandidates` is the most expensive read path in the app and, until this
   file, the only major one nothing counted. It walks the public `discovery`
   collection newest-active first and has to exclude everybody the viewer has
   already swiped on — and it answered that by reading the viewer's ENTIRE
   swipe history, on every deck load. Measured against this emulator before the
   change, at the deck size the app actually asks for (60) against a pool of
   300: **122 reads for a fresh account, 221 after a hundred swipes, 321 after
   two hundred**, and 127 flat at all three afterwards. Those are the numbers
   the README and `docs/ARCHITECTURE.md` quote; the checks below use a smaller
   deck and a smaller pool so their arithmetic can be written out term by term,
   so do not expect 122 to appear in this file. One read per swipe ever made,
   spent again every time somebody opens the deck, against 50,000 a day for the
   whole deployment.

   This is the same defect `specs/09-read-cost.store.js` exists for, in the
   same file, two functions apart. `getLikesReceived` had it and was fixed;
   `listCandidates` had it and the comment above it argued it could not be —
   that the exclusion "cannot do that one id at a time". It can. Swipe ids are
   derived from the pair, so the ids are known without reading anything, and a
   key query bills the documents it returns with a floor of one: sixty people
   asked about ten at a time costs six reads when none of them are swiped.

   Ten at a time, and not thirty, because the binding limit is not Firestore's.
   The swipes read rule is evaluated once per value in an `in` list and
   `firestore.rules` allows 1000 expressions per request; measured with the real
   ruleset, 20 is allowed and 25 is `permission-denied`, in the same place
   whether none, half or all of the documents exist.
   `rules-tests/specs/08-budget.rules.js` pins that, so a rule that grows more
   expensive fails there rather than in somebody's deck.

   What is checked here, in the order somebody would doubt it:

     1. The deck is still right — self, blocks and swipes all excluded, limit
        honoured. A cost check alone passes against a function returning
        nothing, so the correctness checks come first and the cost checks carry
        a floor.
     2. The bill does not grow with the history behind it. This is the check
        the file exists for, and it is a scaling property rather than a number
        because a number ages into a lie.
     3. The lookups are batched — sixty people cost six reads, not sixty.
     4. Only the room the deck has left is asked about.
     5. Somebody the mutual filters exclude is never asked about at all, which
        is what the filter reordering buys.
     6. When the batched query is refused, the deck still loads — and still
        excludes, which is a separate thing and needs its own swipes to prove.
   ========================================================================== */
'use strict';

/** How many candidates to ask for. Smaller than the app's 60, to keep the arithmetic legible. */
const LIMIT = 20;

/**
 * The page size the store derives from that limit: `min(200, max(60, limit*2))`.
 * Repeated rather than imported because the store does not export it — and a
 * check whose expected numbers came from the same expression as the code would
 * agree with it however wrong both were.
 */
const PAGE = 60;

/** The store's `in` batch size, likewise repeated on purpose. */
const BATCH = 10;

module.exports = {
  title: 'A deck load does not cost more the longer you have used the app',

  async run(t, k) {
    const me = 'deck-me';

    /** Run one call with the store's Firestore swapped for a counting stand-in. */
    async function measure(fn) {
      const real = k.ctx.ZC.firebase.db;
      const tally = { reads: 0, calls: 0 };
      k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
      try {
        const value = await fn();
        return { value: value, reads: tally.reads, calls: tally.calls };
      } finally {
        k.ctx.ZC.firebase.db = real;
      }
    }

    function deck(options) {
      return measure(function () { return k.store.listCandidates(me, options || { limit: LIMIT }); });
    }

    function uidsOf(list) {
      return (list || []).map(function (u) { return u.uid; }).sort();
    }

    await k.admin.set('users', me, k.h.userDoc(me));

    /* ---- a population, all of it eligible ----------------------------- */

    const pool = [];
    const seeded = [];
    for (let i = 0; i < PAGE; i += 1) {
      const them = 'deck-p-' + String(i).padStart(3, '0');
      pool.push(them);
      seeded.push({
        id: them,
        data: k.h.discoveryDoc(them, {
          // Ascending, so the newest-active page is a known slice of the pool.
          lastActiveAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString()
        })
      });
    }
    await k.admin.setMany('discovery', seeded);

    /* ---- 1. the deck is right before it is cheap ----------------------- */

    const first = await deck();
    k.ctx.drainWarnings();

    t.check('a fresh account gets a full deck',
      first.value.length === LIMIT, first.value.length + ' of ' + LIMIT);

    t.check('and it is the most recently active people, newest first',
      first.value[0] && first.value[0].uid === pool[pool.length - 1] &&
        first.value.every(function (u) { return u.uid !== me; }),
      'top of the deck is ' + (first.value[0] || {}).uid + ', newest seeded is ' + pool[pool.length - 1]);

    /* ---- 2. the bill, and that it does not grow ------------------------ */

    // A history of swipes on people who are NOT in the pool. That is the whole
    // point: the deck it produces is identical, so anything the second
    // measurement costs above the first is the history and nothing else.
    async function addHistory(from, count) {
      const swipes = [];
      for (let i = from; i < from + count; i += 1) {
        const them = 'deck-gone-' + String(i).padStart(4, '0');
        swipes.push({
          id: me + '_' + them,
          data: { from: me, to: them, action: 'pass', createdAt: '2026-01-01T00:00:00.000Z' }
        });
      }
      await k.admin.setMany('swipes', swipes);
    }

    await addHistory(0, 50);
    const short = await deck();
    k.ctx.drainWarnings();

    await addHistory(50, 150);
    const long = await deck();
    k.ctx.drainWarnings();

    t.check('the same deck comes back whatever the history behind it',
      k.same(uidsOf(short.value), uidsOf(long.value)) && long.value.length === LIMIT,
      long.value.length + ' candidates, identical to the run at 50 swipes');

    // The check this file exists for. Not "under N reads" — a number ages into a
    // lie the first time somebody adds a field. Four times the history, the same
    // bill. The floor is not padding: equality between two measurements is
    // satisfied by two measurements of nothing, and reading the whole history
    // was ALSO stable at a fixed history, so without the floor a version that
    // still read it would pass whenever the two runs happened to match.
    t.check('and costs exactly what it cost before, with four times the history',
      short.reads === long.reads && long.reads >= LIMIT,
      short.reads + ' reads at 50 swipes, ' + long.reads + ' at 200 — reading the history ' +
      'itself would have made those 71 and 221');

    /* ---- 3. the lookups are batched ------------------------------------ */

    // Every term named, so a change to any of them is legible rather than a
    // number that moved: one `users/{me}`, one page of the discovery walk, and
    // the swipe lookups for the people the deck actually takes.
    const expected = 1 + PAGE + Math.ceil(LIMIT / BATCH);
    t.check('a deck load is the account, one page, and ' + Math.ceil(LIMIT / BATCH) +
      ' batched swipe lookups',
      long.reads === expected,
      long.reads + ' read(s): 1 for users/' + me + ', ' + PAGE + ' for the page, and ' +
      Math.ceil(LIMIT / BATCH) + ' for ' + LIMIT + ' people asked about ' + BATCH +
      ' at a time. One read each would make it ' + (1 + PAGE + LIMIT));

    /* ---- 4. and only for the room the deck has left -------------------- */

    const half = await deck({ limit: BATCH });
    k.ctx.drainWarnings();

    t.check('asking for ' + BATCH + ' asks about ' + BATCH + ', not about the whole page',
      half.value.length === BATCH && half.reads === 1 + PAGE + 1,
      half.reads + ' read(s) for a deck of ' + half.value.length + ' — one batch, not the ' +
      Math.ceil(PAGE / BATCH) + ' the page would need');

    /* ---- 5. people the filters exclude are never asked about ----------- */

    // Most of the pool re-seeded well outside the viewer's age preferences, so
    // the mutual pre-filter drops them. If the swipe lookup ran before that
    // filter — which is the order this code used to have, because the lookup was
    // free once the whole history was in hand — it would ask about them too.
    //
    // They are re-stamped as the NEWEST people in the pool, and that detail is
    // the whole check. A first pass put them at the oldest end, where the deck
    // fills from the eligible people ahead of them and never reaches them
    // whichever order the filters run in: the check passed against a build with
    // the lookup deliberately moved in front of the filter, which is to say it
    // was measuring nothing. Newest-first is the only arrangement where the
    // wrong order actually costs something.
    const ineligible = pool.slice(0, PAGE - LIMIT);
    await k.admin.setMany('discovery', ineligible.map(function (them, i) {
      return {
        id: them,
        data: k.h.discoveryDoc(them, {
          lastActiveAt: new Date(Date.UTC(2026, 1, 1) + i * 60000).toISOString(),
          profile: Object.assign(k.h.discoveryDoc(them).profile, { age: 71 })
        })
      };
    }));

    const filtered = await deck();
    k.ctx.drainWarnings();

    t.check('the deck skips everybody outside the viewer\'s age range',
      filtered.value.length === LIMIT &&
        filtered.value.every(function (u) { return ineligible.indexOf(u.uid) === -1; }),
      filtered.value.length + ' candidate(s), none of the ' + ineligible.length + ' ineligible');

    t.check('and never spends a read asking whether it had swiped on them',
      filtered.reads === expected,
      filtered.reads + ' read(s), the same as when the whole page was eligible. Asking first ' +
      'and filtering after would make it ' + (1 + PAGE + Math.ceil(PAGE / BATCH)));

    /* ---- 6. and the deck loads even when the batch query is refused ---- */

    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0 };
    let refused = 0;
    // A Firestore whose `swipes` collection refuses the batched form. This is
    // the shape of the rules budget running out — the failure the batch size
    // was chosen to stay clear of, injected so the fallback is executed rather
    // than assumed.
    const refusing = new Proxy(k.h.countingDb(real, tally), {
      get: function (obj, prop) {
        const value = obj[prop];
        if (prop !== 'collection') return value;
        return function (name) {
          const col = value.apply(obj, arguments);
          if (name !== 'swipes') return col;
          return new Proxy(col, {
            get: function (c, p) {
              if (p !== 'where') return c[p];
              return function () {
                refused += 1;
                throw new Error('rules expression budget exceeded');
              };
            }
          });
        };
      }
    });

    let fallback;
    k.ctx.ZC.firebase.db = refusing;
    try {
      fallback = await k.store.listCandidates(me, { limit: LIMIT });
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    const warned = k.ctx.drainWarnings();

    t.check('a refused batch query still produces the deck, one read per person',
      refused > 0 && fallback.length === LIMIT && tally.reads === 1 + PAGE + LIMIT,
      refused + ' refusal(s), ' + fallback.length + ' candidate(s), ' + tally.reads +
      ' read(s) — dearer than ' + expected + ', still bounded by the people considered ' +
      'rather than by the history');

    t.check('and it says so, rather than failing quietly into a cheaper wrong answer',
      warned.some(function (w) { return /Batched swipe lookup unavailable/.test(w); }),
      k.show(warned.slice(0, 2)));

    /* ---- 7. and the exclusion still works through the fallback --------- */

    const taken = fallback.map(function (u) { return u.uid; }).slice(0, 5);
    await k.admin.setMany('swipes', taken.map(function (them) {
      return {
        id: me + '_' + them,
        data: { from: me, to: them, action: 'like', createdAt: '2026-01-02T00:00:00.000Z' }
      };
    }));

    // The fallback again, now that there is something for it to find. The check
    // above proves it produces a deck and what that costs; it could not prove it
    // excludes anybody, because at that point nothing in the pool had been
    // swiped and an exclusion step that found nothing looks identical to one
    // that does not work. This is the path that only runs when something has
    // already gone wrong, so "it returns the right number of cards" is not
    // enough to know about it.
    let excluded;
    k.ctx.ZC.firebase.db = refusing;
    try {
      excluded = await k.store.listCandidates(me, { limit: LIMIT });
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    t.check('and one read at a time still excludes the people it finds',
      taken.every(function (them) {
        return excluded.map(function (u) { return u.uid; }).indexOf(them) === -1;
      }) && excluded.length === LIMIT - taken.length,
      excluded.length + ' candidate(s) through the fallback, none of them the ' +
      taken.length + ' just swiped on');

    const after = await deck();
    k.ctx.drainWarnings();

    // Exactly five short, not "still full": the step above left the pool with
    // precisely LIMIT eligible people in it, so the deck shrinking by the five
    // that were swiped is the strongest form of this check available — a deck
    // that still came back full would mean the exclusion had not happened.
    t.check('somebody already swiped on does not come back in the next deck',
      taken.every(function (them) { return uidsOf(after.value).indexOf(them) === -1; }) &&
        after.value.length === LIMIT - taken.length,
      'swiped ' + k.show(taken) + ', and none of them are in the ' + after.value.length +
      ' returned — ' + LIMIT + ' eligible people less the ' + taken.length + ' just answered');

    // Both extra terms named. Four of the five are the lookups: the batch that
    // holds all five swiped people now bills five instead of its empty floor of
    // one. The fifth is the walk asking for a second page, which it does because
    // the deck could not be filled — an empty result still bills one read, and
    // that is the cost of a deck the population cannot fill rather than a cost
    // of the change.
    const emptyPage = 1;
    t.check('and the extra reads are the swipes it found, plus the page it went looking on',
      after.reads === expected + (taken.length - 1) + emptyPage,
      after.reads + ' read(s) against ' + expected + ' when nothing was swiped: the batch ' +
      'carrying all ' + taken.length + ' now bills ' + taken.length + ' rather than its floor ' +
      'of 1, and one more for the empty second page the unfilled deck asked for');
  }
};
