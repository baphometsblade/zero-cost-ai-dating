/* ==========================================================================
   The who-liked-you count is live, correct, and costs what changed.

   Its query is `swipes where to == me`, which has a blind spot the poll it
   replaced did not: it never fires when *I* answer somebody, because my swipe
   is aimed the other way. The first version of this listener therefore kept
   counting a person after I had passed on them — until something unrelated
   moved or the page reloaded. That is a correctness regression paid for a cost
   win, which is not a trade worth making, and it is the check below that found
   it:

     PASS  the three waiting likes are counted        [[3]]
     FAIL  answering one takes it off the count       [[3]]

   The fix costs nothing: `recordSwipe` already knows it answered somebody, so
   it says so directly rather than the listener spending a read to find out.

   The cost claim is the other half. Whether each sender has been answered is
   remembered rather than recomputed, so a new inbound like costs one read for
   the change, one for the sender's own record, and one for the block list —
   three, whether eight people have liked this account or eight hundred.
   ========================================================================== */
'use strict';

/** People who have liked this account before the measurement starts. */
const WAITING = 8;

/** Long enough for a snapshot and the lookups it triggers. */
const SETTLE_MS = 1200;

/** @returns {Promise<void>} */
function settle(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms || SETTLE_MS); });
}

module.exports = {
  title: 'A live like count is corrected by this client, and costs what changed',

  async run(t, k) {
    const me = 'likes-me';
    await k.admin.set('users', me, k.h.userDoc(me));

    const likers = [];
    for (let i = 0; i < WAITING; i += 1) {
      const them = 'likes-them-' + String(i).padStart(2, '0');
      likers.push(them);
      await k.admin.set('users', them, k.h.userDoc(them));
      await k.admin.set('swipes', them + '_' + me, {
        id: them + '_' + me, from: them, to: me, action: i % 3 ? 'like' : 'super',
        createdAt: '2026-01-02T00:00:00.000Z'
      });
    }

    const real = k.ctx.ZC.firebase.db;
    const tally = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, tally);

    const seen = [];
    let stop = function () { /* replaced below */ };
    try {
      stop = k.store.listenLikesReceived(me, function (count) { seen.push(count); });
      await settle();
      k.ctx.drainWarnings();

      t.check('everyone still waiting is counted',
        seen[seen.length - 1] === WAITING, k.show(seen));

      // The query itself, the block list once, and whether each sender was
      // answered — asked ten at a time. This check used to pin "one lookup per
      // sender", 2M + 1, and it was right about the code: a `get` per sender,
      // each billed even though a waiting sender's answer is a document that
      // does not exist. The lookup now goes through `alreadySwiped`, which bills
      // what it finds with a floor of one per batch of ten, so everybody still
      // waiting costs one read per ten of them. `specs/21-navigation-cost`
      // carries the reason this matters: it is paid on every page, not once.
      const lookups = Math.ceil(WAITING / 10);
      t.check('subscribing costs the senders, the blocks once, and one lookup per ten senders',
        tally.reads === WAITING + 1 + lookups,
        tally.reads + ' reads for ' + WAITING + ' waiting (expected ' + (WAITING + 1 + lookups) + ')');

      /* ---- this client answering somebody ------------------------------- */

      const before = tally.reads;
      const deliveries = seen.length;
      await k.store.recordSwipe(me, likers[0], 'pass');
      await settle();
      k.ctx.drainWarnings();

      t.check('answering one takes it off the count',
        seen.length > deliveries && seen[seen.length - 1] === WAITING - 1, k.show(seen));

      // Exactly one, and named rather than given slack: `recordSwipe` reads the
      // pair's existing swipe document and, for a pass, stops there. So the
      // listener spends nothing — the swipe it needs to know about is the one
      // this client just wrote, and it is told rather than sent looking.
      //
      // An upper bound with room in it would pass just as well against a
      // listener that had gone back to recomputing, as long as few enough
      // people were waiting. This fails if recordSwipe's own cost changes too,
      // which is worth knowing on a path the deck runs on every swipe.
      t.check('and the count itself costs one read, recordSwipe\'s own',
        tally.reads - before === 1,
        (tally.reads - before) + ' read(s) across the answer');

      /* ---- and a rewind putting it back --------------------------------- */

      await k.store.undoSwipe(me, likers[0]);
      await settle();
      k.ctx.drainWarnings();

      t.check('a rewind puts them back on the count',
        seen[seen.length - 1] === WAITING, k.show(seen.slice(-3)));

      /* ---- somebody new liking this account ----------------------------- */

      const beforeNew = tally.reads;
      const newcomer = 'likes-newcomer';
      await k.admin.set('users', newcomer, k.h.userDoc(newcomer));
      await k.admin.set('swipes', newcomer + '_' + me, {
        id: newcomer + '_' + me, from: newcomer, to: me, action: 'like',
        createdAt: '2026-01-03T00:00:00.000Z'
      });
      await settle();
      k.ctx.drainWarnings();

      t.check('a new like is counted', seen[seen.length - 1] === WAITING + 1, k.show(seen.slice(-2)));

      // The check that would fail if the answered set were recomputed from
      // scratch on every delivery: this would be WAITING + 2 reads instead.
      t.check('and costs three reads however many were already waiting',
        tally.reads - beforeNew === 3,
        (tally.reads - beforeNew) + ' read(s) with ' + WAITING + ' already there');
    } finally {
      stop();
      k.ctx.ZC.firebase.db = real;
    }

    /* ---- a stream that dies says so, and lets go ------------------------- */

    // This listener took no error handler. When its stream died the store
    // warned and stopped there, `app.js` kept holding the dead handle, and its
    // `if (!likeStop)` refused every re-subscription for the life of the page —
    // the defect `listenMatches` lost a round earlier, left on its sibling.
    // Injected at the query, because this project runs open rules here and the
    // emulator will not deny anything.
    const broken = {
      collection: function () {
        const query = {
          where: function () { return query; },
          onSnapshot: function (next, onErr) {
            setTimeout(function () { onErr(new Error('Missing or insufficient permissions.')); }, 0);
            return function () { /* nothing to unsubscribe */ };
          }
        };
        return query;
      }
    };
    k.ctx.ZC.firebase.db = broken;
    const deadSeen = [];
    const deadErrors = [];
    try {
      // Deliberately never stopped: a caller told the stream is over lets go of
      // the handle rather than calling it, which is exactly what app.js does.
      k.store.listenLikesReceived(me, function (count) { deadSeen.push(count); },
        function (err) { deadErrors.push(err); });
      await settle(200);
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    t.check('a like stream that dies tells its caller, once, and delivers nothing',
      deadErrors.length === 1 && deadSeen.length === 0,
      deadErrors.length + ' error(s), ' + deadSeen.length + ' delivery(s)');

    // The half a caller cannot do for itself. `recordSwipe` drives every live
    // like watcher directly, so one whose stream had died — and whose caller,
    // told to let go, never unsubscribed — would go on being handed counts.
    await k.store.recordSwipe(me, likers[1], 'pass');
    await settle(200);
    k.ctx.drainWarnings();
    t.check('and the dead watcher is retired: answering somebody afterwards reaches no one',
      deadSeen.length === 0,
      deadSeen.length + ' delivery(s) to a stream that had already died');

    // And a fresh subscription afterwards works at all.
    const retried = [];
    const stopRetry = k.store.listenLikesReceived(me, function (count) { retried.push(count); });
    await settle();
    stopRetry();
    k.ctx.drainWarnings();
    t.check('and a fresh subscription after the failure counts again',
      retried.length > 0 && retried[retried.length - 1] === WAITING,
      k.show(retried));

    /* ---- the list on the page that is already counting ------------------- */

    // matches.html on premium draws who liked you (`renderLikes`, on the first
    // delivery of the conversation list) while `app.js`'s nav badge — this
    // listener — is counting the same people. Both used to do the whole job:
    // the sender query, the account for its block list, and the answered-lookup.
    // Run in firebase mode in a browser with twelve waiting, the list's call
    // landed BEFORE the badge's first count on every load measured, and the
    // page sent the account read and both lookups twice — each of the list's after the badge's had finished, so the SDK had
    // nothing to share them with: three billed reads more. The sender query it
    // did not send twice: a `get` of a query a listener is already holding is
    // served from that listener's target.
    //
    // Which makes this tally's number for the old code — 46 — requests, not a
    // bill, and here even more so than on the page: asked in the same tick as
    // the subscription, the old code's account read and lookups started together
    // with the count's, and the SDK shared those too (measured with twelve
    // senders, all waiting: the emulator saw one of each). What is pinned is the property, not the coincidence — the
    // list asks for nothing the count is asking for, so it costs nothing extra
    // whichever way the timing falls. Same argument as the shared match stream's.
    //
    // A fresh account and its own likers, so the arithmetic is only this. Two
    // of them are not waiting — one this account has already answered, one it
    // has blocked — so a list handed every sender the count holds, rather than
    // the ones it counts, names two people too many.
    const page = 'likes-page';
    const PAGE_WAITING = 12;
    const answeredLiker = 'likes-page-answered';
    const blockedLiker = 'likes-page-blocked';
    await k.admin.set('users', page, k.h.userDoc(page, { blocked: [blockedLiker] }));
    for (const them of [answeredLiker, blockedLiker]) {
      await k.admin.set('discovery', them, k.h.discoveryDoc(them));
      await k.admin.set('swipes', them + '_' + page, {
        id: them + '_' + page, from: them, to: page, action: 'like', createdAt: '2026-01-04T00:00:00.000Z'
      });
    }
    await k.admin.set('swipes', page + '_' + answeredLiker, {
      id: page + '_' + answeredLiker, from: page, to: answeredLiker, action: 'pass',
      createdAt: '2026-01-04T00:00:00.000Z'
    });
    for (let i = 0; i < PAGE_WAITING; i += 1) {
      const them = 'likes-page-' + String(i).padStart(2, '0');
      await k.admin.set('discovery', them, k.h.discoveryDoc(them));
      await k.admin.set('swipes', them + '_' + page, {
        id: them + '_' + page, from: them, to: page, action: i % 3 ? 'like' : 'super',
        createdAt: '2026-01-04T00:00:00.000Z'
      });
    }
    // The count asks about every sender, the blocked one included; the one
    // answered is the only swipe either lookup finds, inside the floor of one
    // read per batch.
    const pageSenders = PAGE_WAITING + 2;
    const pageLookups = Math.ceil(pageSenders / 10);

    // Cold faces, so every profile the list returns is a read it pays.
    globalThis.localStorage.removeItem(k.store.KEYS.profiles);
    const pageTally = { reads: 0, calls: 0 };
    k.ctx.ZC.firebase.db = k.h.countingDb(real, pageTally);
    const pageCounts = [];
    let pageList = null;
    let stopPage = function () { /* replaced below */ };
    try {
      stopPage = k.store.listenLikesReceived(page, function (count) { pageCounts.push(count); });
      // Asked before the count has arrived, which is the order the page runs in.
      pageList = await k.store.getLikesReceived(page);
      await settle();
    } finally {
      stopPage();
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();

    const pageIds = (pageList || []).map(function (user) { return user.uid; });
    t.check('a list asked for before the live count has delivered names everyone waiting, and only them, as the count does',
      pageIds.length === PAGE_WAITING && pageIds.indexOf(answeredLiker) === -1 && pageIds.indexOf(blockedLiker) === -1 &&
      pageCounts[pageCounts.length - 1] === PAGE_WAITING,
      'list ' + pageIds.length +
      (pageIds.indexOf(answeredLiker) === -1 ? '' : ', naming the person already answered') +
      (pageIds.indexOf(blockedLiker) === -1 ? '' : ', naming the person blocked') +
      ', count ' + k.show(pageCounts));
    t.check('and asks for nothing the count is already asking for: its reads, plus one profile per person listed',
      pageTally.reads === (pageSenders + 1 + pageLookups) + PAGE_WAITING,
      pageTally.reads + ' read(s) requested, expected ' + (pageSenders + 1 + pageLookups) + ' for the count (' +
      pageSenders + ' senders, the account, ' + pageLookups + ' lookups) and ' + PAGE_WAITING + ' for the faces');

    // Only before that first count. A count that has delivered cannot
    // see this account answering somebody from another tab — its query watches
    // likes aimed AT the account — so a list that took a finished count's word
    // would name a person already answered. Written here as the other tab
    // would write it, straight to the database, and the count's own number is
    // the control: it must still be counting them, or this proves nothing about
    // where the list's answer came from.
    const settledCounts = [];
    const stopSettled = k.store.listenLikesReceived(page, function (count) { settledCounts.push(count); });
    const newcomer = 'likes-page-new';
    const accountAsked = [];
    let judging = null;
    let judged = null;
    let countWhenAsked = null;
    let lookupsWhenAsked = 0;
    let stopSecond = function () { /* replaced below */ };
    try {
      await settle();
      await k.admin.set('swipes', page + '_likes-page-00', {
        id: page + '_likes-page-00', from: page, to: 'likes-page-00', action: 'pass',
        createdAt: '2026-01-05T00:00:00.000Z'
      });
      const afterOtherTab = await k.store.getLikesReceived(page);
      k.ctx.drainWarnings();
      t.check('a list asked for after the count has finished is read fresh, and honours an answer the count cannot see',
        afterOtherTab.length === PAGE_WAITING - 1 &&
        afterOtherTab.every(function (user) { return user.uid !== 'likes-page-00'; }) &&
        settledCounts[settledCounts.length - 1] === PAGE_WAITING,
        'list ' + afterOtherTab.length + ', the count still says ' + k.show(settledCounts.slice(-1)));

      // Nor while that same count is judging a NEWCOMER. That is a lookup too,
      // but not one that asks about everybody: it asks about the new sender
      // alone, and the count it ends in is built on everyone else's REMEMBERED
      // answers, which the check above has just shown going stale. A list asked
      // for in that window must still read for itself.
      //
      // No delay is put in to reach the window. The list is asked for from a
      // second listener on the same query, which the SDK serves from the same
      // target and calls straight after the count's own, in the delivery that
      // brings the newcomer. Two controls say it landed there: the count had
      // already sent for the account behind the newcomer's lookup, and had not
      // yet counted them.
      k.ctx.ZC.firebase.db = noteGets(real, 'users/' + page, accountAsked);
      stopSecond = real.collection('swipes').where('to', '==', page).where('action', 'in', ['like', 'super'])
        .onSnapshot(function (snap) {
          if (judging || !snap.docs.some(function (doc) { return doc.id === newcomer + '_' + page; })) return;
          countWhenAsked = settledCounts[settledCounts.length - 1];
          lookupsWhenAsked = accountAsked.length;
          judging = k.store.getLikesReceived(page).then(function (list) { return { list: list }; },
            function (err) { return { err: err }; });
        });
      await settle(400);
      await k.admin.set('discovery', newcomer, k.h.discoveryDoc(newcomer));
      await k.admin.set('swipes', newcomer + '_' + page, {
        id: newcomer + '_' + page, from: newcomer, to: page, action: 'like',
        createdAt: '2026-01-06T00:00:00.000Z'
      });
      await settle();
      judged = judging ? await judging : null;
    } finally {
      stopSecond();
      stopSettled();
      k.ctx.ZC.firebase.db = real;
    }
    // Gone again, so everything below is about the same people as above.
    await k.admin.del('swipes', newcomer + '_' + page);
    k.ctx.drainWarnings();
    const judgedIds = judged && Array.isArray(judged.list)
      ? judged.list.map(function (user) { return user.uid; })
      : [];
    const inWindow = lookupsWhenAsked > 0 && countWhenAsked === PAGE_WAITING;
    t.check('and so is one asked for while the count judges a newcomer, whose lookup asks about them alone',
      inWindow && settledCounts[settledCounts.length - 1] === PAGE_WAITING + 1 &&
      judgedIds.length === PAGE_WAITING && judgedIds.indexOf('likes-page-00') === -1 &&
      judgedIds.indexOf(newcomer) !== -1,
      (inWindow ? '' : 'the list was not asked for while the count judged the newcomer, so this tested nothing; ') +
      (!judged ? 'the list was never asked for'
        : (judged.err ? 'rejected: ' + judged.err.message
          : 'list ' + judgedIds.length +
            (judgedIds.indexOf('likes-page-00') === -1 ? '' : ', naming the person answered from another tab') +
            (judgedIds.indexOf(newcomer) === -1 ? ', without the newcomer' : ''))) +
      '; the count said ' + countWhenAsked + ' when it was asked, then ' + k.show(settledCounts.slice(-1)));

    // And a count that stops while the list is waiting on it sends the list to
    // look for itself, rather than leaving it waiting on an answer that is never
    // coming. The count's stream here subscribes and never delivers — a slow
    // network, held still — so the list is provably waiting when the count is
    // stopped; everything else reaches the emulator as usual. Bounded, so a
    // regression fails here by name instead of hanging the suite.
    k.ctx.ZC.firebase.db = silentStreams(real);
    let outcome = null;
    let joinedFirst = false;
    try {
      const stopEarly = k.store.listenLikesReceived(page, function () { /* never called */ });
      let answered = false;
      const abandoned = k.store.getLikesReceived(page).then(function (list) {
        answered = true;
        return { list: list };
      }, function (err) {
        answered = true;
        return { err: err };
      });
      await settle(300);
      joinedFirst = !answered;
      stopEarly();
      outcome = await Promise.race([abandoned, settle(5000).then(function () { return null; })]);
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    t.check('a count that stops under a waiting list hands it back, and the list still comes',
      joinedFirst && !!outcome && !outcome.err && Array.isArray(outcome.list) && outcome.list.length === PAGE_WAITING - 1,
      (joinedFirst ? 'the list was waiting on the count; ' : 'the list never waited on the count, so this tested nothing; ') +
      (outcome === null ? 'still waiting 5s after the count stopped'
        : (outcome.err ? 'rejected: ' + outcome.err.message : 'list ' + outcome.list.length)));

    // The same for a count whose stream DIES, which is the error channel this
    // listener was given a round ago: its caller still hears the death once —
    // that is what lets app.js re-subscribe — and the list waiting on the count
    // is not left behind with it.
    const deaths = [];
    let heardDeath = function () { /* replaced below */ };
    const death = new Promise(function (resolve) { heardDeath = resolve; });
    k.ctx.ZC.firebase.db = silentStreams(real, 300);
    let deathOutcome = null;
    let waitedOnDying = false;
    try {
      k.store.listenLikesReceived(page, function () { /* never called */ },
        function (err) { deaths.push(err); heardDeath(); });
      let answered = false;
      const orphaned = k.store.getLikesReceived(page).then(function (list) {
        answered = true;
        return { list: list };
      }, function (err) {
        answered = true;
        return { err: err };
      });
      await settle(150);
      waitedOnDying = !answered;
      deathOutcome = await Promise.race([orphaned, settle(5000).then(function () { return null; })]);
      // The death is waited for as well, and a little past it for a second one,
      // so the deaths below are counted after the first would have come. A list
      // that never waited is answered before it, and counting then would call
      // the error channel broken when it was not.
      await Promise.race([death, settle(5000)]);
      await settle(200);
    } finally {
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    t.check('one whose stream dies still tells its caller once, and the waiting list still comes',
      waitedOnDying && deaths.length === 1 && !!deathOutcome && !deathOutcome.err &&
      Array.isArray(deathOutcome.list) && deathOutcome.list.length === PAGE_WAITING - 1,
      deaths.length + ' death(s) reported; ' +
      (waitedOnDying ? '' : 'the list never waited on the count, so this tested nothing; ') +
      (deathOutcome === null ? 'the list was still waiting 5s after the stream died'
        : (deathOutcome.err ? 'rejected: ' + deathOutcome.err.message : 'list ' + deathOutcome.list.length)));

    // And one whose LOOKUP fails — the stream delivers, the account read behind
    // it does not. The count stays subscribed (the next delivery tries again);
    // the list asks for itself, and here its own read gets through.
    k.ctx.ZC.firebase.db = failFirstGet(real, 'users/' + page);
    let lookupOutcome = null;
    let stopFailing = function () { /* replaced below */ };
    try {
      stopFailing = k.store.listenLikesReceived(page, function () { /* not the point */ });
      lookupOutcome = await Promise.race([
        k.store.getLikesReceived(page).then(function (list) { return { list: list }; },
          function (err) { return { err: err }; }),
        settle(5000).then(function () { return null; })
      ]);
    } finally {
      stopFailing();
      k.ctx.ZC.firebase.db = real;
    }
    const lookupWarnings = k.ctx.drainWarnings();
    t.check('and one whose lookup fails sends the list to look for itself, which it does',
      lookupWarnings.some(function (w) { return /Live like count failed/.test(w); }) &&
      !!lookupOutcome && !lookupOutcome.err && Array.isArray(lookupOutcome.list) &&
      lookupOutcome.list.length === PAGE_WAITING - 1,
      (lookupWarnings.some(function (w) { return /Live like count failed/.test(w); })
        ? '' : 'the count\'s lookup never failed, so this tested nothing; ') +
      (lookupOutcome === null ? 'the list was still waiting after 5s'
        : (lookupOutcome.err ? 'rejected: ' + lookupOutcome.err.message : 'list ' + lookupOutcome.list.length)));

    // And one whose FIRST snapshot never comes — the SDK offline and holding
    // back even its cache answer. The list joins it, as it joins any count
    // that has not delivered, and the join used to have no bound: the panel
    // waited on a count that was never going to speak. It waits a few seconds
    // now, then looks for itself.
    k.ctx.ZC.firebase.db = stallListeners(real);
    let stalledOutcome = null;
    let stopStalled = function () { /* replaced below */ };
    try {
      stopStalled = k.store.listenLikesReceived(page, function () { /* never called */ });
      stalledOutcome = await Promise.race([
        k.store.getLikesReceived(page).then(function (list) { return { list: list }; },
          function (err) { return { err: err }; }),
        settle(8000).then(function () { return null; })
      ]);
    } finally {
      stopStalled();
      k.ctx.ZC.firebase.db = real;
    }
    k.ctx.drainWarnings();
    t.check('and one whose first snapshot never comes holds the list only a few seconds, then it looks for itself',
      !!stalledOutcome && !stalledOutcome.err && Array.isArray(stalledOutcome.list) &&
      stalledOutcome.list.length === PAGE_WAITING - 1,
      stalledOutcome === null ? 'the list was still waiting after 8s'
        : (stalledOutcome.err ? 'rejected: ' + stalledOutcome.err.message : 'list ' + stalledOutcome.list.length));

    // "Until the first count" means until the first count is DELIVERED, not
    // until every sender has an answer. They differ when somebody likes this
    // account while the first lookup is out: their delivery sends a second
    // lookup, the first one lands and is counted without them, and the count is
    // then remembering answers while a lookup is still out. A list asked for
    // now that joined would be handed whatever the last lookup to land
    // completes — here a third, for the next newcomer, which asks about the two
    // newcomers alone — on top of the first lookup's remembered answer about a
    // person this account has since answered from another tab.
    //
    // The account read in front of each of the count's lookups is held — the
    // first for 700 ms, the second for 3 s — so the first lookup lands while the
    // second is out; everything else reaches the emulator as usual.
    const early = 'likes-page-early';
    const late = 'likes-page-late';
    const held = { asked: 0 };
    const raceCounts = [];
    let raceAsked = null;
    let raceList = null;
    let stopRace = function () { /* replaced below */ };
    k.ctx.ZC.firebase.db = holdGets(real, 'users/' + page, [700, 3000], held);
    try {
      stopRace = k.store.listenLikesReceived(page, function (count) { raceCounts.push(count); });
      await until(function () { return held.asked >= 1; });
      await k.admin.set('discovery', early, k.h.discoveryDoc(early));
      await k.admin.set('swipes', early + '_' + page, {
        id: early + '_' + page, from: early, to: page, action: 'like', createdAt: '2026-01-07T00:00:00.000Z'
      });
      await until(function () { return held.asked >= 2 && raceCounts.length >= 1; }, 5000);
      await k.admin.set('swipes', page + '_likes-page-01', {
        id: page + '_likes-page-01', from: page, to: 'likes-page-01', action: 'pass',
        createdAt: '2026-01-07T00:00:00.000Z'
      });
      await settle(100);
      raceAsked = { counts: raceCounts.slice(), asked: held.asked };
      const raced = k.store.getLikesReceived(page).then(function (list) { return { list: list }; },
        function (err) { return { err: err }; });
      await settle(150);
      raceAsked.own = held.asked - raceAsked.asked;
      await k.admin.set('discovery', late, k.h.discoveryDoc(late));
      await k.admin.set('swipes', late + '_' + page, {
        id: late + '_' + page, from: late, to: page, action: 'like', createdAt: '2026-01-07T00:00:00.000Z'
      });
      raceList = await Promise.race([raced, settle(5000).then(function () { return null; })]);
      await settle(3500);
    } finally {
      stopRace();
      k.ctx.ZC.firebase.db = real;
    }
    await k.admin.del('swipes', early + '_' + page);
    await k.admin.del('swipes', late + '_' + page);
    await k.admin.del('swipes', page + '_likes-page-01');
    k.ctx.drainWarnings();
    const raceIds = raceList && Array.isArray(raceList.list)
      ? raceList.list.map(function (user) { return user.uid; })
      : [];
    // The controls: the first count had gone out, without the early newcomer,
    // whose lookup was still being held.
    const raceWindow = !!raceAsked && raceAsked.asked === 2 && raceAsked.counts.length >= 1 &&
      raceAsked.counts[raceAsked.counts.length - 1] === PAGE_WAITING - 1;
    t.check('a list asked for after the first count, while a newcomer from the first lookup is still out, reads for itself',
      raceWindow && raceAsked.own === 1 && raceIds.indexOf('likes-page-01') === -1 && raceIds.indexOf(early) !== -1,
      (raceWindow ? '' : 'the first count had not gone out while the newcomer was held, so this tested nothing; ') +
      (raceAsked ? raceAsked.own + ' account read(s) of its own; ' : '') +
      (raceList === null ? 'the list was still waiting after 5s'
        : (raceList.err ? 'rejected: ' + raceList.err.message
          : 'list ' + raceIds.length +
            (raceIds.indexOf('likes-page-01') === -1 ? '' : ', naming the person answered from another tab') +
            (raceIds.indexOf(early) === -1 ? ', without the newcomer' : ''))) +
      '; the count said ' + (raceAsked ? k.show(raceAsked.counts) : '?') + ' when it was asked, then ' +
      k.show(raceCounts.slice(-1)));
  }
};

/**
 * @param {function(): boolean} ready the condition
 * @param {number} [ms] how long to wait for it
 * @returns {Promise<void>} resolved when it holds, or when the time is up
 */
function until(ready, ms) {
  const end = Date.now() + (ms || 8000);
  return new Promise(function (resolve) {
    (function poll() {
      if (ready() || Date.now() > end) return resolve();
      setTimeout(poll, 10);
    })();
  });
}

/**
 * A database whose snapshot listeners never deliver, while every read and
 * write goes through to the real one — the SDK offline, holding back even the
 * answer it could give from cache.
 * @param {Object} target the real database
 * @returns {Object} the stand-in
 */
function stallListeners(target) {
  const wrap = function (obj) {
    return new Proxy(obj, {
      get: function (o, prop) {
        if (prop === 'onSnapshot') return function () { return function () { /* nothing to stop */ }; };
        const value = o[prop];
        if (typeof value !== 'function') return value;
        return function () {
          const out = value.apply(o, arguments);
          return out && typeof out === 'object' && typeof out.onSnapshot === 'function' ? wrap(out) : out;
        };
      }
    });
  };
  return wrap(target);
}

/**
 * The real Firestore, except that the n-th `get` of one document is held for
 * `delays[n]` ms before it is sent, and every `get` of it is counted when it is
 * asked for.
 * @param {Object} target the compat Firestore, or a ref or query chained off it
 * @param {string} path the document, e.g. 'users/abc'
 * @param {number[]} delays per `get`, in the order they are asked for; none after
 * @param {{asked:number}} state shared across the chain
 * @returns {Object} a stand-in
 */
function holdGets(target, path, delays, state) {
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        if (prop === 'get' && obj.path === path) {
          const ms = delays[state.asked] || 0;
          state.asked += 1;
          const args = arguments;
          return new Promise(function (resolve) { setTimeout(resolve, ms); })
            .then(function () { return value.apply(obj, args); });
        }
        const out = value.apply(obj, arguments);
        return out && typeof out === 'object' && typeof out.then !== 'function' ? holdGets(out, path, delays, state) : out;
      };
    }
  });
}

