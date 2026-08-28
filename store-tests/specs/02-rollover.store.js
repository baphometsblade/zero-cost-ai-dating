/* ==========================================================================
   Midnight.

   A counter that resets daily has a second race hiding inside it: the reset
   itself. It used to be its own read-then-write in getUsage, which could
   overwrite a bump that had just landed — or be overwritten by one. Now the
   roll-over is decided inside the same transaction as the bump, so these
   checks seed yesterday's counters and confirm today's view is right whether
   it is reached by reading, by one bump, or by twenty at once.
   ========================================================================== */
'use strict';

const N = 20;

function range(n) {
  return Array.from({ length: n }, function (_, i) { return i; });
}

module.exports = {
  title: 'The day roll-over happens inside the transaction',

  async run(t, k) {
    const util = k.ctx.ZC.util;
    const today = util.todayKey();
    const yesterday = util.todayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
    // Yesterday finished at the free plan's ceiling, so anything that leaks
    // across midnight is loud rather than subtle.
    const spent = { date: yesterday, likes: 25, superLikes: 1, rewinds: 3 };
    const freshWithOneLike = { date: today, likes: 1, superLikes: 0, rewinds: 0 };

    /* ---- one bump on a stale day ---------------------------------------- */

    const uid = 'rollover-bump';
    await k.admin.set('users', uid, k.h.userDoc(uid, { usage: Object.assign({}, spent) }));

    const returned = await k.store.bumpUsage(uid, 'likes');
    k.ctx.drainWarnings();
    const stored = (await k.admin.get('users', uid) || {}).usage || {};

    t.check(
      "yesterday's counters reset to zero before today's bump lands",
      k.same({ date: stored.date, likes: stored.likes, superLikes: stored.superLikes, rewinds: stored.rewinds },
        freshWithOneLike),
      k.show(stored)
    );
    t.check(
      'the caller is told the same thing that was stored',
      k.same({ date: returned.date, likes: returned.likes, superLikes: returned.superLikes, rewinds: returned.rewinds },
        freshWithOneLike),
      k.show(returned)
    );

    /* ---- the read path -------------------------------------------------- */

    // getUsage still persists the reset it reports — it is not a pure read —
    // but it now does so through the same transaction a bump takes, so it
    // cannot fight one.
    const readUid = 'rollover-read';
    await k.admin.set('users', readUid, k.h.userDoc(readUid, { usage: Object.assign({}, spent) }));

    const view = await k.store.getUsage(readUid);
    k.ctx.drainWarnings();
    const afterRead = (await k.admin.get('users', readUid) || {}).usage || {};

    t.check(
      'getUsage reports zeros for today when the stored date is stale',
      k.same({ date: view.date, likes: view.likes, superLikes: view.superLikes, rewinds: view.rewinds },
        { date: today, likes: 0, superLikes: 0, rewinds: 0 }),
      k.show(view)
    );
    t.check(
      'and persists that reset rather than leaving yesterday behind',
      afterRead.date === today && afterRead.likes === 0,
      k.show(afterRead)
    );

    /* ---- the gate the UI actually asks ----------------------------------- */

    const gateUid = 'rollover-gate';
    await k.admin.set('users', gateUid, k.h.userDoc(gateUid, { usage: Object.assign({}, spent) }));
    const gate = await k.store.canSpend(gateUid, 'likes');
    k.ctx.drainWarnings();

    t.check(
      'canSpend sees the new day, not yesterday at the limit',
      gate.allowed === true && gate.remaining === 25,
      k.show(gate)
    );

    /* ---- the roll-over under contention ---------------------------------- */

    // The case neither the old reset nor the old bump could survive: the day
    // turns over while several devices are swiping.
    const raceUid = 'rollover-race';
    await k.admin.set('users', raceUid, k.h.userDoc(raceUid, { usage: Object.assign({}, spent) }));
    await Promise.all(range(N).map(function () {
      return k.store.bumpUsage(raceUid, 'likes');
    }));
    const warned = k.ctx.drainWarnings();
    const raced = (await k.admin.get('users', raceUid) || {}).usage || {};

    t.check(
      N + ' concurrent bumps across midnight store exactly ' + N,
      k.same({ date: raced.date, likes: raced.likes, superLikes: raced.superLikes, rewinds: raced.rewinds },
        { date: today, likes: N, superLikes: 0, rewinds: 0 }),
      k.show(raced) + (warned.length ? ', ' + warned.length + ' warning(s)' : '')
    );
  }
};
