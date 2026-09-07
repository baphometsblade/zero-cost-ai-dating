/* ==========================================================================
   What a swipe costs to WRITE, counted rather than described.

   A Spark project gets 50,000 document reads a day and **20,000 writes**. Every
   cost spec in this suite until now has counted the reads; nothing anywhere
   counted a write. That is the half of the bill this project had only ever
   asserted in prose — and the prose has form. `scripts/claims.js` lists the
   three numbers that drifted before anything executed them, and one of the
   three is this one: *"a 'three writes' that was four for a mutual like"*,
   caught by a person reading carefully, which is the standard the rest of this
   repository refuses to accept.

   So the numbers `README.md` quotes are executed here. An ordinary like is
   three document writes — the swipe, the daily counter, the affinity map — and
   four when it turns out mutual, because that is when the match document is
   created. A pass is two: there is no counter to move.

   The identities matter as much as the count. "Three writes" is satisfied by
   three writes to the wrong documents, and the specific wrong document has
   history here too: the learning save used to go through `updateUser`, which
   republished `discovery/{uid}` to mirror a field that projection has never
   carried. So every check below names what was written, not just how many.

   Two of the checks are about the instrument rather than the app, and they earn
   their place because a write counter is easy to build wrong in exactly two
   ways:

     - a write the server refuses is not billed, so counting the call rather
       than its result would charge for every denial this suite provokes;
     - a transaction's callback is REPLAYED on contention, so counting `tx.set`
       where it is called would report one contended bump as two or three
       writes. Twenty concurrent bumps have to come to twenty.
   ========================================================================== */
'use strict';

/** Concurrent bumps for the replay check. Matches `specs/01-concurrency`. */
const BUMPS = 20;

