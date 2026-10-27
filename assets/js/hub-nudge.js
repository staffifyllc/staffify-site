// The idle prompt. Loaded on every signed-in page by portal-shell, after the shift bar.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "do we have this set up where if milton is inactive after 10 mins he does
// something to keep going?" and "its not for slack its for the actual sales hub".
//
// For a caller whose shift is running (not on break, not off): when 10 minutes pass with no click,
// key, scroll or touch in any Hub tab AND no call placed in Quo, the Hub asks "Still on your shift?"
// with three answers: Next call (into the dialer), I'm on a call (asks again in 10 minutes), Take a
// break (the shift bar's own Break). It asks; it never accuses. The Hub cannot see a call made from
// the phone's own dialer, and a Quo call that is still going may not be listed yet.
//
// It changes nothing about the shift. Idle time is never deducted and never turned into payroll
// (Paul, 2026-10-24). The prompt and the answer are recorded as activity events, so the Activity
// page shows when it appeared and what was chosen. Owners are never prompted.
//
// Every open tab shares one clock of the last interaction (localStorage), and answering in one tab
// closes the prompt in all of them (BroadcastChannel, with the storage event as the fallback).
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__staffifyNudge) return;
  const IDLE_MS = 10 * 60000, SNOOZE_MS = 10 * 60000, CHECK_MS = 30000, QUO_EVERY_MS = 60000, WRITE_EVERY_MS = 10000;
  const LAST = 'staffify-last-activity', SNOOZE = 'staffify-idle-snooze', SHOWN = 'staffify-idle-prompt';
  const get = k => { try { return Number(localStorage.getItem(k)) || 0; } catch { return 0; } };
  const put = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };

  // ---- the shared clock of the last interaction --------------------------------------------
  let lastLocal = Date.now(), lastWrite = 0;
  const touch = (t = Date.now()) => { lastLocal = Math.max(lastLocal, t); if (t - lastWrite >= WRITE_EVERY_MS || t > get(LAST) + WRITE_EVERY_MS) { lastWrite = t; put(LAST, Math.max(get(LAST), t)); } };
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel']) document.addEventListener(ev, () => { if (!box) touch(); }, { passive: true, capture: true });
  touch();
  const lastActivity = () => Math.max(lastLocal, get(LAST));

  // ---- the shift, from the shift bar ---------------------------------------------------------
  const shift = () => (window.__staffifyShift && typeof window.__staffifyShift.snapshot === 'function' ? window.__staffifyShift.snapshot() : null);
  const running = s => !!(s && s.required && s.state === 'on' && s.shift);
  // The quiet clock starts no earlier than the shift started or last resumed.
  function onSince(s) {
    const sh = s.shift, breaks = (sh.breaks || []).filter(b => b.endedAt);
    return Math.max(Date.parse(sh.startedAt) || 0, ...breaks.map(b => Date.parse(b.endedAt) || 0));
  }

  // ---- Quo: a call placed recently, or one still going, is not idle -------------------------
  let quoAt = 0, quo = null;
  async function quoRecent(now) {
    if (now - quoAt < QUO_EVERY_MS && quo) return quo;
    quoAt = now;
    try {
      const r = await fetch('/api/quo-activity/', { cache: 'no-store', credentials: 'same-origin' });
      const j = r.ok ? await r.json() : null;
      const me = j && !j.error && Array.isArray(j.reps) ? j.reps[0] : null;   // own seat, today
      quo = me ? { lastCallAt: Date.parse(me.lastCallAt || '') || 0, inProgress: !!me.callInProgress } : { lastCallAt: 0, inProgress: false, unread: true };
    } catch { quo = { lastCallAt: 0, inProgress: false, unread: true }; }
    return quo;
  }

  // ---- the prompt ----------------------------------------------------------------------------
  let box = null, titleWas = null, checking = false;
  const send = kind => { try { return fetch('/api/activity/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'event', kind, page: (location.pathname || '/').slice(0, 120) }), keepalive: true, credentials: 'same-origin' }).catch(() => {}); } catch { return null; } };
  const el = (t, text, cls) => { const e = document.createElement(t); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
  const onDialer = () => /^\/(dialer|spearhead)\//.test(location.pathname || '');

  function close({ others = true } = {}) {
    if (box) { box.remove(); box = null; }
    if (titleWas !== null) { document.title = titleWas; titleWas = null; }
    if (others) tell('closed');
  }
  function show(quietMinutes, now) {
    if (box) return;
    // One tab records that the prompt appeared; every open tab shows it.
    if (now - get(SHOWN) >= IDLE_MS) { put(SHOWN, now); send('idle_prompt'); }
    box = el('div', null, 'idle-prompt');
    box.setAttribute('role', 'alertdialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'idle-prompt-title'); box.setAttribute('aria-describedby', 'idle-prompt-body');
    const card = el('div', null, 'idle-card');
    const h = el('h2', 'Still on your shift?'); h.id = 'idle-prompt-title';
    const p = el('p', 'Nothing in the Hub or in Quo for ' + quietMinutes + ' minutes. ' + (onDialer() ? 'Your next call is on screen.' : 'Your next call is ready in the dialer.')); p.id = 'idle-prompt-body';
    const row = el('div', null, 'idle-actions');
    const button = (text, cls, fn) => { const b = el('button', text, 'ps-btn' + (cls ? ' ' + cls : '')); b.type = 'button'; b.onclick = fn; return b; };
    const next = button('Next call', 'primary', () => {
      send('idle_prompt_next'); touch(); close();
      if (onDialer()) { try { window.scrollTo(0, 0); } catch {} const call = document.querySelector('a[href^="tel:"]'); if (call && typeof call.focus === 'function') call.focus(); }
      else location.href = '/dialer/';
    });
    const onCall = button("I'm on a call", '', () => { send('idle_prompt_on_call'); put(SNOOZE, Date.now() + SNOOZE_MS); touch(); close(); });
    const brk = button('Take a break', '', async () => {
      brk.disabled = true; send('idle_prompt_break');
      const r = window.__staffifyShift && typeof window.__staffifyShift.break === 'function' ? await window.__staffifyShift.break() : { ok: false };
      if (r && r.ok) { touch(); close(); return; }
      brk.disabled = false; p.textContent = (r && r.error) || 'The break could not be started. Use the Break button at the top.';
    });
    row.append(next, onCall, brk);
    card.append(h, p, row, el('small', 'This only checks in. Your shift time is not changed.', 'idle-note'));
    box.append(card);
    box.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); onCall.click(); } });
    document.body.append(box);
    if (typeof next.focus === 'function') next.focus();
    // A hidden tab gets a marker in its title, so the prompt is seen on return.
    titleWas = document.title; document.title = 'Still on shift? · ' + titleWas;
  }

  /** One check. Exposed for tests with an explicit clock. */
  async function check(now = Date.now()) {
    if (checking) return 'busy';
    hook();
    const s = shift();
    if (!running(s)) { if (box) close({ others: false }); return 'not running'; }
    if (box) return 'showing';
    if (get(SNOOZE) > now) return 'snoozed';
    const since = Math.max(lastActivity(), onSince(s), get(SNOOZE) - SNOOZE_MS);
    if (now - since < IDLE_MS) return 'active';
    checking = true;
    try {
      const q = await quoRecent(now);
      if (q.inProgress) return 'on a call';
      if (q.lastCallAt && now - q.lastCallAt < IDLE_MS) { touch(q.lastCallAt); return 'dialled'; }
      const s2 = shift();
      if (!running(s2)) return 'not running';
      show(Math.floor((now - Math.max(since, q.lastCallAt || 0)) / 60000), now);
      return 'prompted';
    } finally { checking = false; }
  }

  // ---- every tab in step -----------------------------------------------------------------------
  let bc = null;
  try { if (typeof BroadcastChannel === 'function') { bc = new BroadcastChannel('staffify-nudge'); bc.onmessage = e => { if (e && e.data === 'closed') close({ others: false }); }; } } catch { bc = null; }
  function tell(msg) { try { if (bc) bc.postMessage(msg); } catch {} put('staffify-idle-closed', Date.now()); }
  if (typeof window.addEventListener === 'function') window.addEventListener('storage', e => { if (e && e.key === 'staffify-idle-closed') close({ others: false }); });
  // The shift bar may load after this script; hook into it whenever it is there.
  let hooked = false;
  function hook() { if (hooked || !window.__staffifyShift || typeof window.__staffifyShift.onChange !== 'function') return; hooked = true; window.__staffifyShift.onChange(snap => { if (!running(snap) && box) close({ others: false }); }); }
  hook();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  const timer = setInterval(() => { check(); }, CHECK_MS);

  window.__staffifyNudge = { check, close, touch, lastActivity, isShowing: () => !!box, stop: () => clearInterval(timer), IDLE_MS, SNOOZE_MS };
})();