/**
 * The real Firestore, except that every live stream subscribes and never
 * delivers: a listener held at "not yet", with reads still going through.
 * Given `dieAfterMs`, each stream reports a denial after that long instead.
 * @param {Object} target the compat Firestore, or a ref or query chained off it
 * @param {number} [dieAfterMs] when to fail the stream, if at all
 * @returns {Object} a stand-in
 */
function silentStreams(target, dieAfterMs) {
  return new Proxy(target, {
    get: function (obj, prop) {
      if (prop === 'onSnapshot') {
        return function (next, onErr) {
          if (typeof dieAfterMs === 'number' && typeof onErr === 'function') {
            setTimeout(function () { onErr(new Error('Missing or insufficient permissions.')); }, dieAfterMs);
          }
          return function () { /* nothing to stop */ };
        };
      }
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        const out = value.apply(obj, arguments);
        return out && typeof out === 'object' && typeof out.then !== 'function' ? silentStreams(out, dieAfterMs) : out;
      };
    }
  });
}

/**
 * The real Firestore, noting each `get` of one document when it is ASKED for
 * rather than when it answers — which is what tells a check that a lookup was
 * already out when something else happened.
 * @param {Object} target the compat Firestore, or a ref or query chained off it
 * @param {string} path the document, e.g. 'users/abc'
 * @param {number[]} asked gets one entry per `get`
 * @returns {Object} a stand-in
 */
function noteGets(target, path, asked) {
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        if (prop === 'get' && obj.path === path) asked.push(Date.now());
        const out = value.apply(obj, arguments);
        return out && typeof out === 'object' && typeof out.then !== 'function' ? noteGets(out, path, asked) : out;
      };
    }
  });
}

/**
 * The real Firestore, except that the first `get` of one document fails.
 * @param {Object} target the compat Firestore, or a ref or query chained off it
 * @param {string} path the document, e.g. 'users/abc'
 * @param {{failed:boolean}} [state] shared across the chain; created on first call
 * @returns {Object} a stand-in
 */
function failFirstGet(target, path, state) {
  const shared = state || { failed: false };
  return new Proxy(target, {
    get: function (obj, prop) {
      const value = obj[prop];
      if (typeof value !== 'function') return value;
      return function () {
        if (prop === 'get' && obj.path === path && !shared.failed) {
          shared.failed = true;
          return Promise.reject(new Error('Failed to get document because the client is offline.'));
        }
        const out = value.apply(obj, arguments);
        return out && typeof out === 'object' && typeof out.then !== 'function' ? failFirstGet(out, path, shared) : out;
      };
    }
  });
}
