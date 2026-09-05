/* ==========================================================================
   The conversation list, pushed rather than polled — and what that costs.

   `matches.html` refreshed its list on a twenty-second timer that called
   `getMatches`, which reads every match document AND a `discovery/{uid}` for
   each of them. Measured against this emulator: exactly 2N reads a tick. At ten
   conversations that is 3,600 reads an hour from one open tab, 86,400 a day —
   1.7x the entire 50,000-a-day Spark quota, from one person leaving one tab
   open.

   `listenMatchViews` is the same answer, pushed. Three claims, and each is a
   claim about BILLING rather than about code, which is why they are counted
   here rather than reasoned about in a comment:

     1. The rows are free, because the badge is already paying for them. Both
        subscriptions share one stream, so a page holding two costs what a page
        holding one costs.
     2. A face is fetched once per person per page, not once per delivery.
     3. Sitting still costs nothing, and one conversation changing costs one
        read — for BOTH subscribers together, not one each.

   The counting stand-in is `harness.countingDb`, the same one
   `specs/11-live-cost.store.js` uses: it counts a listener's deltas rather than
   its payload, because a snapshot carrying twelve rows because one of them moved
   is one read and not twelve.
   ========================================================================== */
'use strict';

/** Conversations to seed. Enough that "one read per match" is not one read. */
const MATCHES = 6;

/** How long to sit still before claiming nothing was billed. */
const IDLE_MS = 1200;

/**
 * Wait until `test()` answers true, or give up. Deliveries here arrive over a
 * network round trip, so a fixed sleep is either flaky or slow; this is neither.
 * @param {Function} test the condition
 * @param {number} ms how long to wait for it
 * @returns {Promise<boolean>} whether it came true
 */
function until(test, ms) {
  return new Promise(function (resolve) {
    const started = Date.now();
    const timer = setInterval(function () {
      let ok = false;
      try { ok = !!test(); } catch (err) { ok = false; }
      if (ok || Date.now() - started > ms) {
        clearInterval(timer);
        resolve(ok);
      }
    }, 25);
  });
}

