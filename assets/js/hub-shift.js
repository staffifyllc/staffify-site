// The shift bar: Start, a running clock, Break, Resume, End. Loaded on every signed-in page.
// ------------------------------------------------------------------
// Paul, 2026-10-24 (through Codex): "an explicit Start shift button for Milton that starts his
// timer/log, and require an active shift before he can place calls through the Hub ... visible
// running elapsed timer, Break/Resume, End shift; persist server timestamps tied to authenticated
// identity, survive refresh, and prevent overlapping shifts across tabs/devices."
//
// The server owns the shift (api/shift.js). This script shows it, sends the four presses, keeps the
// clock running from the server's timestamps, and keeps every open tab in step (BroadcastChannel,
// with a localStorage ping as the fallback, plus a poll every minute and on becoming visible).
// It also holds the one gate for phone links: a click on any tel: (or Quo openphone:) link in the Hub while the shift
// is not running is stopped and explained, with the start action right there. The Hub cannot see
// or stop a call placed from a phone app on its own; it only declines to hand over the number.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__staffifyShift) return;
  const API = '/api/shift/';
  let data = null, fetchedAt = 0, bar = null, busy = false, firstLoad = null, loaded = false, seq = 0, pressSeq = 0;
  // Whether this person needed a shift the last time the server said, so a failed read can fail
  // closed for a caller without blocking an owner. Per browser; a convenience, not the gate.
  const KNOWN = 'staffify-shift-required';
  const knownRequired = () => { try { return localStorage.getItem(KNOWN); } catch { return null; } };
  const listeners = [];
  const el = (t, text, cls) => { const e = document.createElement(t); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const pad = n => String(n).padStart(2, '0');
  const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); };
  const serverNow = () => (data && data.now ? Date.parse(data.now) + (Date.now() - fetchedAt) : Date.now());
  const state = () => (data ? data.state || 'off' : 'off');
  const required = () => !!(data && data.required);
  // No answer from the server (a failed read): blocked for anyone this browser last saw as a
  // caller, open for anyone it last saw as an owner, blocked when it has never been told.
  const blocked = () => (data ? required() && state() !== 'on' : loaded && knownRequired() !== '0');
  const message = () => (data && data.gate && data.gate.message) || 'Start your shift to call.';
  const shift = () => (data && data.shift) || null;
  function elapsed() { const s = shift(); if (!s) return 0; const n = serverNow(); let brk = 0; for (const b of s.breaks || []) brk += (b.endedAt ? Date.parse(b.endedAt) : n) - Date.parse(b.startedAt); return n - Date.parse(s.startedAt) - brk; }
  function onBreakFor() { const s = shift(); if (!s) return 0; const b = (s.breaks || []).slice(-1)[0]; return b && !b.endedAt ? serverNow() - Date.parse(b.startedAt) : 0; }
  const snapshot = () => ({ state: state(), required: required(), blocked: blocked(), message: message(), shift: shift(), today: (data && data.today) || null });
  const emit = () => { const snap = snapshot(); for (const fn of listeners) { try { fn(snap); } catch {} } try { if (typeof CustomEvent === 'function' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('staffify-shift', { detail: snap })); } catch {} };

  async function load() {
    const mySeq = ++seq;
    try {
      const r = await fetch(API + '?me=1', { cache: 'no-store', credentials: 'same-origin' });
      if (r.status === 401 || r.status === 400) { data = null; try { localStorage.removeItem(KNOWN); } catch {} render(); return; }
      const j = await r.json();
      // A press answered after this read was sent is newer than this read; keep the press.
      if (r.ok && j && j.gate && mySeq > pressSeq) { data = j; fetchedAt = Date.now(); try { localStorage.setItem(KNOWN, j.required ? '1' : '0'); } catch {} }
    } catch { /* keep the last known state; the next poll tries again */ }
    loaded = true;
    render(); emit();
  }
  async function act(action) {
    if (busy) return { ok: false, reason: 'busy', error: 'Still saving the last change.' };
    busy = true; pressSeq = ++seq; render();
    try {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, page: (location.pathname || '/').slice(0, 120) }), credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (j && j.gate) { data = j; fetchedAt = Date.now(); } else await load();
      busy = false; render(); emit(); tellOtherTabs();
      return { ok: r.ok, status: r.status, reason: j.reason || null, error: r.ok ? null : (j.error || 'Not changed.'), ended: j.ended || null };
    } catch { busy = false; render(); return { ok: false, reason: 'network', error: 'Could not reach the server. Nothing changed.' }; }
  }

  // ---- the bar in the header ----------------------------------------------------------------
  function render() {
    const header = document.querySelector('.portal-header') || document.querySelector('.topbar');
    if (!header) return;
    if (!data || (!required() && !shift())) { if (bar) { bar.remove(); bar = null; } return; }
    if (!bar) { bar = el('div', null, 'portal-shift'); bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Your shift'); header.append(bar); }
    bar.replaceChildren();
    const st = state();
    bar.append(el('i', null, 'ps-dot ' + st));
    const label = { off: 'Off shift', on: 'On shift', break: 'On break', stale: 'Shift open 12h+' }[st] || st;
    bar.append(el('span', label, 'ps-label'));
    if (st !== 'off') { const c = el('span', hms(elapsed()), 'ps-time'); c.setAttribute('aria-live', 'off'); bar.append(c); }
    if (st === 'break') bar.append(el('span', 'break ' + hms(onBreakFor()), 'ps-break'));
    const btn = (text, action, cls) => { const b = el('button', text, 'ps-btn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.disabled = busy; b.onclick = async () => { if (action === 'end' && typeof window.confirm === 'function' && !window.confirm(st === 'stale' ? 'End this shift? It has been open for more than 12 hours, so it will be flagged for review rather than counted.' : 'End your shift now?')) return; const r = await act(action); if (!r.ok) flash(r.error); else if (action === 'end' && r.ended && r.ended.status === 'closed') flash('Shift ended: ' + minutesText(r.ended.clockedMinutes) + ' clocked.'); }; return b; };
    if (st === 'off') bar.append(btn('Start shift', 'start', 'primary'));
    else if (st === 'on') bar.append(btn('Break', 'break'), btn('End shift', 'end'));
    else if (st === 'break') bar.append(btn('Resume', 'resume', 'primary'), btn('End shift', 'end'));
    else bar.append(btn('End shift', 'end', 'primary'));
    bar.title = st === 'off' ? 'Press Start when you begin working. Calls from the Hub need a running shift.' : 'Running on the server since ' + new Date(shift().startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. The same shift shows in every tab and on every device.';
  }
  const minutesText = n => (n >= 60 ? Math.floor(n / 60) + 'h ' + (n % 60) + 'm' : n + 'm');
  function flash(text) { let t = document.getElementById('shift-flash'); if (!t) { t = el('div', null, 'shift-flash'); t.id = 'shift-flash'; t.setAttribute('role', 'status'); document.body.append(t); } t.textContent = text; t.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(() => t.classList.remove('show'), 7000); }

  // ---- the phone-link gate -------------------------------------------------------------------
  function explain(anchor) {
    let box = document.getElementById('shift-gate');
    if (!box) { box = el('div', null, 'shift-gate'); box.id = 'shift-gate'; box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-label', 'Start your shift to call'); document.body.append(box); }
    box.replaceChildren();
    if (!data) {
      // The shift could not be read. Say so, and offer to try again rather than guessing.
      box.append(el('b', 'Your shift could not be checked just now.'), el('span', 'Calling from the Hub needs a running shift. Check your connection and try again.'));
      const again = el('button', 'Try again', 'ps-btn primary'); again.type = 'button';
      again.onclick = async () => { again.disabled = true; await load(); if (blocked()) explain(anchor); else { box.remove(); if (anchor && anchor.getAttribute) location.href = anchor.getAttribute('href'); } };
      const later0 = el('button', 'Not now', 'ps-btn'); later0.type = 'button'; later0.onclick = () => box.remove();
      box.append(again, later0); return;
    }
    box.append(el('b', 'Calling from the Hub needs a running shift.'), el('span', message()));
    const st = state();
    const action = st === 'break' ? 'resume' : st === 'stale' ? 'end' : 'start';
    const go = el('button', { start: 'Start shift', resume: 'Resume shift', end: 'End this shift' }[action], 'ps-btn primary'); go.type = 'button';
    go.onclick = async () => { go.disabled = true; const r = await act(action); if (!r.ok) { box.append(el('span', r.error || 'Not changed.', 'err')); go.disabled = false; return; } if (action === 'end') { explain(anchor); return; } box.remove(); if (anchor && anchor.isConnected && typeof anchor.focus === 'function') anchor.focus(); };
    const later = el('button', 'Not now', 'ps-btn'); later.type = 'button'; later.onclick = () => box.remove();
    box.append(go, later);
    clearTimeout(explain.t); explain.t = setTimeout(() => { if (box.isConnected) box.remove(); }, 25000);
  }
  document.addEventListener('click', e => {
    const t = e.target; const a = t && typeof t.closest === 'function' ? t.closest('a') : null;
    const href = a ? a.getAttribute('href') || '' : '';
    if (!a || !/^(tel|openphone):/i.test(href)) return;   // Quo's own dial link on phones is a call too
    // The first read has not answered yet: hold the click until it does, then call or explain.
    if (!loaded) {
      e.preventDefault(); e.stopPropagation(); if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      Promise.resolve(firstLoad).then(() => { if (blocked()) explain(a); else location.href = href; });
      return;
    }
    if (!blocked()) return;
    e.preventDefault(); e.stopPropagation(); if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    explain(a);
  }, true);

  // ---- every tab shows the same shift -----------------------------------------------------
  let bc = null;
  try { if (typeof BroadcastChannel === 'function') { bc = new BroadcastChannel('staffify-shift'); bc.onmessage = () => load(); } } catch { bc = null; }
  if (typeof window.addEventListener === 'function') window.addEventListener('storage', e => { if (e && e.key === 'staffify-shift-rev') load(); });
  const tellOtherTabs = () => { try { if (bc) bc.postMessage('changed'); } catch {} try { localStorage.setItem('staffify-shift-rev', String(Date.now())); } catch {} };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  const poll = setInterval(load, 60000);
  const tick = setInterval(() => { if (!bar || !shift()) return; const c = bar.querySelector('.ps-time'); if (c) c.textContent = hms(elapsed()); const b = bar.querySelector('.ps-break'); if (b) b.textContent = 'break ' + hms(onBreakFor()); }, 1000);

  window.__staffifyShift = { state, blocked, required, message, shift, snapshot, start: () => act('start'), break: () => act('break'), resume: () => act('resume'), end: () => act('end'), refresh: load, onChange: fn => { listeners.push(fn); }, explain, stop: () => { clearInterval(poll); clearInterval(tick); } };
  firstLoad = load();
})();
