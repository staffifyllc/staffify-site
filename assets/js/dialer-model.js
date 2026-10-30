// The dialer's decisions, with no DOM in them.
// ------------------------------------------------------------------
// Everything the workspace has to get right about time, order and grouping lives here so it can
// be tested without a browser: what a quick pick means, which follow-ups are due, how a prospect's
// local time reads, which key does what. The workspace file only draws.

export const OUTCOMES = [
  { value: 'connected',    label: 'Connected',             hint: 'You spoke with them',                key: '1', tone: 'good', next: 'book'  },
  { value: 'callback',     label: 'Callback',              hint: 'Bad time, time agreed',              key: '2', tone: 'warm', next: 'time'  },
  // Paul, 2026-10-27: "I ned a card that says gatkeeper". Its own outcome, shown next to Callback. Key 8,
  // so the keys a caller already knows (1 to 7) keep meaning what they meant.
  { value: 'gatekeeper',   label: 'Gatekeeper',            hint: 'Reached staff, not the owner',       key: '8', tone: 'warm', next: 'time'  },
  { value: 'voicemail',    label: 'Left voicemail',        hint: '',                                   key: '3', tone: '',     next: 'retry' },
  { value: 'no_answer',    label: 'No answer',             hint: '',                                   key: '4', tone: '',     next: 'retry' },
  { value: 'timing',       label: 'Not now',               hint: 'Interested, later',                  key: '5', tone: 'warm', next: 'later' },
  { value: 'wrong_number', label: 'Wrong number',          hint: 'The number, not the person',         key: '6', tone: '',     next: null    },
  { value: 'suppress',     label: 'Not interested / stop', hint: 'Excluded from all outreach',         key: '7', tone: 'bad',  next: null    },
];
export const NEEDS_TIME = ['callback', 'gatekeeper', 'no_answer', 'voicemail', 'timing'];
export const outcome = value => OUTCOMES.find(o => o.value === value) || null;

// ---- time --------------------------------------------------------------------------------------
const pad = n => String(n).padStart(2, '0');
/** A Date as the value a datetime-local input wants, in the browser's zone. */
export const toLocalInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const atHour = (base, days, hour, minute = 0) => { const d = new Date(base); d.setDate(d.getDate() + days); d.setHours(hour, minute, 0, 0); return d; };
const nextWeekday = (base, weekday, hour) => { const d = new Date(base); const add = ((weekday + 7 - d.getDay()) % 7) || 7; d.setDate(d.getDate() + add); d.setHours(hour, 0, 0, 0); return d; };

/**
 * The quick picks for a follow-up time. Every one is in the future from `now`, and "later today"
 * only appears while there is still a working afternoon to point at.
 */
export function quickPicks(now = new Date()) {
  const n = new Date(now);
  const picks = [{ label: 'In 1 hour', at: new Date(n.getTime() + 3600000) }];
  if (n.getHours() < 15) picks.push({ label: 'Today 4 pm', at: atHour(n, 0, 16) });
  picks.push({ label: 'Tomorrow 10 am', at: atHour(n, 1, 10) }, { label: 'Tomorrow 2 pm', at: atHour(n, 1, 14) },
    { label: 'Next Monday 10 am', at: nextWeekday(n, 1, 10) }, { label: 'In 2 weeks', at: atHour(n, 14, 10) });
  return picks;
}

/** Where the next-time picker starts for an outcome, so a rep only edits when the default is wrong. */
export function defaultNext(value, now = new Date()) {
  const n = new Date(now);
  if (value === 'timing') return atHour(n, 90, 10);
  if (value === 'callback' || value === 'gatekeeper') return atHour(n, 1, 10);
  if (value === 'voicemail' || value === 'no_answer') return atHour(n, 2, 10);
  return atHour(n, 1, 10);
}

const DAY = 86400000;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = d => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** 'Overdue 25 min' / 'Today 2:30 PM' / 'Tomorrow 10:00 AM' / 'Mon, Oct 27, 10:00 AM'. */
export function fmtWhen(iso, now = new Date()) {
  const d = new Date(iso); if (Number.isNaN(+d)) return '';
  const n = new Date(now);
  const diff = d - n;
  if (diff < 0) {
    const m = Math.round(-diff / 60000);
    if (m < 60) return `Overdue ${m} min`;
    if (m < 24 * 60) return `Overdue ${Math.round(m / 60)} h`;
    return `Overdue ${Math.round(m / 60 / 24)} d`;
  }
  if (sameDay(d, n)) return 'Today ' + clock(d);
  if (sameDay(d, new Date(n.getTime() + DAY))) return 'Tomorrow ' + clock(d);
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ', ' + clock(d);
}

