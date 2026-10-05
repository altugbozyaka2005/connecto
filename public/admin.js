(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status });
    return data;
  }

  // Tiny DOM builder: el('p', { class: 'x' }, 'text', child). Text is always set as text, never HTML.
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    return node;
  }

  function avatar(name, src) {
    const a = el('div', { class: 'avatar avatar-md' });
    if (src) a.style.backgroundImage = `url("${src}")`;
    else a.textContent = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    return a;
  }

  const fmt = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  function age(dob) {
    const d = new Date(`${dob}T00:00:00Z`), now = new Date();
    let a = now.getUTCFullYear() - d.getUTCFullYear();
    if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
    return a;
  }

  function toast(title, body) {
    const t = el('div', { class: 'toast toast-simple' }, el('div', { class: 'toast-text' }, el('strong', {}, title), body && el('p', {}, body)));
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 4000);
  }

  // ---------- Views ----------

  const HINTS = {
    open: 'Reports waiting for review, newest first. Suspending closes every open report about that person.',
    resolved: 'Reports you’ve already acted on or dismissed.',
    suspended: 'Accounts that can’t sign in. Includes automatic suspensions (3+ different reporters in 24 hours).',
  };
  let view = 'open';

  function reportCard(r, open) {
    const rep = r.reported;
    const meta = [
      `Age ${age(rep.dateOfBirth)}`,
      `joined ${new Date(rep.joinedAt).toLocaleDateString()}`,
      `${rep.totalReporters} ${rep.totalReporters === 1 ? 'person has' : 'people have'} reported them`,
    ].join(' · ');

    const note = el('input', { type: 'text', class: 'note-input', placeholder: 'Note for the record (optional)', maxlength: 500 });
    const act = async (action, btn) => {
      if (action === 'suspend' && !confirm(`Suspend ${rep.name}? They'll be signed out and can't sign in again until you unsuspend them.`)) return;
      btn.disabled = true;
      try {
        await api('POST', `/api/admin/reports/${r.id}`, { action, note: note.value });
        toast(action === 'suspend' ? `${rep.name} suspended` : 'Report dismissed');
        load();
      } catch (err) {
        btn.disabled = false;
        toast('Action failed', err.message);
      }
    };

    return el('article', { class: 'report' },
      el('div', { class: 'report-top' },
        avatar(rep.name, rep.avatar),
        el('div', { class: 'report-who' },
          el('p', { class: 'report-name' }, rep.name, rep.suspended && el('span', { class: 'pill pill-danger' }, 'Suspended')),
          el('p', { class: 'report-email' }, rep.email),
          el('p', { class: 'report-meta' }, meta),
        ),
        el('div', { class: 'report-when' },
          el('span', { class: 'pill' }, r.reasonLabel),
          el('time', {}, fmt(r.createdAt)),
        ),
      ),
      el('dl', { class: 'report-facts' },
        el('dt', {}, 'Where'), el('dd', {}, { call: 'During or right after a call', chat: 'In direct messages', match: 'From the match list' }[r.context] || r.context),
        el('dt', {}, 'Their activity'), el('dd', {}, r.activity ? `“${r.activity}”` : '—'),
        el('dt', {}, 'Reported by'), el('dd', {}, `${r.reporter.name} (${r.reporter.email})`),
      ),
      r.details && el('blockquote', { class: 'report-details' }, r.details),
      r.transcript?.length
        ? el('details', { class: 'transcript' },
            el('summary', {}, `${r.context === 'chat' ? 'Direct messages' : 'Chat from the call'} (${r.transcript.length} messages)`),
            el('ol', {}, r.transcript.map((m) => el('li', {}, el('b', {}, m.name), ' ', m.text, el('time', {}, new Date(m.at).toLocaleTimeString())))))
        : r.context === 'call' && el('p', { class: 'report-meta' }, 'No chat messages were sent in this call.'),
      open
        ? el('div', { class: 'report-actions' },
            note,
            el('button', { type: 'button', class: 'btn btn-ghost', onclick: (e) => act('dismiss', e.currentTarget) }, 'Dismiss'),
            el('button', { type: 'button', class: 'btn btn-danger', onclick: (e) => act('suspend', e.currentTarget) }, 'Suspend account'))
        : el('p', { class: 'report-resolution' },
            el('span', { class: `pill ${r.status === 'actioned' ? 'pill-danger' : ''}` }, r.status === 'actioned' ? 'Suspended' : 'Dismissed'),
            ` ${fmt(r.resolvedAt)}`, r.resolutionNote && ` · “${r.resolutionNote}”`),
    );
  }

  function suspendedRow(u) {
    return el('article', { class: 'report report-row' },
      avatar(u.name, u.avatar),
      el('div', { class: 'report-who' },
        el('p', { class: 'report-name' }, u.name),
        el('p', { class: 'report-email' }, u.email),
        el('p', { class: 'report-meta' }, `${fmt(u.suspendedAt)} · ${u.reason || 'No reason recorded'}`),
      ),
      el('button', {
        type: 'button', class: 'btn btn-ghost',
        onclick: async (e) => {
          if (!confirm(`Unsuspend ${u.name}? They'll be able to sign in again, and their open reports will be dismissed.`)) return;
          e.currentTarget.disabled = true;
          await api('POST', `/api/admin/users/${u.id}/unsuspend`, {});
          toast(`${u.name} can sign in again`);
          load();
        },
      }, 'Unsuspend'),
    );
  }

  async function load() {
    $('#view-hint').textContent = HINTS[view];
    const list = $('#list');
    list.textContent = '';
    $('#empty').hidden = true;
    try {
      const open = (await api('GET', '/api/admin/reports?status=open')).reports;
      $('#count-open').textContent = open.length ? String(open.length) : '';
      let items;
      if (view === 'open') items = open.map((r) => reportCard(r, true));
      else if (view === 'resolved') {
        const [a, d] = await Promise.all([api('GET', '/api/admin/reports?status=actioned'), api('GET', '/api/admin/reports?status=dismissed')]);
        items = [...a.reports, ...d.reports].sort((x, y) => (y.resolvedAt || 0) - (x.resolvedAt || 0)).map((r) => reportCard(r, false));
      } else items = (await api('GET', '/api/admin/suspended')).users.map(suspendedRow);
      list.append(...items);
      if (!items.length) {
        $('#empty').textContent = { open: 'No open reports. 🎉', resolved: 'Nothing resolved yet.', suspended: 'No suspended accounts.' }[view];
        $('#empty').hidden = false;
      }
    } catch (err) {
      $('#empty').textContent = err.message;
      $('#empty').hidden = false;
    }
  }

  document.querySelectorAll('.admin-tabs .tab').forEach((t) => t.addEventListener('click', () => {
    view = t.dataset.view;
    document.querySelectorAll('.admin-tabs .tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    load();
  }));

  // ---------- Gate ----------

  api('GET', '/api/auth/me')
    .then(({ user }) => {
      if (!user.isAdmin) throw new Error(`${user.email} isn’t an admin account.`);
      $('#console').hidden = false;
      load();
      // Refresh open reports every minute, but never while a note is being typed.
      setInterval(() => {
        const typing = [...document.querySelectorAll('.note-input')].some((i) => i.value || i === document.activeElement);
        if (view === 'open' && !document.hidden && !typing) load();
      }, 60000);
    })
    .catch((err) => {
      $('#gate-text').textContent = err.status === 401 ? 'Sign in to Connecto with an admin account first.' : err.message;
      $('#gate').hidden = false;
    });
})();
