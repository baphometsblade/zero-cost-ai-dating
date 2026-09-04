/* ==========================================================================
   A tab left open costs nothing while nothing happens.

   `app.js` used to refresh its badges every twenty seconds while the tab was in
   the foreground: every match document, a profile for each of them, and on the
   premium plan every inbound like and a profile for each of those — spent again
   and again whether or not anything had changed. Bounded by the size of a
   social graph, which is the right shape, and not free: a Spark project gets
   50,000 document reads a day, and that is a handful of hours from one tab.

   A snapshot listener bills the documents it first delivers and then only the
   ones that change. That is the whole argument for the rewrite, and it is a
   claim about billing rather than about code, so this counts.

   Two properties, and the second is the one that matters:

     1. Subscribing costs what the data costs — one read per match, once.
     2. Time passing costs nothing, and a single change costs a single read.

   The counting stand-in is `harness.countingDb`, shared with the read-cost spec
   next door. It counts a listener's *deltas* rather than its payload, and that
   distinction was not free: written the obvious way — `snap.size` per delivery —
   the last check below reported **12 reads for one changed document**, because a
   snapshot carries the whole result set however little of it moved. That is the
   payload, not the bill: Firestore charges for the documents in the first
   snapshot and then for each document that changes. Measured the wrong way, a
   listener looks exactly as expensive as the poll it replaces, and this file
   would have argued against its own change.
   ========================================================================== */
'use strict';

/** Conversations to seed. Enough that "one read per match" is not one read. */
const MATCHES = 12;

/** How long to sit still, in milliseconds, before claiming nothing was billed. */
const IDLE_MS = 1500;

module.exports = {
  title: 'A live badge costs the data once, then only what changes',

  async run(t, k) {
    const me = 'live-me';
    await k.admin.set('users', me, k.h.userDoc(me));

    const ids = [];
    const seeded = [];
    for (let i = 0; i < MATCHES; i += 1) {
      const them = 'live-them-' + String(i).padStart(2, '0');
      const id = [me, them].sort().join('_');
      ids.push(id);
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

    const expectedUnread = seeded.reduce(function (sum, m) { return sum + m.data.unread[me]; }, 0);

    /* ---- 1. subscribing costs the data, once ---------------------------- */

    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);

    const seen = [];
    let stop = function () { /* replaced below */ };
    try {
      const first = await new Promise(function (resolve) {
        let settled = false;
        const timer = setTimeout(function () { if (!settled) { settled = true; resolve(null); } }, 10000);
        stop = k.store.listenMatches(me, function (rows) {
          seen.push(rows);
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(rows);
        });
      });
      k.ctx.drainWarnings();

      t.check('the subscription delivers every match this account is in',
        Array.isArray(first) && first.length === MATCHES,
        (first ? first.length : 'timed out') + ' of ' + MATCHES);

      t.check('and the unread counts it carries are this account\'s, not the other side\'s',
        Array.isArray(first) && first.reduce(function (sum, row) { return sum + row.unread; }, 0) === expectedUnread,
        'summed ' + (Array.isArray(first) ? first.reduce(function (s, r) { return s + r.unread; }, 0) : '?') +
        ', expected ' + expectedUnread);

      // No profile fetch. The badge draws a number, and a name per match on a
      // timer is what made the thing it replaced expensive.
      t.check('the first delivery costs one read per match and nothing else',
        tally.reads === MATCHES, tally.reads + ' reads for ' + MATCHES + ' matches');

      /* ---- 2. and then nothing, until something happens ----------------- */

      const settledReads = tally.reads;
      await new Promise(function (resolve) { setTimeout(resolve, IDLE_MS); });

      t.check('sitting still for ' + IDLE_MS + 'ms costs nothing at all',
        tally.reads === settledReads,
        tally.reads + ' reads, was ' + settledReads);

      // One message arriving on one conversation. The old poll would have
      // re-read all twelve, plus twelve profiles, to notice.
      const before = tally.reads;
      const deliveries = seen.length;
      const bumped = {};
      bumped[me] = 9;
      bumped[ids[0].split('_')[0] === me ? ids[0].split('_')[1] : ids[0].split('_')[0]] = 0;
      await k.admin.set('matches', ids[0], Object.assign({}, seeded[0].data, {
        unread: bumped, lastMessage: 'hello', lastMessageAt: '2026-02-01T00:00:00.000Z'
      }));

      await new Promise(function (resolve) {
        const started = Date.now();
        const wait = setInterval(function () {
          if (seen.length > deliveries || Date.now() - started > 8000) {
            clearInterval(wait);
            resolve();
          }
        }, 50);
      });
      k.ctx.drainWarnings();

      t.check('a change on one conversation is delivered',
        seen.length > deliveries, seen.length + ' deliveries, was ' + deliveries);

      t.check('and costs one read, not one per match',
        tally.reads - before === 1, (tally.reads - before) + ' read(s) for one changed document');
    } finally {
      stop();
      k.ctx.ZC.firebase.db = real;
    }
  }
};