module.exports = {
  title: 'A swipe is three writes, and four when it is mutual',

  async run(t, k) {
    const me = 'wc-me';
    const passed = 'wc-passed';
    const liked = 'wc-liked';
    const mutual = 'wc-mutual';
    const ghost = 'wc-ghost';

    /**
     * Run one call with the store's Firestore swapped for a counting stand-in,
     * reporting both how many writes it billed and which documents they were.
     */
    async function measure(fn) {
      const real = k.ctx.ZC.firebase.db;
      const tally = { reads: 0, calls: 0, writes: 0, wrote: [] };
      k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
      try {
        const value = await fn();
        return { value: value, writes: tally.writes, wrote: tally.wrote };
      } finally {
        k.ctx.ZC.firebase.db = real;
      }
    }

    /**
     * The collections written to, in order, without the document ids — so a
     * check can name what was written without pinning ids the emulator
     * generates afresh every run. 'tx:users/wc-me:update' becomes
     * 'tx:users:update'.
     */
    function shape(wrote) {
      return wrote.map(function (entry) {
        const parts = entry.split(':');
        const op = parts[parts.length - 1];
        const path = parts[parts.length - 2] || '';
        // Firestore paths alternate collection/document, so the collections are
        // the even-numbered segments. Dropping only the second one was wrong for
        // the one path here that is nested: a message lives at
        // `matches/{id}/messages/{id}`.
        const collections = path.split('/').filter(function (_, i) { return i % 2 === 0; });
        return parts.slice(0, parts.length - 2).concat([collections.join('/'), op]).join(':');
      });
    }

    const learning = { interestAffinity: { hiking: 1 }, likeCount: 1, passCount: 0 };

    await k.admin.set('users', me, k.h.userDoc(me));
    await k.admin.setMany('users', [passed, liked, mutual].map(function (uid) {
      return { id: uid, data: k.h.userDoc(uid) };
    }));
    // The viewer gets a projection too, because in this app everybody has one —
    // and without it a swipe that wrongly republished the projection would fail
    // with NOT_FOUND and crash the file rather than reddening the check that
    // exists to catch exactly that.
    await k.admin.setMany('discovery', [me, passed, liked, mutual].map(function (uid) {
      return { id: uid, data: k.h.discoveryDoc(uid) };
    }));

    /* ---- 1. a pass ----------------------------------------------------- */

    // The deck's real sequence, from `dashboard.js`: record the swipe, bump the
    // counter when the action has one, then save the learning map. A pass has
    // no counter — `entry.field` is null — so it never reaches the bump.
    const pass = await measure(function () {
      return k.store.recordSwipe(me, passed, 'pass')
        .then(function () { return k.store.saveLearning(me, learning); });
    });
    k.ctx.drainWarnings();

    t.check('a pass is two writes: the swipe and the affinity map',
      pass.writes === 2 && k.same(shape(pass.wrote), ['swipes:set', 'users:update']),
      pass.writes + ' write(s): ' + k.show(pass.wrote));

    /* ---- 2. an ordinary like -------------------------------------------- */

    const like = await measure(function () {
      return k.store.recordSwipe(me, liked, 'like')
        .then(function () { return k.store.bumpUsage(me, 'likes', 1); })
        .then(function () { return k.store.saveLearning(me, learning); });
    });
    k.ctx.drainWarnings();

    t.check('an ordinary like is three: the swipe, the counter, the affinity map',
      like.writes === 3 &&
        k.same(shape(like.wrote), ['swipes:set', 'tx:users:update', 'users:update']),
      like.writes + ' write(s): ' + k.show(like.wrote) +
      ' — at three a swipe, a Spark project\'s 20,000 daily writes is about 6,600 of them');

    // The regression this one exists for: the learning save used to go through
    // `updateUser`, which rewrote the whole user document AND republished
    // `discovery/{uid}` — to mirror a field the projection has never carried.
    t.check('and none of it republishes the public projection',
      pass.wrote.concat(like.wrote).every(function (entry) { return entry.indexOf('discovery/') === -1; }),
      k.show(pass.wrote.concat(like.wrote)));

    /* ---- 3. a like that turns out mutual --------------------------------- */

    await k.admin.set('swipes', mutual + '_' + me, {
      id: mutual + '_' + me, from: mutual, to: me, action: 'like',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    const both = await measure(function () {
      return k.store.recordSwipe(me, mutual, 'like')
        .then(function (outcome) {
          return k.store.bumpUsage(me, 'likes', 1)
            .then(function () { return k.store.saveLearning(me, learning); })
            .then(function () { return outcome; });
        });
    });
    k.ctx.drainWarnings();

    t.check('a like that turns out mutual is four — the match document is the fourth',
      both.writes === 4 && both.value && both.value.matched === true &&
        k.same(shape(both.wrote),
          ['swipes:set', 'matches:set', 'tx:users:update', 'users:update']),
      both.writes + ' write(s): ' + k.show(both.wrote));

    /* ---- 4. a message ---------------------------------------------------- */

    const matchId = k.h.pairId(me, mutual);
    const said = await measure(function () {
      return k.store.sendMessage(matchId, me, 'the first thing anybody says');
    });
    k.ctx.drainWarnings();

    t.check('sending a message is two: the message, and the conversation row it moves',
      said.writes === 2 &&
        k.same(shape(said.wrote), ['matches/messages:set', 'matches:update']),
      said.writes + ' write(s): ' + k.show(said.wrote) +
      ' — the row carries the preview and the unread count, so it moves with every message');

    /* ---- 5. a profile save ----------------------------------------------- */

    const saved = await measure(function () {
      return k.store.updateUser(me, { displayName: 'A New Name' });
    });
    k.ctx.drainWarnings();

    t.check('a profile save is two, and both of them inside one transaction',
      saved.writes === 2 &&
        k.same(shape(saved.wrote), ['tx:users:set', 'tx:discovery:set']),
      saved.writes + ' write(s): ' + k.show(saved.wrote) +
      ' — two independent writes could land in either order and leave the public ' +
      'half behind the private one, which is what specs/06 measures');

    /* ---- 6. the instrument: a refused write is not a write --------------- */

    // `bumpUsage` on an account with no document. The transaction's `update`
    // fails, the store warns and hands back its optimistic figure — and nothing
    // was stored, so nothing may be counted. A counter that tallied the call
    // rather than the outcome would charge for every denial in this suite.
    const refused = await measure(function () {
      return k.store.bumpUsage(ghost, 'likes', 1);
    });
    const warned = k.ctx.drainWarnings();

    t.check('a write the server refuses is not billed and is not counted',
      refused.writes === 0 && warned.some(function (w) { return /Could not persist usage/.test(w); }),
      refused.writes + ' write(s) for a bump on an account that does not exist, ' +
      warned.length + ' warning(s)');

    t.check('and nothing was conjured into existence to justify it',
      (await k.admin.get('users', ghost)) === null, 'users/' + ghost);

    /* ---- 7. the instrument: a replayed attempt is not a second write ----- */

    // Firestore replays a transaction whose document moved underneath it, so
    // `tx.update` can run more than once for one committed write. Twenty
    // concurrent bumps are twenty writes however many attempts that took;
    // counting where `tx.update` is called would report more.
    const spender = 'wc-spender';
    await k.admin.set('users', spender, k.h.userDoc(spender));

    const contended = await measure(function () {
      const all = [];
      for (let i = 0; i < BUMPS; i += 1) all.push(k.store.bumpUsage(spender, 'likes', 1));
      return Promise.all(all);
    });
    k.ctx.drainWarnings();

    const stored = await k.admin.get('users', spender);
    const likes = stored && stored.usage ? stored.usage.likes : null;

    t.check(BUMPS + ' concurrent bumps are ' + BUMPS + ' writes, not one per replay',
      contended.writes === BUMPS,
      contended.writes + ' write(s) for ' + BUMPS + ' bumps. Contention makes Firestore ' +
      'run the callback again, and each replay would add one more to a counter that ' +
      'tallied the call instead of the commit');

    t.check('and all ' + BUMPS + ' of them actually landed, so that is not ' +
      BUMPS + ' writes of nothing',
      likes === BUMPS, 'stored likes: ' + k.show(likes));

    /* ---- 8. the instrument: the way nothing here creates documents ------ */

    // `collection.add()` is a billed write the shipped store never makes — it
    // creates every document through `.doc(id).set(...)`, messages included. The
    // counter covers it anyway, because the day somebody does reach for `add`
    // the alternative is a tally that silently reports one write short. An
    // unexercised branch is not evidence of anything, so it is exercised.
    const added = await measure(function () {
      return k.ctx.ZC.firebase.db.collection('wc-scratch').add({ hello: 'world' });
    });
    k.ctx.drainWarnings();

    t.check('a document created with add() is one write, though nothing shipped uses it',
      added.writes === 1 && k.same(shape(added.wrote), ['wc-scratch:add']),
      added.writes + ' write(s): ' + k.show(added.wrote));
  }
};
