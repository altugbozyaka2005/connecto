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
    $('#activity-input').value = state.activity;
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

  function renderMatches(matches) {
    state.matches = matches;
    const grid = $('#match-grid');
    grid.textContent = '';
    const tpl = $('#match-card-tpl');
    for (const m of matches) {
      const card = tpl.content.firstElementChild.cloneNode(true);
      paintAvatar(card.querySelector('.avatar'), m.name, m.avatar);
      card.querySelector('.match-name').textContent = m.name;
      card.querySelector('.match-activity').textContent = m.activity;
      card.querySelector('.score-bar i').style.width = `${m.score}%`;
      card.querySelector('.score b').textContent = `${m.score}%`;
      const cta = card.querySelector('.match-cta');
      if (m.requestedYou) {
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
      hit.addEventListener('click', () => onMatchClick(m));
      card.querySelector('.card-more').addEventListener('click', (e) => {
        e.stopPropagation();
        openCardMenu(e.currentTarget, m);
      });
      grid.append(card);
    }
    $('#empty-state').toggleAttribute('data-show', matches.length === 0);
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

  socket.on('matches', ({ matches, online }) => {
    $('#online-count').textContent = Math.max(0, online - 1);
    if (!state.room) renderMatches(matches);
  });

  socket.on('incoming-request', ({ from, score }) => {
    if (state.room || state.incoming.has(from.id)) return;
    const el = toast({
      title: `${from.name} wants to join you`,
      body: `“${from.activity}” · ${score}% match`,
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

  // ---------- 4. Meeting room ----------

  // Fallback if the server sends no ICE servers; normally room-start includes STUN + TURN.
  const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  let pc = null;
  let localStream = null;
  let pendingCandidates = [];
  let peerReady = false;
  let localReady = false;
  let unread = 0;
  let remoteHasVideo = false;
  let remoteCamOn = true;

  socket.on('room-start', async (room) => {
    state.room = room;
    clearIncoming();
    unread = 0;
    $('#chat-dot').hidden = true;
    $('#chat-log').textContent = '';
    $('#peer-name').textContent = room.peer.name;
    $('#remote-label').textContent = room.peer.name;
    $('#room-activity').textContent = state.activity === room.peer.activity
      ? state.activity
      : `${state.activity}  ·  ${room.peer.activity}`;
    paintAvatar($('#peer-avatar'), room.peer.name, room.peer.avatar);
    paintAvatar($('#local-avatar'), state.user.displayName, state.user.avatar);
    $('#remote-status').textContent = 'Connecting…';
    $('#remote-placeholder').hidden = false;
    systemMessage(`You matched with ${room.peer.name}! They're doing “${room.peer.activity}”.`);
    show('screen-room');
    await startCall(room.initiator);
  });

  async function startCall(initiator) {
    peerReady = false;
    localReady = false;
    pendingCandidates = [];
    remoteHasVideo = false;
    remoteCamOn = true;

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

    pc = new RTCPeerConnection({ iceServers: state.room.iceServers || DEFAULT_ICE });
    if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    // Always be able to receive audio+video, even if we have nothing to send.
    if (!hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' });
    if (!hasVideo) pc.addTransceiver('video', { direction: 'recvonly' });

    const remoteStream = new MediaStream();
    $('#remote-video').srcObject = remoteStream;
    pc.ontrack = (e) => {
      remoteStream.addTrack(e.track);
      if (e.track.kind === 'video') {
        remoteHasVideo = true;
        if (!e.track.muted) $('#remote-placeholder').hidden = true;
        e.track.onunmute = () => { $('#remote-placeholder').hidden = !remoteCamOn; };
        e.track.onmute = () => { $('#remote-placeholder').hidden = false; };
      }
    };
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      const s = pc?.connectionState;
      if (s === 'connected') $('#remote-status').textContent = `${state.room?.peer.name || 'Peer'}'s camera is off`;
      if (s === 'failed') $('#remote-status').textContent = 'Could not connect video. Chat still works.';
    };

    localReady = true;
    if (initiator) {
      if (peerReady) await makeOffer();
    } else {
      socket.emit('signal', { ready: true });
    }
    socket.emit('media-state', { video: hasVideo, audio: hasAudio });
  }

  async function makeOffer() {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { description: pc.localDescription });
  }

  async function flushCandidates() {
    for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
    pendingCandidates = [];
  }

  socket.on('signal', async (data) => {
    if (!state.room) return;
    try {
      if (data.ready) {
        peerReady = true;
        if (state.room.initiator && localReady) await makeOffer();
        return;
      }
      // Offers only follow our 'ready', and answers only follow our offer, so pc exists here.
      if (!pc) return;
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          socket.emit('signal', { description: pc.localDescription });
        }
        await flushCandidates();
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else pendingCandidates.push(data.candidate);
      }
    } catch (err) {
      console.error('Signaling error', err);
    }
  });

  socket.on('media-state', ({ video }) => {
    remoteCamOn = !!video;
    if (!video) $('#remote-status').textContent = `${state.room?.peer.name || 'Peer'}'s camera is off`;
    $('#remote-placeholder').hidden = remoteCamOn && remoteHasVideo;
  });

  function setCtrl(sel, on, disabled = false) {
    const b = $(sel);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = disabled;
  }

  $('#mic-btn').addEventListener('click', () => {
    const track = localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCtrl('#mic-btn', track.enabled);
    socket.emit('media-state', { audio: track.enabled, video: !!localStream.getVideoTracks()[0]?.enabled });
  });

  $('#cam-btn').addEventListener('click', () => {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setCtrl('#cam-btn', track.enabled);
    $('#local-placeholder').hidden = track.enabled;
    socket.emit('media-state', { video: track.enabled, audio: !!localStream.getAudioTracks()[0]?.enabled });
  });

  function stopMedia() {
    pc?.close();
    pc = null;
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    $('#local-video').srcObject = null;
    $('#remote-video').srcObject = null;
  }

  function exitRoom(notice) {
    stopMedia();
    state.room = null;
    $('#chat-panel').removeAttribute('data-open');
    show('screen-matches');
    if (notice) toast({ title: notice, body: 'You’re back in the match list.' });
  }

  $('#leave-btn').addEventListener('click', () => {
    socket.emit('leave-room');
    exitRoom();
  });

  socket.on('peer-left', ({ reason }) => {
    const peer = state.room?.peer;
    const name = peer?.name || 'Your match';
    exitRoom();
    // Something went wrong in the call? Offer to report right away.
    const el = toast({
      title: reason === 'disconnected' ? `${name} disconnected` : `${name} left the room`,
      body: 'You’re back in the match list.',
      timeout: 10000,
      actions: peer ? [{ label: 'Report a problem', onClick: () => { dismiss(el); openReport({ lastPeer: true }, name, false); } }] : null,
    });
  });

  // Another tab of ours blocked this person mid-call.
  socket.on('room-ended', () => { if (state.room) exitRoom(); });

  socket.on('suspended', () => {
    signedOut('Your account has been suspended for breaking the community guidelines.');
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
    if (block && reportCtx.inCall && state.room) exitRoom();
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
    if (blockCtx.inCall && state.room) exitRoom();
    toast({ title: `${blockCtx.name} is blocked`, body: 'You won’t see each other again.' });
  });

  // In-call flag button: report (with "also block" ticked) covers both cases.
  $('#report-btn').addEventListener('click', () => {
    if (state.room) openReport({ lastPeer: true }, state.room.peer.name, true);
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

  socket.on('chat', ({ from, text }) => {
    const li = document.createElement('li');
    li.className = 'msg' + (from === socket.id ? ' mine' : '');
    li.textContent = text;
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
