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
   be encoding a bug as a requirement.
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

    // Named separately from the sweep above, because this is the one that is
    // world-readable: every signed-in user can read discovery/{uid}, so a
    // projection that outlives its account is a profile still on display for
    // somebody who asked to be gone.
    t.check('the world-readable projection is gone',
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
  }
};