module.exports = {
  title: 'The conversation list costs the data once, then only what changes',

  async run(t, k) {
    const me = 'views-me';
    await k.admin.set('users', me, k.h.userDoc(me));

    const ids = [];
    const others = [];
    const seeded = [];
    for (let i = 0; i < MATCHES; i += 1) {
      const them = 'views-them-' + String(i).padStart(2, '0');
      const id = [me, them].sort().join('_');
      ids.push(id);
      others.push(them);
      const unread = {};
      unread[me] = i % 3;
      unread[them] = 0;
      seeded.push({
        id: id,
        data: {
          id: id, users: [me, them].sort(), createdAt: '2026-01-01T00:00:00.000Z',
          lastMessage: null, lastMessageAt: null, unread: unread
        }
      });
    }
    await k.admin.setMany('matches', seeded);
    // A public projection each, which is where the faces come from.
    await k.admin.setMany('discovery', others.map(function (them) {
      return { id: them, data: k.h.discoveryDoc(them, { displayName: 'Person ' + them.slice(-2) }) };
    }));

    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);

    /** Wait for a listener's first delivery, or give up. */
    function firstOf(subscribe) {
      return new Promise(function (resolve) {
        let settled = false;
        const timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, 10000);
        const stop = subscribe(function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ value: value, stop: stop });
        });
      });
    }

    const badgeRows = [];
    const listViews = [];
    let stopBadge = function () { /* replaced */ };
    let stopList = function () { /* replaced */ };

    try {
      /* ---- 1. the badge subscribes first, exactly as app.js does -------- */

      const badge = await firstOf(function (cb) {
        stopBadge = k.store.listenMatches(me, function (rows) { badgeRows.push(rows); cb(rows); });
        return stopBadge;
      });
      const afterBadge = tally.reads;

      t.check('the badge subscription costs one read per match, as it always did',
        afterBadge === MATCHES && badge && badge.value.length === MATCHES,
        tally.reads + ' read(s) for ' + MATCHES + ' matches, ' +
        (badge ? badge.value.length : 'nothing') + ' row(s) delivered');

      /* ---- 2. the list joins, and pays only for the faces --------------- */

      const list = await firstOf(function (cb) {
        stopList = k.store.listenMatchViews(me, function (views) { listViews.push(views); cb(views); });
        return stopList;
      });
      const facesCost = tally.reads - afterBadge;

      t.check('the conversation list then costs the faces and nothing else',
        facesCost === MATCHES,
        facesCost + ' read(s) on top of the badge — one profile per conversation is ' + MATCHES +
        '; a second match query would make it ' + (MATCHES * 2));

      t.check('and every conversation it delivers carries a name',
        !!list && list.value.length === MATCHES &&
          list.value.every(function (v) { return !!(v.other && v.other.displayName); }),
        list ? list.value.map(function (v) { return v.other.displayName; }).join(', ') : 'timed out');

      t.check('which is the whole point: the rows were already paid for',
        tally.reads === MATCHES * 2,
        tally.reads + ' read(s) total for a page holding both — the poll it replaces spent ' +
        (MATCHES * 2) + ' every twenty seconds, forever');

      /* ---- 3. and then nothing, until something happens ----------------- */

      const settledReads = tally.reads;
      const settledDeliveries = listViews.length;
      await new Promise(function (resolve) { setTimeout(resolve, IDLE_MS); });

      t.check('sitting still for ' + IDLE_MS + 'ms costs nothing at all',
        tally.reads === settledReads && listViews.length === settledDeliveries,
        tally.reads + ' read(s), was ' + settledReads + '; ' +
        listViews.length + ' delivery(s), was ' + settledDeliveries);

      /* ---- 4. one conversation changing costs one read, for both -------- */

      const before = tally.reads;
      const badgeBefore = badgeRows.length;
      const listBefore = listViews.length;
      const bumped = {};
      bumped[me] = 4;
      bumped[others[0]] = 0;
      await k.admin.set('matches', ids[0], Object.assign({}, seeded[0].data, {
        unread: bumped, lastMessage: 'hello', lastMessageAt: '2026-02-01T00:00:00.000Z'
      }));
      await until(function () { return listViews.length > listBefore; }, 5000);

      t.check('one conversation changing costs exactly one read, for both subscribers together',
        tally.reads - before === 1,
        (tally.reads - before) + ' read(s) — two unshared subscriptions would bill 2, and ' +
        're-fetching the faces would bill ' + (1 + MATCHES));

      t.check('and both of them were told about it',
        badgeRows.length > badgeBefore && listViews.length > listBefore,
        'badge ' + badgeBefore + '->' + badgeRows.length + ', list ' + listBefore + '->' + listViews.length);

      const latest = listViews[listViews.length - 1] || [];
      const moved = latest.filter(function (v) { return v.matchId === ids[0]; })[0];
      t.check('with the new preview and the new unread count on the view, not just the row',
        !!moved && moved.lastMessage === 'hello' && moved.unread === 4 && !!moved.other.displayName,
        moved ? k.show({ lastMessage: moved.lastMessage, unread: moved.unread, name: moved.other.displayName }) : 'row missing');

      /* ---- 5. a new match with a stranger: one row, one face ------------ */

      const beforeNew = tally.reads;
      const deliveriesBeforeNew = listViews.length;
      const stranger = 'views-stranger';
      const strangerId = [me, stranger].sort().join('_');
      await k.admin.set('discovery', stranger, k.h.discoveryDoc(stranger, { displayName: 'A Stranger' }));
      await k.admin.set('matches', strangerId, {
        id: strangerId, users: [me, stranger].sort(), createdAt: '2026-03-01T00:00:00.000Z',
        lastMessage: null, lastMessageAt: null, unread: { [me]: 0, [stranger]: 0 }
      });
      await until(function () {
        const rows = listViews[listViews.length - 1] || [];
        return rows.some(function (v) { return v.matchId === strangerId; });
      }, 5000);

      t.check('a brand-new match with somebody never seen costs one row and one face',
        tally.reads - beforeNew === 2,
        (tally.reads - beforeNew) + ' read(s) — re-fetching every profile would bill ' + (1 + MATCHES + 1));

      const withStranger = listViews[listViews.length - 1] || [];
      t.check('and the people already in the list were not re-read to add them',
        withStranger.length === MATCHES + 1 &&
          withStranger.every(function (v) { return !!(v.other && v.other.displayName); }) &&
          listViews.length > deliveriesBeforeNew,
        withStranger.length + ' conversation(s), all named');

      /* ---- 6. the other side ending it removes the row ------------------ */

      const beforeGone = tally.reads;
      await k.admin.del('matches', strangerId);
      await until(function () {
        const rows = listViews[listViews.length - 1] || [];
        return !rows.some(function (v) { return v.matchId === strangerId; });
      }, 5000);

      t.check('a conversation the other side ends leaves the list, for one read',
        tally.reads - beforeGone === 1 &&
          (listViews[listViews.length - 1] || []).length === MATCHES,
        (tally.reads - beforeGone) + ' read(s), ' +
        (listViews[listViews.length - 1] || []).length + ' conversation(s) left');
    } finally {
      stopList();
      stopBadge();
      k.ctx.ZC.firebase.db = real;
    }

    /* ---- 6b. a profile read that lands late must not put the old list back */

    // The out-of-order case, staged rather than hoped for. A conversation is
    // added (its face has to be fetched, and that fetch is held open) and then
    // REMOVED while the fetch is still outstanding. The removal needs no new
    // face, so it is delivered first; the addition finishes afterwards, carrying
    // the older list. Without a sequence token the page would end up showing a
    // conversation that no longer exists — and it would stay there, because
    // nothing else is coming.
    const held = [];
    function holdingDb(target) {
      return {
        collection: function (name) {
          const real = target.collection(name);
          if (name !== 'discovery') return real;
          return {
            doc: function (id) {
              const ref = real.doc(id);
              return {
                get: function () {
                  return new Promise(function (resolve, reject) {
                    held.push(function () { ref.get().then(resolve, reject); });
                  });
                }
              };
            },
            where: function () { return real.where.apply(real, arguments); },
            orderBy: function () { return real.orderBy.apply(real, arguments); },
            limit: function () { return real.limit.apply(real, arguments); }
          };
        }
      };
    }

    const lateViews = [];
    let stopLate = function () { /* replaced */ };
    const lateFirst = await new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(null); }, 8000);
      stopLate = k.store.listenMatchViews(me, function (views) {
        lateViews.push(views);
        if (lateViews.length === 1) { clearTimeout(timer); resolve(views); }
      });
    });

    try {
      t.check('the late-delivery check starts from a list it can actually see',
        Array.isArray(lateFirst) && lateFirst.length === MATCHES,
        lateFirst ? lateFirst.length + ' conversation(s)' : 'timed out');

      k.ctx.ZC.firebase.db = holdingDb(real);
      const ghost = 'views-ghost';
      const ghostId = [me, ghost].sort().join('_');
      await k.admin.set('discovery', ghost, k.h.discoveryDoc(ghost, { displayName: 'A Ghost' }));
      await k.admin.set('matches', ghostId, {
        id: ghostId, users: [me, ghost].sort(), createdAt: '2026-04-01T00:00:00.000Z',
        lastMessage: null, lastMessageAt: null, unread: { [me]: 0, [ghost]: 0 }
      });
      const holding = await until(function () { return held.length > 0; }, 5000);

      // ...and now it is gone again, before that face ever arrived.
      await k.admin.del('matches', ghostId);
      const shrank = await until(function () {
        const last = lateViews[lateViews.length - 1] || [];
        return lateViews.length > 1 && last.length === MATCHES;
      }, 5000);

      held.splice(0).forEach(function (release) { release(); });
      await new Promise(function (resolve) { setTimeout(resolve, 400); });
      const final = lateViews[lateViews.length - 1] || [];

      t.check('a profile read that lands after a newer list does not put the older one back',
        holding && shrank && final.length === MATCHES &&
          !final.some(function (v) { return v.matchId === ghostId; }),
        'held ' + (holding ? 'yes' : 'no') + ', shrank ' + (shrank ? 'yes' : 'no') +
        ', final list ' + final.length + ' conversation(s)' +
        (final.some(function (v) { return v.matchId === ghostId; })
          ? ' INCLUDING the one that was removed' : ''));

      /* ---- 6c. and a hydration in flight at unsubscribe is dropped ------ */

      const beforeStop = lateViews.length;
      const ghost2 = 'views-ghost-two';
      const ghost2Id = [me, ghost2].sort().join('_');
      k.ctx.ZC.firebase.db = holdingDb(real);
      await k.admin.set('discovery', ghost2, k.h.discoveryDoc(ghost2, { displayName: 'Another Ghost' }));
      await k.admin.set('matches', ghost2Id, {
        id: ghost2Id, users: [me, ghost2].sort(), createdAt: '2026-05-01T00:00:00.000Z',
        lastMessage: null, lastMessageAt: null, unread: { [me]: 0, [ghost2]: 0 }
      });
      const holding2 = await until(function () { return held.length > 0; }, 5000);
      stopLate();
      held.splice(0).forEach(function (release) { release(); });
      await new Promise(function (resolve) { setTimeout(resolve, 400); });

      t.check('and one still resolving when the page tears down is never delivered',
        holding2 && lateViews.length === beforeStop,
        'held ' + (holding2 ? 'yes' : 'no') + ', ' + (lateViews.length - beforeStop) +
        ' delivery(s) after unsubscribe — a page that has gone cannot be drawn on');
      await k.admin.del('matches', ghost2Id);
    } finally {
      stopLate();
      k.ctx.ZC.firebase.db = real;
    }

    /* ---- 7. a stream that dies says so, to everyone, once --------------- */

    // The failure this closes: `onSnapshot`'s error callback only warned, so a
    // page could not tell "still loading" from "this will never arrive" and sat
    // on a skeleton with nothing to click. Injected at the query, because the
    // emulator runs this project with open rules and will not deny anything.
    const broken = {
      collection: function () {
        return {
          where: function () {
            return {
              onSnapshot: function (next, onErr) {
                setTimeout(function () { onErr(new Error('Missing or insufficient permissions.')); }, 0);
                return function () { /* nothing to unsubscribe */ };
              }
            };
          }
        };
      }
    };
    k.ctx.ZC.firebase.db = broken;

    const deliveries = [];
    const errors = [];
    const stopA = k.store.listenMatches(me, function (r) { deliveries.push(['badge', r]); },
      function (err) { errors.push(err); });
    const stopB = k.store.listenMatchViews(me, function (v) { deliveries.push(['list', v]); },
      function (err) { errors.push(err); });
    await until(function () { return errors.length >= 2; }, 4000);
    stopA();
    stopB();
    k.ctx.drainWarnings();

    t.check('a stream that dies tells every subscriber, and delivers nothing',
      errors.length === 2 && deliveries.length === 0,
      errors.length + ' error(s), ' + deliveries.length + ' delivery(s)');

    /* ---- 8. ...and a retry is allowed to work --------------------------- */

    // If the dead stream stayed in the map, a retry button would be wired to a
    // corpse: it would look connected and never deliver again.
    k.ctx.ZC.firebase.db = real;

    // Compared against what is actually stored rather than against a number
    // written here: the checks above add and remove conversations, and a
    // hard-coded count would turn a bookkeeping slip into a failure of the
    // property under test.
    const stored = (await k.admin.list('matches'))
      .filter(function (row) { return (row.data.users || []).indexOf(me) !== -1; })
      .map(function (row) { return row.id; }).sort();

    // Settled, not first: `onSnapshot` serves what the SDK already has cached
    // before the server answers, so a first delivery can legitimately carry a
    // document that has since been deleted. Measured — it did, by one row. The
    // claim under test is that a fresh subscription after a failure works at
    // all, not that its opening frame is server-authoritative.
    const retries = [];
    const stopRetry = k.store.listenMatchViews(me, function (views) { retries.push(views); });
    const settled = await until(function () {
      const last = retries[retries.length - 1];
      return !!last && k.same(last.map(function (v) { return v.matchId; }).sort(), stored);
    }, 8000);
    stopRetry();
    const last = retries[retries.length - 1] || [];

    t.check('and a fresh subscription after that failure is allowed to try again',
      retries.length > 0 && settled,
      retries.length + ' delivery(s) on the retry, settling on ' + last.length +
      ' conversation(s) against ' + stored.length + ' stored');
  }
};
