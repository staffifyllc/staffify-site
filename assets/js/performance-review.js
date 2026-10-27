// The Performance page's tabs, and its Caller review tab.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "we need that view put into performance as a tab", about a review of Milton's
// calling: day by day, who actually answered, whether the numbers are bad, how many leads are left,
// when he calls, who he calls again, pace and logging. Data: GET /api/performance-review/ (see
// api/_performance-review.js for what every figure means). Owners pick any caller; a caller sees
// their own. Built with DOM nodes, never HTML strings: notes are prospect-facing free text.
import { mountLive } from './live-status.js';
const $ = id => document.getElementById(id);
function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = String(v);
        else if (k === 'hidden') n.hidden = !!v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(typeof c === 'number' ? String(c) : c);
    return n;
}

// ---- formatting ---------------------------------------------------------------------------------
const TZ = 'America/New_York';
export const etToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export const shiftDay = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const dayLabel = (day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(day + 'T12:00:00Z'));
const clockET = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const whenET = iso => new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
export const mins = m => (m === null || m === undefined ? 'unknown' : m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm');
const talk = s => (s === null || s === undefined ? 'unknown' : mins(Math.round(s / 60)));
const num = v => (v === null || v === undefined ? 'unknown' : String(v));
const pct = r => (r && r.pct !== null && r.pct !== undefined ? r.pct + '%' : null);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// ---- tabs ---------------------------------------------------------------------------------------
// Right now is for owners only: its button stays hidden until the sign-in says owner.
const TABS = [{ id: 'live', button: 'tab-live', panel: 'live' }, { id: 'today', button: 'tab-today', panel: 'app' }, { id: 'review', button: 'tab-review', panel: 'review' }];
const shown = t => { const b = $(t.button); return !!b && !b.hidden; };
let opened = false, liveMounted = false;
function show(tab, remember) {
    for (const t of TABS) {
        const b = $(t.button), p = $(t.panel), on = t.id === tab;
        if (b) { b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; b.classList.toggle('on', on); }
        if (p) p.hidden = !on;
    }
    // The shell's "Skip to content" link points at the panel that is showing.
    const skip = document.querySelector('.portal-skip'), shown = TABS.find(t => t.id === tab);
    if (skip && shown) skip.setAttribute('href', '#' + shown.panel);
    if (remember) {
        const u = new URL(location.href);
        if (tab === 'today') u.searchParams.delete('tab'); else u.searchParams.set('tab', tab);
        history.replaceState(null, '', u.toString());
    }
    if (tab === 'review' && !opened) { opened = true; start(); }
    if (tab === 'live' && !liveMounted && $('live')) { liveMounted = true; const box = el('section'); $('live').replaceChildren(box); mountLive(box); }
}

// ---- the review ---------------------------------------------------------------------------------
const state = { owner: false, me: null, people: [], user: null, from: null, to: null, seq: 0 };
function setUrl() {
    const u = new URL(location.href);
    u.searchParams.set('tab', 'review');
    if (state.owner && state.user) u.searchParams.set('user', state.user); else u.searchParams.delete('user');
    u.searchParams.set('from', state.from); u.searchParams.set('to', state.to);
    history.replaceState(null, '', u.toString());
}
const isDay = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

async function start() {
    const box = $('review'); if (!box) return;
    box.replaceChildren(el('p', { class: 'pr-meta', text: 'Checking your sign-in.' }));
    let r;
    try { r = await fetch('/api/auth-me/', { cache: 'no-store' }); } catch { r = null; }
    if (!r || r.status === 401 || !r.ok) { box.replaceChildren(el('p', { class: 'pr-empty', text: r && r.status === 401 ? 'Sign in to your Staffify account to see the caller review.' : 'Your sign-in could not be checked just now. Refresh to try again.' })); return; }
    const me = ((await r.json().catch(() => ({}))) || {}).rep || null;
    state.me = me; state.owner = !!me && (me.role === 'admin' || !!me.financeAccess);
    let peopleFailed = false;
    if (state.owner) {
        try { const p = await fetch('/api/daily-report/?people=1', { cache: 'no-store' }); if (p.ok) state.people = ((await p.json()) || {}).people || []; else peopleFailed = true; } catch { peopleFailed = true; }
    }
    const q = new URLSearchParams(location.search);
    const today = etToday();
    state.user = (state.owner ? (q.get('user') || (state.people[0] && state.people[0].email)) : me && me.email) || null;
    state.to = isDay(q.get('to')) && q.get('to') <= today ? q.get('to') : today;
    state.from = isDay(q.get('from')) && q.get('from') <= state.to ? q.get('from') : shiftDay(state.to, -13);
    box.replaceChildren(controls(), el('div', { id: 'pr-out' }));
    if (!state.user) { $('pr-out').replaceChildren(el('p', { class: 'pr-empty', text: peopleFailed ? 'The list of callers could not be read. Refresh to try again.' : 'Nobody has a caller review yet. A review appears for anyone with the caller role.' })); return; }
    load();
}

function controls() {
    const pick = el('select', { id: 'pr-user', 'aria-label': 'Caller', onchange: e => { state.user = e.target.value; load(); } });
    for (const p of state.people) { const o = el('option', { value: p.email, text: p.name || p.email }); if (p.email === state.user) o.setAttribute('selected', ''); pick.append(o); }
    pick.value = state.user || '';
    const from = el('input', { type: 'date', id: 'pr-from', 'aria-label': 'From', value: state.from, max: etToday(), onchange: e => { if (isDay(e.target.value)) { state.from = e.target.value; load(); } } });
    const to = el('input', { type: 'date', id: 'pr-to', 'aria-label': 'To', value: state.to, max: etToday(), onchange: e => { if (isDay(e.target.value)) { state.to = e.target.value; load(); } } });
    from.value = state.from; to.value = state.to;
    const preset = (label, days) => el('button', { type: 'button', class: 'pr-preset', 'data-days': days, onclick: () => { state.to = etToday(); state.from = shiftDay(state.to, -(days - 1)); $('pr-from').value = state.from; $('pr-to').value = state.to; load(); } }, label);
    return el('div', { class: 'pr-ctl' },
        state.owner && state.people.length ? el('label', { class: 'pr-field' }, el('span', { text: 'Caller' }), pick) : null,
        el('label', { class: 'pr-field' }, el('span', { text: 'From' }), from),
        el('label', { class: 'pr-field' }, el('span', { text: 'To' }), to),
        el('div', { class: 'pr-presets' }, preset('Last 7 days', 7), preset('Last 14 days', 14), preset('Last 30 days', 30)));
}

async function load() {
    const out = $('pr-out'); if (!out || !state.user) return;
    const seq = ++state.seq;
    if (state.from > state.to) { out.replaceChildren(el('p', { class: 'pr-empty', text: 'The start date is after the end date.' })); return; }
    setUrl();
    out.replaceChildren(el('p', { class: 'pr-meta', text: 'Building the review from Quo, the Hub call log and Calendly. This can take up to a minute.' }));
    const url = '/api/performance-review/?' + (state.owner ? 'user=' + encodeURIComponent(state.user) + '&' : '') + 'from=' + state.from + '&to=' + state.to;
    let res = null, body = null;
    try { res = await fetch(url, { cache: 'no-store' }); body = await res.json().catch(() => null); } catch { res = null; }
    if (seq !== state.seq) return;          // a newer choice is already loading
    if (!res) { out.replaceChildren(el('p', { class: 'pr-empty', text: 'The review could not be reached. Refresh to try again. Nothing here is a zero.' })); return; }
    if (res.status === 401) { out.replaceChildren(el('p', { class: 'pr-empty', text: 'Sign in to your Staffify account to see the caller review.' })); return; }
    if (!res.ok || !body || !body.review) { const msg = (body && body.error) || 'The review could not be built.'; out.replaceChildren(el('p', { class: 'pr-empty', text: msg + (/[.!?]$/.test(msg) ? '' : '.') + ' Nothing here is a zero.' })); return; }
    out.replaceChildren(...render(body.review));
}

// ---- drawing ------------------------------------------------------------------------------------
const section = (title, ...kids) => el('section', { class: 'pr-sec' }, el('h2', { text: title }), ...kids);
const lede = text => el('p', { class: 'pr-lede', text });
function table(head, rows, { foot, cls } = {}) {
    return el('div', { class: 'pr-scroll' }, el('table', { class: 'pr-table' + (cls ? ' ' + cls : '') },
        el('thead', null, el('tr', null, head.map(h => el('th', { scope: 'col', text: h })))),
        el('tbody', null, rows.map(r => el('tr', null, r.map(c => el('td', null, c === null || c === undefined ? 'unknown' : c))))),
        foot ? el('tfoot', null, el('tr', null, foot.map(c => el('td', null, c === null || c === undefined ? 'unknown' : c)))) : null));
}
const activityText = d => (d.activityUnavailable ? 'unknown' : d.activityMeasured ? mins(d.activeMinutes) : 'not measured');
const quietText = d => (d.quietStretches ? mins(d.quietMinutes) + (d.quietStretches.length ? ' (' + d.quietStretches.length + ')' : '') : d.shiftMeasured || d.shiftUnavailable ? 'unknown' : 'not recorded');
const shiftText = d => (d.shiftMeasured ? (d.clockedMinutes ? mins(d.clockedMinutes) : 'none declared') : d.shiftUnavailable ? 'unknown' : 'not recorded');
const tile = (n, label, sub) => el('div', { class: 'pr-tile' }, el('b', { text: n }), el('span', { text: label }), sub ? el('em', { text: sub }) : null);

export function render(v) {
    const t = v.totals || {};
    const parts = [];
    const range = dayLabel(v.from, { weekday: 'short', month: 'short', day: 'numeric' }) + ' to ' + dayLabel(v.to, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    parts.push(el('p', { class: 'pr-meta' },
        el('b', { text: (v.user && v.user.name) || '' }), ' · ' + range + ' (Eastern) · built ' + clockET(v.generatedAt) + (v.partial ? ' · today is still in progress' : ''),
        el('br'), 'Quo: ' + v.sources.quo + ' · Hub call log: ' + v.sources.hubLog + ' · Calendly: ' + v.sources.calendly));

    const HOWS = { Conversation: ['conversation', 'conversations'], 'Callback agreed': ['callback agreed', 'callbacks agreed'], 'Not now': ['not now', 'not now'], 'Not interested': ['not interested', 'not interested'] };
    const byHow = (t.reachedByHow || []).map(x => { const w = HOWS[x.how] || [x.how.toLowerCase(), x.how.toLowerCase()]; return x.n + ' ' + (x.n === 1 ? w[0] : w[1]); }).join(', ');
    const reachedSub = t.reached === null ? null : (byHow || 'none') + (pct(t.reachedPerDial) ? ' · ' + pct(t.reachedPerDial) + ' of Quo dials' : '');
    parts.push(el('div', { class: 'pr-tiles' },
        tile(num(t.dials), 'dials in Quo', t.numbers === null ? null : 'to ' + plural(t.numbers, 'number', 'numbers') + ' over ' + plural(t.daysWorked, 'day', 'days')),
        tile(num(t.outcomes), 'outcomes logged', t.prospects === null ? null : 'on ' + plural(t.prospects, 'prospect', 'prospects')),
        tile(num(t.reached), 'people answered', reachedSub),
        tile(num(t.meetings), 'meetings booked', 'discovery calls, from Calendly')));
    if ((v.coverage || []).length) parts.push(el('ul', { class: 'pr-coverage' }, v.coverage.map(c => el('li', { text: c }))));

    // Day by day
    const days = v.days || [];
    parts.push(section('Day by day',
        days.length ? table(['Day', 'Dials', 'Logged', 'Answered', 'Meetings', 'Talk', 'Shift', 'Hub active'],
            days.map(d => [dayLabel(d.day) + (d.partial ? ' (so far)' : ''), num(d.dials), num(d.outcomes), num(d.reached), num(d.meetings), talk(d.talkSeconds), shiftText(d), activityText(d)]),
            { foot: ['Total', num(t.dials), num(t.outcomes), num(t.reached), num(t.meetings), talk(t.talkSeconds), t.clockedMinutes === null ? (days.some(d => d.shiftUnavailable) ? 'unknown' : 'not recorded') : mins(t.clockedMinutes), t.activeMinutes === null ? (days.some(d => d.activityUnavailable) ? 'unknown' : 'not measured') : mins(t.activeMinutes)] })
            : el('p', { class: 'pr-empty', text: 'No calls, outcomes, shift or Hub activity in these dates.' }),
        (v.quietDays || []).length ? el('p', { class: 'pr-small', text: 'No calls, outcomes or shift on ' + v.quietDays.map(d => dayLabel(d)).join(', ') + '.' }) : null));

    // Who answered
    const list = (v.reached && v.reached.list) || [];
    const checks = v.notesToCheck === undefined ? [] : v.notesToCheck;
    parts.push(section('Who answered',
        lede(t.reached === null ? 'Unknown: the Hub call log could not be read.' : plural(t.reached, 'call', 'calls') + ' reached a person, by the outcome chosen' + (byHow ? ': ' + byHow : '') + '.'
            + (t.reachedPerDial && t.reachedPerDial.den ? ' Of the ' + plural(t.reachedPerDial.den, 'Quo dial', 'Quo dials') + ', ' + t.reachedPerDial.num + ' reached a person' + (pct(t.reachedPerDial) ? ' (' + pct(t.reachedPerDial) + ')' : '') + '.' + (t.reachedWithoutQuoCall ? ' The other ' + t.reachedWithoutQuoCall + (t.reachedWithoutQuoCall === 1 ? ' was' : ' were') + ' logged with no matching Quo call.' : '')
                : t.reachedPerDial && t.reached ? ' None matched a Quo call: Quo shows no dials in these dates.' : '')),
        list.length ? table(['When', 'Company', 'Outcome', 'Note'], list.map(x => [whenET(x.at), x.company || '', x.how, x.note || ''])) : null,
        el('p', { class: 'pr-small', text: "Quo counts a call as answered when voicemail or a phone menu picks up, so that count is not used here. Who it was, owner or staff, is in the note." }),
        checks === null ? null : el('div', { class: 'pr-sub' }, el('h3', { text: 'Notes to check' }),
            el('p', { class: 'pr-small', text: checks.length ? plural(checks.length, 'note reads', 'notes read') + ' as if the outcome may be wrong. They are not counted above. Some are false alarms, so open the card before changing anything.' : 'No notes disagree with their outcome.' }),
            checks.length ? table(['When', 'Company', 'Logged as', 'Note', 'Why it is listed'], checks.map(x => [whenET(x.at), x.company || '', x.logged, x.note || '', x.hint])) : null)));

    // Numbers
    const n = v.numbers || {};
    parts.push(section('Are the numbers bad?',
        lede(n.flagged === null || n.flagged === undefined ? 'Unknown: the Hub call log could not be read.' : plural(n.flagged, 'prospect', 'prospects') + ' of ' + n.prospects + ' had a number problem in the logged outcomes or notes.' + ((n.byIssue || []).length ? ' ' + n.byIssue.map(i => i.issue + ': ' + i.n).join(' · ') + '.' : '')),
        (v.segments || []).length ? table(['Campaign', 'Prospects', 'Logged', 'Answered', 'Voicemail', 'No answer', 'Number problems'], v.segments.map(s => [s.name, num(s.prospects), num(s.outcomes), num(s.reached), num(s.voicemail), num(s.noAnswer), num(s.flagged)])) : null,
        (n.list || []).length ? el('details', { class: 'pr-more' }, el('summary', { text: 'The ' + plural(n.list.length, 'prospect', 'prospects') + ' with a number problem' }), table(['Company', 'Campaign', 'Problem', 'Note'], n.list.map(x => [x.company || '', x.campaign, x.issues.join(', '), x.note || '']))) : null));

    // Supply
    const s = v.supply;
    parts.push(section('Leads ready to call, right now',
        !s ? lede('Unknown: the call queue could not be read.') : lede((s.crmIncomplete ? 'At least ' : '') + plural(s.neverDialled, 'callable lead nobody has called', 'callable leads nobody has called') + '. ' + (s.crmIncomplete ? 'At least ' : '') + plural(s.hisFollowUpsDue, "of this caller's own follow-ups is", "of this caller's own follow-ups are") + ' due.'),
        s && s.crmIncomplete ? el('p', { class: 'pr-small', text: 'The CRM could not be read just now, so leads and follow-ups whose only number is in the CRM are missing from both counts.' }) : null,
        s && s.bySource.length ? table(['Where the number came from', 'Leads'], s.bySource.map(x => [x.label, num(x.n)])) : null,
        s && s.byCampaign.length > 1 ? table(['Campaign', 'Leads'], s.byCampaign.map(x => [x.name, num(x.n)])) : null));

    // When
    const tm = v.timing || { buckets: null, etHours: [] };
    const maxH = Math.max(1, ...tm.etHours.map(h => h.dials));
    const bar = (n) => { const b = el('span', { class: 'pr-bar' }); b.style.width = Math.round((n / maxH) * 100) + '%'; return el('span', { class: 'pr-barwrap' }, b, el('span', { class: 'pr-barn', text: String(n) })); };
    parts.push(section('When the calls were made',
        tm.buckets ? lede("Each logged call at the prospect's own clock, from the number's area code.") : lede('Unknown: the Hub call log could not be read, so local times are unknown.'),
        tm.buckets ? table(["Prospect's local time", 'Calls logged', 'Answered'], tm.buckets.filter(b => b.outcomes || b.key !== 'unknown').map(b => [b.label, num(b.outcomes), num(b.reached)])) : null,
        tm.etHours.length ? el('div', { class: 'pr-sub' }, el('h3', { text: 'Dials by hour, Eastern' }), table(['Hour', 'Dials'], tm.etHours.map(h => [h.label.replace(' Eastern', ''), bar(h.dials)]), { cls: 'pr-hours' })) : null));

    // Repeats
    const rp = v.repeats;
    parts.push(section('Calling the same people again',
        !rp ? lede('Unknown: the Hub call log could not be read.') : lede(rp.nextDay && rp.nextDay.den ? rp.nextDay.num + ' of ' + rp.nextDay.den + ' no answer and voicemail outcomes were set to call again within 36 hours' + (pct(rp.nextDay) ? ' (' + pct(rp.nextDay) + ')' : '') + '.' : 'No no-answer or voicemail outcomes with a next call time.'),
        rp ? table(['Times called in these dates', 'Prospects'], rp.distribution.map(d => [d.label, num(d.prospects)])) : null,
        rp && rp.mostCalled.length ? el('details', { class: 'pr-more' }, el('summary', { text: 'Prospects called more than once' }), table(['Company', 'Calls', 'Outcomes', 'Answered'], rp.mostCalled.map(p => [p.company || '', num(p.attempts), p.outcomes.join(', '), p.reached ? 'yes' : 'no']))) : null));

    // Pace
    parts.push(section('Pace',
        days.length ? table(['Day', 'Shift', 'Dials', 'Dials per shift hour', 'First to last dial', 'Hub active', 'Quiet on shift'],
            days.map(d => [dayLabel(d.day), shiftText(d), num(d.dials), d.dialsPerClockedHour !== null ? String(d.dialsPerClockedHour) : (d.dials === null || d.shiftUnavailable) ? 'unknown' : 'n/a', d.dials === null ? 'unknown' : d.firstDial ? clockET(d.firstDial) + ' to ' + clockET(d.lastDial) + (d.dialSpanMinutes !== null ? ' (' + mins(d.dialSpanMinutes) + ')' : '') : 'no dials', activityText(d), quietText(d)])) : null,
        el('p', { class: 'pr-small', text: 'Shift is what was declared in the Hub. Hub active is an estimate of minutes with the Hub in use. Neither is payroll; Hubstaff is the source for paid hours.' })));

    // Quiet stretches on shift: when the caller was not working, by day.
    const qt = v.quiet;
    parts.push(section('Quiet stretches on shift',
        !qt ? lede('Not measured in these dates: it needs a declared shift (from Oct 24, 2026), Hub activity and Quo for the same day.')
            : lede(mins(qt.quietMinutes) + ' quiet out of ' + mins(qt.onShiftMinutes) + ' on shift, in ' + plural(qt.list.length, 'stretch', 'stretches') + ' of 10 minutes or more.' + (qt.daysUnknown ? ' ' + plural(qt.daysUnknown, 'day with a shift is', 'days with a shift are') + ' unknown because a source could not be read.' : '')),
        qt && qt.list.length ? table(['Day', 'From', 'To', 'Quiet', 'Prompt'], qt.list.map(x => [dayLabel(x.day), clockET(x.from), x.open ? 'now' : clockET(x.to), mins(x.minutes), x.prompted ? (x.answer === 'No answer' ? 'Shown, no answer' : 'Shown: ' + String(x.answer).toLowerCase()) : 'Not shown'])) : null,
        el('p', { class: 'pr-small', text: "Quiet means no Hub click, key or scroll and no Quo call for 10 minutes or more on a running shift. Breaks are not counted. A call from the phone's own dialer is invisible here. Never deducted from the shift, never payroll." })));

    // Logging
    parts.push(section('Logging',
        lede(t.dialsWithoutOutcome === null ? 'Unknown: Quo or the Hub call log could not be read.' : plural(t.dialsWithoutOutcome, 'dial has', 'dials have') + ' no outcome logged. ' + plural(t.outcomesWithoutQuoCall, 'outcome has', 'outcomes have') + ' no matching Quo call.' + (t.notesToCheck ? ' ' + plural(t.notesToCheck, 'note is', 'notes are') + ' listed to check under Who answered.' : ''))));

    const defs = v.definitions || {};
    parts.push(el('details', { class: 'pr-more pr-defs' }, el('summary', { text: 'How each figure is counted' }),
        el('dl', null, Object.entries({ Dials: defs.dials, Logged: defs.outcomes, Answered: defs.reached, 'Notes to check': defs.notesToCheck, 'Number problems': defs.numbers, "Prospect's local time": defs.local, 'Call again within 36 hours': defs.nextDay, 'Leads ready to call': defs.supply, 'Quiet on shift': defs.quiet }).filter(([, d]) => d).flatMap(([k, d]) => [el('dt', { text: k }), el('dd', { text: d })]))));
    return parts;
}

// ---- boot ---------------------------------------------------------------------------------------
export function init() {
    const tablist = document.querySelector('[role=tablist]');
    for (const t of TABS) { const b = $(t.button); if (b) b.addEventListener('click', () => show(t.id, true)); }
    if (tablist) tablist.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const tabs = TABS.filter(shown);
        const i = tabs.findIndex(t => $(t.button).getAttribute('aria-selected') === 'true');
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        show(next.id, true); const b = $(next.button); if (b) b.focus();
    });
    const asked = new URLSearchParams(location.search).get('tab');
    show(asked === 'review' ? 'review' : 'today', false);
    // Owners open on Right now (unless the link asked for another tab); callers never see it.
    if ($('tab-live')) ownerCheck().then(owner => {
        if (!owner) return;
        $('tab-live').hidden = false;
        if (asked === 'live' || !asked) show('live', false);
    });
}
async function ownerCheck() {
    try { const r = await fetch('/api/auth-me/', { cache: 'no-store' }); if (!r.ok) return false; const me = ((await r.json()) || {}).rep; return !!me && (me.role === 'admin' || !!me.financeAccess); } catch { return false; }
}
if (typeof document !== 'undefined' && document.getElementById && $('tab-review')) init();
