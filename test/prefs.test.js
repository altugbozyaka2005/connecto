// Match preferences: mutual filters (gender, age, country, language) and call modes.
const test = require('node:test');
const assert = require('node:assert');
const prefs = require('../prefs');
const { start, stop, signedInSocket, once, call } = require('./helpers');

const side = (p, f) => ({ prefs: prefs.clean(p), facts: { gender: null, age: 30, country: null, languages: [], ...f } });

test('filters are mutual, unknown details only pass "anyone", modes pick the richest shared one', () => {
  const womanTR = side({}, { gender: 'woman', age: 22, country: 'TR', languages: ['tr', 'en'] });
  const man = side({ genders: ['woman'] }, { gender: 'man', age: 30 });
  assert.ok(prefs.fits(man.prefs, womanTR.facts));
  assert.ok(prefs.compatible(man, womanTR));
  // She only wants women: neither sees the other.
  const picky = side({ genders: ['woman'] }, womanTR.facts);
  assert.ok(!prefs.compatible(man, picky));
  // Age bands, country, language.
  assert.ok(prefs.fits(prefs.clean({ ages: ['18-25'] }), womanTR.facts));
  assert.ok(!prefs.fits(prefs.clean({ ages: ['26-35', '46+'] }), womanTR.facts));
  assert.ok(prefs.fits(prefs.clean({ countries: ['GB', 'TR'] }), womanTR.facts));
  assert.ok(!prefs.fits(prefs.clean({ countries: ['GB'] }), womanTR.facts));
  assert.ok(prefs.fits(prefs.clean({ languages: ['en'] }), womanTR.facts));
  assert.ok(!prefs.fits(prefs.clean({ languages: ['fr'] }), womanTR.facts));
  // Someone who didn't share a detail is left out when you filter on it.
  assert.ok(!prefs.fits(prefs.clean({ countries: ['TR'] }), man.facts));
  assert.ok(!prefs.fits(prefs.clean({ genders: ['man'] }), side({}, { gender: 'prefer_not' }).facts));
  // Modes
  assert.strictEqual(prefs.callMode(side({}), side({ modes: ['voice', 'chat'] })), 'voice');
  assert.strictEqual(prefs.callMode(side({ modes: ['chat'] }), side({ modes: ['video', 'voice'] })), null);
  assert.ok(!prefs.compatible(side({ modes: ['chat'] }), side({ modes: ['video'] })));
  // Cleaning: junk dropped, no modes means all.
  assert.deepStrictEqual(prefs.clean({ genders: ['robot', 'man'], modes: [] }).modes, ['video', 'voice', 'chat']);
  assert.deepStrictEqual(prefs.clean({ genders: ['robot', 'man'] }).genders, ['man']);
});

let base;
test.describe('over sockets', () => {
  test.before(async () => { base = await start(); });
  test.after(stop);

  function waitFor(sock, ev, pred = () => true) {
    return new Promise((resolve) => {
      const h = (p) => { if (pred(p)) { sock.off(ev, h); resolve(p); } };
      sock.on(ev, h);
    });
  }
  const patchMe = (x, body) => fetch(`${base}/api/auth/me`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: x.cookie }, body: JSON.stringify(body) }).then((r) => r.json());

  test('a filter hides people both ways, the server refuses requests that break it, and calls use the shared mode', async (t) => {
    const ayla = await signedInSocket(base, { firstName: 'Ayla', gender: 'woman' });
    const burak = await signedInSocket(base, { firstName: 'Burak', gender: 'man' });
    const ceyda = await signedInSocket(base, { firstName: 'Ceyda', gender: 'woman' });
    t.after(() => [ayla, burak, ceyda].forEach((x) => x.sock.close()));

    const saved = await patchMe(ayla, { country: 'TR', languages: ['tr', 'en'] });
    assert.strictEqual(saved.user.country, 'TR');
    assert.deepStrictEqual(saved.user.languages, ['tr', 'en']);
    assert.ok((await patchMe(ayla, { country: 'XX' })).fields.country);
    ayla.sock.emit('refresh-profile');

    // Ayla: women only, voice or chat.
    const res = await call(ayla.sock, 'set-prefs', { genders: ['woman'], modes: ['voice', 'chat'] });
    assert.deepStrictEqual(res.prefs.modes, ['voice', 'chat']);

    const activity = 'prefs test practicing turkish conversation';
    for (const x of [burak, ceyda, ayla]) await call(x.sock, 'set-activity', { activity });
    const seen = await waitFor(ayla.sock, 'matches', (m) => m.matches.some((x) => x.id === ceyda.sock.id));
    assert.ok(!seen.matches.some((x) => x.id === burak.sock.id), 'Ayla does not see Burak');
    assert.strictEqual(seen.matches.find((x) => x.id === ceyda.sock.id).mode, 'voice');
    const bv = await waitFor(burak.sock, 'matches', (m) => m.matches.some((x) => x.id === ceyda.sock.id));
    assert.ok(!bv.matches.some((x) => x.id === ayla.sock.id), 'and Burak does not see Ayla');
    assert.ok((await call(burak.sock, 'send-request', { to: ayla.sock.id })).error, 'requests across a filter are refused');

    // Ceyda and Ayla match; the call is voice.
    const rooms = Promise.all([once(ayla.sock, 'room-start'), once(ceyda.sock, 'room-start')]);
    await call(ceyda.sock, 'send-request', { to: ayla.sock.id });
    await call(ayla.sock, 'respond-request', { from: ceyda.sock.id, accept: true });
    const [room] = await rooms;
    assert.strictEqual(room.mode, 'voice');

    // Groups are filtered by mode.
    ayla.sock.emit('leave-room');
    await call(burak.sock, 'create-room', { capacity: 3, activity, mode: 'video' });
    await call(ceyda.sock, 'set-activity', { activity });
    const cv = await waitFor(ceyda.sock, 'matches', (m) => m.groups.length);
    assert.strictEqual(cv.groups[0].mode, 'video');
    await call(ayla.sock, 'set-activity', { activity });
    const av = await waitFor(ayla.sock, 'matches');
    assert.ok(!av.groups.length, 'voice/chat-only Ayla does not see a video group');
  });
});
