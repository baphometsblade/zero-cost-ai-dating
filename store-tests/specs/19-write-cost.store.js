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

   Everything from section 6 on is about the instrument rather than the app,
   and it earns its place because a cost counter is easy to build wrong — in
   more ways than the two this header once said were all of them:

     - a write the server refuses is not billed, so counting the call rather
       than its result would charge for every denial this suite provokes —
       and neither is one the SDK refuses before sending it;
     - a transaction's callback is REPLAYED on contention, so counting `tx.set`
       where it is called would report one contended bump as two or three
       writes. Twenty concurrent bumps have to come to twenty;
     - a reference reached through a snapshot — its `docs`, `forEach`,
       `docChanges()`, a listener's delivery, a transaction's `get` — or as what
       `add()` resolves to is as billed as one built from the database, and the
       counter once could not see it. Account deletion reaches every match that
       way, so that is measured too;
     - a name is not a write: `toString` on a counted reference once recorded
       one, because the list of write operations was asked through the
       prototype chain;
     - a batch's and a transaction's writes chain, and a counter that hands
       back the real batch from the first one loses the rest — the commit
       included;
     - the SDK declares four ways to register a listener and accepts a fifth,
       and a counter that recognises only one of them measures nothing at all
       for the others;
     - what a converter makes of a document is the app's own object, and a
       counter that takes it for Firestore's invents writes, or breaks the
       call it is measuring;
     - a read the client's own cache answers never reaches Firestore, and is
       not billed.
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
     * reporting both how many writes it billed and which documents they were —
     * and the reads, which only the instrument checks at the end look at.
     */
    async function measure(fn) {
      const real = k.ctx.ZC.firebase.db;
      const tally = { reads: 0, calls: 0, writes: 0, wrote: [] };
      k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);
      try {
        const value = await fn();
        return {
          value: value, writes: tally.writes, wrote: tally.wrote, reads: tally.reads, calls: tally.calls
        };
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

    /**
     * Register a listener on `col` through `register`, and resolve with the
     * reference to document `id` from the first delivery that holds it —
     * unsubscribing right there, so a write made through it afterwards cannot
     * come back as a second delivery — or with null after ten seconds or on
     * the listener's error. What runs inside the listener sits in a try: the
     * SDK calls a listener from its own scheduler, so an exception there would
     * never reach this spec, and would end the run instead of failing a check.
     */
    function heardRef(register, col, id) {
      return new Promise(function (resolve) {
        let stop = null;
        let settled = false;
        const timer = setTimeout(function () { settle(null); }, 10000);
        function settle(ref) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (stop) stop();
          resolve(ref);
        }
        stop = register(col, function (snap) {
          try {
            const doc = snap.docs.filter(function (d) { return d.id === id; })[0];
            if (doc) settle(doc.ref);
          } catch (err) {
            settle(null);
          }
        }, function () { settle(null); });
        // A delivery that came before `register` returned found no `stop` yet.
        if (settled) stop();
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

    /* ---- 9. the instrument: what a snapshot hands back is counted too ---- */

    // `deleteAccountData` reaches every match it deletes through the query that
    // found it — `matches.docs[i].ref` — and asks that reference for the match's
    // messages before deleting it. The stand-in used to wrap only what a method
    // RETURNED — never what a promise resolved to, nor what a property held — so
    // the snapshot and every ref hanging off it were the real ones: the messages
    // query and the match delete were billed and never counted. Its cost grows
    // with the account — a query and a delete per match, on top of the
    // messages — and it is the path the counter could not see.
    const leaver = 'wc-leaver';
    const left = 'wc-left';
    const leftMatch = k.h.pairId(leaver, left);
    const MESSAGES = 2;
    await k.admin.setMany('users', [leaver, left].map(function (uid) {
      return { id: uid, data: k.h.userDoc(uid) };
    }));
    await k.admin.setMany('discovery', [leaver, left].map(function (uid) {
      return { id: uid, data: k.h.discoveryDoc(uid) };
    }));
    await k.admin.setMany('swipes', [[leaver, left], [left, leaver]].map(function (pair) {
      return { id: pair[0] + '_' + pair[1], data: k.h.swipeDoc(pair[0], pair[1], 'like') };
    }));
    await k.admin.set('matches', leftMatch, k.h.matchDoc(leaver, left));
    const messages = [];
    for (let i = 0; i < MESSAGES; i += 1) {
      messages.push({ id: 'm' + i, data: k.h.messageDoc(i % 2 ? left : leaver) });
    }
    await k.admin.setMany('matches/' + leftMatch + '/messages', messages);

    const gone = await measure(function () { return k.store.deleteAccountData(leaver); });
    k.ctx.drainWarnings();

    // A swipe each way, every message, the match, then the projection and the
    // account: one write per document deleted.
    const purged = ['batch:swipes:delete', 'batch:swipes:delete']
      .concat(messages.map(function () { return 'batch:matches/messages:delete'; }))
      .concat(['matches:delete', 'discovery:delete', 'users:delete']);
    t.check('deleting an account bills the match it deletes, though it reaches it through a snapshot',
      gone.value === true && gone.writes === purged.length && k.same(shape(gone.wrote), purged),
      gone.writes + ' write(s): ' + k.show(gone.wrote));

    // Four queries the store makes from the database itself — filed reports
    // (none, so the one read an empty result costs), swipes each way, matches —
    // and one it makes from the match's own ref, which bills every message.
    t.check('and the messages it looks for under that match are reads, not free',
      gone.calls === 5 && gone.reads === 4 + MESSAGES,
      gone.reads + ' read(s) in ' + gone.calls + ' quer(ies), against ' + (4 + MESSAGES) +
      ' in 5 billed — one query and ' + MESSAGES + ' reads of it are the per-match message scan');

    /* ---- 10. the instrument: more ways a reference reaches the app ------- */

    // A snapshot's `ref` is one way out of the counter. These are others it
    // covers: the reference `add()` resolves to, `docs`, `forEach`,
    // `docChanges()`, a listener's delivery and a transaction's `get`. (The
    // ways it is known not to cover — a reference stored as a field's value
    // among them — are listed in the `countingDb` docblock in harness.js, with
    // why none touches a number here.) Each route writes to its own document,
    // so a route that slips past the counter is named by what is missing
    // rather than by a count one short.
    const ROUTES = 'wc-routes';
    await k.admin.setMany(ROUTES, ['by-docs', 'by-foreach', 'by-change', 'by-listener', 'by-tx']
      .map(function (id) { return { id: id, data: { route: null } }; }));

    const created = await measure(function () {
      return k.ctx.ZC.firebase.db.collection('wc-scratch').add({ hello: 'again' })
        .then(function (ref) { return ref.set({ hello: 'and again' }); });
    });
    k.ctx.drainWarnings();

    t.check('a document created with add() and written again through what add() returned is two writes',
      created.writes === 2 && k.same(shape(created.wrote), ['wc-scratch:add', 'wc-scratch:set']),
      created.writes + ' write(s): ' + k.show(created.wrote));

    const routed = await measure(async function () {
      const db = k.ctx.ZC.firebase.db;
      const col = db.collection(ROUTES);
      const byId = function (docs, id) { return docs.filter(function (doc) { return doc.id === id; })[0]; };

      const snap = await col.get();
      await byId(snap.docs, 'by-docs').ref.update({ route: 'docs' });

      let viaEach = null;
      snap.forEach(function (doc) { if (doc.id === 'by-foreach') viaEach = doc.ref; });
      await viaEach.update({ route: 'forEach' });

      const change = snap.docChanges().filter(function (c) { return c.doc.id === 'by-change'; })[0];
      await change.doc.ref.update({ route: 'docChanges' });

      const heard = await heardRef(function (c, next, error) { return c.onSnapshot(next, error); },
        col, 'by-listener');
      if (heard) await heard.update({ route: 'listener' });

      const read = await db.runTransaction(function (tx) { return tx.get(col.doc('by-tx')); });
      await read.ref.update({ route: 'transaction' });
    });
    k.ctx.drainWarnings();

    const routes = await k.admin.list(ROUTES);
    t.check('a document reached through docs, forEach, docChanges(), a listener or a transaction\'s get ' +
      'is counted when it is written',
      k.same(routed.wrote, ['by-docs', 'by-foreach', 'by-change', 'by-listener', 'by-tx']
        .map(function (id) { return ROUTES + '/' + id + ':update'; })) &&
        routes.every(function (doc) { return doc.data.route !== null; }),
      routed.writes + ' write(s): ' + k.show(routed.wrote) + '; stored: ' +
      k.show(routes.map(function (doc) { return doc.id + '=' + doc.data.route; })));

    /* ---- 11. the instrument: a name is not a write ------------------------ */

    // `WRITE_OPS` was an object literal and was asked `WRITE_OPS[prop]`, which
    // walks the prototype chain — so `toString`, `valueOf` and `hasOwnProperty`
    // were all "write operations", and turning a counted ref into text recorded
    // a write. Nothing shipped stringifies a ref today; a log line or a check's
    // detail string would have been enough.
    const named = await measure(function () {
      const db = k.ctx.ZC.firebase.db;
      const ref = db.collection('wc-scratch').doc('named');
      const batch = db.batch();
      batch.set(ref, { named: true });
      const text = [String(ref), '' + ref, ref.toLocaleString(),
        String(ref.hasOwnProperty('path')), String(batch)];
      return batch.commit().then(function () { return text; });
    });
    k.ctx.drainWarnings();

    t.check('a reference or a batch turned into text is not a write',
      named.writes === 1 && k.same(shape(named.wrote), ['batch:wc-scratch:set']),
      named.writes + ' write(s): ' + k.show(named.wrote) +
      ' — one batched set, and nothing else touched Firestore');

    /* ---- 12. the instrument: a chained write is still a write ------------ */

    // A batch's and a transaction's `set`, `update` and `delete` return the batch
    // or transaction itself, so they chain — and the stand-in used to hand back
    // the REAL one, so the second write in a chain went uncounted and a chained
    // `commit()` committed a batch the tally never heard about. The shipped store
    // never chains — each `tx.set` and `batch.delete` is a statement of its own —
    // and the day it does, the count must not drop.
    const chained = await measure(function () {
      const db = k.ctx.ZC.firebase.db;
      const col = db.collection('wc-scratch');
      return db.batch().set(col.doc('chain-a'), { n: 1 }).set(col.doc('chain-b'), { n: 2 }).commit()
        .then(function () {
          return db.runTransaction(function (tx) {
            tx.set(col.doc('chain-c'), { n: 3 }).set(col.doc('chain-d'), { n: 4 });
            return Promise.resolve();
          });
        });
    });
    k.ctx.drainWarnings();

    const landed = [];
    for (const id of ['chain-a', 'chain-b', 'chain-c', 'chain-d']) {
      if (await k.admin.get('wc-scratch', id)) landed.push(id);
    }
    t.check('a chained write on a batch or a transaction is counted, and so is a chained commit',
      chained.writes === 4 && landed.length === 4 &&
        k.same(chained.wrote, ['batch:wc-scratch/chain-a:set', 'batch:wc-scratch/chain-b:set',
          'tx:wc-scratch/chain-c:set', 'tx:wc-scratch/chain-d:set']),
      chained.writes + ' write(s): ' + k.show(chained.wrote) + '; landed: ' + k.show(landed));

    /* ---- 13. the instrument: a listener, wherever the SDK finds it ------- */

    // The SDK's typings declare four ways to hand `onSnapshot` its listener: a
    // function or an observer object, either one alone or after an options
    // object. The counter used to recognise only a function given first, so a
    // listener registered any of the other three ways was neither counted nor
    // carried — a first delivery of three documents read as no reads, and a
    // write through one of them as no write. A fifth call is not declared but
    // the compat SDK accepts it all the same: a function followed by an
    // observer, where the SDK listens with the observer and never calls the
    // function. The store registers every listener as `(next, error)`; a spec
    // that registers one another way must still be measuring something. Each
    // way listens to a collection of its own, which this client has never
    // read, and is expected to bill the three documents of its first delivery.
    const REGISTRATIONS = [
      ['a function', function (col, next, error) { return col.onSnapshot(next, error); }],
      ['an observer', function (col, next, error) { return col.onSnapshot({ next: next, error: error }); }],
      ['options, then an observer', function (col, next, error) {
        return col.onSnapshot({ includeMetadataChanges: false }, { next: next, error: error });
      }],
      ['options, then a function', function (col, next, error) {
        return col.onSnapshot({ includeMetadataChanges: false }, next, error);
      }],
      ['a function the SDK ignores, then an observer', function (col, next, error) {
        return col.onSnapshot(function () { /* never called: the observer wins */ },
          { next: next, error: error });
      }]
    ];
    const HEARD = ['a', 'b', 'c'];
    const heardBy = [];
    for (let i = 0; i < REGISTRATIONS.length; i += 1) {
      const way = REGISTRATIONS[i];
      const listened = 'wc-heard-' + i;
      await k.admin.setMany(listened, HEARD.map(function (id) { return { id: id, data: { by: null } }; }));
      const heard = await measure(async function () {
        const ref = await heardRef(way[1], k.ctx.ZC.firebase.db.collection(listened), 'b');
        if (ref) await ref.update({ by: way[0] });
      });
      k.ctx.drainWarnings();
      const written = await k.admin.get(listened, 'b');
      heardBy.push({
        way: way[0], reads: heard.reads, calls: heard.calls, wrote: heard.wrote,
        landed: !!written && written.by === way[0], expected: [listened + '/b:update']
      });
    }

    t.check('a listener registered any of the four ways the SDK declares, or the fifth it accepts, ' +
      'is counted, and what it delivers is carried',
      heardBy.every(function (h) {
        return h.reads === HEARD.length && h.calls === 1 && k.same(h.wrote, h.expected) && h.landed;
      }),
      heardBy.map(function (h) {
        return h.way + ': ' + h.reads + ' read(s) in ' + h.calls + ' delivery(s), ' +
          k.show(h.wrote) + (h.landed ? '' : ', and the write did not land');
      }).join('; ') + ' — against ' + HEARD.length + ' reads in one delivery, and the one write, for each');

    // An observer's other half. The stand-in hands the SDK an observer of its
    // own, so the app's `error` has to be passed on, bound to the app's
    // observer as the SDK would have bound it — dropped, a refused listener is
    // only logged by the SDK, and the app never hears that it has stopped. The
    // real rules refuse a signed-out listener on `users`.
    let stopRefused = null;
    const refusedBy = await new Promise(function (resolve) {
      const timer = setTimeout(function () { resolve(null); }, 10000);
      const observer = {
        next: function () { clearTimeout(timer); resolve({ delivered: true }); },
        error: function (err) {
          clearTimeout(timer);
          resolve({ bound: this === observer, code: err && err.code });
        }
      };
      const signedOut = k.h.countingDb(k.rulesEnv.unauthenticatedContext().firestore(),
        { reads: 0, calls: 0 });
      stopRefused = signedOut.collection('users').onSnapshot(observer);
    });
    if (stopRefused) stopRefused();
    k.ctx.drainWarnings();

    t.check('and an observer\'s error reaches the app\'s own observer, bound to it',
      !!refusedBy && refusedBy.bound === true && refusedBy.code === 'permission-denied',
      refusedBy ? k.show(refusedBy) : 'nothing reached the observer in ten seconds');

    /* ---- 14. the instrument: the app's own objects are not Firestore's ---- */

    // What a converter's `fromFirestore` returns is the app's model, and
    // `data()` hands it back. While the counter was learning to follow
    // snapshots it took anything with a `get`, an `onSnapshot`, a `collection`
    // or a `docChanges` method for a handle, and anything whose `doc` was one,
    // asking that of `doc` again however deep it went — so a Map came back
    // from `data()` as a counting stand-in, its own `set` and `delete` tallied
    // as billed writes, and a model whose `doc` was itself sent that question
    // round until `data()` threw. Nothing shipped uses a converter. The day
    // something does, the counter must not invent writes, and must not break
    // the call it is measuring.
    const CONVERTED = 'wc-converted';
    await k.admin.setMany(CONVERTED, [
      { id: 'mapped', data: { a: 1, b: 2 } },
      { id: 'looped', data: { a: 1 } }
    ]);
    const made = {};
    const converter = {
      toFirestore: function (model) { return model; },
      fromFirestore: function (snap) {
        const fields = snap.data();
        if (snap.id === 'mapped') {
          made.mapped = new Map(Object.keys(fields).map(function (key) { return [key, fields[key]]; }));
          return made.mapped;
        }
        made.looped = { fields: fields };
        made.looped.doc = made.looped;
        return made.looped;
      }
    };
    const modelled = await measure(async function () {
      const col = k.ctx.ZC.firebase.db.collection(CONVERTED).withConverter(converter);
      const out = {};
      const mapped = (await col.doc('mapped').get()).data();
      out.mapped = mapped === made.mapped;
      mapped.set('c', 3);
      mapped.delete('a');
      const looped = await col.doc('looped').get();
      try {
        out.looped = looped.data() === made.looped;
      } catch (err) {
        out.looped = String((err && err.message) || err);
      }
      return out;
    });
    k.ctx.drainWarnings();
    const stillStored = await k.admin.get(CONVERTED, 'mapped');

    t.check('a model a converter made comes back as the app made it, and what the app does to it is no write',
      modelled.value.mapped === true && modelled.writes === 0 &&
        !!stillStored && k.same(stillStored, { a: 1, b: 2 }),
      'the same Map: ' + modelled.value.mapped + '; ' + modelled.writes + ' write(s): ' +
      k.show(modelled.wrote) + '; stored: ' + k.show(stillStored));

    t.check('and a model that refers to itself comes back as made, rather than breaking data()',
      modelled.value.looped === true,
      'data() gave ' + k.show(modelled.value.looped));

    // The test that replaced it reads members of whatever it is asked about,
    // and a getter can throw. A throw there has to mean "not a handle": the
    // counter may miss a read, but it may not raise an exception inside the
    // call it is measuring. A plain object stands in for the database here,
    // because no Firestore object has such a getter to offer.
    const odd = {
      get _delegate() { throw new Error('not for reading'); }
    };
    const odds = [odd];
    let handedBack;
    try {
      const holder = k.h.countingDb({ odd: odd, odds: odds }, { reads: 0, calls: 0 });
      handedBack = holder.odd === odd && holder.odds === odds ? 'as it came' : 'changed';
    } catch (err) {
      handedBack = 'threw: ' + ((err && err.message) || err);
    }
    t.check('and a value that throws when the counter looks at it is handed back, ' +
      'not turned into an exception',
      handedBack === 'as it came', handedBack);

    /* ---- 15. the instrument: a write refused on the spot is no write ----- */

    // A batch's or a transaction's `set` checks its data before it buffers
    // anything, and throws there and then on what Firestore cannot store, such
    // as an `undefined` field. The stand-in used to note the write before
    // making the call, so a refused one stayed in the tally though nothing was
    // ever sent. The store never catches that throw and commits anyway, so no
    // number depended on it; a caller that does must not be billed for it.
    const refusedSet = await measure(function () {
      const db = k.ctx.ZC.firebase.db;
      const col = db.collection('wc-scratch');
      const refusals = [];
      const batch = db.batch();
      try {
        batch.set(col.doc('refused-a'), { nope: undefined });
      } catch (err) {
        refusals.push('batch');
      }
      batch.set(col.doc('kept-a'), { n: 1 });
      return batch.commit().then(function () {
        return db.runTransaction(function (tx) {
          try {
            tx.set(col.doc('refused-b'), { nope: undefined });
          } catch (err) {
            if (refusals.indexOf('tx') < 0) refusals.push('tx');
          }
          tx.set(col.doc('kept-b'), { n: 2 });
          return Promise.resolve();
        });
      }).then(function () { return refusals; });
    });
    k.ctx.drainWarnings();

    const keptAndRefused = [];
    for (const id of ['kept-a', 'kept-b', 'refused-a', 'refused-b']) {
      if (await k.admin.get('wc-scratch', id)) keptAndRefused.push(id);
    }
    t.check('a batched or transactional write the SDK refuses on the spot is not counted',
      k.same(refusedSet.value, ['batch', 'tx']) && k.same(keptAndRefused, ['kept-a', 'kept-b']) &&
        refusedSet.writes === 2 &&
        k.same(refusedSet.wrote, ['batch:wc-scratch/kept-a:set', 'tx:wc-scratch/kept-b:set']),
      'refused: ' + k.show(refusedSet.value) + '; ' + refusedSet.writes + ' write(s): ' +
      k.show(refusedSet.wrote) + '; landed: ' + k.show(keptAndRefused));

    /* ---- 16. the instrument: a read the cache answers is no read --------- */

    // `cachedUsage` asks for a document with `{ source: 'cache' }`, and a read
    // the client answers from what it already holds never reaches Firestore,
    // so it is not billed. The counter used to count every `get` that
    // resolved. A listener on the document keeps it in the client's cache, and
    // its one delivery is the only read here that Firestore bills.
    await k.admin.set('wc-scratch', 'cached', { n: 1 });
    const cachedRead = await measure(async function () {
      const ref = k.ctx.ZC.firebase.db.collection('wc-scratch').doc('cached');
      let stop = null;
      const heardIt = await new Promise(function (resolve) {
        const timer = setTimeout(function () { resolve(false); }, 10000);
        stop = ref.onSnapshot(function () { clearTimeout(timer); resolve(true); },
          function () { clearTimeout(timer); resolve(false); });
      });
      try {
        const snap = await ref.get({ source: 'cache' });
        return { heard: heardIt, fromCache: snap.metadata.fromCache, n: snap.exists ? snap.data().n : null };
      } finally {
        stop();
      }
    });
    k.ctx.drainWarnings();

    t.check('a read the client\'s cache answers is not counted',
      cachedRead.value.heard === true && cachedRead.value.fromCache === true && cachedRead.value.n === 1 &&
        cachedRead.reads === 1 && cachedRead.calls === 1,
      cachedRead.reads + ' read(s) in ' + cachedRead.calls + ' call(s), against the listener\'s one; ' +
      k.show(cachedRead.value));
  }
};
