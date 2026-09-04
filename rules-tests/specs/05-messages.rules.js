/* matches/{matchId}/messages/{msgId} — the conversation.

   Messages are never editable, so neither side can rewrite what was said after
   the fact. Deletes ARE allowed to participants, because unmatch and account
   deletion have to purge the conversation before removing the parent match —
   a deleted match would otherwise strand its messages forever, unreadable but
   undeletable. That trade-off is deliberate, and asserted here. */
'use strict';

module.exports = {
  title: 'matches/{id}/messages — participants only, append-only, self-authored',

  async run(t, ctx) {
    const { h, testing, seed, as, anon, ok } = ctx;
    const { assertSucceeds, assertFails } = testing;
    const ME = 'me';
    const PEER = 'peer';
    const OUTSIDER = 'outsider';
    const THIRD = 'third';

    const mine = h.pairId(ME, PEER);
    const theirs = h.pairId(OUTSIDER, THIRD);

    await seed(async function (admin) {
      const db = admin.firestore();
      await db.doc('matches/' + mine).set(h.matchDoc(ME, PEER));
      await db.doc('matches/' + theirs).set(h.matchDoc(OUTSIDER, THIRD));
      await db.doc('matches/' + mine + '/messages/seeded').set(h.messageDoc(PEER, 'seeded from them'));
      await db.doc('matches/' + theirs + '/messages/seeded').set(h.messageDoc(OUTSIDER, 'not your business'));
    });

    /* ---- reads ---- */
    t.check('a participant can read the conversation',
      await ok(assertSucceeds(as(ME).collection('matches/' + mine + '/messages').get())));

    t.check('an outsider cannot read a conversation they are not in',
      await ok(assertFails(as(ME).collection('matches/' + theirs + '/messages').get())));

    t.check('a signed-out visitor cannot read messages',
      await ok(assertFails(anon().collection('matches/' + mine + '/messages').get())));

    /* ---- create ---- */
    // One unexpected key is the whole test. `hasAll` admitted any number of them at
    // any size, so a document the rules called well-formed could still be padded to
    // Firestore's 1 MiB ceiling; a spec that actually wrote a megabyte would prove the
    // same thing and take a hundred times as long.
    // This one is the sharpest: the 1000-character cap on `text` reads like a bound on
    // the message and bounded only that field.
    t.check('a message carrying a field the shape does not name is refused',
      await ok(assertFails(as(ME).collection('matches/' + mine + '/messages').add(
        Object.assign(h.messageDoc(ME, 'hello'), { padding: 'x'.repeat(64) })
      ))));

    t.check('a message timestamp longer than a timestamp is refused',
      await ok(assertFails(as(ME).collection('matches/' + mine + '/messages').add(
        Object.assign(h.messageDoc(ME, 'hello'), { createdAt: 'x'.repeat(200) })
      ))));

    t.check('a participant can send a message as themselves',
      await ok(assertSucceeds(as(ME).collection('matches/' + mine + '/messages').add(h.messageDoc(ME, 'hello')))));

    t.check('you cannot put words in the other person\'s mouth',
      await ok(assertFails(as(ME).collection('matches/' + mine + '/messages').add(h.messageDoc(PEER, 'forged')))));

    t.check('an outsider cannot post into a stranger\'s conversation',
      await ok(assertFails(as(ME).collection('matches/' + theirs + '/messages').add(h.messageDoc(ME, 'intruding')))));

    t.check('an empty message is rejected',
      await ok(assertFails(as(ME).collection('matches/' + mine + '/messages').add(h.messageDoc(ME, '')))));

    t.check('a message over 1000 characters is rejected',
      await ok(assertFails(as(ME).collection('matches/' + mine + '/messages').add(h.messageDoc(ME, 'x'.repeat(1001))))));

    t.check('exactly 1000 characters is still allowed',
      await ok(assertSucceeds(as(ME).collection('matches/' + mine + '/messages').add(h.messageDoc(ME, 'x'.repeat(1000))))));

    t.check('you cannot post to a match that does not exist',
      await ok(assertFails(as(ME).collection('matches/' + h.pairId(ME, 'ghost') + '/messages').add(h.messageDoc(ME, 'hi')))));

    /* ---- immutability ---- */
    t.check('a message can never be edited, even your own',
      await ok(assertFails(as(ME).doc('matches/' + mine + '/messages/seeded').update({ text: 'rewritten' }))));

    /* ---- delete: needed by unmatch and account deletion ---- */
    t.check('an outsider cannot delete someone else\'s message',
      await ok(assertFails(as(ME).doc('matches/' + theirs + '/messages/seeded').delete())));

    t.check('a participant can delete a message (unmatch purges the thread first)',
      await ok(assertSucceeds(as(ME).doc('matches/' + mine + '/messages/seeded').delete())));
  }
};
