// The Hub's presence signal. Loaded on every signed-in page by portal-shell.
// ------------------------------------------------------------------
// One heartbeat a minute, and only while this tab is visible and the person has interacted with
// it (pointer, key, scroll, touch) inside the last five minutes. The server counts minutes as a
// set per person per day, so a second tab or device in the same minute adds nothing. A page view
// is sent on load; a leave is sent when the tab is hidden or closed (sendBeacon, so it survives
// the unload). A failed send is dropped: the next minute tries again, and a minute lost to a
// network blip is a minute under-counted, never over-counted.
//
// Nothing about keystrokes, text, screenshots or other sites is read or sent. The payload is the
// action, the page path and nothing else; identity is whatever the server's session cookie says.
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__staffifyActivity) return;
  const HEARTBEAT_MS = 60000, IDLE_CUTOFF_MS = 5 * 60000;
  const page = () => (location.pathname || '/').slice(0, 120);
  let lastInteraction = Date.now(), lastSent = 0, pending = false;
  const note = () => { lastInteraction = Date.now(); };
  for (const ev of ['pointerdown', 'keydown', 'scroll', 'touchstart', 'wheel']) document.addEventListener(ev, note, { passive: true, capture: true });

  const send = (body, { beacon = false } = {}) => {
    const json = JSON.stringify({ ...body, page: page() });
    try {
      if (beacon && navigator.sendBeacon) return navigator.sendBeacon('/api/activity/', new Blob([json], { type: 'application/json' }));
      return fetch('/api/activity/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true, credentials: 'same-origin' }).catch(() => {});
    } catch { return false; }
  };
  const active = () => document.visibilityState === 'visible' && Date.now() - lastInteraction < IDLE_CUTOFF_MS;
  const beat = () => {
    if (pending || !active()) return;
    if (Date.now() - lastSent < HEARTBEAT_MS - 1000) return;
    pending = true; lastSent = Date.now();
    Promise.resolve(send({ action: 'heartbeat' })).finally(() => { pending = false; });
  };
  // A page view counts the first minute on its own; the first heartbeat follows a minute later.
  send({ action: 'event', kind: 'page_view' });
  lastSent = Date.now();
  const timer = setInterval(beat, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { note(); beat(); } else send({ action: 'event', kind: 'leave' }, { beacon: true }); });
  window.addEventListener('pagehide', () => send({ action: 'event', kind: 'leave' }, { beacon: true }));
  window.__staffifyActivity = { stop: () => clearInterval(timer), isActive: active, idleCutoffMs: IDLE_CUTOFF_MS, heartbeatMs: HEARTBEAT_MS };
})();
