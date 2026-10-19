/* ==========================================================================
   Deleting an account actually deletes it.

   This is the most consequential thing the app does and the least reversible.
   docs/DEPLOY.md says the rules are shaped "so unmatch and account deletion
   can purge the conversation before the match goes", and that a report's
   subject may delete it because "that is what lets account deletion purge
   everything the account wrote". Those are promises about a database.

   Until this file, every test of them ran against `localStorage`. The demo
   adapter deletes by looping over three plain objects and cannot really fail;
   the Firebase adapter is a client-side traversal of five collections, done a
   query at a time, from a browser, with no transaction around it and no server
   to finish the job if the tab closes. The two share a name and nothing else,
   and it was the one nobody ran that people's data actually goes through.

   What is checked here is completeness: seed an account with a footprint in
   every place an account can leave one, run the shipped `deleteAccountData`,
   then enumerate whole collections and assert the uid appears in none of them.
   Enumerating matters — asking for the ids the test happens to know about
   would only ever re-prove the traversal the test itself was written from, and
   the whole risk is the document nobody thought to look for.

   The one thing deliberately expected to survive is a report *about* the
   account. That is somebody else's document in an abuse queue, it is what the
   queue is for, and DEPLOY.md says so. A test that demanded its removal would
   be encoding a bug as a requirement. The other is a pass aimed at the
   account: firestore.rules keeps a pass private to its author, so the account
   can neither read, find nor delete one, and it stays with the account that
   made it.
   The sweep seeds none; the last two sections, run under the real rules, do —
   the second with a pass its author makes while the purge is running.
   ========================================================================== */
'use strict';

/** Where an account can leave something behind. */
const COLLECTIONS = ['users', 'discovery', 'swipes', 'matches', 'reports'];

