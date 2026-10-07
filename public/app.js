/* global io */
(() => {
  const $ = (sel) => document.querySelector(sel);
  // Connects only once signed in; the server rejects sockets without a session.
  const socket = io({ autoConnect: false });

  // One top bar (logo, Connects / Background / Friends, account menu) shared by the main pages,
  // and one friends block shared by the Friends page and the in-call friends dialog.
  document.querySelectorAll('[data-topbar]').forEach((h) => h.replaceWith($('#topbar-tpl').content.firstElementChild.cloneNode(true)));
  document.querySelectorAll('.friends-view').forEach((v) => v.append($('#friends-view-tpl').content.cloneNode(true)));
  const PAGES = { connects: 'screen-connects', background: 'screen-background', friends: 'screen-friends' };

  const state = {
    user: null, // own account, from /api/auth/me
    pendingAvatar: null, // photo chosen on the sign-up form
    activity: '',
    searching: false, // the server has us in live matching (re-sent after a reconnect)
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
    const page = Object.keys(PAGES).find((k) => PAGES[k] === screenId);
    // Leaving a page some other way (a call, the logo, signing out): drop its #page URL.
    if (!page && PAGES[location.hash.slice(1)]) history.replaceState(null, '', location.pathname + location.search);
    document.querySelectorAll('.screen').forEach((s) => s.toggleAttribute('data-active', s.id === screenId));
    // Highlight the current page in the top menu.
    document.querySelectorAll('.nav-btn').forEach((b) => {
      if (b.dataset.page === page) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
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
    // A link or reload to /#connects, /#background or /#friends opens that page.
    const page = location.hash.slice(1);
    if (PAGES[page]) {
      show('screen-activity');
      history.replaceState(null, '', location.pathname);
      return openPage(page);
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
    state.searching = true;
    $('#my-activity').textContent = activity;
    clearIncoming();
    renderMatches([]);
    show('screen-matches');
  });

  // The logo takes you back to the main page ("What are you doing right now?").
  document.querySelectorAll('a.brand-sm').forEach((logo) => logo.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.room || !state.user) return;
    // Leaving the matches (from that screen or from a page on top of it) stops live matching.
    if (state.searching) {
      socket.emit('stop-searching');
      state.searching = false;
      clearIncoming();
    }
    $('#activity-input').value = state.activity;
    show('screen-activity');
    $('#activity-input').focus();
  }));

  $('#change-activity-btn').addEventListener('click', () => {
    socket.emit('stop-searching');
    state.searching = false;
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
    // With one, the server puts you back in live matching.
    state.searching = !!state.activity;
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

    const note = $('#friends-call-note');
    note.hidden = !state.room;
    if (state.room) {
      note.textContent = state.room.isHost || !state.room.hostId
        ? 'Invite friends to this call. As the host, anyone you invite joins as soon as they accept.'
        : 'Invite friends to this call. You’re not the host, so the host approves anyone you invite.';
    }
    document.querySelectorAll('.friends-view').forEach((view) => fillFriends(view, friends, requests));
  }

  function fillFriends(view, friends, requests) {
    const reqList = view.querySelector('.friend-requests');
    reqList.textContent = '';
    view.querySelector('.friend-requests-section').hidden = !requests.length;
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

    const list = view.querySelector('.friend-list');
    list.textContent = '';
    view.querySelector('.friends-empty').hidden = friends.length > 0 || requests.length > 0;
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
          if ($('#friends-dialog').open) $('#friends-dialog').close();
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

  document.querySelectorAll('.room-friends-btn').forEach((b) => b.addEventListener('click', () => {
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

  // ---------- Pages: Connects, Background, Friends ----------

  // Each page gets a #name URL, so the browser's back button leaves it.
  let pageReturnTo = 'screen-activity';
  const pageScreens = Object.values(PAGES);

  function openPage(name) {
    if (!PAGES[name] || state.room) return;
    const current = document.querySelector('.screen[data-active]')?.id;
    const fromPage = pageScreens.includes(current);
    if (!fromPage) pageReturnTo = current === 'screen-matches' ? 'screen-matches' : 'screen-activity';
    if (location.hash !== `#${name}`) {
      if (fromPage) history.replaceState({ page: name }, '', `#${name}`);
      else history.pushState({ page: name }, '', `#${name}`);
    }
    renderPage(name);
    show(PAGES[name]);
  }

  function renderPage(name) {
    if (name === 'background') renderBgPage();
    else if (name === 'connects') renderConnects();
    else if (name === 'friends') renderFriends();
  }

  window.addEventListener('popstate', () => {
    const name = location.hash.slice(1);
    if (PAGES[name] && state.user?.emailVerified && !state.room) {
      renderPage(name);
      show(PAGES[name]);
    } else if (pageScreens.includes(document.querySelector('.screen[data-active]')?.id)) {
      show(pageReturnTo);
    }
  });

  // Top menu buttons (and any other [data-page] button) open their page.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b) return;
    closeMenus();
    openPage(b.dataset.page);
  });

  // ---------- Background searches ----------

  state.inbox = {
    searches: [], maxSearches: 3, maxSlots: 3, notifyEmail: true,
    connects: { answer: [], ready: [], scheduled: [], waiting: [], recent: [] },
  };
  let shownAwaySummary = false;
  let selectedSearch = null; // the topic bubble that's open
  let editingSearch = null; // search being edited in the dialog (null = new)

  function untilText(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  const short = (t, n = 28) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const allMatches = () => state.inbox.searches.flatMap((x) => x.matches);
  const matchedPeople = () => new Set(allMatches().map((m) => m.person.id)).size;

  // The entry card on the main screen, the Background button's count, and the matches screen button.
  function renderBgControls() {
    const { searches } = state.inbox;
    const total = matchedPeople();
    $('#bg-entry').toggleAttribute('data-on', !!searches.length);
    $('#bg-entry-sub').textContent = !searches.length
      ? 'Keep looking after you close the tab'
      : searches.length === 1
        ? `“${short(searches[0].activity, 32)}” · ${plural(searches[0].matches.length, 'match', 'matches')}`
        : `${searches.length} running · ${plural(total, 'match', 'matches')}`;
    const fresh = new Set(allMatches().filter((m) => m.new).map((m) => m.person.id)).size;
    $('#bg-entry-badge').textContent = fresh;
    $('#bg-entry-badge').hidden = !fresh;

    // Top menu: a green dot while a search runs, with the number of people matched once there are any.
    document.querySelectorAll('.bg-top-btn').forEach((b) => {
      const dot = b.querySelector('.bg-top-dot');
      dot.hidden = !searches.length;
      dot.textContent = total ? (total > 99 ? '99+' : total) : '';
      dot.toggleAttribute('data-count', !!total);
      b.title = !searches.length ? 'Background searches'
        : `Background searches · ${searches.length} running · ${plural(total, 'person', 'people')} matched`;
    });

    const btn = $('#bg-btn');
    btn.toggleAttribute('data-on', !!searches.length);
    $('#bg-btn-label').textContent = searches.length ? `Background searches (${searches.length})` : 'Search in background';
    // The empty-state offer is hidden once this exact activity is already searched in the background.
    const covered = searches.some((x) => x.activity.toLowerCase() === state.activity.toLowerCase());
    $('#bg-empty-btn').hidden = covered;
    $('#bg-empty-hint').hidden = covered;
  }

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
  $('#bg-entry').addEventListener('click', () => openPage('background'));
  $('#bg-btn').addEventListener('click', () => (state.inbox.searches.length ? openPage('background') : openBgDialog()));
  $('#bg-empty-btn').addEventListener('click', () => openBgDialog());
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
    selectedSearch = res.id;
    toast({
      title: editingSearch ? 'Background search updated' : 'Background search on',
      body: `Looking for “${res.activity}” until ${untilText(res.expiresAt)}, even after you close Connecto.`,
      actions: document.querySelector('#screen-background[data-active]') ? undefined : [{ label: 'View', cls: 'btn-primary', onClick: (el) => { dismiss(el); openPage('background'); } }],
    });
  });
  async function stopSearch(search) {
    await emit('bg-stop', { id: search.id });
    toast({ title: 'Background search stopped', body: `“${short(search.activity, 40)}”`, timeout: 2500 });
  }
  $('#bg-stop').addEventListener('click', async () => {
    if (editingSearch) await stopSearch(editingSearch);
    $('#bg-dialog').close();
  });
  $('#bg-notify').addEventListener('change', (e) => { if (state.inbox.searches.length) emit('notify-email', { on: e.target.checked }); });

  const currentSearch = () => state.inbox.searches.find((x) => x.id === selectedSearch);
  $('#bg-panel-edit').addEventListener('click', () => currentSearch() && openBgDialog(currentSearch()));
  $('#bg-panel-stop').addEventListener('click', () => currentSearch() && stopSearch(currentSearch()));

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

  // A background match, drawn like a live match card. People you're already in touch with
  // get a link to Connects instead of a second set of buttons.
  function bgMatchCard(m, search) {
    const p = m.person;
    const card = personCard({ ...p, activity: m.activity, score: m.score, interests: p.interests || [] });
    card.classList.add('bg-match');
    const av = card.querySelector('.avatar');
    av.classList.add('presence');
    av.dataset.status = p.status;
    if (m.new) card.querySelector('.match-name').append(newTag());
    card.querySelector('.match-meta').textContent = [statusLine(p), `found ${ago(m.foundAt)}`, metaLine(p)].filter(Boolean).join(' · ');
    card.querySelector('.card-more').hidden = true;
    const cta = card.querySelector('.match-cta');
    delete card.dataset.state;
    let action;
    if (m.request) {
      card.dataset.state = 'connected';
      cta.textContent = '✓ In Connects · chat →';
      action = () => openChat(p.id);
    } else {
      cta.textContent = p.status === 'offline' ? 'Send request · they’ll see it later' : 'Send request →';
      action = async () => {
        cta.textContent = 'Sending…';
        const res = await emit('connect-request', { accountId: p.id, searchId: search.id });
        if (res.error) toast({ title: 'Couldn’t send request', body: res.error });
      };
    }
    const hit = card.querySelector('.match-hit');
    const fresh = hit.cloneNode(false); // drop the live-match click handler
    hit.replaceWith(fresh);
    fresh.setAttribute('aria-label', `${cta.textContent}: ${p.name}, ${m.activity}`);
    fresh.addEventListener('click', action);
    return card;
  }

  // One bubble per search topic; the selected one shows its matches below.
  function renderBgPage() {
    const { searches } = state.inbox;
    if (!searches.some((x) => x.id === selectedSearch)) selectedSearch = searches[0]?.id ?? null;
    const box = $('#bg-bubbles');
    box.textContent = '';
    for (const x of searches) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'bubble';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(x.id === selectedSearch));
      const dot = document.createElement('span');
      dot.className = 'bgp-dot';
      const label = document.createElement('span');
      label.className = 'bubble-label';
      label.textContent = x.activity;
      const count = document.createElement('span');
      count.className = 'bubble-count';
      count.textContent = x.matches.length;
      count.title = plural(x.matches.length, 'match', 'matches');
      b.append(dot, label, count);
      if (x.matches.some((m) => m.new)) b.append(newTag());
      b.addEventListener('click', () => { selectedSearch = x.id; renderBgPage(); });
      box.append(b);
    }
    box.hidden = !searches.length;
    $('#bgp-empty').hidden = !!searches.length;
    $('#bgp-notify').checked = !!state.inbox.notifyEmail;

    const x = currentSearch();
    $('#bg-panel').hidden = !x;
    if (!x) return;
    $('#bg-panel-title').textContent = `“${x.activity}”`;
    $('#bg-panel-detail').textContent = `${plural(x.matches.length, 'match', 'matches')} · started ${ago(x.startedAt)} · until ${untilText(x.expiresAt)} (${timeLeft(x.expiresAt)})`;
    const grid = $('#bg-panel-grid');
    grid.textContent = '';
    for (const m of x.matches) grid.append(bgMatchCard(m, x));
    $('#bg-panel-none').hidden = !!x.matches.length;
  }

  // ---------- Connects ----------

  const JOIN_EARLY_MS = 10 * 60 * 1000;

  // "Tue, Oct 7, 7:00 PM (9:00 PM their time)"
  function whenText(ms, p) {
    const d = new Date(ms);
    const mine = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (!p?.timezone || p.timezone === MY_TZ) return mine;
    try {
      return `${mine} (${new Intl.DateTimeFormat([], { timeZone: p.timezone, hour: 'numeric', minute: '2-digit' }).format(d)} their time)`;
    } catch {
      return mine;
    }
  }

  function inText(ms) {
    const min = Math.round((ms - Date.now()) / 60000);
    if (min <= 0) return 'now';
    if (min < 60) return `in ${min} min`;
    const h = Math.round(min / 60);
    return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)} days`;
  }

  // Connects badge: requests and time suggestions to answer, meetings about to start, unread messages.
  const connectsUrgent = () => {
    const cx = state.inbox.connects;
    return cx.answer.length + cx.scheduled.filter((r) => r.meetingAt - Date.now() < JOIN_EARLY_MS).length + unreadTotal();
  };

  async function callBack(person, joining = false) {
    const res = await emit('connect-call', { accountId: person.id });
    if (res.error) {
      if (joining && /not online/.test(res.error)) {
        return toast({ title: `${person.name} isn’t here yet`, body: 'Keep Connecto open. You’ll get a call as soon as they tap Join.', timeout: 6000 });
      }
      return toast({ title: 'Couldn’t call', body: res.error });
    }
    if (!res.matched) toast({ title: `Calling ${person.name}…`, body: 'You’ll join as soon as they pick up.', timeout: 3500 });
  }

  async function acceptConnect(id, person) {
    const res = await emit('connect-respond', { id, accept: true });
    if (res.error) toast({ title: 'Couldn’t accept', body: res.error });
    else toast({ title: `You and ${person.name} both want to connect 🎉`, body: person.status === 'offline' ? 'They’re offline. Propose a time under Ready to talk.' : 'They’re online now. Tap Call now.' });
  }

  // ---------- Connects: sidebar + conversations (like Discord DMs) ----------

  // Sidebar sections, top to bottom. Each person shows once, in the first section that has them.
  const SECTIONS = [
    { key: 'answer', title: 'Needs your answer' },
    { key: 'scheduled', title: 'Scheduled' },
    { key: 'people', title: 'Direct messages' },
    { key: 'waiting', title: 'Waiting on them' },
  ];
  let selectedChat = null; // accountId of the open conversation
  const dms = new Map(); // accountId -> { messages, more, loaded, loading, seenAt }
  const myId = () => state.user?.id;
  const isDesktop = () => window.matchMedia('(min-width: 761px)').matches;
  // The conversation with `id` is on screen (on phones the list and the chat take turns).
  const chatVisible = (id) => selectedChat === id && !!document.querySelector('#screen-connects[data-active]')
    && (isDesktop() || $('#dc').dataset.view === 'chat');
  const typingFrom = new Map(); // accountId -> timer for "is typing…"

  // Everything we know about one person in Connects.
  function entryFor(id) {
    const cx = state.inbox.connects;
    const find = (list) => list.find((x) => x.person.id === id) || null;
    const e = {
      answer: find(cx.answer), scheduled: find(cx.scheduled), waiting: find(cx.waiting),
      ready: find(cx.ready), dm: find(cx.people || []),
    };
    e.person = (e.dm || e.answer || e.scheduled || e.waiting || e.ready)?.person || null;
    e.canChat = !!e.dm;
    return e;
  }

  // Sidebar sections with each person once.
  function sections() {
    const cx = state.inbox.connects;
    const seen = new Set();
    const take = (list) => list.filter((x) => !seen.has(x.person.id) && seen.add(x.person.id));
    return {
      answer: take(cx.answer),
      scheduled: take(cx.scheduled),
      people: take(cx.people || []),
      waiting: take(cx.waiting),
    };
  }

  const unreadTotal = () => (state.inbox.connects.people || []).reduce((n, p) => n + p.unread, 0);

  function subtitle(key, it) {
    if (key === 'answer') return it.kind === 'times' ? '📅 Suggested times · pick one' : `Wants to connect${it.activity ? ` · “${short(it.activity, 30)}”` : ''}`;
    if (key === 'scheduled') return `📅 ${new Date(it.meetingAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${inText(it.meetingAt)}`;
    if (key === 'waiting') return it.kind === 'times' ? 'You suggested times' : 'Request sent';
    const typing = typingFrom.has(it.person.id);
    if (typing) return 'typing…';
    if (it.last) return `${it.last.mine ? 'You: ' : ''}${it.last.body.replace(/\s+/g, ' ')}`;
    if (it.person.doing) return `${it.person.status === 'in-call' ? 'In a call' : 'Matching on'} “${short(it.person.doing, 30)}”`;
    return 'Say hi 👋';
  }

  function renderSidebar() {
    const groups = sections();
    const q = $('#dc-filter').value.trim().toLowerCase();
    const nav = $('#dc-cats');
    nav.textContent = '';
    let any = false;
    for (const { key, title } of SECTIONS) {
      const items = groups[key].filter((it) => !q || it.person.name.toLowerCase().includes(q));
      if (!items.length) continue;
      any = true;
      const sec = document.createElement('section');
      sec.className = 'dc-cat';
      sec.dataset.key = key;
      const h = document.createElement('h4');
      h.textContent = `${title} — ${items.length}`;
      const ul = document.createElement('ul');
      for (const it of items) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dc-item';
        if (it.person.id === selectedChat) b.setAttribute('aria-current', 'true');
        const av = document.createElement('div');
        av.className = 'avatar avatar-sm presence';
        paintAvatar(av, it.person.name, it.person.avatar);
        av.dataset.status = it.person.status;
        const text = document.createElement('span');
        text.className = 'dc-item-text';
        const name = document.createElement('strong');
        name.textContent = it.person.name;
        const sub = document.createElement('span');
        sub.textContent = subtitle(key, it);
        if (typingFrom.has(it.person.id) && key === 'people') sub.className = 'dc-typing-sub';
        text.append(name, sub);
        b.append(av, text);
        const unread = key === 'people' ? it.unread : 0;
        if (unread) {
          b.dataset.unread = '';
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = unread > 99 ? '99+' : unread;
          b.append(badge);
        } else if (it.new) {
          b.append(newTag());
        }
        b.addEventListener('click', () => openChat(it.person.id));
        li.append(b);
        ul.append(li);
      }
      sec.append(h, ul);
      nav.append(sec);
    }
    $('#dc-side-empty').hidden = any || !!q;
  }
  $('#dc-filter').addEventListener('input', renderSidebar);

  // Open someone's conversation (from anywhere: a toast, a match card, the sidebar).
  function openChat(id) {
    selectedChat = id;
    $('#dc').dataset.view = 'chat';
    if (!document.querySelector('#screen-connects[data-active]')) openPage('connects');
    else renderConnects();
    $('#dc-input').value = '';
    if (entryFor(id).canChat) {
      loadHistory(id);
      if (isDesktop()) $('#dc-input').focus();
    }
  }
  $('#dc-back').addEventListener('click', () => { $('#dc').dataset.view = 'list'; });

  function renderConnects() {
    renderSidebar();
    const e = selectedChat ? entryFor(selectedChat) : null;
    // Desktop, on this page: open the most relevant conversation by default.
    if (!e?.person && isDesktop() && document.querySelector('#screen-connects[data-active]')) {
      const g = sections();
      const first = g.answer[0] || g.scheduled[0] || g.people[0] || g.waiting[0];
      if (first) {
        selectedChat = first.person.id;
        if (entryFor(selectedChat).canChat) loadHistory(selectedChat);
        return renderConnects();
      }
    }
    $('#dc-blank').hidden = !!e?.person;
    $('#dc-convo').hidden = !e?.person;
    if (!e?.person) {
      if ($('#dc').dataset.view === 'chat') $('#dc').dataset.view = 'list';
      return;
    }
    renderConvoHead(e);
    renderBanner(e);
    renderIntro(e);
    renderMessages();
    $('#dc-compose').hidden = !e.canChat;
    $('#dc-locked').hidden = e.canChat;
    $('#dc-locked').textContent = e.answer?.kind === 'request'
      ? `Accept ${e.person.name}’s request to start chatting.`
      : `You can message ${e.person.name} once they accept your request.`;
    $('#dc-input').placeholder = `Message ${e.person.name}`;
  }

  function iconButton(label, svgPath, cls, onClick) {
    const b = button('', cls, onClick);
    b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="${svgPath}"/></svg><span class="dc-act-label"></span>`;
    b.querySelector('.dc-act-label').textContent = label;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  }
  const ICON_CALL = 'M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8Z';
  const ICON_CAL = 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm12 18H5V9h14v11Z';
  const ICON_ADD = 'M15 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6Zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z';
  const ICON_MORE = 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z';

  function renderConvoHead(e) {
    const p = e.person;
    const av = $('#dc-avatar');
    paintAvatar(av, p.name, p.avatar);
    av.dataset.status = p.status;
    $('#dc-name').textContent = p.name;
    $('#dc-status').textContent = [
      statusLine(p),
      p.doing && `${p.status === 'in-call' ? 'in a call' : 'matching on'} “${short(p.doing, 40)}”`,
      metaLine(p),
    ].filter(Boolean).join(' · ');
    const box = $('#dc-actions');
    box.textContent = '';
    if (e.canChat) {
      const call = iconButton('Call', ICON_CALL, 'btn btn-ghost dc-act', () => callBack(p));
      call.disabled = !e.dm.available || !!state.room;
      if (!e.dm.available) call.title = `${p.name} is offline. Plan a time instead.`;
      const plan = iconButton(e.scheduled ? 'Reschedule' : 'Plan a time', ICON_CAL, 'btn btn-ghost dc-act', () => openPropose(e.scheduled || e.ready || e.waiting?.kind === 'times' && e.waiting || { person: p }));
      box.append(call, plan);
      if (!e.dm.friend) {
        box.append(iconButton('Add friend', ICON_ADD, 'btn btn-ghost dc-act', async (ev) => {
          ev.currentTarget.disabled = true;
          const res = await emit('friend-request', { accountId: p.id });
          if (res.error) return toast({ title: 'Couldn’t add friend', body: res.error });
          toast(res.status === 'friends'
            ? { title: `You and ${p.name} are now friends 🎉` }
            : { title: 'Friend request sent', body: `If ${p.name} adds you too, you’ll be friends.`, timeout: 3000 });
        }));
      }
    }
    const more = iconButton('More', ICON_MORE, 'btn btn-ghost dc-act dc-more', (ev) => {
      ev.stopPropagation();
      openCardMenu(ev.currentTarget, { id: `acct-${p.id}`, name: p.name }, { accountId: p.id });
    });
    box.append(more);
  }

  // What's going on with this person: a request, suggested times, a meeting.
  function renderBanner(e) {
    const box = $('#dc-banner');
    box.textContent = '';
    const p = e.person;
    const line = (text) => { const el = document.createElement('p'); el.textContent = text; box.append(el); return el; };
    const actions = (...btns) => { const d = document.createElement('div'); d.className = 'dc-banner-actions'; d.append(...btns); box.append(d); };
    const propose = (label, cls, item) => button(label, cls, () => openPropose(item));
    const unschedule = (label, id) => button(label, 'btn btn-ghost bgp-stop', () => emit('connect-unschedule', { id }));
    box.dataset.tone = '';
    if (e.answer?.kind === 'request') {
      box.dataset.tone = 'accent';
      line([`${p.name} wants to connect`, e.answer.activity && `“${e.answer.activity}”`, ago(e.answer.at)].filter(Boolean).join(' · '));
      actions(
        button('Decline', 'btn btn-ghost', () => emit('connect-respond', { id: e.answer.id, accept: false })),
        button('Accept', 'btn btn-good', () => acceptConnect(e.answer.id, p)),
      );
    } else if (e.answer) {
      box.dataset.tone = 'accent';
      line(`${p.name} suggested ${e.answer.proposal.slots.length === 1 ? 'a time' : 'some times'} to talk. Pick one:`);
      actions(
        ...e.answer.proposal.slots.map((t) => button(whenText(t, p), 'btn btn-good', async () => {
          const res = await emit('connect-pick', { id: e.answer.id, slot: t });
          if (res.error) toast({ title: 'Couldn’t pick that time', body: res.error });
          else toast({ title: `Meeting set with ${p.name} 📅`, body: `${whenText(t, p)}. We’ll remind you both 10 minutes before.` });
        })),
        propose('Suggest another time', 'btn btn-ghost', e.answer),
      );
    } else if (e.scheduled) {
      box.dataset.tone = 'good';
      const open = e.scheduled.meetingAt - Date.now() < JOIN_EARLY_MS;
      line(`📅 Meeting ${whenText(e.scheduled.meetingAt, p)} · ${inText(e.scheduled.meetingAt)}`).className = 'dc-banner-strong';
      const join = button(open ? 'Join' : 'Join opens 10 min before', open ? 'btn btn-good' : 'btn btn-ghost', () => callBack(p, true));
      join.disabled = !open || !!state.room;
      actions(join, propose('Reschedule', 'btn btn-ghost', e.scheduled), unschedule('Cancel meeting', e.scheduled.id));
    } else if (e.waiting?.kind === 'times') {
      line(`You suggested: ${e.waiting.proposal.slots.map((t) => whenText(t, p)).join(' · ')}. Waiting for ${p.name} to pick.`);
      actions(propose('Change times', 'btn btn-ghost', e.waiting), unschedule('Withdraw', e.waiting.id));
    } else if (e.waiting) {
      line(`Request sent ${ago(e.waiting.at)}. You can chat once ${p.name} accepts.`);
      actions(button('Cancel request', 'btn btn-ghost', () => emit('connect-cancel', { id: e.waiting.id })));
    }
    box.hidden = !box.childElementCount;
  }

  // Top of the conversation: who they are (like Discord's "beginning of your conversation").
  function renderIntro(e) {
    const p = e.person;
    const box = $('#dc-intro');
    box.textContent = '';
    const av = document.createElement('div');
    av.className = 'avatar avatar-lg';
    paintAvatar(av, p.name, p.avatar);
    const h = document.createElement('h3');
    h.textContent = p.name;
    if (e.dm?.friend) {
      const f = document.createElement('span');
      f.className = 'pill-friend';
      f.textContent = 'Friend';
      h.append(' ', f);
    }
    const info = document.createElement('p');
    const since = e.dm?.since;
    info.textContent = e.canChat
      ? (since ? `You connected ${ago(since)}. This is the start of your conversation.` : 'This is the start of your conversation.')
      : [metaLine(p)].filter(Boolean).join(' · ');
    box.append(av, h, info);
    if (p.bio) {
      const bio = document.createElement('p');
      bio.className = 'dc-intro-bio';
      bio.textContent = p.bio;
      box.append(bio);
    }
    if (p.interests?.length) {
      const chips = document.createElement('div');
      chips.className = 'mini-chips';
      for (const i of p.interests) {
        const c = document.createElement('span');
        c.className = 'mini-chip';
        c.textContent = i;
        chips.append(c);
      }
      box.append(chips);
    }
  }

  async function loadHistory(id, older = false) {
    const d = dms.get(id) || { messages: [], more: false, loaded: false, loading: false, seenAt: 0 };
    dms.set(id, d);
    if (d.loading || (d.loaded && !older)) {
      if (d.loaded) markRead(id);
      return renderMessages();
    }
    d.loading = true;
    const res = await emit('dm-history', { with: id, before: older ? d.messages[0]?.id : undefined });
    d.loading = false;
    if (res.error) return;
    const scroller = $('#dc-scroll');
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    const known = new Set(d.messages.map((m) => m.id));
    d.messages = [...res.messages.filter((m) => !known.has(m.id)), ...d.messages].sort((a, b) => a.id - b.id);
    d.more = res.more;
    d.loaded = true;
    const lastMineRead = [...d.messages].reverse().find((m) => m.from === myId() && m.read);
    if (lastMineRead) d.seenAt = Math.max(d.seenAt, lastMineRead.at);
    if (selectedChat === id) {
      renderMessages(older ? null : 'bottom');
      if (older) scroller.scrollTop = scroller.scrollHeight - fromBottom; // keep your place
      markRead(id);
    }
  }
  $('#dc-older').addEventListener('click', () => selectedChat && loadHistory(selectedChat, true));

  function markRead(id) {
    const p = (state.inbox.connects.people || []).find((x) => x.person.id === id);
    if (p?.unread && document.visibilityState === 'visible' && chatVisible(id)) {
      socket.emit('dm-read', { with: id });
    }
  }
  document.addEventListener('visibilitychange', () => { if (selectedChat) markRead(selectedChat); });

  const dayLabel = (ms) => {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  };

  // Messages grouped like Discord: a new group when the sender changes or 5+ minutes pass.
  function renderMessages(scroll = null) {
    const box = $('#dc-messages');
    const scroller = $('#dc-scroll');
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    box.textContent = '';
    const d = selectedChat && dms.get(selectedChat);
    $('#dc-older').hidden = !d?.more;
    if (!d || !entryFor(selectedChat).canChat) return;
    const other = entryFor(selectedChat).person;
    const me = state.user;
    let prev = null;
    let group = null;
    for (const m of d.messages) {
      if (!prev || new Date(prev.at).toDateString() !== new Date(m.at).toDateString()) {
        const sep = document.createElement('div');
        sep.className = 'dc-day';
        sep.textContent = dayLabel(m.at);
        box.append(sep);
        prev = null;
      }
      if (!prev || prev.from !== m.from || m.at - prev.at > 5 * 60 * 1000) {
        group = document.createElement('div');
        group.className = 'dc-group';
        const mine = m.from === me.id;
        const av = document.createElement('div');
        av.className = 'avatar avatar-sm';
        const name = mine ? (me.displayName || me.firstName) : other.name;
        paintAvatar(av, name, mine ? me.avatar : other.avatar);
        const body = document.createElement('div');
        body.className = 'dc-group-body';
        const head = document.createElement('p');
        head.className = 'dc-group-head';
        const n = document.createElement('strong');
        n.textContent = mine ? 'You' : other.name;
        const t = document.createElement('time');
        t.textContent = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        head.append(n, t);
        body.append(head);
        group.append(av, body);
        box.append(group);
      }
      const p = document.createElement('p');
      p.className = 'dc-msg';
      p.textContent = m.body;
      p.title = new Date(m.at).toLocaleString();
      group.lastChild.append(p);
      prev = m;
    }
    // "Seen" under your last message once they've read it.
    const last = d.messages.at(-1);
    if (last && last.from === me.id && d.seenAt >= last.at) {
      const seen = document.createElement('p');
      seen.className = 'dc-seen';
      seen.textContent = 'Seen';
      box.append(seen);
    }
    if (scroll === 'bottom' || atBottom) scroller.scrollTop = scroller.scrollHeight;
  }

  // Composer: Enter sends, Shift+Enter adds a line.
  const input = $('#dc-input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  let lastTypingPing = 0;
  input.addEventListener('input', () => {
    autosize();
    if (selectedChat && Date.now() - lastTypingPing > 3000) {
      lastTypingPing = Date.now();
      socket.emit('dm-typing', { to: selectedChat });
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#dc-compose').requestSubmit();
    }
  });
  $('#dc-compose').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body || !selectedChat) return;
    input.value = '';
    autosize();
    lastTypingPing = 0;
    const res = await emit('dm-send', { to: selectedChat, body });
    if (res.error) {
      input.value = body;
      autosize();
      toast({ title: 'Message not sent', body: res.error });
    }
  });

  // Live messages (also echoed to your own other tabs).
  socket.on('dm', (m) => {
    const other = m.from === myId() ? m.to : m.from;
    const d = dms.get(other);
    if (d?.loaded && !d.messages.some((x) => x.id === m.id)) d.messages.push(m);
    if (m.from === other) {
      typingFrom.delete(other);
      if (selectedChat === other) $('#dc-typing').textContent = '';
    }
    if (chatVisible(other)) {
      renderMessages(m.from === myId() ? 'bottom' : null);
      if (m.from === other && document.visibilityState === 'visible') socket.emit('dm-read', { with: other });
    } else if (m.from === other) {
      const el = toast({
        title: m.fromName,
        body: m.body.length > 140 ? `${m.body.slice(0, 139)}…` : m.body,
        avatarOf: { name: m.fromName, avatar: m.fromAvatar },
        timeout: 8000,
        actions: [{ label: 'Reply', cls: 'btn-primary', onClick: () => { dismiss(el); openChat(other); } }],
      });
    }
  });

  socket.on('dm-read', ({ by, at }) => {
    const d = dms.get(by);
    if (!d) return;
    d.seenAt = Math.max(d.seenAt, at);
    if (selectedChat === by) renderMessages();
  });

  socket.on('dm-typing', ({ from }) => {
    clearTimeout(typingFrom.get(from));
    typingFrom.set(from, setTimeout(() => {
      typingFrom.delete(from);
      if (selectedChat === from) $('#dc-typing').textContent = '';
      renderSidebar();
    }, 4500));
    if (selectedChat === from) {
      const p = entryFor(from).person;
      $('#dc-typing').textContent = p ? `${p.name} is typing…` : '';
    }
    renderSidebar();
  });

  // Countdowns and the Join button move with the clock.
  setInterval(() => {
    renderBadges();
    if (document.querySelector('#screen-connects[data-active]') && selectedChat) {
      const e = entryFor(selectedChat);
      if (e.person) renderBanner(e);
      renderSidebar();
    }
  }, 30 * 1000);

  // ---------- Propose a time ----------

  let proposing = null;
  const toLocalInput = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  function addSlot(ms) {
    const row = document.createElement('div');
    row.className = 'slot-row';
    const input = document.createElement('input');
    input.type = 'datetime-local';
    input.min = toLocalInput(Date.now());
    input.value = toLocalInput(ms);
    const hint = document.createElement('span');
    hint.className = 'slot-hint';
    const update = () => {
      const t = new Date(input.value).getTime();
      hint.textContent = Number.isFinite(t) && proposing ? whenText(t, proposing.person) : '';
    };
    input.addEventListener('input', update);
    const remove = button('✕', 'icon-btn', () => { row.remove(); renderSlotControls(); });
    remove.setAttribute('aria-label', 'Remove this time');
    row.append(input, remove, hint);
    $('#propose-slots').append(row);
    update();
    renderSlotControls();
  }

  function renderSlotControls() {
    const rows = $('#propose-slots').children;
    $('#propose-add').hidden = rows.length >= state.inbox.maxSlots;
    for (const r of rows) r.querySelector('.icon-btn').hidden = rows.length === 1;
  }

  function openPropose(item) {
    proposing = item;
    const p = item.person;
    $('#propose-title').textContent = `Propose a time to ${p.name}`;
    $('#propose-intro').textContent = `Suggest up to ${state.inbox.maxSlots} times. ${p.name} picks one, and you both get a reminder 10 minutes before.`
      + (p.timezone && p.timezone !== MY_TZ ? ' Times are in your time zone; theirs is shown under each.' : '');
    $('#propose-slots').textContent = '';
    const nextHour = Math.ceil(Date.now() / 3600000) * 3600000 + 3600000;
    const existing = item.proposal?.mine ? item.proposal.slots : item.meetingAt ? [item.meetingAt] : [];
    (existing.length ? existing : [nextHour]).forEach(addSlot);
    openDialog('#propose-dialog');
  }
  $('#propose-add').addEventListener('click', () => {
    const inputs = [...$('#propose-slots').querySelectorAll('input')];
    const last = new Date(inputs.at(-1)?.value).getTime();
    addSlot((Number.isFinite(last) ? last : Date.now()) + 24 * 3600000);
  });
  $('#propose-go').addEventListener('click', async () => {
    const slots = [...$('#propose-slots').querySelectorAll('input')].map((i) => new Date(i.value).getTime()).filter(Number.isFinite);
    // Someone you're connected with but have no open request with: plan by account.
    const res = await emit('connect-propose', proposing.id ? { id: proposing.id, slots } : { accountId: proposing.person.id, slots });
    if (res.error) { $('#propose-dialog .form-error').textContent = res.error; return; }
    $('#propose-dialog').close();
    toast({ title: 'Times sent', body: `${proposing.person.name} will pick one. We’ll let you know.`, timeout: 3500 });
  });

  // ---------- Inbox updates & notifications ----------

  function renderBadges() {
    const n = connectsUrgent();
    document.querySelectorAll('.connects-badge').forEach((b) => { b.textContent = n > 99 ? '99+' : n; b.hidden = !n; });
    document.title = n ? `(${n}) Connecto` : 'Connecto';
  }

  function renderInbox() {
    renderBgControls();
    renderBadges();
    renderBgPage();
    renderConnects();
  }

  socket.on('inbox', (payload) => {
    state.inbox = payload;
    // First load after coming back: tell them what happened while they were away.
    if (!shownAwaySummary) {
      shownAwaySummary = true;
      const cx = payload.connects;
      const n = cx.answer.length;
      const r = cx.ready.filter((x) => x.new).length;
      const fresh = payload.searches.find((x) => x.matches.some((y) => y.new));
      const m = new Set(allMatches().filter((x) => x.new).map((x) => x.person.id)).size;
      if (fresh) selectedSearch = fresh.id;
      if (n || r || m) {
        const el = toast({
          title: 'While you were away',
          body: [
            n && `${n} ${n === 1 ? 'connect needs' : 'connects need'} your answer`,
            r && `${r} accepted your request`,
            m && `${m} new background ${m === 1 ? 'match' : 'matches'}`,
          ].filter(Boolean).join(' · '),
          timeout: 12000,
          actions: [{ label: 'View', cls: 'btn-primary', onClick: () => { dismiss(el); openPage(n || r ? 'connects' : 'background'); } }],
        });
      }
    }
    renderInbox();
  });
  socket.on('disconnect', () => { shownAwaySummary = false; });

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
          if (!res.error) toast({ title: `You and ${from.name} both want to connect 🎉`, body: 'Call now or set a time under Connects.' });
        } },
      ],
    });
  });

  socket.on('connect-accepted', ({ accountId, name }) => {
    const el = toast({
      title: `${name} accepted your request 🎉`,
      body: 'You both want to connect. Call now, or set a time under Connects.',
      timeout: 20000,
      actions: [
        { label: 'Message', onClick: () => { dismiss(el); openChat(accountId); } },
        { label: 'Call now', cls: 'btn-good', onClick: async () => {
          dismiss(el);
          const res = await emit('connect-call', { accountId });
          if (res.error) toast({ title: 'Couldn’t call', body: res.error });
        } },
      ],
    });
  });

  // The other side proposed times, picked one, or called it off.
  socket.on('connect-update', ({ kind, name, at }) => {
    const copy = {
      proposed: [`${name} suggested times to meet`, 'Pick the one that works for you.'],
      scheduled: [`${name} picked a time 📅`, at ? `${new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. We’ll remind you 10 minutes before.` : ''],
      unscheduled: [`${name} cancelled the planned time`, 'You can still call when you’re both online, or propose another time.'],
    }[kind];
    if (!copy) return;
    const el = toast({
      title: copy[0], body: copy[1], timeout: 10000,
      actions: [{ label: 'Open Connects', cls: 'btn-primary', onClick: () => { dismiss(el); openPage('connects'); } }],
    });
  });

  socket.on('meeting-soon', ({ accountId, name, at }) => {
    const el = toast({
      title: `Your meeting with ${name} starts ${inText(at)}`,
      body: 'Tap Join when you’re ready. They’ll get the call.',
      timeout: 0,
      actions: [
        { label: 'Later', onClick: () => dismiss(el) },
        { label: 'Join', cls: 'btn-good', onClick: () => { dismiss(el); callBack({ id: accountId, name }, true); } },
      ],
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
  // `target` defaults to the live match's socket; Connects passes { accountId }.
  function openCardMenu(btn, match, target = { target: match.id }) {
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
      if (action === 'report') openReport(target, match.name, false);
      if (action === 'block') confirmBlock(target, match.name, false);
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
    // Whatever page we're on (Connects, Background, Friends), keep live matching going.
    if (state.searching && state.activity) {
      const res = await emit('set-activity', { activity: state.activity });
      if (res.error) state.searching = false;
    }
  });

  // The server says which account this connection is. If it isn't the one on screen (you signed
  // into another account in another tab, which replaced this browser's login), reload as that account.
  socket.on('hello', ({ accountId }) => {
    if (state.user && state.user.id !== accountId) location.reload();
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
