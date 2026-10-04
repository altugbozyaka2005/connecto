/* global io */
(() => {
  const $ = (sel) => document.querySelector(sel);
  // Connects only once signed in; the server rejects sockets without a session.
  const socket = io({ autoConnect: false });

  const state = {
    user: null, // own account, from /api/auth/me
    pendingAvatar: null, // photo chosen on the sign-up form
    activity: '',
    room: null, // { roomId, peer, initiator }
    matches: [],
    incoming: new Map(), // fromId -> toast element
  };

  const SUGGESTIONS = [
    'Studying for exams 📚', 'Coding a side project 💻', 'Working out at the gym 🏋️',
    'Playing chess ♟️', 'Learning Spanish 🇪🇸', 'Cooking dinner 🍝',
    'Reading a novel 📖', 'Practicing guitar 🎸', 'Drawing / sketching 🎨', 'Just chilling ☕',
  ];

  // ---------- Helpers ----------

  function show(screenId) {
    // Leaving the Background searches page some other way (a call, signing out): drop its #background URL.
    if (screenId !== 'screen-background' && location.hash === '#background') history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('.screen').forEach((s) => s.toggleAttribute('data-active', s.id === screenId));
    window.scrollTo(0, 0);
  }

  function hueFor(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 65% 55%)`;
  }

  function paintAvatar(el, name, avatar) {
    el.textContent = '';
    if (avatar) {
      el.style.backgroundImage = `url("${avatar}")`;
    } else {
      el.style.backgroundImage = '';
      el.style.setProperty('--hue', hueFor(name || '?'));
      el.textContent = (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    }
  }

  const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || '';

  // "Istanbul · 21:05 their time" (time only when they're in a different time zone).
  function metaLine(p) {
    const parts = [];
    if (p.city) parts.push(p.city);
    if (p.timezone && p.timezone !== MY_TZ) {
      try {
        parts.push(`${new Intl.DateTimeFormat([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' }).format(new Date())} their time`);
      } catch { /* unknown zone */ }
    }
    return parts.join(' · ');
  }

  function emit(event, payload) {
    return new Promise((resolve) => socket.emit(event, payload, (res) => resolve(res || {})));
  }

  function toast({ title, body, avatarOf, actions, timeout = 4000 }) {
    const el = document.createElement('div');
    el.className = 'toast' + (avatarOf ? '' : ' toast-simple');
    if (avatarOf) {
      const av = document.createElement('div');
      av.className = 'avatar avatar-md';
      paintAvatar(av, avatarOf.name, avatarOf.avatar);
      el.append(av);
    }
    const text = document.createElement('div');
    text.className = 'toast-text';
    const strong = document.createElement('strong');
    strong.textContent = title;
    text.append(strong);
    if (body) {
      const p = document.createElement('p');
      p.textContent = body;
      text.append(p);
    }
    el.append(text);
    if (actions) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn ${a.cls || 'btn-ghost'}`;
        b.textContent = a.label;
        b.onclick = () => a.onClick(el);
        row.append(b);
      }
      el.append(row);
    }
    $('#toasts').append(el);
    if (timeout) setTimeout(() => dismiss(el), timeout);
    return el;
  }

  function dismiss(el) {
    if (!el || !el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }

  // Center-crop and shrink the uploaded photo so it is small enough to send around.
  function resizeImage(file, size = 192) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  // ---------- 1. Accounts ----------

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      err.fields = data.fields || {};
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setUser(user) {
    state.user = user;
    document.querySelectorAll('.me-avatar').forEach((el) => paintAvatar(el, user.displayName, user.avatar));
    document.querySelectorAll('.me-name').forEach((el) => { el.textContent = user.firstName; });
    document.querySelectorAll('.menu-email').forEach((el) => { el.textContent = user.email; });
    $('#greeting').textContent = `Hey ${user.firstName} 👋`;
    document.querySelectorAll('.admin-link').forEach((el) => { el.hidden = !user.isAdmin; });
  }

  function onSignedIn(user) {
    setUser(user);
    for (const f of ['#login-form', '#register-form', '#forgot-form', '#reset-form']) {
      $(f).reset();
      clearFormErrors($(f));
    }
    state.pendingAvatar = null;
    paintAvatar($('#avatar-preview'), '+', null);
    if (!user.emailVerified) return showVerify(user);
    stopVerifyPolling();
    if (!socket.connected) socket.connect();
    // Keep the stored time zone in sync with this device (people travel).
    if (MY_TZ && user.timezone !== MY_TZ) {
      api('PATCH', '/api/auth/me', { timezone: MY_TZ })
        .then(({ user: u }) => { setUser(u); socket.emit('refresh-profile'); })
        .catch(() => {});
    }
    $('#activity-input').value = state.activity;
    // A link or reload to /#background opens that page.
    if (location.hash === '#background') {
      show('screen-activity');
      history.replaceState(null, '', location.pathname);
      return openBgPage();
    }
    show('screen-activity');
    $('#activity-input').focus();
  }

  // Drop all local state and return to the sign-in screen.
  function signedOut(message) {
    if (state.room) stopMedia();
    state.room = null;
    state.user = null;
    state.activity = '';
    clearIncoming();
    stopVerifyPolling();
    if (socket.connected) socket.disconnect();
    switchTab('login');
    show('screen-auth');
    if (message) toast({ title: message });
  }

  // which: 'login' | 'register' | 'forgot' | 'reset'
  function switchTab(which) {
    $('#tab-login').setAttribute('aria-selected', String(which === 'login'));
    $('#tab-register').setAttribute('aria-selected', String(which === 'register'));
    $('#auth-tabs').hidden = which === 'forgot' || which === 'reset';
    for (const name of ['login', 'register', 'forgot', 'reset']) $(`#${name}-form`).hidden = name !== which;
    const form = $(`#${which}-form`);
    clearFormErrors(form);
    if (which === 'forgot') {
      form.querySelector('.form-success').hidden = true;
      form.elements.email.value ||= $('#login-form').elements.email.value;
    }
    form.querySelector('input:not([type=file])').focus();
  }
  $('#tab-login').addEventListener('click', () => switchTab('login'));
  $('#tab-register').addEventListener('click', () => switchTab('register'));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.goto)));

  document.querySelectorAll('.reveal').forEach((btn) => btn.addEventListener('click', () => {
    const input = btn.previousElementSibling;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
    btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  }));

  function clearFormErrors(form) {
    form.querySelector('.form-error').textContent = '';
    form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  }

  function showFormErrors(form, err) {
    form.querySelector('.form-error').textContent = err.message;
    let first = null;
    for (const [name, msg] of Object.entries(err.fields || {})) {
      const slot = form.querySelector(`.field-error[data-for="${name}"]`);
      if (slot) slot.textContent = msg;
      const input = form.elements[name];
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        first ||= input;
      }
    }
    first?.focus();
  }

  async function submitWith(form, fn) {
    const btn = form.querySelector('button[type=submit]');
    clearFormErrors(form);
    btn.disabled = true;
    try { await fn(); } catch (err) { showFormErrors(form, err); } finally { btn.disabled = false; }
  }

  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    submitWith(form, async () => {
      const { user, verificationSent } = await api('POST', '/api/auth/login', {
        email: form.elements.email.value,
        password: form.elements.password.value,
      });
      onSignedIn(user);
      if (verificationSent) {
        $('#verify-success').textContent = `We just sent a new confirmation link to ${user.email}.`;
        $('#verify-success').hidden = false;
      }
    });
  });

  // Forgot password: same answer whether or not the email has an account.
  $('#forgot-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const email = form.elements.email.value.trim();
    if (!email) return showFormErrors(form, { message: 'Enter your email address.' });
    submitWith(form, async () => {
      await api('POST', '/api/auth/forgot-password', { email });
      const ok = form.querySelector('.form-success');
      ok.textContent = `If an account exists for ${email}, we've emailed a reset link. It expires in 1 hour.`;
      ok.hidden = false;
    });
  });

  $('#reset-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const { password, confirm } = form.elements;
    if (password.value !== confirm.value) {
      return showFormErrors(form, { message: 'Passwords don’t match.', fields: { confirm: 'This doesn’t match the new password.' } });
    }
    submitWith(form, async () => {
      const { user } = await api('POST', '/api/auth/reset-password', { token: state.resetToken, password: password.value });
      state.resetToken = null;
      onSignedIn(user);
      toast({ title: 'Password updated', body: 'You’re signed in with your new password.' });
    });
  });

  // Confirm-email screen: waits (polling) until the link is clicked, possibly in another tab.
  let verifyTimer = null;
  function showVerify(user) {
    $('#verify-email').textContent = user.email;
    $('#verify-error').textContent = '';
    $('#verify-success').hidden = true;
    show('screen-verify');
    stopVerifyPolling();
    verifyTimer = setInterval(async () => {
      try {
        const { user: fresh } = await api('GET', '/api/auth/me');
        if (fresh.emailVerified) {
          onSignedIn(fresh);
          toast({ title: 'Email confirmed ✔', timeout: 2500 });
        }
      } catch (err) {
        if (err.status === 401) signedOut();
      }
    }, 4000);
  }
  function stopVerifyPolling() {
    clearInterval(verifyTimer);
    verifyTimer = null;
  }

  $('#resend-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    $('#verify-error').textContent = '';
    $('#verify-success').hidden = true;
    btn.disabled = true;
    try {
      const res = await api('POST', '/api/auth/resend-verification', {});
      if (res.alreadyVerified) return onSignedIn((await api('GET', '/api/auth/me')).user);
      $('#verify-success').textContent = `Sent! Check ${state.user.email}.`;
      $('#verify-success').hidden = false;
    } catch (err) {
      $('#verify-error').textContent = err.message;
    } finally {
      // Server allows one email a minute; keep the button calm until then.
      setTimeout(() => { btn.disabled = false; }, 15000);
    }
  });

  // Nobody under 18 can pick a birth date in the picker.
  {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    $('#register-form').elements.dateOfBirth.max = d.toISOString().slice(0, 10);
    $('#register-form').elements.dateOfBirth.min = '1900-01-01';
  }

  $('#register-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    submitWith(form, async () => {
      const { user } = await api('POST', '/api/auth/register', {
        firstName: f.firstName.value,
        lastName: f.lastName.value,
        email: f.email.value,
        password: f.password.value,
        dateOfBirth: f.dateOfBirth.value,
        gender: f.gender.value || null,
        acceptTerms: f.acceptTerms.checked,
        avatar: state.pendingAvatar,
      });
      onSignedIn(user);
      toast({ title: `Welcome to Connecto, ${user.firstName}!`, timeout: 3000 });
    });
  });

  paintAvatar($('#avatar-preview'), '+', null);
  $('#register-form').elements.firstName.addEventListener('input', (e) => {
    if (!state.pendingAvatar) paintAvatar($('#avatar-preview'), e.target.value || '+', null);
  });

  $('#avatar-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const slot = $('#register-form .field-error[data-for="avatar"]');
    if (!file) return;
    try {
      state.pendingAvatar = await resizeImage(file);
      paintAvatar($('#avatar-preview'), '', state.pendingAvatar);
      slot.textContent = '';
    } catch (err) {
      slot.textContent = err.message;
    }
  });

  // Account menu
  function closeMenus() { document.querySelectorAll('details.account[open]').forEach((d) => d.removeAttribute('open')); }
  document.addEventListener('click', (e) => { if (!e.target.closest('details.account')) closeMenus(); });

  document.querySelectorAll('.logout-btn').forEach((b) => b.addEventListener('click', async () => {
    closeMenus();
    try { await api('POST', '/api/auth/logout', {}); } catch { /* signing out locally anyway */ }
    signedOut();
  }));

  document.querySelectorAll('.change-photo-btn').forEach((b) => b.addEventListener('click', () => {
    closeMenus();
    $('#photo-change-input').click();
  }));

  $('#photo-change-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { user } = await api('PATCH', '/api/auth/me', { avatar: await resizeImage(file) });
      setUser(user);
      socket.emit('refresh-profile');
      toast({ title: 'Profile photo updated', timeout: 2500 });
    } catch (err) {
      toast({ title: 'Could not update photo', body: err.message });
    }
  });

  // ---------- 2. Activity ----------

  for (const s of SUGGESTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = s;
    chip.onclick = () => { $('#activity-input').value = s; $('#activity-input').focus(); };
    $('#suggestions').append(chip);
  }

  $('#activity-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const activity = $('#activity-input').value.trim();
    if (!activity) return;
    const res = await emit('set-activity', { activity });
    if (res.error) { $('#activity-error').textContent = res.error; return; }
    $('#activity-error').textContent = '';
    state.activity = activity;
    $('#my-activity').textContent = activity;
    clearIncoming();
    renderMatches([]);
    show('screen-matches');
  });

  $('#change-activity-btn').addEventListener('click', () => {
    socket.emit('stop-searching');
    clearIncoming();
    $('#activity-input').value = state.activity;
    show('screen-activity');
    $('#activity-input').select();
  });

  // ---------- 3. Matches ----------

  state.people = [];
  state.groups = [];
  state.away = [];
  state.filter = 'all';

  // Kept for callers that clear the list (e.g. after changing activity).
  function renderMatches(people, groups = [], away = []) {
    state.people = people;
    state.groups = groups;
    state.away = away;
    renderResults();
  }

  function renderResults() {
    const { people, groups, away, filter } = state;
    // "People" includes away (background) searchers; they're ranked lower by the server.
    const peopleAll = [...people, ...away];
    $('#n-all').textContent = peopleAll.length + groups.length || '';
    $('#n-people').textContent = peopleAll.length || '';
    $('#n-groups').textContent = groups.length || '';
    // Live people and groups first; background searchers get their own section below,
    // since you can't call them right now.
    const items = [
      ...(filter !== 'groups' ? people.map((m) => ({ kind: 'person', m })) : []),
      ...(filter !== 'people' ? groups.map((g) => ({ kind: 'group', m: g })) : []),
    ].sort((a, b) => b.m.score - a.m.score);
    const grid = $('#match-grid');
    grid.textContent = '';
    for (const it of items) grid.append(it.kind === 'group' ? groupCard(it.m) : personCard(it.m));
    const awayGrid = $('#away-grid');
    awayGrid.textContent = '';
    const showAway = filter !== 'groups' && away.length > 0;
    $('#away-section').hidden = !showAway;
    if (showAway) for (const m of away) awayGrid.append(personCard(m));
    $('#empty-state').toggleAttribute('data-show', items.length === 0);
    $('#empty-state h3').textContent = filter === 'groups' ? 'No open groups yet' : 'Looking for people…';
    $('#empty-state p').textContent = filter === 'groups'
      ? 'Nobody has opened a group for something similar yet. Start one and others can ask to join.'
      : 'No one’s doing something similar just yet. Keep this tab open — matches appear here the moment someone joins.';
  }

  document.querySelectorAll('.filter-tabs .tab').forEach((t) => t.addEventListener('click', () => {
    state.filter = t.dataset.filter;
    document.querySelectorAll('.filter-tabs .tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    renderResults();
  }));

  function groupCard(g) {
    const card = $('#group-card-tpl').content.firstElementChild.cloneNode(true);
    card.querySelector('.seat-count').textContent = `${g.count}/${g.capacity}`;
    const dots = card.querySelector('.seat-dots');
    for (let i = 0; i < g.capacity; i++) {
      const d = document.createElement('i');
      if (i < g.count) d.className = 'on';
      dots.append(d);
    }
    const stack = card.querySelector('.avatar-stack');
    for (const m of g.members.slice(0, 5)) {
      const av = document.createElement('div');
      av.className = 'avatar' + (m.friend ? ' friend' : '');
      av.title = m.friend ? `${m.name} (friend)` : m.name;
      paintAvatar(av, m.name, m.avatar);
      stack.append(av);
    }
    card.querySelector('.group-activity').textContent = g.activity;
    const friendsIn = g.members.filter((m) => m.friend).map((m) => m.name);
    card.querySelector('.group-host').textContent = [`Hosted by ${g.hostName}`, friendsIn.length && `with your friend ${friendsIn.join(', ')}`].filter(Boolean).join(' · ');
    card.querySelector('.score-bar i').style.width = `${g.score}%`;
    card.querySelector('.score b').textContent = `${g.score}%`;
    const cta = card.querySelector('.match-cta');
    if (g.requested) {
      card.dataset.state = 'requested';
      cta.textContent = 'Asked to join · cancel';
    } else {
      cta.textContent = 'Ask to join →';
    }
    const hit = card.querySelector('.match-hit');
    hit.setAttribute('aria-label', `${cta.textContent}: group of ${g.count} of ${g.capacity}, ${g.activity}`);
    hit.addEventListener('click', async () => {
      if (g.requested) return socket.emit('cancel-join', { roomId: g.id });
      const res = await emit('join-request', { roomId: g.id });
      if (res.error) toast({ title: 'Couldn’t ask to join', body: res.error });
      else toast({ title: 'Asked to join', body: `${g.hostName} will let you in or decline within a minute.`, timeout: 3000 });
    });
    return card;
  }

  function personCard(m) {
    const card = $('#match-card-tpl').content.firstElementChild.cloneNode(true);
    paintAvatar(card.querySelector('.avatar'), m.name, m.avatar);
    card.querySelector('.name-text').textContent = m.name;
    card.querySelector('.pill-friend').hidden = !m.friend;
    card.querySelector('.pill-away').hidden = !m.away;
    if (m.away) card.classList.add('away');
    card.querySelector('.match-meta').textContent = m.away
      ? [`Searching in the background · ${ago(m.since)}`, metaLine(m)].filter(Boolean).join(' · ')
      : metaLine(m);
    card.querySelector('.match-activity').textContent = m.activity;
    card.querySelector('.match-bio').textContent = m.bio || '';
    const chips = card.querySelector('.mini-chips');
    const shared = new Set((m.shared || []).map((x) => x.toLowerCase()));
    // Shared interests first, highlighted.
    for (const i of [...(m.interests || [])].sort((a, b) => shared.has(b.toLowerCase()) - shared.has(a.toLowerCase()))) {
      const c = document.createElement('span');
      c.className = 'mini-chip' + (shared.has(i.toLowerCase()) ? ' shared' : '');
      c.textContent = i;
      if (shared.has(i.toLowerCase())) c.title = 'You both like this';
      chips.append(c);
    }
    card.querySelector('.score-bar i').style.width = `${m.score}%`;
    card.querySelector('.score b').textContent = `${m.score}%`;
    const cta = card.querySelector('.match-cta');
    if (m.away) {
      if (m.requested) card.dataset.state = 'requested';
      cta.textContent = m.requestedYou ? 'Asked to connect — accept' : m.requested ? 'Request sent ✓' : 'Send request · they’ll see it later';
    } else if (m.requestedYou) {
      card.dataset.state = 'requested-you';
      cta.textContent = 'Wants to join you — accept';
    } else if (m.requested) {
      card.dataset.state = 'requested';
      cta.textContent = 'Request sent · cancel';
    } else {
      cta.textContent = 'Send request →';
    }
    const hit = card.querySelector('.match-hit');
    hit.setAttribute('aria-label', `${cta.textContent}: ${m.name}, ${m.activity}`);
    hit.addEventListener('click', () => (m.away ? requestAway(m) : onMatchClick(m)));
    // Report/block menu needs a live person; away cards don't have one.
    card.querySelector('.card-more').hidden = !!m.away;
    card.querySelector('.card-more').addEventListener('click', (e) => {
      e.stopPropagation();
      openCardMenu(e.currentTarget, m);
    });
    return card;
  }

  async function onMatchClick(m) {
    if (m.requested) {
      socket.emit('cancel-request', { to: m.id });
      return;
    }
    const res = await emit('send-request', { to: m.id });
    if (res.error) toast({ title: 'Could not send request', body: res.error });
    else if (!res.matched) toast({ title: `Request sent to ${m.name}`, body: 'We’ll let you know when they respond.', timeout: 2500 });
  }

  socket.on('matches', ({ matches, groups, away, online }) => {
    $('#online-count').textContent = Math.max(0, online - 1);
    if (!state.room) renderMatches(matches, groups || [], away || []);
  });

  function ago(ms) {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  }

  async function requestAway(m) {
    if (m.requested) return;
    const res = await emit('connect-request', { accountId: m.accountId });
    if (res.error) return toast({ title: 'Couldn’t send request', body: res.error });
    toast(res.status === 'accepted'
      ? { title: `You and ${m.name} both want to connect 🎉`, body: 'Find them under Requests and call when you’re both online.' }
      : { title: `Request sent to ${m.name}`, body: 'They’ll see it when they’re back. We’ll let you know if they accept.', timeout: 4000 });
  }

  socket.on('incoming-request', ({ from, score, friend, connect }) => {
    if (state.room || state.incoming.has(from.id)) return;
    const details = [metaLine(from), from.bio].filter(Boolean).join(' · ');
    const el = toast({
      title: friend ? `Your friend ${from.name} is inviting you to a call`
        : connect ? `${from.name} is calling (you both wanted to connect)` : `${from.name} wants to join you`,
      body: friend || connect
        ? [from.activity && `They're doing “${from.activity}”`, details].filter(Boolean).join(' · ')
        : [`“${from.activity}” · ${score}% match`, details].filter(Boolean).join(' · '),
      avatarOf: from,
      timeout: 0,
      actions: [
        { label: 'Decline', onClick: () => respond(from.id, false) },
        { label: 'Accept', cls: 'btn-good', onClick: () => respond(from.id, true) },
      ],
    });
    state.incoming.set(from.id, el);
  });

  async function respond(fromId, accept) {
    dismiss(state.incoming.get(fromId));
    state.incoming.delete(fromId);
    const res = await emit('respond-request', { from: fromId, accept });
    if (res.error) toast({ title: 'Request expired', body: res.error });
  }

  function clearIncoming() {
    for (const el of state.incoming.values()) dismiss(el);
    state.incoming.clear();
  }

  socket.on('request-cancelled', ({ from }) => {
    dismiss(state.incoming.get(from));
    state.incoming.delete(from);
  });

  socket.on('request-declined', ({ name, reason }) => {
    if (state.room) return;
    toast({
      title: reason === 'declined' ? `${name} declined your request` : `${name} is no longer available`,
      body: 'No worries — try someone else.',
    });
  });

  // ---------- 4. Meeting room (1:1 and groups up to 5) ----------
  //
  // Everyone in a room connects directly to everyone else (one RTCPeerConnection per person).
  // The server tells the later joiner of each pair to make the offer ('connect-peer').

  // Fallback if the server sends no ICE servers; normally room-start includes STUN + TURN.
  const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  let localStream = null;
  let iceServers = DEFAULT_ICE;
  const peers = new Map(); // memberId -> { pc, stream, tile, pending: [], camOn, hasVideo }
  let unread = 0;

  const others = () => (state.room?.members || []).filter((m) => m.id !== socket.id);
  const memberById = (id) => state.room?.members.find((m) => m.id === id);

  socket.on('room-start', async (room) => {
    clearIncoming();
    closeAllPeers();
    iceServers = room.iceServers || DEFAULT_ICE;
    state.room = room;
    state.friendRequested = false;
    state.lastPeer = null;
    unread = 0;
    $('#chat-dot').hidden = true;
    $('#chat-log').textContent = '';
    $('#tiles').textContent = '';
    paintAvatar($('#local-avatar'), state.user.displayName, state.user.avatar);
    const o = others();
    if (!o.length) systemMessage('Your group room is open. People doing something similar can ask to join. You decide who gets in.');
    else if (o.length === 1) introduce(o[0]);
    else systemMessage(`You joined a group call with ${o.map((m) => m.name).join(', ')}.`);
    renderRoom();
    show('screen-room');
    await startLocalMedia();
    if (state.room) socket.emit('media-ready');
  });

  function introduce(peer) {
    systemMessage(peer.friend
      ? `You're in a call with your friend ${peer.name}.`
      : `You matched with ${peer.name}! They're doing “${peer.activity}”.`);
    const about = [peer.city && `From ${peer.city}`, peer.interests?.length && `Into ${peer.interests.join(', ')}`].filter(Boolean).join(' · ');
    if (about) systemMessage(about);
    if (peer.bio) systemMessage(`“${peer.bio}”`);
  }

  socket.on('room-state', (room) => {
    if (!state.room || state.room.roomId !== room.roomId) return;
    state.room = { ...state.room, ...room };
    renderRoom();
  });

  socket.on('room-notice', ({ text }) => { if (state.room) systemMessage(text); });

  socket.on('member-left', ({ id, name, reason }) => {
    if (!state.room) return;
    closePeer(id);
    systemMessage(reason === 'removed' ? `${name} was removed from the call.` : reason === 'disconnected' ? `${name} disconnected.` : `${name} left.`);
  });

  // Draws tiles, top bar and the room dialog from state.room.
  function renderRoom() {
    const room = state.room;
    if (!room) return;
    const o = others();
    const total = room.members.length;

    // 1:1 calls remember who you were with, for "Add friend" / "Report" afterwards.
    if (o.length === 1 && total === 2) state.lastPeer = o[0];

    $('#stage').dataset.count = String(o.length);
    $('#local-label').textContent = room.isHost ? 'You (host)' : 'You';
    $('#waiting').hidden = o.length > 0;
    for (const id of [...peers.keys()]) if (!memberById(id)) closePeer(id);
    for (const m of o) ensureTile(m);
    for (const m of o) {
      const t = peers.get(m.id)?.tile || $(`#tiles [data-id="${CSS.escape(m.id)}"]`);
      if (t) {
        t.querySelector('.tile-name').textContent = m.name;
        t.querySelector('.host-tag').hidden = room.hostId !== m.id;
      }
    }

    // Top bar
    const acts = [...new Set([room.activity, ...room.members.map((m) => m.activity)].filter(Boolean))];
    $('#room-activity').textContent = (room.open && room.activity) || acts.slice(0, 2).join('  ·  ') || 'Hanging out';
    $('#room-who').textContent = !o.length ? 'Your group room'
      : o.length === 1 ? `Together with ${o[0].name}`
      : `With ${o.slice(0, 2).map((m) => m.name.split(' ')[0]).join(', ')}${o.length > 2 ? ` +${o.length - 2}` : ''}`;
    const pill = $('#room-pill');
    pill.textContent = room.open ? `Open · ${total}/${room.capacity}` : total > 2 ? `Group · ${total}` : '';
    pill.classList.toggle('open', room.open);

    const canManage = room.isHost || !room.hostId;
    $('#room-btn-label').textContent = room.open || total > 2 || !canManage ? `People (${total})` : 'Open to others';
    $('#room-badge').textContent = room.requests.length;
    $('#room-badge').hidden = !room.requests.length;

    const one = o.length === 1 ? o[0] : null;
    $('#add-friend-btn').hidden = !one || one.friend || state.friendRequested;

    if ($('#room-dialog').open) renderRoomDialog();
  }

  function renderRoomDialog() {
    const room = state.room;
    if (!room) return;
    const canManage = room.isHost || !room.hostId;
    $('#room-host-controls').hidden = !canManage;
    $('#room-guest-note').hidden = canManage;
    const host = memberById(room.hostId);
    $('#room-guest-note').textContent = host
      ? `${host.name} is the host and decides who can join${room.open ? ` (up to ${room.capacity} people).` : '.'}`
      : '';
    $('#room-open').checked = room.open;
    $('#open-hint').textContent = room.open
      ? `Visible in matching. ${room.members.length}/${room.capacity} seats taken.`
      : 'People doing something similar can ask to join. You decide who gets in.';
    const sel = $('#room-capacity');
    sel.textContent = '';
    for (let n = Math.max(2, room.members.length); n <= 5; n++) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = `${n} people`;
      sel.append(opt);
    }
    // Not open yet: suggest 4 seats for when they flip the switch.
    sel.value = String(room.open ? room.capacity : Math.max(4, room.members.length));
    $('#room-error').textContent = '';

    const reqs = $('#room-requests');
    reqs.textContent = '';
    $('#room-requests-section').hidden = !room.requests.length;
    for (const r of room.requests) {
      const { li, who } = personRow(r);
      const line = document.createElement('span');
      line.textContent = [`“${r.activity}”`, metaLine(r)].filter(Boolean).join(' · ');
      who.append(line);
      li.append(
        button('Decline', 'btn btn-ghost', () => answerJoin(r.id, false)),
        button('Let in', 'btn btn-good', () => answerJoin(r.id, true)),
      );
      reqs.append(li);
    }

    const list = $('#room-members');
    list.textContent = '';
    for (const m of room.members) {
      const { li, who } = personRow(m);
      const line = document.createElement('span');
      line.textContent = [m.id === socket.id ? 'You' : null, room.hostId === m.id ? 'Host' : null, m.activity && `“${m.activity}”`].filter(Boolean).join(' · ');
      who.append(line);
      if (m.id !== socket.id) {
        const more = button('⋯', 'icon-btn', (e) => { e.stopPropagation(); openTileMenu(e.currentTarget, m); });
        more.setAttribute('aria-label', `Options for ${m.name}`);
        li.append(more);
      }
      list.append(li);
    }
  }

  $('#room-btn').addEventListener('click', () => {
    renderRoomDialog();
    openDialog('#room-dialog');
  });

  async function saveRoomSettings(patch) {
    const res = await emit('room-settings', patch);
    if (res.error) $('#room-error').textContent = res.error;
  }
  $('#room-open').addEventListener('change', (e) => saveRoomSettings({ open: e.target.checked, capacity: Number($('#room-capacity').value) }));
  // Size only applies once the call is open; before that it's sent along with "open".
  $('#room-capacity').addEventListener('change', (e) => {
    if (state.room?.open) saveRoomSettings({ capacity: Number(e.target.value) });
  });

  // ---- Join requests (host side) ----
  const joinToasts = new Map();
  socket.on('join-request', ({ from, score, invitedBy }) => {
    const el = toast({
      title: invitedBy ? `${from.name} wants to join (invited by ${invitedBy})` : `${from.name} wants to join your call`,
      body: [`“${from.activity}” · ${score}% match`, metaLine(from), from.bio].filter(Boolean).join(' · '),
      avatarOf: from,
      timeout: 60000,
      actions: [
        { label: 'Decline', onClick: () => answerJoin(from.id, false) },
        { label: 'Let in', cls: 'btn-good', onClick: () => answerJoin(from.id, true) },
      ],
    });
    joinToasts.set(from.id, el);
  });
  socket.on('join-request-cancelled', ({ from }) => { dismiss(joinToasts.get(from)); joinToasts.delete(from); });

  async function answerJoin(id, accept) {
    dismiss(joinToasts.get(id));
    joinToasts.delete(id);
    const res = await emit('join-respond', { from: id, accept });
    if (res.error) toast({ title: 'Couldn’t do that', body: res.error });
  }

  // ---- Media ----

  async function startLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: true });
    } catch {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        systemMessage('Camera unavailable — joined with audio only.');
      } catch {
        localStream = null;
        systemMessage('No camera or microphone access — you can still chat. (Allow access in your browser to use video.)');
      }
    }
    if (!state.room) { stopMedia(); return; } // left while waiting for permission
    const hasVideo = !!localStream?.getVideoTracks().length;
    const hasAudio = !!localStream?.getAudioTracks().length;
    $('#local-video').srcObject = hasVideo ? localStream : null;
    $('#local-placeholder').hidden = hasVideo;
    setCtrl('#cam-btn', hasVideo, !hasVideo);
    setCtrl('#mic-btn', hasAudio, !hasAudio);
    socket.emit('media-state', { video: hasVideo, audio: hasAudio });
  }

  function ensureTile(m) {
    if ($(`#tiles [data-id="${CSS.escape(m.id)}"]`)) return;
    const tile = $('#tile-tpl').content.firstElementChild.cloneNode(true);
    tile.dataset.id = m.id;
    paintAvatar(tile.querySelector('.avatar'), m.name, m.avatar);
    tile.querySelector('.tile-name').textContent = m.name;
    tile.querySelector('.tile-more').addEventListener('click', (e) => {
      e.stopPropagation();
      const member = memberById(m.id);
      if (member) openTileMenu(e.currentTarget, member);
    });
    $('#tiles').append(tile);
  }

  function getPeer(id) {
    if (peers.has(id)) return peers.get(id);
    const m = memberById(id);
    if (m) ensureTile(m);
    const tile = $(`#tiles [data-id="${CSS.escape(id)}"]`);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, stream: new MediaStream(), tile, pending: [], camOn: true, hasVideo: false };
    peers.set(id, peer);

    const hasAudio = !!localStream?.getAudioTracks().length;
    const hasVideo = !!localStream?.getVideoTracks().length;
    if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    // Always be able to receive audio+video, even if we have nothing to send.
    if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });

    const video = tile?.querySelector('video');
    const placeholder = tile?.querySelector('.tile-placeholder');
    const status = tile?.querySelector('.tile-status');
    if (video) video.srcObject = peer.stream;
    pc.ontrack = (e) => {
      peer.stream.addTrack(e.track);
      if (e.track.kind === 'video' && placeholder) {
        peer.hasVideo = true;
        if (!e.track.muted) placeholder.hidden = peer.camOn;
        e.track.onunmute = () => { placeholder.hidden = !peer.camOn; };
        e.track.onmute = () => { placeholder.hidden = false; };
      }
    };
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: id, candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (!status) return;
      if (pc.connectionState === 'connected') status.textContent = 'Camera is off';
      if (pc.connectionState === 'failed') status.textContent = 'Could not connect video. Chat still works.';
    };
    return peer;
  }

  function closePeer(id) {
    const p = peers.get(id);
    p?.pc.close();
    peers.delete(id);
    $(`#tiles [data-id="${CSS.escape(id)}"]`)?.remove();
  }
  function closeAllPeers() { for (const id of [...peers.keys()]) closePeer(id); }

  // Server: "you're the later joiner of this pair, call them".
  socket.on('connect-peer', async ({ peerId }) => {
    if (!state.room) return;
    try {
      const { pc } = getPeer(peerId);
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('signal', { to: peerId, description: pc.localDescription });
    } catch (err) {
      console.error('Offer failed', err);
    }
  });

  socket.on('signal', async ({ from, description, candidate }) => {
    if (!state.room || !memberById(from)) return;
    const peer = getPeer(from);
    try {
      if (description) {
        await peer.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          socket.emit('signal', { to: from, description: peer.pc.localDescription });
        }
        for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {});
        peer.pending = [];
      } else if (candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate).catch(() => {});
        else peer.pending.push(candidate);
      }
    } catch (err) {
      console.error('Signaling error', err);
    }
  });

  socket.on('media-state', ({ from, video, audio }) => {
    const peer = peers.get(from);
    const tile = peer?.tile || $(`#tiles [data-id="${CSS.escape(from)}"]`);
    if (!tile) return;
    if (peer) peer.camOn = !!video;
    tile.querySelector('.muted-tag').hidden = !!audio;
    if (!video) tile.querySelector('.tile-status').textContent = 'Camera is off';
    tile.querySelector('.tile-placeholder').hidden = !!video && !!peer?.hasVideo;
  });

  function setCtrl(sel, on, disabled = false) {
    const b = $(sel);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = disabled;
  }

  function sendMediaState() {
    socket.emit('media-state', {
      audio: !!localStream?.getAudioTracks()[0]?.enabled,
      video: !!localStream?.getVideoTracks()[0]?.enabled,
    });
  }

  $('#mic-btn').addEventListener('click', () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCtrl('#mic-btn', track.enabled);
    sendMediaState();
  });

  $('#cam-btn').addEventListener('click', () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCtrl('#cam-btn', track.enabled);
    $('#local-placeholder').hidden = track.enabled;
    sendMediaState();
  });

  function stopMedia() {
    closeAllPeers();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    $('#local-video').srcObject = null;
  }

  function exitRoom(notice) {
    stopMedia();
    state.room = null;
    for (const el of joinToasts.values()) dismiss(el);
    joinToasts.clear();
    if ($('#room-dialog').open) $('#room-dialog').close();
    closeTileMenu();
    $('#chat-panel').removeAttribute('data-open');
    // Calls from a friend invite can start before you've typed an activity.
    show(state.activity ? 'screen-matches' : 'screen-activity');
    if (notice) toast({ title: notice, body: 'You’re back in the match list.' });
  }

  $('#leave-btn').addEventListener('click', () => {
    const wasOneToOne = others().length === 1;
    const peer = state.lastPeer;
    socket.emit('leave-room');
    exitRoom();
    if (wasOneToOne && peer) postCallPrompt(peer, `Call with ${peer.name} ended`);
  });

  // After a 1:1 call: offer "Add friend" (unless already friends/asked) and "Report a problem".
  function postCallPrompt(peer, title) {
    const actions = [];
    if (!peer.friend && !state.friendRequested) {
      actions.push({ label: 'Add friend', cls: 'btn-good', onClick: (el) => { dismiss(el); addFriend(peer.name); } });
    }
    actions.push({ label: 'Report a problem', onClick: (el) => { dismiss(el); openReport({ lastPeer: true }, peer.name, false); } });
    toast({
      title,
      body: !peer.friend && !state.friendRequested ? `Enjoyed it? Add ${peer.name} as a friend to meet again.` : 'You’re back in the match list.',
      avatarOf: peer,
      timeout: 15000,
      actions,
    });
  }

  // target: a member id in the current call; omitted = your last 1:1 partner.
  async function addFriend(name, target) {
    const res = await emit('friend-request', target ? { target } : undefined);
    if (res.error) return toast({ title: 'Couldn’t add friend', body: res.error });
    if (!target || others().length === 1) state.friendRequested = true;
    const btn = $('#add-friend-btn');
    if (res.status === 'friends') {
      btn.hidden = true;
      toast({ title: `You and ${name} are now friends 🎉`, body: 'Find them anytime under Friends.' });
    } else {
      btn.textContent = 'Friend request sent ✓';
      btn.disabled = true;
      toast({ title: 'Friend request sent', body: `If ${name} adds you too, you’ll become friends.`, timeout: 3000 });
    }
  }

  $('#add-friend-btn').addEventListener('click', () => {
    const one = others()[0];
    if (one) addFriend(one.name, one.id);
  });

  // A closed call ended because everyone else left (or our other tab blocked them).
  socket.on('room-ended', ({ reason, name } = {}) => {
    if (!state.room) return;
    const peer = state.lastPeer;
    exitRoom();
    if (reason !== 'self' && peer) postCallPrompt(peer, reason === 'disconnected' ? `${name} disconnected` : `${name} left the call`);
  });

  socket.on('removed-from-room', () => {
    if (state.room) exitRoom('You were removed from the call');
  });

  // ---- ⋯ menu on a person in the call ----
  let tileMenuFor = null;
  function openTileMenu(btn, member) {
    const menu = $('#tile-menu');
    if (tileMenuFor === member.id && !menu.hidden) return closeTileMenu();
    closeTileMenu();
    closeCardMenu();
    tileMenuFor = member.id;
    menu.querySelector('[data-action="friend"]').hidden = !!member.friend;
    menu.querySelector('[data-action="remove"]').hidden = !state.room?.isHost;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - h - 8)}px`;
    // In an open dialog, the menu must sit inside it to be clickable (top layer).
    const dlg = btn.closest('dialog');
    (dlg || document.body).append(menu);
    menu.onclick = async (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      closeTileMenu();
      if (action === 'friend') addFriend(member.name, member.id);
      if (action === 'report') openReport({ target: member.id }, member.name, true);
      if (action === 'block') confirmBlock({ target: member.id }, member.name, true);
      if (action === 'remove' && confirm(`Remove ${member.name} from the call? They won't be able to rejoin it.`)) {
        const res = await emit('remove-member', { id: member.id });
        if (res.error) toast({ title: 'Couldn’t remove', body: res.error });
      }
    };
  }
  function closeTileMenu() {
    const menu = $('#tile-menu');
    menu.hidden = true;
    document.querySelectorAll('.tile-more[aria-expanded="true"], .icon-btn[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    tileMenuFor = null;
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('#tile-menu')) closeTileMenu(); });

  // ---- Group rooms from search ----
  // The wording is pre-filled with your search but can be changed before starting.
  function openCreateRoom(wording) {
    $('#create-room-activity').value = wording ?? state.activity ?? '';
    openDialog('#create-room-dialog');
    $('#create-room-activity').focus();
  }
  $('#start-group-btn').addEventListener('click', () => openCreateRoom());
  $('#start-group-from-prompt').addEventListener('click', () => openCreateRoom($('#activity-input').value.trim()));
  $('#create-room-go').addEventListener('click', async () => {
    const activity = $('#create-room-activity').value.trim();
    if (!activity) { $('#create-room-dialog .form-error').textContent = 'Tell people what the room is for.'; return; }
    const res = await emit('create-room', { capacity: Number($('#create-room-size').value), activity });
    if (res.error) { $('#create-room-dialog .form-error').textContent = res.error; return; }
    state.activity = activity;
    $('#my-activity').textContent = activity;
    $('#create-room-dialog').close();
  });

  // ---- Asking to join a group (requester side) ----
  socket.on('join-declined', ({ reason, activity }) => {
    const titles = {
      declined: 'The host didn’t let you in this time',
      timeout: 'No answer from the host',
      full: 'That group filled up',
      closed: 'That group isn’t taking people anymore',
    };
    toast({ title: titles[reason] || titles.closed, body: `“${activity}”. Try another group or person.` });
  });

  socket.on('suspended', () => {
    signedOut('Your account has been suspended for breaking the community guidelines.');
  });

  // ---------- Friends ----------

  state.friends = { friends: [], requests: [] };
  const STATUS_TEXT = { searching: null, online: 'Online', 'in-call': 'In a call', offline: 'Offline' };

  function personRow(p, extraClass) {
    const li = document.createElement('li');
    const av = document.createElement('div');
    av.className = `avatar avatar-sm ${extraClass || ''}`;
    paintAvatar(av, p.name, p.avatar);
    if (p.status) av.dataset.status = p.status;
    const who = document.createElement('div');
    who.className = 'who';
    const strong = document.createElement('strong');
    strong.textContent = p.name;
    who.append(strong);
    li.append(av, who);
    return { li, who };
  }

  function button(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  function renderFriends() {
    const { friends, requests } = state.friends;
    document.querySelectorAll('.friends-badge').forEach((b) => {
      b.textContent = requests.length;
      b.hidden = !requests.length;
    });

    const reqList = $('#friend-requests');
    reqList.textContent = '';
    $('#friend-requests-section').hidden = !requests.length;
    for (const r of requests) {
      const { li } = personRow(r);
      li.append(
        button('Not now', 'btn btn-ghost', () => emit('friend-respond', { id: r.id, accept: false })),
        button('Accept', 'btn btn-good', async () => {
          const res = await emit('friend-respond', { id: r.id, accept: true });
          if (!res.error) toast({ title: `You and ${r.name} are now friends 🎉` });
        }),
      );
      reqList.append(li);
    }

    const note = $('#friends-call-note');
    note.hidden = !state.room;
    if (state.room) {
      note.textContent = state.room.isHost || !state.room.hostId
        ? 'Invite friends to this call. As the host, anyone you invite joins as soon as they accept.'
        : 'Invite friends to this call. You’re not the host, so the host approves anyone you invite.';
    }
    const list = $('#friend-list');
    list.textContent = '';
    $('#friends-empty').hidden = friends.length > 0 || requests.length > 0;
    for (const f of friends) {
      const { li, who } = personRow(f, 'presence');
      const line = document.createElement('span');
      line.textContent = f.status === 'searching' ? `Matching on “${f.activity}”`
        : f.status === 'in-call' && f.activity ? `In a call · “${f.activity}”`
        : [STATUS_TEXT[f.status], metaLine(f)].filter(Boolean).join(' · ');
      who.append(line);
      if (f.status === 'online' || f.status === 'searching') {
        const inCall = !!state.room;
        const invite = button(inCall ? 'Invite to this call' : 'Invite to call', 'btn btn-primary', async () => {
          invite.disabled = true;
          const res = await emit('friend-invite', { id: f.id });
          if (res.error) { invite.disabled = false; return toast({ title: 'Couldn’t invite', body: res.error }); }
          if (!res.matched) {
            invite.textContent = 'Invited ✓';
            toast({
              title: `Invite sent to ${f.name}`,
              body: inCall
                ? (res.needsApproval ? 'If they accept, the host will be asked to let them in.' : 'They’ll join as soon as they accept.')
                : 'You’ll join a call as soon as they accept.',
              timeout: 3500,
            });
          }
          $('#friends-dialog').close();
        });
        li.append(invite);
      }
      li.append(button('✕', 'icon-btn', () => {
        if (confirm(`Remove ${f.name} from your friends? They won't be told.`)) emit('friend-remove', { id: f.id });
      }));
      li.lastChild.setAttribute('aria-label', `Remove ${f.name}`);
      li.lastChild.title = 'Remove friend';
      list.append(li);
    }
  }

  socket.on('friends', (payload) => {
    state.friends = payload;
    renderFriends();
  });

  socket.on('friend-request', (from) => {
    const el = toast({
      title: `${from.name} wants to be friends`,
      body: 'Become friends to see when they’re online and call them directly.',
      avatarOf: from,
      timeout: 20000,
      actions: [
        { label: 'Not now', onClick: () => { dismiss(el); emit('friend-respond', { id: from.id, accept: false }); } },
        { label: 'Accept', cls: 'btn-good', onClick: async () => {
          dismiss(el);
          const res = await emit('friend-respond', { id: from.id, accept: true });
          if (!res.error) toast({ title: `You and ${from.name} are now friends 🎉` });
        } },
      ],
    });
  });

  socket.on('friend-added', ({ name }) => {
    if (state.room && state.room.peer.name === name) $('#add-friend-btn').hidden = true;
    toast({ title: `You and ${name} are now friends 🎉`, body: 'Find them anytime under Friends.' });
  });

  document.querySelectorAll('.friends-btn, .room-friends-btn').forEach((b) => b.addEventListener('click', () => {
    renderFriends();
    openDialog('#friends-dialog');
  }));

  // ---------- Edit profile ----------

  let draftTags = [];
  function renderTags() {
    const box = $('#tags');
    box.textContent = '';
    draftTags.forEach((t, i) => {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = t;
      const x = button('×', '', () => { draftTags.splice(i, 1); renderTags(); });
      x.setAttribute('aria-label', `Remove ${t}`);
      chip.append(x);
      box.append(chip);
    });
    $('#tag-entry').disabled = draftTags.length >= 5;
    $('#tag-entry').placeholder = draftTags.length >= 5 ? 'Up to 5 interests' : 'Type and press Enter';
  }

  function addTag() {
    const input = $('#tag-entry');
    const t = input.value.replace(/,/g, ' ').trim().replace(/^#/, '');
    if (t && draftTags.length < 5 && !draftTags.some((x) => x.toLowerCase() === t.toLowerCase())) draftTags.push(t);
    input.value = '';
    renderTags();
  }
  $('#tag-entry').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(); }
    if (e.key === 'Backspace' && !e.target.value && draftTags.length) { draftTags.pop(); renderTags(); }
  });
  $('#tag-input').addEventListener('click', () => $('#tag-entry').focus());

  const bioInput = $('#profile-form').elements.bio;
  bioInput.addEventListener('input', () => { $('#bio-count').textContent = bioInput.value.length; });

  document.querySelectorAll('.edit-profile-btn').forEach((b) => b.addEventListener('click', () => {
    closeMenus();
    const form = $('#profile-form');
    clearFormErrors(form);
    form.elements.bio.value = state.user.bio || '';
    form.elements.city.value = state.user.city || '';
    $('#bio-count').textContent = form.elements.bio.value.length;
    $('#tz-label').textContent = MY_TZ || 'unknown';
    draftTags = [...(state.user.interests || [])];
    renderTags();
    openDialog('#profile-dialog');
  }));

  $('#profile-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    if ($('#tag-entry').value.trim()) addTag(); // don't lose a half-typed interest
    submitWith(form, async () => {
      const { user } = await api('PATCH', '/api/auth/me', {
        bio: form.elements.bio.value,
        interests: draftTags,
        city: form.elements.city.value,
        timezone: MY_TZ,
      });
      setUser(user);
      socket.emit('refresh-profile');
      $('#profile-dialog').close();
      toast({ title: 'Profile saved', timeout: 2500 });
    });
  });

  // ---------- Invites into someone's call ----------

  const roomInviteToasts = new Map();
  socket.on('room-invite', ({ roomId, from, activity, count, capacity, members, needsApproval }) => {
    if (state.room) return;
    dismiss(roomInviteToasts.get(roomId));
    const who = members.length > 1 ? `with ${members.join(', ')}` : `with ${from.name}`;
    const el = toast({
      title: `${from.name} invites you to join their call`,
      body: [`“${activity}”`, `${count}/${capacity} people ${who}`, needsApproval && 'the host will let you in'].filter(Boolean).join(' · '),
      avatarOf: from,
      timeout: 60000,
      actions: [
        { label: 'Not now', onClick: () => { dismiss(el); emit('room-invite-respond', { roomId, accept: false }); } },
        { label: 'Join', cls: 'btn-good', onClick: async () => {
          dismiss(el);
          const res = await emit('room-invite-respond', { roomId, accept: true });
          if (res.error) toast({ title: 'Couldn’t join', body: res.error });
          else if (res.pending) toast({ title: 'Waiting for the host', body: 'You’ll be let in as soon as they say yes.', timeout: 4000 });
        } },
      ],
    });
    roomInviteToasts.set(roomId, el);
  });
  socket.on('room-invite-expired', ({ roomId }) => { dismiss(roomInviteToasts.get(roomId)); roomInviteToasts.delete(roomId); });
  socket.on('room-invite-declined', ({ name }) => toast({ title: `${name} can’t join right now`, timeout: 3000 }));

  // ---------- Background searches page ----------

  state.inbox = { searches: [], maxSearches: 3, incoming: [], outgoing: [], ready: [], history: [], notifyEmail: true };
  let shownAwaySummary = false;
  const openSearches = new Set(); // ids of searches expanded on the page
  let bgReturnTo = 'screen-activity';
  let editingSearch = null; // search being edited in the dialog (null = new)

  function untilText(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  const short = (t, n = 28) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const allMatches = () => state.inbox.searches.flatMap((x) => x.matches);

  // The entry button on the main screen and the status button on the matches screen.
  function renderBgControls() {
    const { searches, incoming, ready } = state.inbox;
    const total = new Set(allMatches().map((m) => m.person.id)).size;
    $('#bg-entry').toggleAttribute('data-on', !!searches.length);
    $('#bg-entry-sub').textContent = !searches.length
      ? 'Keep looking after you close the tab'
      : searches.length === 1
        ? `“${short(searches[0].activity, 32)}” · ${plural(searches[0].matches.length, 'match', 'matches')}`
        : `${searches.length} running · ${plural(total, 'match', 'matches')}`;
    const urgent = incoming.length + ready.filter((r) => r.available).length + allMatches().filter((m) => m.new).length;
    $('#bg-entry-badge').textContent = urgent;
    $('#bg-entry-badge').hidden = !urgent;

    // Top bar button: a green dot while any background search is running.
    document.querySelectorAll('.bg-top-btn').forEach((b) => {
      b.toggleAttribute('data-on', !!searches.length);
      b.querySelector('.bg-top-dot').hidden = !searches.length;
      b.title = searches.length ? `Background searches · ${searches.length} running` : 'Background searches';
    });
    const btn = $('#bg-btn');
    btn.toggleAttribute('data-on', !!searches.length);
    $('#bg-btn-label').textContent = searches.length ? `Background searches (${searches.length})` : 'Search in background';
    // The empty-state offer is hidden once this exact activity is already searched in the background.
    const covered = searches.some((x) => x.activity.toLowerCase() === state.activity.toLowerCase());
    $('#bg-empty-btn').hidden = covered;
    $('#bg-empty-hint').hidden = covered;
  }

  // A page of its own: it gets a #background URL so the browser's back button leaves it.
  function openBgPage() {
    const current = document.querySelector('.screen[data-active]')?.id;
    if (current !== 'screen-background') {
      bgReturnTo = current === 'screen-matches' ? 'screen-matches' : 'screen-activity';
      if (location.hash !== '#background') history.pushState({ page: 'background' }, '', '#background');
    }
    renderInbox();
    show('screen-background');
  }

  function leaveBgPage() {
    if (location.hash === '#background') history.back();
    else show(bgReturnTo);
  }
  window.addEventListener('popstate', () => {
    if (location.hash === '#background' && state.user?.emailVerified && !state.room) openBgPage();
    else if (document.querySelector('#screen-background[data-active]')) show(bgReturnTo);
  });
  $('#bgp-back').addEventListener('click', leaveBgPage);

  // New search (prefilled with what you're doing live) or editing one of yours.
  function openBgDialog(search = null) {
    editingSearch = search;
    $('#bg-title').textContent = search ? 'Edit background search' : 'New background search';
    $('#bg-activity').value = search ? search.activity : (state.activity || '');
    $('#bg-notify').checked = state.inbox.notifyEmail;
    $('#bg-on').hidden = !search;
    if (search) $('#bg-on').textContent = `Running until ${untilText(search.expiresAt)}. Saving restarts the timer.`;
    $('#bg-stop').hidden = !search;
    $('#bg-go').textContent = search ? 'Save' : 'Start';
    $('#bg-dialog .form-error').textContent = '';
    openDialog('#bg-dialog');
    $('#bg-activity').focus();
  }
  $('#bg-entry').addEventListener('click', openBgPage);
  $('#bg-btn').addEventListener('click', () => (state.inbox.searches.length ? openBgPage() : openBgDialog()));
  $('#bg-empty-btn').addEventListener('click', () => openBgDialog());
  document.querySelectorAll('.bg-top-btn').forEach((b) => b.addEventListener('click', openBgPage));
  $('#bgp-new').addEventListener('click', () => {
    if (state.inbox.searches.length >= state.inbox.maxSearches) {
      return toast({ title: `You can run up to ${state.inbox.maxSearches} background searches`, body: 'Stop one to start another.' });
    }
    openBgDialog();
  });
  $('#bgp-notify').addEventListener('change', (e) => emit('notify-email', { on: e.target.checked }));

  $('#bg-go').addEventListener('click', async () => {
    const activity = $('#bg-activity').value.trim();
    if (!activity) { $('#bg-dialog .form-error').textContent = 'Tell us what you’re looking for.'; return; }
    const res = await emit('bg-start', {
      id: editingSearch?.id, hours: Number($('#bg-hours').value), notify: $('#bg-notify').checked, activity,
    });
    if (res.error) { $('#bg-dialog .form-error').textContent = res.error; return; }
    $('#bg-dialog').close();
    openSearches.add(res.id);
    toast({
      title: editingSearch ? 'Background search updated' : 'Background search on',
      body: `Looking for “${res.activity}” until ${untilText(res.expiresAt)}, even after you close Connecto.`,
      actions: document.querySelector('#screen-background[data-active]') ? undefined : [{ label: 'View', cls: 'btn-primary', onClick: (el) => { dismiss(el); openBgPage(); } }],
    });
  });
  $('#bg-stop').addEventListener('click', async () => {
    if (editingSearch) await emit('bg-stop', { id: editingSearch.id });
    $('#bg-dialog').close();
    toast({ title: 'Background search stopped', timeout: 2500 });
  });
  $('#bg-notify').addEventListener('change', (e) => { if (state.inbox.searches.length) emit('notify-email', { on: e.target.checked }); });

  function statusLine(p) {
    return { searching: 'Online now', online: 'Online now', 'in-call': 'In a call', offline: 'Offline' }[p.status] || '';
  }

  function timeLeft(ms) {
    const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
    if (min < 60) return `${min} min left`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h}h left` : `${Math.round(h / 24)} days left`;
  }

  const newTag = () => {
    const tag = document.createElement('span');
    tag.className = 'new-tag';
    tag.textContent = 'NEW';
    return tag;
  };

  // A person with a line under their name, flagged NEW when it happened since your last visit.
  function inboxRow(p, line, isNew) {
    const { li, who } = personRow({ ...p, status: p.status }, 'presence');
    if (isNew) who.firstChild.append(newTag());
    const span = document.createElement('span');
    span.textContent = line;
    who.append(span);
    return li;
  }

  async function callBack(person) {
    const res = await emit('connect-call', { accountId: person.id });
    if (res.error) return toast({ title: 'Couldn’t call', body: res.error });
    if (!res.matched) toast({ title: `Calling ${person.name}…`, body: 'You’ll join as soon as they pick up.', timeout: 3500 });
  }

  async function acceptConnect(id, person) {
    const res = await emit('connect-respond', { id, accept: true });
    if (res.error) toast({ title: 'Couldn’t accept', body: res.error });
    else toast({ title: `You and ${person.name} both want to connect 🎉`, body: person.status === 'offline' ? 'We’ll let them know. Call when you’re both online.' : 'They’re online now. Tap Call now.' });
  }

  // One background search: a header you tap to show or hide its matches.
  function searchCard(search) {
    const card = document.createElement('article');
    card.className = 'bgs';
    const open = openSearches.has(search.id);
    card.toggleAttribute('data-open', open);

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'bgs-head';
    head.setAttribute('aria-expanded', String(open));
    const dot = document.createElement('span');
    dot.className = 'bgp-dot';
    const title = document.createElement('span');
    title.className = 'bgs-title';
    const strong = document.createElement('strong');
    strong.textContent = `“${search.activity}”`;
    const sub = document.createElement('span');
    sub.textContent = `Background search · ${timeLeft(search.expiresAt)}`;
    title.append(strong, sub);
    const count = document.createElement('span');
    count.className = 'bgs-count';
    count.dataset.zero = String(!search.matches.length);
    count.textContent = plural(search.matches.length, 'match', 'matches');
    const fresh = search.matches.filter((m) => m.new).length;
    if (fresh) count.prepend(newTag());
    const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chev.setAttribute('viewBox', '0 0 24 24');
    chev.setAttribute('class', 'bgs-chev');
    chev.innerHTML = '<path fill="currentColor" d="m7 10 5 5 5-5z"/>';
    head.append(dot, title, count, chev);
    head.addEventListener('click', () => {
      if (openSearches.has(search.id)) openSearches.delete(search.id);
      else openSearches.add(search.id);
      const now = openSearches.has(search.id);
      card.toggleAttribute('data-open', now);
      head.setAttribute('aria-expanded', String(now));
    });

    const body = document.createElement('div');
    body.className = 'bgs-body';
    if (search.matches.length) {
      const list = document.createElement('ul');
      list.className = 'people-list';
      for (const m of search.matches) {
        const li = inboxRow(m.person, `“${m.activity}” · ${m.score}% match · found ${ago(m.foundAt)} · ${statusLine(m.person)}`, m.new);
        if (m.request === 'ready') {
          const b = button(m.available ? 'Call now' : 'Accepted · not online', 'btn btn-primary', () => callBack(m.person));
          b.disabled = !m.available || !!state.room;
          li.append(b);
        } else if (m.request === 'incoming') {
          li.append(button('Accept', 'btn btn-good', () => acceptConnect(m.requestId, m.person)));
        } else if (m.request === 'sent') {
          const b = button('Request sent', 'btn btn-ghost', null);
          b.disabled = true;
          li.append(b);
        } else {
          li.append(button('Send request', 'btn btn-primary', async (e) => {
            e.currentTarget.disabled = true;
            const res = await emit('connect-request', { accountId: m.person.id, searchId: search.id });
            if (res.error) toast({ title: 'Couldn’t send request', body: res.error });
          }));
        }
        list.append(li);
      }
      body.append(list);
    } else {
      const p = document.createElement('p');
      p.className = 'bgs-none';
      p.textContent = 'No matches yet. Anyone who starts a similar background search shows up here, and people searching live can find you and send a request.';
      body.append(p);
    }
    const foot = document.createElement('div');
    foot.className = 'bgs-foot';
    const when = document.createElement('span');
    when.textContent = `Started ${ago(search.startedAt)} · until ${untilText(search.expiresAt)}`;
    const stopBtn = button('Stop', 'btn btn-ghost bgp-stop', async () => {
      await emit('bg-stop', { id: search.id });
      toast({ title: 'Background search stopped', body: `“${short(search.activity, 40)}”`, timeout: 2500 });
    });
    foot.append(when, button('Edit', 'btn btn-ghost', () => openBgDialog(search)), stopBtn);
    body.append(foot);

    card.append(head, body);
    return card;
  }

  function renderInbox() {
    const { searches, incoming, outgoing, ready } = state.inbox;
    const history = state.inbox.history || [];
    const urgent = incoming.length + ready.filter((r) => r.available).length;
    document.querySelectorAll('.inbox-badge').forEach((b) => { b.textContent = urgent; b.hidden = !urgent; });
    renderBgControls();
    $('#bgp-notify').checked = !!state.inbox.notifyEmail;

    // What happened since the last visit
    const freshMatches = new Set(allMatches().filter((m) => m.new).map((m) => m.person.id)).size;
    const freshRequests = incoming.filter((r) => r.new).length;
    const freshAccepted = ready.filter((r) => r.new).length;
    const parts = [
      freshMatches && `${freshMatches} new ${freshMatches === 1 ? 'match' : 'matches'}`,
      freshRequests && `${freshRequests} new ${freshRequests === 1 ? 'request' : 'requests'}`,
      freshAccepted && `${freshAccepted} accepted`,
    ].filter(Boolean);
    $('#bgp-summary').hidden = !parts.length;
    $('#bgp-summary').textContent = parts.length ? `While you were away: ${parts.join(' · ')}` : '';

    const list = $('#bgs-list');
    list.textContent = '';
    for (const search of searches) list.append(searchCard(search));
    $('#bgp-empty').hidden = !!searches.length;
    $('#bgp-new').disabled = false;

    const fill = (listId, sectionId, items, build) => {
      const ul = $(listId);
      ul.textContent = '';
      $(sectionId).hidden = !items.length;
      for (const it of items) ul.append(build(it));
    };
    fill('#inbox-ready', '#inbox-ready-section', ready, (r) => {
      const li = inboxRow(r.person, `“${r.activity}” · ${statusLine(r.person)}`, r.new);
      const call = button(r.available ? 'Call now' : 'Not online', 'btn btn-primary', () => callBack(r.person));
      call.disabled = !r.available || !!state.room;
      li.append(call);
      return li;
    });
    fill('#inbox-incoming', '#inbox-incoming-section', incoming, (r) => {
      const li = inboxRow(r.person, `“${r.activity}” · ${ago(r.at)}`, r.new);
      li.append(
        button('Decline', 'btn btn-ghost', () => emit('connect-respond', { id: r.id, accept: false })),
        button('Accept', 'btn btn-good', () => acceptConnect(r.id, r.person)),
      );
      return li;
    });
    fill('#inbox-outgoing', '#inbox-outgoing-section', outgoing, (r) => {
      const li = inboxRow(r.person, `Sent ${ago(r.at)} · ${statusLine(r.person)}`);
      li.append(button('Cancel', 'btn btn-ghost', () => emit('connect-cancel', { id: r.id })));
      return li;
    });
    fill('#inbox-history', '#inbox-history-section', history, (h) => inboxRow(h.person, `Talked ${ago(h.at)} · “${h.activity}”${h.friend ? ' · friends' : ''}`));
  }

  socket.on('inbox', (payload) => {
    state.inbox = payload;
    // Searches that ended can't stay expanded.
    for (const id of openSearches) if (!payload.searches.some((x) => x.id === id)) openSearches.delete(id);
    renderInbox();
    // First load after coming back: tell them what happened while they were away.
    if (!shownAwaySummary) {
      shownAwaySummary = true;
      const n = payload.incoming.length;
      const r = payload.ready.length;
      const m = new Set(allMatches().filter((x) => x.new).map((x) => x.person.id)).size;
      // Searches with new matches open expanded.
      for (const x of payload.searches) if (x.matches.some((y) => y.new)) openSearches.add(x.id);
      if (n || r || m) {
        const el = toast({
          title: 'While you were away',
          body: [
            n && `${n} ${n === 1 ? 'person wants' : 'people want'} to connect`,
            r && `${r} accepted your request`,
            m && `${m} new background ${m === 1 ? 'match' : 'matches'}`,
          ].filter(Boolean).join(' · '),
          timeout: 12000,
          actions: [{ label: 'View', cls: 'btn-primary', onClick: () => { dismiss(el); openBgPage(); } }],
        });
      }
    }
  });
  socket.on('disconnect', () => { shownAwaySummary = false; });

  document.querySelectorAll('.inbox-btn').forEach((b) => b.addEventListener('click', openBgPage));

  socket.on('connect-request', ({ id, from, activity }) => {
    const el = toast({
      title: `${from.name} wants to connect`,
      body: [`“${activity}”`, metaLine(from)].filter(Boolean).join(' · '),
      avatarOf: from,
      timeout: 20000,
      actions: [
        { label: 'Later', onClick: () => dismiss(el) },
        { label: 'Accept', cls: 'btn-good', onClick: async () => {
          dismiss(el);
          const res = await emit('connect-respond', { id, accept: true });
          if (!res.error) toast({ title: `You and ${from.name} both want to connect 🎉`, body: 'Tap Call now under Requests.' });
        } },
      ],
    });
  });

  socket.on('connect-accepted', ({ accountId, name }) => {
    const el = toast({
      title: `${name} accepted your request 🎉`,
      body: 'You both want to connect. Call them now?',
      timeout: 20000,
      actions: [{ label: 'Call now', cls: 'btn-good', onClick: async () => {
        dismiss(el);
        const res = await emit('connect-call', { accountId });
        if (res.error) toast({ title: 'Couldn’t call', body: res.error });
      } }],
    });
  });

  // ---------- Safety: report & block ----------

  function openDialog(id) {
    const d = $(id);
    d.querySelector('.form-error') && (d.querySelector('.form-error').textContent = '');
    d.showModal();
    return d;
  }
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
  });

  // ⋯ menu on match cards
  let cardMenuFor = null;
  function openCardMenu(btn, match) {
    const menu = $('#card-menu');
    if (cardMenuFor === match.id && !menu.hidden) return closeCardMenu();
    closeCardMenu();
    cardMenuFor = match.id;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.onclick = (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      closeCardMenu();
      if (action === 'report') openReport({ target: match.id }, match.name, false);
      if (action === 'block') confirmBlock({ target: match.id }, match.name, false);
    };
  }
  function closeCardMenu() {
    $('#card-menu').hidden = true;
    document.querySelectorAll('.card-more[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    cardMenuFor = null;
  }
  document.addEventListener('click', (e) => { if (!e.target.closest('#card-menu')) closeCardMenu(); });
  window.addEventListener('scroll', closeCardMenu, { passive: true });
  window.addEventListener('resize', closeCardMenu);

  // target: { target: socketId } for a match card, { lastPeer: true } for your current/last call.
  let reportCtx = null;
  function openReport(target, name, inCall) {
    reportCtx = { target, name, inCall };
    const form = $('#report-form');
    form.reset();
    form.querySelectorAll('.report-name').forEach((el) => { el.textContent = name; });
    form.querySelector('button[type=submit]').disabled = false;
    openDialog('#report-dialog');
  }

  $('#report-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const reason = form.elements.reason.value;
    const err = form.querySelector('.form-error');
    if (!reason) { err.textContent = 'Choose what’s wrong so we can review it properly.'; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const block = form.elements.block.checked;
    const res = await emit('report', { ...reportCtx.target, reason, details: form.elements.details.value, block });
    btn.disabled = false;
    if (res.error) { err.textContent = res.error; return; }
    $('#report-dialog').close();
    // In a group the blocked person is removed instead; in a 1:1 the call ends.
    if (block && reportCtx.inCall && state.room && others().length <= 1) exitRoom();
    toast({
      title: 'Thanks, your report was sent',
      body: block ? `You won’t see ${reportCtx.name} again.` : 'We’ll review it as soon as possible.',
    });
  });

  let blockCtx = null;
  function confirmBlock(target, name, inCall) {
    blockCtx = { target, name, inCall };
    $('#block-dialog .block-name').textContent = name;
    openDialog('#block-dialog');
  }

  $('#block-confirm').addEventListener('click', async () => {
    const res = await emit('block', blockCtx.target);
    if (res.error) { $('#block-dialog .form-error').textContent = res.error; return; }
    $('#block-dialog').close();
    if (blockCtx.inCall && state.room && others().length <= 1) exitRoom();
    toast({ title: `${blockCtx.name} is blocked`, body: 'You won’t see each other again.' });
  });

  // In-call flag button: report (with "also block" ticked) covers both cases.
  $('#report-btn').addEventListener('click', () => {
    if (!state.room) return;
    const o = others();
    if (o.length === 1) return openReport({ target: o[0].id }, o[0].name, true);
    // Group: pick who from the people list (⋯ → Report).
    renderRoomDialog();
    openDialog('#room-dialog');
  });

  // Blocked people list (account menu)
  document.querySelectorAll('.blocked-btn').forEach((b) => b.addEventListener('click', async () => {
    closeMenus();
    const list = $('#blocked-list');
    list.textContent = '';
    $('#blocked-empty').hidden = true;
    openDialog('#blocked-dialog');
    try {
      const { blocks } = await api('GET', '/api/blocks');
      $('#blocked-empty').hidden = blocks.length > 0;
      for (const blk of blocks) {
        const li = document.createElement('li');
        const av = document.createElement('div');
        av.className = 'avatar avatar-sm';
        paintAvatar(av, blk.name, blk.avatar);
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = blk.name;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-ghost';
        btn.textContent = 'Unblock';
        btn.onclick = async () => {
          btn.disabled = true;
          try {
            await api('DELETE', `/api/blocks/${blk.id}`, {});
            li.remove();
            if (!list.children.length) $('#blocked-empty').hidden = false;
          } catch (err) {
            btn.disabled = false;
            toast({ title: 'Couldn’t unblock', body: err.message });
          }
        };
        li.append(av, name, btn);
        list.append(li);
      }
    } catch (err) {
      $('#blocked-empty').textContent = err.message;
      $('#blocked-empty').hidden = false;
    }
  }));

  // Chat
  function systemMessage(text) {
    const li = document.createElement('li');
    li.className = 'msg-system';
    li.textContent = text;
    $('#chat-log').append(li);
    li.scrollIntoView({ block: 'end' });
  }

  socket.on('chat', ({ from, name, text }) => {
    const li = document.createElement('li');
    li.className = 'msg' + (from === socket.id ? ' mine' : '');
    // In groups, show who said it.
    if (from !== socket.id && others().length > 1) {
      const who = document.createElement('span');
      who.className = 'msg-name';
      who.textContent = name;
      li.append(who);
    }
    li.append(text);
    $('#chat-log').append(li);
    li.scrollIntoView({ block: 'end', behavior: 'smooth' });
    if (from !== socket.id && !$('#chat-panel').hasAttribute('data-open') && getComputedStyle($('#chat-toggle')).display !== 'none') {
      unread++;
      $('#chat-dot').hidden = false;
    }
  });

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chat-input').value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    $('#chat-input').value = '';
  });

  $('#chat-toggle').addEventListener('click', () => {
    $('#chat-panel').toggleAttribute('data-open');
    unread = 0;
    $('#chat-dot').hidden = true;
  });
  $('#chat-close').addEventListener('click', () => $('#chat-panel').removeAttribute('data-open'));

  // ---------- Connection lifecycle ----------

  let everConnected = false;
  socket.on('connect', async () => {
    // First connect needs nothing; after a reconnect the server has a fresh, idle entry for us.
    if (!everConnected) { everConnected = true; return; }
    if (state.room) exitRoom('Connection lost');
    if (state.activity && document.querySelector('#screen-matches[data-active]')) {
      await emit('set-activity', { activity: state.activity });
    }
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') signedOut('Your session has expired. Please sign in again.');
    if (err.message === 'unverified' && state.user) showVerify(state.user);
  });

  // The server kicks our sockets when this session logs out (e.g. from another tab).
  socket.on('disconnect', (reason) => {
    if (reason === 'io server disconnect' && state.user) signedOut('You were signed out.');
  });

  // ---------- Startup ----------

  async function restoreSession() {
    try {
      onSignedIn((await api('GET', '/api/auth/me')).user);
    } catch {
      show('screen-auth');
    }
  }

  // Links from emails arrive as /?verify=TOKEN or /?reset=TOKEN. Tokens are only used after
  // the page runs (a POST), so email scanners that pre-open links can't burn them.
  (async () => {
    const params = new URLSearchParams(location.search);
    const verifyToken = params.get('verify');
    const resetToken = params.get('reset');
    if (verifyToken || resetToken) history.replaceState(null, '', location.pathname);

    if (resetToken) {
      state.resetToken = resetToken;
      show('screen-auth');
      return switchTab('reset');
    }
    if (verifyToken) {
      try {
        const res = await api('POST', '/api/auth/verify-email', { token: verifyToken });
        if (res.user) {
          onSignedIn(res.user);
          toast({ title: 'Email confirmed ✔', body: 'You’re all set. Start matching!' });
        } else {
          show('screen-auth');
          switchTab('login');
          toast({ title: 'Email confirmed ✔', body: 'Sign in to start matching.' });
        }
        return;
      } catch (err) {
        toast({ title: 'Couldn’t confirm email', body: err.message, timeout: 8000 });
      }
    }
    await restoreSession();
  })();
})();
