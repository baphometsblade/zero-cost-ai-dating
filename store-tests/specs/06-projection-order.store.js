/* ==========================================================================
   The projection has to agree with the document it projects.

   updateUser writes two documents: the private users/{uid} and the public
   discovery/{uid} that everybody else's deck reads. It used to write them
   separately — the transaction committed, and then a follow-up set published
   the projection.

   Two saves racing that way commit their user documents in one order and can
   publish their projections in the other, because two independent promises
   settle on their own schedule. The loser is the *public* profile: it keeps
   an older name, bio or location than the account it is supposed to mirror,
   and nothing ever corrects it, because the next write publishes from the
   next value rather than reconciling this one.

   Putting the projection inside the same transaction is what makes that
   impossible: both documents commit together, and whichever save commits
   second has read the first. This spec pins the invariant — the two
   documents agree — rather than the mechanism, so it keeps its meaning if
   the implementation changes again.

   Read this check honestly. It is a GUARD, not a reproduction. Reverting the
   fix — publishing the projection after the transaction, the way it used to
   — leaves this spec green: run against the emulator over loopback, twenty
   racing saves settled in commit order every time, three runs out of three.
   Every request here travels the same near-zero distance, so the window the
   bug needs barely exists. It is wider wherever latency varies, which is
   everywhere else. So the fix rests on the ordering argument above, and this
   spec exists to catch a regression that breaks the invariant outright — not
   to prove the race was real. Nothing in this suite proves that. */
'use strict';

/** Concurrent saves. Enough that an ordering inversion would show up. */
const N = 20;

module.exports = {
  title: 'A racing save cannot leave the public projection behind',

  async run(t, k) {
    const uid = 'projection-order';
    await k.admin.set('users', uid, k.h.userDoc(uid));

    // All at once, deliberately: these are not sequenced the way the deck
    // sequences a swipe, because the point is the ordering between two
    // independent saves rather than the deck's own pattern.
    const names = [];
    const saves = [];
    for (let i = 1; i <= N; i++) {
      const displayName = 'Name ' + i;
      names.push(displayName);
      saves.push(k.store.updateUser(uid, { displayName: displayName }));
    }
    const rejected = [];
    await Promise.all(saves.map(function (p) {
      return p.catch(function (err) { rejected.push(err && err.message ? err.message : String(err)); });
    }));

    const user = (await k.admin.get('users', uid)) || {};
    const shadow = (await k.admin.get('discovery', uid)) || {};
    const userName = user.displayName;
    const shadowName = shadow.displayName;

    t.check(
      'every save committed',
      rejected.length === 0,
      rejected.length + ' rejection(s)' + (rejected.length ? ': ' + rejected[0] : '')
    );
    t.check(
      'the winning name is one of the names actually written',
      names.indexOf(userName) !== -1,
      'stored ' + k.show(userName)
    );
    t.check(
      'the public projection shows the same name as the private document',
      shadowName === userName,
      'users/' + uid + ' says ' + k.show(userName) +
        ', discovery/' + uid + ' says ' + k.show(shadowName)
    );
    t.check(
      'the projection still carries only the public shape',
      shadow.email === undefined && shadow.blocked === undefined &&
        shadow.usage === undefined && shadow.learning === undefined,
      k.show(Object.keys(shadow).sort())
    );
  }
};