/** The prospect's clock, from a zone the CRM gave us. null when the zone is unknown: nothing is guessed. */
export function localTime(timeZone, now = Date.now()) {
  if (!timeZone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(now));
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const hour = Number(get('hour')) % 24;
    const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(now));
    const weekday = get('weekday');
    const weekend = weekday === 'Sat' || weekday === 'Sun';
    const inHours = !weekend && hour >= 8 && hour < 18;
    return { time, weekday, hour, inHours, note: weekend ? 'Weekend there' : hour < 8 ? 'Early there' : hour >= 18 ? 'After hours there' : 'Business hours' };
  } catch { return null; }
}

// ---- follow-ups --------------------------------------------------------------------------------
/**
 * Everything this caller has promised, from the queue (callbacks and retries they own) and from
 * their own task list. Grouped the way a rep reads a day: due now, later today, upcoming, later.
 */
export function followUps({ records = [], tasks = [], me = '', now = Date.now() } = {}) {
  const mine = String(me || '').toLowerCase();
  const items = [];
  for (const r of records) {
    if (!r || !r.nextCallAt || !NEEDS_TIME.includes(r.callOutcome)) continue;
    if (String(r.callOwner || '').toLowerCase() !== mine) continue;
    if (r.status === 'suppressed' || r.status === 'excluded') continue;   // a no, or a card closed by a stop: nobody to call back
    if (r.pausedFollowUp) continue;   // a paused campaign's callback is in the Paused area, not due work
    const last = (r.callHistory || []).slice(-1)[0] || {};
    items.push({ kind: 'callback', id: 'cb:' + r.id, recordId: r.id, company: r.company || r.recipient, who: r.verifiedFirstName || '', recipient: r.recipient,
      at: r.nextCallAt, outcome: r.callOutcome, note: last.notes || '', phone: r.callContact && r.callContact.phone || null, campaignId: r.campaignId || null });
  }
  // A task for a card that is gone from the list (a no, a stop) is not work any more either.
  const live = new Set(records.filter(r => r && r.status !== 'suppressed' && r.status !== 'excluded').map(r => r.id));
  const known = new Set(records.filter(Boolean).map(r => r.id));
  for (const t of tasks) {
    if (!t || t.doneAt) continue;
    if (t.recordId && known.has(t.recordId) && !live.has(t.recordId)) continue;
    items.push({ kind: 'task', id: 'task:' + t.id, taskId: t.id, recordId: t.recordId || null, company: t.company || '', who: '', recipient: t.recipient || null,
      at: t.dueAt, outcome: null, note: t.title + (t.notes ? ' · ' + t.notes : ''), title: t.title, phone: null, campaignId: t.campaignId || null, hubspot: t.hubspot || null });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const n = new Date(now), endOfToday = atHour(n, 0, 23, 59).getTime(), week = n.getTime() + 7 * DAY;
  const groups = { dueNow: [], today: [], upcoming: [], later: [] };
  for (const it of items) {
    const t = Date.parse(it.at);
    if (!(t > 0)) continue;
    if (t <= n.getTime()) groups.dueNow.push(it);
    else if (t <= endOfToday) groups.today.push(it);
    else if (t <= week) groups.upcoming.push(it);
    else groups.later.push(it);
  }
  return groups;
}
export const followUpCount = g => g.dueNow.length + g.today.length + g.upcoming.length + g.later.length;

// ---- the timeline ------------------------------------------------------------------------------
/** Emails, calls and notes for one prospect, newest first, from whatever the card has. */
export function timeline({ brief = null, row = {} } = {}) {
  const items = [];
  const events = (brief && Array.isArray(brief.events) && brief.events.length ? brief.events : (row.events || [])).filter(e => e && e.kind !== 'draft');
  for (const e of events) {
    const incoming = e.kind === 'received';
    items.push({ kind: incoming ? 'email_in' : 'email_out', at: e.at, title: (incoming ? 'Reply' : 'Email') + (e.subject ? ' · ' + e.subject : ''), detail: e.mailbox || e.from || '', body: e.body || null, id: e.id || null });
  }
  for (const c of row.callHistory || []) {
    const o = outcome(c.outcome);
    items.push({ kind: 'call', at: c.at, title: 'Call · ' + (o ? o.label : c.outcome), detail: [c.caller, c.nextCallAt ? 'next ' + new Date(c.nextCallAt).toLocaleString() : null].filter(Boolean).join(' · '), body: c.notes || null, outcome: c.outcome });
  }
  if (row.overviewSentAt) items.push({ kind: 'email_out', at: row.overviewSentAt, title: 'Overview sent', detail: 'hello@gostaffify.com', body: null });
  return items.filter(i => Date.parse(i.at) > 0).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
/** One line: the most recent thing that happened, for the top of the card. */
export function lastTouch(items, now = Date.now()) {
  const t = items[0]; if (!t) return 'No contact recorded yet';
  const days = Math.floor((now - Date.parse(t.at)) / DAY);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
  return t.title.replace(/ · .*$/, '') + ' ' + when;
}

// ---- keyboard ----------------------------------------------------------------------------------
const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** What a key press means on this screen, or null. Never fires while the rep is typing. */
export function shortcut(e) {
  const t = e.target || {};
  if (TYPING.has(t.tagName) || t.isContentEditable) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return { type: 'save' };
    if (e.key === 'Escape') return { type: 'escape' };
    return null;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') return { type: 'save' };
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const o = OUTCOMES.find(x => x.key === e.key); if (o) return { type: 'outcome', value: o.value };
  const k = String(e.key || '').toLowerCase();
  if (k === 'n') return { type: 'next' };
  if (k === 'p') return { type: 'prev' };
  if (k === 's') return { type: 'skip' };
  if (k === 'f') return { type: 'followups' };
  if (k === 'c') return { type: 'call' };
  if (k === 'escape') return { type: 'escape' };
  return null;
}
export const SHORTCUTS = [['1-7', 'outcome'], ['N', 'next'], ['P', 'previous'], ['S', 'skip'], ['F', 'follow-ups'], ['C', 'call'], ['⌘↵', 'save & next']];

// ---- the number -------------------------------------------------------------------------------
/** How much to trust the number on the card, in one word and one colour, from the brief's dial. */
export function numberTrust(dial) {
  if (!dial) return { tone: 'none', word: 'No number', detail: 'We are finding one. Skip ahead.' };
  const l = String(dial.label || '').toLowerCase();
  if (l.startsWith('published on their own website')) return { tone: 'good', word: 'Listed on their site', detail: dial.detail || '' };
  if (l.startsWith('direct dial')) return { tone: 'ok', word: 'Direct dial', detail: dial.detail || '' };
  if (l.startsWith('main line')) return { tone: 'ok', word: 'Main line', detail: dial.detail || '' };
  return { tone: 'warn', word: 'CRM, unconfirmed', detail: dial.detail || '' };
}

// Paul, 2026-10-30: reps should "see any email efforts that are going in case they need to help work some of those
// leads". A Hiring now card carries its drip row's state (api/outreach-queue.js); this is the line the card shows.
const REPLIED = ['human_reply_hold', 'held_reply'];
const AUTO = ['auto_reply_hold', 'held_out_of_office'];
export function dripLine(drip, now = Date.now()) {
  if (!drip) return null;
  const sent = Math.min(4, Number(drip.sentTouches) || 0);
  const day = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const last = drip.lastSentAt ? ', last ' + day(drip.lastSentAt) : '';
  // Only an email sent with the rep on Reply-To put the answer in their inbox; older ones answered the sending inbox alone.
  if (REPLIED.includes(drip.status)) return { tone: 'good', text: 'Replied to our email' + (drip.replyReceivedAt ? ' ' + day(drip.replyReceivedAt) : '') + (drip.copied ? '. Read it in your inbox or hello@ before you call.' : '. The reply is in ' + (drip.sender || 'the sending inbox') + '; ask Paul for it before you call.') };
  if (AUTO.includes(drip.status)) return { tone: 'muted', text: 'Auto-reply (out of office)' + (drip.replyReceivedAt ? ' ' + day(drip.replyReceivedAt) : '') + '; emails paused.' };
  if (drip.status === 'suppressed') return { tone: 'bad', text: 'Emails stopped: they opted out or said no.' };
  if (drip.status === 'bounce_hold') return { tone: 'bad', text: 'Our email to them bounced.' };
  if (sent >= 4 || drip.status === 'sequence_complete_hold') return { tone: 'muted', text: '4 of 4 emails sent' + last + '.' };
  if (drip.status === 'sent' && sent) return { tone: 'muted', text: sent + ' of 4 emails sent' + last + (drip.nextEligibleAt && Date.parse(drip.nextEligibleAt) > now ? ', next ' + day(drip.nextEligibleAt) : '') + '.' };
  if (['prepared', 'draft_saved', 'draft_creation_pending', 'auto_send_pending'].includes(drip.status)) return { tone: 'muted', text: sent ? sent + ' of 4 emails sent' + last + ', the next is queued.' : 'First email queued.' };
  return { tone: 'muted', text: (sent ? sent + ' of 4 emails sent' + last + '. ' : '') + 'Emails paused.' };
}
