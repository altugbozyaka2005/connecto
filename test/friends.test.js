const test = require('node:test');
const assert = require('node:assert');
const { start, stop, request, signedInSocket, once, call, matchUp, Client } = require('./helpers');

let base;
test.before(async () => { base = await start(); });
test.after(stop);

// Waits for a `friends` push matching the predicate.
function friendsUpdate(sock, pred) {
  return new Promise((resolve) => {
    const h = (p) => { if (pred(p)) { sock.off('friends', h); resolve(p); } };
    sock.on('friends', h);
  });
}

test('profile extras: validation, saved, and shown to matches with a shared-interest boost', async (t) => {
  const { sock: a, cookie } = await signedInSocket(base, { firstName: 'Pia' });
  const { sock: b, cookie: bCookie } = await signedInSocket(base, { firstName: 'Kaan' });
  t.after(() => { a.close(); b.close(); });

  const bad = await request(base, 'PATCH', '/api/auth/me', { bio: 'x'.repeat(201), interests: ['a', 'b', 'c', 'd', 'e', 'f'], timezone: 'Mars/Olympus' }, cookie);
  assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(Object.keys(bad.body.fields).sort(), ['bio', 'interests', 'timezone']);

  const ok = await request(base, 'PATCH', '/api/auth/me', {
    bio: '  Studying  for finals ', interests: ['Chess', 'chess', '#Coffee', 'Hiking'], city: 'Istanbul', timezone: 'Europe/Istanbul',
  }, cookie);
  assert.deepStrictEqual(
    { bio: ok.body.user.bio, interests: ok.body.user.interests, city: ok.body.user.city, timezone: ok.body.user.timezone },
    { bio: 'Studying for finals', interests: ['Chess', 'Coffee', 'Hiking'], city: 'Istanbul', timezone: 'Europe/Istanbul' },
  );
  a.emit('refresh-profile');
  await request(base, 'PATCH', '/api/auth/me', { interests: ['coffee', 'Chess'] }, bCookie);
  b.emit('refresh-profile');

  await call(a, 'set-activity', { activity: 'profile test studying calculus' });
  const m = once(b, 'matches');
  await call(b, 'set-activity', { activity: 'profile test studying calculus' });
  const card = (await m).matches.find((x) => x.id === a.id);
  assert.strictEqual(card.bio, 'Studying for finals');
  assert.strictEqual(card.city, 'Istanbul');
  assert.deepStrictEqual(card.shared.map((x) => x.toLowerCase()).sort(), ['chess', 'coffee']);
  assert.strictEqual(card.friend, false);
});

test('friends: mutual yes after a call, presence, invites, removal', async (t) => {
  const { sock: a } = await signedInSocket(base, { firstName: 'Ece' });
  const { sock: b, user: bUser } = await signedInSocket(base, { firstName: 'Mert' });
  const { sock: stranger } = await signedInSocket(base, { firstName: 'Zed' });
  t.after(() => { a.close(); b.close(); stranger.close(); });

  assert.ok((await call(stranger, 'friend-request')).error, 'needs a recent call');

  await matchUp(a, b, 'friends test playing guitar');
  // A says yes first: B is asked, nothing is final yet.
  const asked = once(b, 'friend-request');
  assert.strictEqual((await call(a, 'friend-request')).status, 'pending');
  assert.strictEqual((await asked).name, 'Ece T.');
  // B says yes too: both become friends.
  const added = once(a, 'friend-added');
  const aList = friendsUpdate(a, (p) => p.friends.some((f) => f.id === bUser.id));
  assert.strictEqual((await call(b, 'friend-request')).status, 'friends');
  await added;
  const fl = await aList;
  const mert = fl.friends.find((f) => f.id === bUser.id);
  assert.strictEqual(mert.status, 'in-call');

  // After the call they're "searching" again (they still have an activity).
  const back = friendsUpdate(a, (p) => p.friends.find((f) => f.id === bUser.id)?.status === 'searching');
  const left = once(a, 'peer-left');
  b.emit('leave-room');
  await left;
  assert.strictEqual((await back).friends[0].activity, 'friends test playing guitar');

  // Strangers can't be invited; friends can, even when idle.
  assert.ok((await call(a, 'friend-invite', { id: 99999 })).error);
  b.emit('stop-searching');
  await friendsUpdate(a, (p) => p.friends.find((f) => f.id === bUser.id)?.status === 'online');
  const inc = once(b, 'incoming-request');
  assert.deepStrictEqual(await call(a, 'friend-invite', { id: bUser.id }), { ok: true });
  const invite = await inc;
  assert.strictEqual(invite.friend, true);
  const rooms = Promise.all([once(a, 'room-start'), once(b, 'room-start')]);
  assert.deepStrictEqual(await call(b, 'respond-request', { from: a.id, accept: true }), { ok: true });
  const [ra] = await rooms;
  assert.strictEqual(ra.peer.friend, true);

  // Offline friends show as offline.
  b.emit('leave-room');
  const off = friendsUpdate(a, (p) => p.friends.find((f) => f.id === bUser.id)?.status === 'offline');
  b.close();
  await off;

  // Removing the friend clears the list for both.
  const gone = friendsUpdate(a, (p) => !p.friends.length);
  await call(a, 'friend-remove', { id: bUser.id });
  await gone;
});

test('"Not now" declines quietly and blocking ends a friendship', async (t) => {
  const { sock: a, user: aUser } = await signedInSocket(base);
  const { sock: b, user: bUser } = await signedInSocket(base);
  t.after(() => { a.close(); b.close(); });
  await matchUp(a, b, 'decline test baking');

  const asked = once(b, 'friend-request');
  await call(a, 'friend-request');
  await asked;
  const pendingShown = friendsUpdate(b, (p) => p.requests.some((r) => r.id === aUser.id));
  b.emit('refresh-profile'); // any recompute pushes the list
  await pendingShown;
  const cleared = friendsUpdate(b, (p) => !p.requests.length);
  assert.deepStrictEqual(await call(b, 'friend-respond', { id: aUser.id, accept: false }), { ok: true });
  await cleared;

  // Become friends, then block: the friendship is gone.
  await call(a, 'friend-request');
  const made = friendsUpdate(a, (p) => p.friends.some((f) => f.id === bUser.id));
  await call(b, 'friend-request');
  await made;
  const removed = friendsUpdate(a, (p) => !p.friends.length);
  await call(b, 'block', { lastPeer: true });
  await removed;
});
