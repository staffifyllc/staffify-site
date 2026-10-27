// The Performance page's tabs, and its Caller review tab.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "we need that view put into performance as a tab", about a review of Milton's
// calling: day by day, who actually answered, whether the numbers are bad, how many leads are left,
// when he calls, who he calls again, pace and logging. Data: GET /api/performance-review/ (see
// api/_performance-review.js for what every figure means). Owners pick any caller; a caller sees
// their own. Built with DOM nodes, never HTML strings: notes are prospect-facing free text.
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
const TABS = [{ id: 'today', button: 'tab-today', panel: 'app' }, { id: 'review', button: 'tab-review', panel: 'review' }];
let opened = false;
function show(tab, remember) {
    for (const t of TABS) {
        const b = $(t.button), p = $(t.panel), on = t.id === tab;
        if (b) { b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; b.classList.toggle('on', on); }
        if (p) p.hidden = !on;
    }
    if (remember) {
        const u = new URL(location.href);
        if (tab === 'today') u.searchParams.delete('tab'); else u.searchParams.set('tab', tab);
        history.replaceState(null, '', u.toString());
    }
    if (tab === 'review' && !opened) { opened = true; start(); }
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
    if (state.owner) {
        try { const p = await fetch('/api/daily-report/?people=1', { cache: 'no-store' }); if (p.ok) state.people = ((await p.json()) || {}).people || []; } catch { state.people = []; }
    }
    const q = new URLSearchParams(location.search);
    const today = etToday();
    state.user = (state.owner ? (q.get('user') || (state.people[0] && state.people[0].email)) : me && me.email) || null;
    state.to = isDay(q.get('to')) && q.get('to') <= today ? q.get('to') : today;
    state.from = isDay(q.get('from')) && q.get('from') <= state.to ? q.get('from') : shiftDay(state.to, -13);
    box.replaceChildren(controls(), el('div', { id: 'pr-out' }));
    if (!state.user) { $('pr-out').replaceChildren(el('p', { class: 'pr-empty', text: 'Nobody has a caller review yet. A review appears for anyone with the caller role.' })); return; }
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
    const out = $('pr-out'); if (!out) return;
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
    if (!res.ok || !body || !body.review) { out.replaceChildren(el('p', { class: 'pr-empty', text: ((body && body.error) || 'The review could not be built.') + ' Nothing here is a zero.' })); return; }
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
const shiftText = d => (d.shiftMeasured ? (d.clockedMinutes ? mins(d.clockedMinutes) : 'none declared') : d.shiftUnavailable ? 'unknown' : 'not recorded');
const tile = (n, label, sub) => el('div', { class: 'pr-tile' }, el('b', { text: n }), el('span', { text: label }), sub ? el('em', { text: sub }) : null);

export function render(v) {
    const t = v.totals || {};
    const parts = [];
    const range = dayLabel(v.from, { weekday: 'short', month: 'short', day: 'numeric' }) + ' to ' + dayLabel(v.to, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    parts.push(el('p', { class: 'pr-meta' },
        el('b', { text: (v.user && v.user.name) || '' }), ' · ' + range + ' (Eastern) · built ' + clockET(v.generatedAt) + (v.partial ? ' · today is still in progress' : ''),
        el('br'), 'Quo: ' + v.sources.quo + ' · Hub call log: ' + v.sources.hubLog + ' · Calendly: ' + v.sources.calendly));

    const reachedSub = t.reached === null ? null : plural(t.prospectsReached, 'prospect', 'prospects') + ', ' + t.staffReached + ' staff' + (t.someoneReached ? ', ' + t.someoneReached + ' unclear' : '') + (pct(t.reachedPerDial) ? ' · ' + pct(t.reachedPerDial) + ' of dials' : '');
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
            days.map(d => [dayLabel(d.day) + (d.partial ? ' (so far)' : ''), num(d.dials), num(d.outcomes), num(d.reached), num(d.meetings), talk(d.talkSeconds), shiftText(d), d.activityMeasured ? mins(d.activeMinutes) : 'not measured']),
            { foot: ['Total', num(t.dials), num(t.outcomes), num(t.reached), num(t.meetings), talk(t.talkSeconds), t.clockedMinutes === null ? 'not recorded' : mins(t.clockedMinutes), t.activeMinutes === null ? 'not measured' : mins(t.activeMinutes)] })
            : el('p', { class: 'pr-empty', text: 'No calls, outcomes, shift or Hub activity in these dates.' }),
        (v.quietDays || []).length ? el('p', { class: 'pr-small', text: 'No calls, outcomes or shift on ' + v.quietDays.map(d => dayLabel(d)).join(', ') + '.' }) : null));

    // Who answered
    const list = (v.reached && v.reached.list) || [];
    parts.push(section('Who answered',
        lede(t.reached === null ? 'Unknown: the Hub call log could not be read.' : (t.dials ? t.reached + ' of ' + plural(t.dials, 'dial', 'dials') : plural(t.reached, 'call', 'calls')) + ' reached a person: ' + t.prospectsReached + ' the prospect, ' + t.staffReached + ' staff' + (t.someoneReached ? ', ' + t.someoneReached + ' unclear' : '') + '.'),
        list.length ? table(['When', 'Company', 'What happened', 'Logged as', 'His note'], list.map(x => [whenET(x.at), x.company || '', (x.who === 'staff' ? 'Staff: ' : x.who === 'someone' ? 'Unclear: ' : 'Prospect: ') + x.how, x.logged, x.note || ''])) : null,
        el('p', { class: 'pr-small', text: "Quo counts a call as answered when voicemail or a phone menu picks up, so that count is not used here." })));

    // Numbers
    const n = v.numbers || {};
    parts.push(section('Are the numbers bad?',
        lede(n.flagged === null || n.flagged === undefined ? 'Unknown: the Hub call log could not be read.' : plural(n.flagged, 'prospect', 'prospects') + ' of ' + n.prospects + ' had a number problem in his outcomes or notes.' + ((n.byIssue || []).length ? ' ' + n.byIssue.map(i => i.issue + ': ' + i.n).join(' · ') + '.' : '')),
        (v.segments || []).length ? table(['Campaign', 'Prospects', 'Logged', 'Answered', 'Voicemail', 'No answer', 'Number problems'], v.segments.map(s => [s.name, num(s.prospects), num(s.outcomes), num(s.reached), num(s.voicemail), num(s.noAnswer), num(s.flagged)])) : null,
        (n.list || []).length ? el('details', { class: 'pr-more' }, el('summary', { text: 'The ' + plural(n.list.length, 'prospect', 'prospects') + ' with a number problem' }), table(['Company', 'Campaign', 'Problem', 'His note'], n.list.map(x => [x.company || '', x.campaign, x.issues.join(', '), x.note || '']))) : null));

    // Supply
    const s = v.supply;
    parts.push(section('Leads ready to call, right now',
        !s ? lede('Unknown: the call queue could not be read.') : lede(plural(s.neverDialled, 'callable lead nobody has called', 'callable leads nobody has called') + '. ' + plural(s.hisFollowUpsDue, 'of his own follow-ups is', 'of his own follow-ups are') + ' due.'),
        s && s.bySource.length ? table(['Where the number came from', 'Leads'], s.bySource.map(x => [x.label, num(x.n)])) : null,
        s && s.byCampaign.length > 1 ? table(['Campaign', 'Leads'], s.byCampaign.map(x => [x.name, num(x.n)])) : null));

    // When
    const tm = v.timing || { buckets: [], etHours: [] };
    const maxH = Math.max(1, ...tm.etHours.map(h => h.dials));
    const bar = (n) => { const b = el('span', { class: 'pr-bar' }); b.style.width = Math.round((n / maxH) * 100) + '%'; return el('span', { class: 'pr-barwrap' }, b, el('span', { class: 'pr-barn', text: String(n) })); };
    parts.push(section('When he calls',
        lede("Each logged call at the prospect's own clock, from the number's area code."),
        table(["Prospect's local time", 'Calls logged', 'Answered'], tm.buckets.filter(b => b.outcomes || b.key !== 'unknown').map(b => [b.label, num(b.outcomes), num(b.reached)])),
        tm.etHours.length ? el('div', { class: 'pr-sub' }, el('h3', { text: 'Dials by hour, Eastern' }), table(['Hour', 'Dials'], tm.etHours.map(h => [h.label.replace(' Eastern', ''), bar(h.dials)]), { cls: 'pr-hours' })) : null));

    // Repeats
    const rp = v.repeats || { distribution: [], mostCalled: [] };
    parts.push(section('Calling the same people again',
        lede(rp.nextDay && rp.nextDay.den ? rp.nextDay.num + ' of ' + rp.nextDay.den + ' no answer and voicemail outcomes were set to call again within 36 hours' + (pct(rp.nextDay) ? ' (' + pct(rp.nextDay) + ')' : '') + '.' : 'No no-answer or voicemail outcomes with a next call time.'),
        table(['Times he called them in these dates', 'Prospects'], rp.distribution.map(d => [d.label, num(d.prospects)])),
        rp.mostCalled.length ? el('details', { class: 'pr-more' }, el('summary', { text: 'Prospects called more than once' }), table(['Company', 'Calls', 'Outcomes', 'Answered'], rp.mostCalled.map(p => [p.company || '', num(p.attempts), p.outcomes.join(', '), p.reached ? 'yes' : 'no']))) : null));

    // Pace
    parts.push(section('Pace',
        days.length ? table(['Day', 'Shift', 'Dials', 'Dials per shift hour', 'First to last dial', 'Hub active'],
            days.map(d => [dayLabel(d.day), shiftText(d), num(d.dials), d.dialsPerClockedHour === null ? 'n/a' : String(d.dialsPerClockedHour), d.firstDial ? clockET(d.firstDial) + ' to ' + clockET(d.lastDial) + (d.dialSpanMinutes !== null ? ' (' + mins(d.dialSpanMinutes) + ')' : '') : 'no dials', d.activityMeasured ? mins(d.activeMinutes) : 'not measured'])) : null,
        el('p', { class: 'pr-small', text: 'Shift is what he declared in the Hub. Hub active is an estimate of minutes with the Hub in use. Neither is payroll; Hubstaff is the source for paid hours.' })));

    // Logging
    const lg = (v.logging && v.logging.list) || [];
    parts.push(section('Logging',
        lede(t.dialsWithoutOutcome === null ? 'Unknown: Quo or the Hub call log could not be read.' : plural(t.dialsWithoutOutcome, 'dial has', 'dials have') + ' no outcome logged. ' + plural(t.outcomesWithoutQuoCall, 'outcome has', 'outcomes have') + ' no matching Quo call. ' + plural(t.mislogged || 0, 'outcome disagrees with its note', 'outcomes disagree with their notes') + '.'),
        lg.length ? table(['When', 'Company', 'Logged as', 'His note', 'Mismatch'], lg.map(x => [whenET(x.at), x.company || '', x.logged, x.note || '', x.reason || ''])) : null));

    const defs = v.definitions || {};
    parts.push(el('details', { class: 'pr-more pr-defs' }, el('summary', { text: 'How each figure is counted' }),
        el('dl', null, Object.entries({ Dials: defs.dials, Logged: defs.outcomes, Answered: defs.reached, 'Number problems': defs.numbers, "Prospect's local time": defs.local, 'Call again within 36 hours': defs.nextDay, 'Leads ready to call': defs.supply }).filter(([, d]) => d).flatMap(([k, d]) => [el('dt', { text: k }), el('dd', { text: d })]))));
    return parts;
}

// ---- boot ---------------------------------------------------------------------------------------
export function init() {
    const tablist = document.querySelector('[role=tablist]');
    for (const t of TABS) { const b = $(t.button); if (b) b.addEventListener('click', () => show(t.id, true)); }
    if (tablist) tablist.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = TABS.findIndex(t => $(t.button) && $(t.button).getAttribute('aria-selected') === 'true');
        const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        show(next.id, true); const b = $(next.button); if (b) b.focus();
    });
    show(new URLSearchParams(location.search).get('tab') === 'review' ? 'review' : 'today', false);
}
if (typeof document !== 'undefined' && document.getElementById && $('tab-review')) init();