module.exports = {
  title: 'Deleting an account leaves nothing of it behind',

  async run(t, k) {
    const me = 'purge-me';
    const other = 'purge-other';
    const matchId = [me, other].sort().join('_');

    /* ---- an account with a footprint everywhere one can exist ---------- */

    await k.admin.set('users', me, k.h.userDoc(me));
    await k.admin.set('users', other, k.h.userDoc(other));
    await k.admin.set('discovery', me, k.h.discoveryDoc(me));
    await k.admin.set('discovery', other, k.h.discoveryDoc(other));

    // Both directions. An inbound like is data *about* this account and must
    // not outlive it, which is the half a purge written from the account's own
    // point of view is most likely to miss.
    await k.admin.set('swipes', me + '_' + other, { from: me, to: other, action: 'like', createdAt: new Date().toISOString() });
    await k.admin.set('swipes', other + '_' + me, { from: other, to: me, action: 'like', createdAt: new Date().toISOString() });

    await k.admin.set('matches', matchId, {
      matchId: matchId, users: [me, other].sort(), createdAt: new Date().toISOString()
    });
    // Messages live in a subcollection, so they are reachable only by knowing
    // to look. A match document deleted with its messages left underneath it
    // is the classic orphan.
    await k.admin.set('matches/' + matchId + '/messages', 'm1', { from: me, text: 'mine', createdAt: new Date().toISOString() });
    await k.admin.set('matches/' + matchId + '/messages', 'm2', { from: other, text: 'theirs', createdAt: new Date().toISOString() });

    await k.admin.set('reports', me + '_' + other, { from: me, about: other, reason: 'spam', createdAt: new Date().toISOString() });
    await k.admin.set('reports', other + '_' + me, { from: other, about: me, reason: 'spam', createdAt: new Date().toISOString() });

    const before = {};
    for (const name of COLLECTIONS) before[name] = (await k.admin.list(name)).length;
    const messagesBefore = (await k.admin.list('matches/' + matchId + '/messages')).length;
    t.check('the account has something in every collection before the purge',
      before.users === 2 && before.discovery === 2 && before.swipes === 2 &&
      before.matches === 1 && before.reports === 2 && messagesBefore === 2,
      k.show(Object.assign({ messages: messagesBefore }, before)));

    /* ---- the shipped purge, against a real Firestore -------------------- */

    const returned = await k.store.deleteAccountData(me);
    k.ctx.drainWarnings();
    t.check('deleteAccountData reports success', returned === true, k.show(returned));

    /* ---- nothing of the account survives -------------------------------- */

    const survivors = [];
    for (const name of COLLECTIONS) {
      const docs = await k.admin.list(name);
      docs.forEach(function (doc) {
        // A report *about* the account is the documented exception.
        if (name === 'reports' && doc.data && doc.data.about === me && doc.data.from !== me) return;
        const json = JSON.stringify({ id: doc.id, data: doc.data });
        if (json.indexOf(me) !== -1) survivors.push(name + '/' + doc.id + ' ' + json.slice(0, 90));
      });
    }
    const orphanMessages = await k.admin.list('matches/' + matchId + '/messages');
    orphanMessages.forEach(function (doc) {
      survivors.push('matches/' + matchId + '/messages/' + doc.id + ' ' + k.show(doc.data));
    });

    t.check('no document anywhere still mentions the deleted account',
      survivors.length === 0, survivors.slice(0, 4).join(' | ') || 'checked ' + COLLECTIONS.join(', ') + ' and the match messages');

    // Named separately from the sweep above, because this is the one other people
    // read: every signed-in user can read a discoverable discovery/{uid}, and a
    // match can read it whatever it says, so a projection that outlives its
    // account is a profile still on display for somebody who asked to be gone.
    t.check('the public projection is gone',
      (await k.admin.get('discovery', me)) === null,
      k.show(await k.admin.get('discovery', me)));

    /* ---- and nothing of anybody else's went with it --------------------- */

    // A purge that deleted too much would pass every check above. The other
    // account keeps its own documents; what it loses is the shared ones, which
    // is deliberate and documented — a conversation cannot have one side.
    t.check('the other account is untouched',
      (await k.admin.get('users', other)) !== null && (await k.admin.get('discovery', other)) !== null,
      'users/' + other + ' and discovery/' + other);

    t.check('their report about the deleted account is retained for the queue',
      (await k.admin.get('reports', other + '_' + me)) !== null,
      'reports/' + other + '_' + me);

    /* ---- a purge that fails, fails before it has broken anything -------- */

    // Deletion is a traversal of several collections with no transaction around
    // it — there cannot be one, on the free tier, from a browser — so it is not
    // atomic and `settings.js` tells the user so. What CAN be arranged is the
    // order: the one step with no prior casualty goes first, so the failure mode
    // this file is about leaves the account exactly as it was.
    //
    // The filed-reports purge used to be last AND swallowed. Letting it throw
    // was half the fix; done in its old position it threw only after the swipes
    // and matches had gone, so it reported a failure over an account whose
    // relationships were already irrecoverable. A reviewer caught that the
    // "leaves the account whole" claim did not hold, and it does not — unless
    // the purge runs first, which is what this asserts.
    const victim = 'purge-order';
    const friend = 'purge-order-friend';
    const pairId = [victim, friend].sort().join('_');
    await k.admin.set('users', victim, k.h.userDoc(victim));
    await k.admin.set('discovery', victim, k.h.discoveryDoc(victim));
    await k.admin.set('swipes', victim + '_' + friend, k.h.swipeDoc(victim, friend, 'like'));
    await k.admin.set('matches', pairId, k.h.matchDoc(victim, friend));
    await k.admin.set('reports', victim + '_' + friend, k.h.reportDoc(victim, friend));

    const real = k.ctx.ZC.firebase.db;
    let refused = 0;
    // A Firestore whose `reports` collection cannot be queried — the shape of
    // the failure, injected so the ordering is executed rather than argued.
    k.ctx.ZC.firebase.db = new Proxy(real, {
      get: function (obj, prop) {
        const value = obj[prop];
        if (prop !== 'collection' || typeof value !== 'function') return value;
        return function (name) {
          const col = value.apply(obj, arguments);
          if (name !== 'reports') return col;
          return new Proxy(col, {
            get: function (c, p) {
              if (p !== 'where') return c[p];
              return function () { refused += 1; throw new Error('reports are unreadable'); };
            }
          });
        };
      }
    });
    let threw = false;
    try {
      await k.store.deleteAccountData(victim);
    } catch (err) {
      threw = true;
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    const survived = {
      user: (await k.admin.get('users', victim)) !== null,
      discovery: (await k.admin.get('discovery', victim)) !== null,
      swipe: (await k.admin.get('swipes', victim + '_' + friend)) !== null,
      match: (await k.admin.get('matches', pairId)) !== null
    };

    t.check('a purge that cannot read the reports says so instead of returning true',
      threw && refused > 0, threw ? refused + ' refusal(s), and it threw' : 'it did NOT throw');

    t.check('and it fails before deleting anything, so a retry has something to finish',
      survived.user && survived.discovery && survived.swipe && survived.match,
      k.show(survived) + ' — with the purge last, the swipe and the match would ' +
      'already be gone and no retry could bring them back');

    /* ---- and under the real rules, as the account itself ---------------- */

    // Everything above runs on this suite's open rules. The purge is the one
    // thing the account does for itself that reads the most of other people's
    // documents, and firestore.rules now keeps a pass private to its author:
    // the account a pass is aimed at may not read it, and a query that could
    // return one — `swipes where to == me`, which the purge used to ask — is
    // refused whole. So the shipped purge is run here as its own account
    // against the real ruleset, where the open rules above could never refuse it.
    const leaving = 'purge-real';
    const liker = 'purge-real-liker';
    const passer = 'purge-real-passer';
    const rdb = function (c) { return c.firestore(); };
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = rdb(c);
      await k.fs.setDoc(k.fs.doc(db, 'users', leaving), k.h.userDoc(leaving));
      await k.fs.setDoc(k.fs.doc(db, 'discovery', leaving), k.h.discoveryDoc(leaving));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', leaving + '_' + liker), k.h.swipeDoc(leaving, liker, 'like'));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', liker + '_' + leaving), k.h.swipeDoc(liker, leaving, 'like'));
      await k.fs.setDoc(k.fs.doc(db, 'swipes', passer + '_' + leaving), k.h.swipeDoc(passer, leaving, 'pass'));
    });
    let realOutcome;
    try {
      k.ctx.ZC.firebase.db = k.rulesEnv.authenticatedContext(leaving).firestore();
      realOutcome = await k.store.deleteAccountData(leaving).catch(function (err) {
        return { rejected: (err && err.code) || String(err) };
      });
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    const left = {};
    await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
      const db = rdb(c);
      for (const path of ['users/' + leaving, 'discovery/' + leaving, 'swipes/' + leaving + '_' + liker,
                          'swipes/' + liker + '_' + leaving, 'swipes/' + passer + '_' + leaving]) {
        left[path] = (await k.fs.getDoc(k.fs.doc(db, path))).exists();
      }
    });

    t.check('under the real rules, the account can delete itself',
      realOutcome === true, k.show(realOutcome));

    t.check('taking its own swipes, the likes aimed at it, and both of its documents',
      !left['users/' + leaving] && !left['discovery/' + leaving] &&
        !left['swipes/' + leaving + '_' + liker] && !left['swipes/' + liker + '_' + leaving],
      k.show(left));

    // The one inbound swipe it cannot find. It is the passer's own record of a
    // decision, readable by nobody else, and the account it names is gone; the
    // demo adapter leaves it the same way, and tests/data-store.test.js says so.
    t.check('while a pass aimed at it stays with the account that made it',
      left['swipes/' + passer + '_' + leaving] === true, k.show(left));

    /* ---- a like rewound while the purge is deleting it ------------------ */

    // The rules let the account a swipe is aimed at delete it only while it is a
    // like or a super like: the id is `from_to`, so somebody passed on knows it,
    // and a pass they deleted would put them back in its author's deck. A miss
    // aimed at them is refused too, or the refusal would be the pass.
    //
    // That makes one race in the purge matter. It lists the likes aimed at the
    // account and deletes them in a batch, which commits all or nothing; a liker
    // who rewinds in between leaves that batch deleting a miss, or a pass if they
    // swiped again, and the whole batch is refused. Each case below rewinds
    // exactly there, as the liker, under the real rules — between the query and
    // the commit of a batch that holds the like, once per liker — and a super
    // like from somebody who does not rewind shares the batch, to show what the
    // refusal took with it.
    async function raceRewind(leaver, rewinders, again) {
      const bystander = 'swipes/' + leaver + '-bystander_' + leaver;
      const raced = [];
      for (let i = 0; i < rewinders; i += 1) raced.push('swipes/' + leaver + '-rewinder' + i + '_' + leaver);
      const swipeAt = function (path, action) {
        const from = path.slice('swipes/'.length, path.lastIndexOf('_'));
        return k.h.swipeDoc(from, leaver, action);
      };
      await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
        const db = rdb(c);
        await k.fs.setDoc(k.fs.doc(db, 'users', leaver), k.h.userDoc(leaver));
        await k.fs.setDoc(k.fs.doc(db, 'discovery', leaver), k.h.discoveryDoc(leaver));
        for (const path of raced) await k.fs.setDoc(k.fs.doc(db, path), swipeAt(path, 'like'));
        await k.fs.setDoc(k.fs.doc(db, bystander), swipeAt(bystander, 'super'));
      });
      const own = k.rulesEnv.authenticatedContext(leaver).firestore();
      const fired = [];
      const racing = new Proxy(own, {
        get: function (obj, prop) {
          const value = obj[prop];
          if (typeof value !== 'function') return value;
          if (prop !== 'batch') return value.bind(obj);
          return function () {
            const batch = value.apply(obj, arguments);
            const paths = [];
            const remove = batch.delete.bind(batch);
            const commit = batch.commit.bind(batch);
            batch.delete = function (ref) { paths.push(ref.path); return remove(ref); };
            batch.commit = async function () {
              const next = raced.find(function (path) {
                return paths.indexOf(path) !== -1 && fired.indexOf(path) === -1;
              });
              if (next) {
                fired.push(next);
                const theirs = k.rulesEnv.authenticatedContext(swipeAt(next).from).firestore();
                await theirs.doc(next).delete();
                if (again) await theirs.doc(next).set(swipeAt(next, again));
              }
              return commit();
            };
            return batch;
          };
        }
      });
      const run = async function (db) {
        try {
          k.ctx.ZC.firebase.db = db;
          return await k.store.deleteAccountData(leaver).catch(function (err) {
            return { rejected: (err && err.code) || String(err) };
          });
        } finally {
          k.ctx.ZC.firebase.db = real;
          k.ctx.drainWarnings();
        }
      };
      const look = async function () {
        const out = {};
        await k.rulesEnv.withSecurityRulesDisabled(async function (c) {
          const db = rdb(c);
          for (const path of ['users/' + leaver, 'discovery/' + leaver].concat(raced, [bystander])) {
            const snap = await k.fs.getDoc(k.fs.doc(db, path));
            out[path] = snap.exists() ? (snap.data().action || 'present') : false;
          }
        });
        return out;
      };
      const outcome = await run(racing);
      return { outcome: outcome, after: await look(), fired: fired.length,
               raced: raced, bystander: bystander, run: run, look: look };
    }

    const gone = await raceRewind('purge-race-gone', 1, null);
    t.check('a like rewound between the purge\'s query and its delete does not stop the purge',
      gone.fired === 1 && gone.outcome === true &&
        !gone.after['users/purge-race-gone'] && !gone.after['discovery/purge-race-gone'],
      'rewound ' + gone.fired + ' time(s); returned ' + k.show(gone.outcome) + '; left ' + k.show(gone.after));

    t.check('and the other like that batch held is purged with the rest',
      gone.after[gone.bystander] === false && gone.after[gone.raced[0]] === false, k.show(gone.after));

    const passed = await raceRewind('purge-race-pass', 1, 'pass');
    t.check('nor does one rewound and swiped again as a pass',
      passed.fired === 1 && passed.outcome === true &&
        !passed.after['users/purge-race-pass'] && !passed.after['discovery/purge-race-pass'] &&
        passed.after[passed.bystander] === false,
      'rewound ' + passed.fired + ' time(s); returned ' + k.show(passed.outcome) + '; left ' + k.show(passed.after));

    t.check('and that pass stays with the account that made it',
      passed.after[passed.raced[0]] === 'pass', k.show(passed.after));

    // The purge asks again once. Refused a second time, it throws like any other
    // failure, with the account's own documents still there, which is what lets
    // the person's retry finish it.
    const twice = await raceRewind('purge-race-twice', 2, null);
    t.check('a purge refused again says so, and keeps the documents a retry starts from',
      twice.fired === 2 && twice.outcome && twice.outcome.rejected === 'permission-denied' &&
        twice.after['users/purge-race-twice'] === 'present' && twice.after['discovery/purge-race-twice'] === 'present',
      'rewound ' + twice.fired + ' time(s); returned ' + k.show(twice.outcome) + '; left ' + k.show(twice.after));

    const retried = await twice.run(k.rulesEnv.authenticatedContext('purge-race-twice').firestore());
    const afterRetry = await twice.look();
    t.check('and the retry does',
      retried === true && Object.keys(afterRetry).every(function (path) { return afterRetry[path] === false; }),
      'returned ' + k.show(retried) + '; left ' + k.show(afterRetry));
  }
};
