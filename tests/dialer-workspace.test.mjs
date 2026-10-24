// The call workspace, actually driven: load, read, log, schedule, follow up.
// ------------------------------------------------------------------
// The page script runs against a fake DOM and a stubbed API. What this catches is what a source
// read cannot: a card that renders blank, a key that selects the wrong outcome, a save that posts
// the wrong time, a drawer that lists a promise under the wrong heading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, install } from './helpers/fake-dom.mjs';
import { toLocalInput } from '../assets/js/dialer-model.js';

const ME = 'milton@trystaffify.com';
const hourAgo = new Date(Date.now() - 3600000).toISOString();
const tomorrow10 = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); return d; })();
const rec = (id, over) => ({ id, company: 'Co ' + id, recipient: id + '@x.com', sender: 'paul@trystaffify.com', owner: 'Paul', campaignId: 'staffify-agency-outreach',
    callReady: true, unclaimed: true, dueForMe: false, mine: false, callOwner: null, sentTouches: 4, lastSentAt: '2026-10-01T18:25:22Z', threadId: 't' + id,
    callContact: { phone: '+1512555000' + id.replace(/\D/g, ''), phoneStatus: 'available' }, callHistory: [], events: [], ...over });
const STATE = () => ({ revision: 41, viewer: ME, numberWork: { callable: 3, findingNumber: 3, noNumberPossible: 0, blocked: 0 },
    records: [
        rec('r1', { company: 'Riley Jones Real Estate Media', recipient: 'tom@rileyjonesrem.com', callContact: { phone: '+19107695931', phoneStatus: 'business_listed' }, industry: { key: 're-media', label: 'Real estate media', source: 'campaign' } }),
        rec('r2', { company: 'Loft & Light', recipient: 'priya@loft.com', callOwner: ME, mine: true, dueForMe: true, unclaimed: false, callOutcome: 'callback', nextCallAt: hourAgo,
            callHistory: [{ at: hourAgo, outcome: 'callback', notes: 'after lunch, ask for Priya', caller: ME, nextCallAt: hourAgo }] }),
        rec('r3', { company: 'Blocked Co', recipient: 'b@blocked.com', lastSentAt: '2026-09-01T18:25:22Z', industry: { key: 'construction', label: 'Construction', source: 'named' } }),
    ],
    tasks: [{ id: 't1', title: 'Send pricing', dueAt: tomorrow10.toISOString(), doneAt: null, company: 'Loft & Light', recordId: 'r2', hubspot: { ok: false, reason: 'no_owner' } }] });
const BRIEF = (row, name) => ({ callable: true, checkedAt: new Date().toISOString(), company: row.company, name, location: 'Wilmington, NC', phone: row.callContact.phone,
    dial: { label: 'Published on their own website', detail: 'This number is published on the business website.', sourceUrl: 'https://example.com/contact', alternates: [] },
    prospectTimezone: { timeZone: 'America/New_York' }, callerName: 'Milton', crmUrl: 'https://app.hubspot.com/contacts/51666712/record/0-1/9', website: 'example.com',
    industry: { key: 're-media', label: 'Real estate media', source: 'campaign' }, fact: 'They shoot listings for three brokerages.', source: { url: 'https://example.com' },
    opener: `Hi ${name.split(' ')[0]}, this is Milton with Staffify. This is a cold call.`, reason: 'Our CEO started his own agencies that needed this exact talent.',
    stages: [{ label: 'Understand the work', say: 'What does a normal week look like?' }, { label: 'Agree a next step', say: 'Would fifteen minutes be useful?' }],
    tree: { open: { choices: [['Go ahead', 'go'], ['Bad time', 'busy']] }, go: { say: 'Great. What does a normal week look like?', choices: [] }, busy: { say: 'No problem. When is better?', log: 'callback', choices: [] } },
    objections: [{ label: 'Busy', say: 'Of course. When is better?', note: '' }], voicemail: 'Hi, this is Milton with Staffify.', bookingUrl: 'https://calendly.com/staffify/discovery',
    events: [{ kind: 'sent', at: '2026-10-01T18:25:22Z', subject: '15 tasks to hand off', body: 'Hi there, I am Paul.', mailbox: 'paul@trystaffify.com' }], instagram: null });

// ---- the stubbed API: records every request so the test can read what was posted ---------------
function stubApi() {
    const calls = [];
    let state = STATE();
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ url: u, body });
        const ok = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
        if (u.startsWith('/api/outreach-queue/?view=calls')) {
            if (!body) return ok(state);
            if (body.action === 'call-outcome') {
                const at = new Date().toISOString();
                state = { ...state, revision: state.revision + 1, records: state.records.map(r => r.id !== body.id ? r : { ...r, callOutcome: body.outcome, nextCallAt: body.nextCallAt, callOwner: ME, mine: true, callReady: false, dueForMe: false, unclaimed: false,
                    callHistory: [...r.callHistory, { at, outcome: body.outcome, notes: body.notes, caller: ME, nextCallAt: body.nextCallAt }] }) };
                return ok({ ...state, callbackTask: body.outcome === 'callback' ? { ok: false, reason: 'no_owner', detail: 'No HubSpot user matches this caller' } : undefined });
            }
            if (body.action === 'task-add') { const task = { id: 't2', title: body.title, dueAt: body.dueAt, notes: body.notes, doneAt: null, company: body.company, recordId: body.id, hubspot: { ok: false, reason: 'no_owner' } }; state.tasks = [...state.tasks, task]; return ok({ ok: true, task }); }
            if (body.action === 'task-done') { const t = state.tasks.find(x => x.id === body.taskId); t.doneAt = new Date().toISOString(); return ok({ ok: true, task: t }); }
        }
        if (u.startsWith('/api/outreach-call-brief/?id=r3')) return ok({ callable: false, error: 'Do not call: Global opt-out', recipient: 'b@blocked.com', company: 'Blocked Co', events: [], callHistory: [], syncedAt: '2026-10-22T12:00:00Z', crmPhone: '+15125550003' }, 409);
        if (u.startsWith('/api/outreach-call-brief/?id=')) { const id = decodeURIComponent(u.split('id=')[1]); const row = state.records.find(r => r.id === id); return ok(BRIEF(row, id === 'r1' ? 'Tom Rieck' : 'Priya Nair')); }
        if (u.startsWith('/api/quo-activity/')) return ok({ reps: [{ dials: 5, connected: 2 }] });
        if (u.startsWith('/api/calendly-link/')) return ok({ ok: true, events: [] });
        if (u.startsWith('/api/send-text/')) return ok({ ok: true, sent: true, content: 'Hi Tom, Milton from Staffify here.' });
        if (u.startsWith('/api/send-overview/')) return ok({ sent: true, at: new Date().toISOString() });
        return ok({ error: 'unexpected ' + u }, 404);
    };
    return { calls, get state() { return state; } };
}

const realTimeout = setTimeout;
const tick = (ms = 25) => new Promise(r => realTimeout(r, ms));
const key = (k, over = {}) => document.dispatchEvent(dom.makeEvent('keydown', { key: k, target: document.body, ...over }));
const byText = (sel, text, root = document.body) => dom.queryAll(root, sel).find(n => dom.text(n) === text || dom.text(n).startsWith(text));
let dom, restore, api, mod;

test('boot: the due callback is first, the card reads whole, and the bar knows the day', async () => {
    dom = makeDom(); restore = install(dom);
    globalThis.setInterval = () => 0;
    globalThis.setTimeout = (fn, ms, ...a) => { const t = realTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
    const app = document.createElement('div'); app.id = 'app'; app.className = 'wrap'; document.body.append(app);
    api = stubApi();
    mod = await import('../assets/js/dialer-workspace.js?' + Date.now());
    await tick(60);
    const text = dom.text(document.body);
    assert.match(text, /1 of 3/, 'three callable records, due callback first');
    assert.match(text, /Loft & Light/);
    assert.match(text, /Callback due\. You agreed to call at/);
    assert.match(text, /after lunch, ask for Priya/, 'the note from the last call is on the banner');
    assert.match(text, /\+15125550002/); assert.match(text, /Listed on their site/);
    assert.match(text, /their time ?· (Business hours|After hours there|Early there|Weekend there)/, 'the prospect clock reads from the CRM zone');
    assert.match(text, /Hi Priya, this is Milton with Staffify/);
    assert.match(text, /5 ?dials today/); assert.match(text, /2 ?picked up/);
    assert.match(text, /3 having a number found automatically/);
    const ocs = document.querySelectorAll('.dw-oc');
    assert.equal(ocs.length, 7); assert.deepEqual(ocs.map(o => o.dataset.outcome), ['connected', 'callback', 'voicemail', 'no_answer', 'timing', 'wrong_number', 'suppress']);
    assert.equal(dom.text(ocs[1].querySelector('.k')), '2');
    const badge = document.querySelector('.dw-badge');
    assert.ok(badge && badge.classList.contains('hot') && dom.text(badge) === '1', 'one follow-up is due now');
    assert.match(text, /Email · 15 tasks to hand off/, 'history shows the email');
    assert.ok(!/undefined|\[object/.test(text), 'nothing unrendered leaks into the page');
});

test('a dialled card nags before it is left without an outcome', async () => {
    globalThis.window.confirm = () => false;
    document.getElementById('call-now').click();
    assert.match(dom.text(document.querySelector('.dw-bar')), /Needs an outcome/);
    key('n');
    await tick();
    assert.match(dom.text(document.body), /1 of 3/, 'still on the same card');
    globalThis.window.confirm = () => true;
});

test('keys pick outcomes; the conversation tree schedules the callback it names', async () => {
    key('1');
    assert.equal(document.querySelector('.dw-oc.sel').dataset.outcome, 'connected');
    assert.ok(document.getElementById('callback-at').hidden, 'no time for a connected call');
    assert.ok(byText('button', 'Meeting booked'), 'sentiment chips for a connected call');
    key('2');
    assert.equal(document.querySelector('.dw-oc.sel').dataset.outcome, 'callback');
    const due = document.getElementById('callback-at');
    assert.ok(!due.hidden && Date.parse(due.value) > Date.now(), 'a future default');
    assert.ok(byText('#next-step button', 'Tomorrow 10 am'));
    // Through the tree: "Bad time" leads to a callback node with its own quick picks.
    byText('.dw-tree button', 'Bad time').click();
    assert.ok(byText('.dw-tree button', 'Log as Callback'));
    byText('.dw-cbk button', 'Tomorrow 2 pm').click();
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(14, 0, 0, 0);
    assert.equal(due.value, toLocalInput(d));
    assert.match(document.getElementById('call-notes').value, /^Bad time\. Agreed to call back/);
    assert.match(dom.text(document.getElementById('toast')), /Callback set for Tomorrow 2:00/);
});

test('save posts the outcome and the time, reports the reminder honestly, and moves on', async () => {
    const notes = document.getElementById('call-notes'); notes.value += ' Spoke to the front desk.';
    key('Enter', { metaKey: true });
    await tick(60);
    const post = api.calls.filter(c => c.body && c.body.action === 'call-outcome').pop();
    assert.ok(post, 'an outcome was posted');
    assert.equal(post.body.id, 'r2'); assert.equal(post.body.outcome, 'callback');
    assert.equal(post.body.expectedRevision, 41);
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(14, 0, 0, 0);
    assert.equal(post.body.nextCallAt, d.toISOString(), 'the agreed time, as an instant');
    assert.match(post.body.notes, /Spoke to the front desk/);
    assert.match(dom.text(document.getElementById('toast')), /No HubSpot reminder: No HubSpot user matches this caller/);
    const text = dom.text(document.body);
    assert.match(text, /1 of 2/, 'two left');
    assert.match(text, /Riley Jones Real Estate Media/);
    assert.match(text, /1 ?callbacks set/);
    assert.equal(document.getElementById('call-notes').value, '', 'a fresh card, no leaked notes');
    assert.equal(localStorage.getItem('staffify-dialer-draft:r2'), null, 'the draft is gone once saved');
});

test('the follow-ups drawer lists the promise just made and the task, each under the right heading', async () => {
    key('f');
    const drawer = document.getElementById('dw-drawer');
    assert.ok(drawer, 'F opens the drawer');
    const text = dom.text(drawer);
    assert.match(text, /Your follow-ups/);
    assert.ok(text.indexOf('This week') >= 0 || text.indexOf('Later today') >= 0, 'grouped by when');
    assert.match(text, /Loft & Light/); assert.match(text, /Callback/);
    assert.match(text, /Send pricing/); assert.match(text, /Task/);
    assert.ok(!/Due now/.test(text), 'nothing is overdue any more');
    byText('.dw-fu button', 'Done').click();
    await tick();
    const done = api.calls.filter(c => c.body && c.body.action === 'task-done').pop();
    assert.equal(done.body.taskId, 't1');
    assert.ok(!/Send pricing/.test(dom.text(drawer)), 'the done task leaves the list');
    key('Escape');
    assert.equal(document.getElementById('dw-drawer'), null, 'Escape closes it');
});

test('a task set from the card is posted with the record and shown as saved', async () => {
    const title = document.querySelector('.dw-task input[aria-label="Task"]');
    title.value = 'Send the pricing sheet';
    byText('.dw-task button', 'Add task').click();
    await tick();
    const post = api.calls.filter(c => c.body && c.body.action === 'task-add').pop();
    assert.equal(post.body.title, 'Send the pricing sheet'); assert.equal(post.body.id, 'r1'); assert.equal(post.body.company, 'Riley Jones Real Estate Media');
    assert.ok(Date.parse(post.body.dueAt) > Date.now());
    assert.match(dom.text(document.getElementById('toast')), /Task saved for Tomorrow 10:00/);
    assert.match(dom.text(document.getElementById('toast')), /no HubSpot reminder because no HubSpot user matches you/);
    assert.equal(title.value, '', 'the form clears');
});

test('the text button posts the approved motion and nothing it should not', async () => {
    byText('.dw-actions button', 'Text').click();
    await tick();
    const post = api.calls.filter(c => c.url.startsWith('/api/send-text/')).pop();
    assert.deepEqual(post.body, { phone: '+19107695931', first: 'Tom', company: 'Riley Jones Real Estate Media', motion: 'outreach', emails: 4, email: 'tom@rileyjonesrem.com' });
    assert.ok(!('message' in post.body), 'no message is composed in the browser');
    assert.match(dom.text(document.getElementById('toast')), /Text sent: Hi Tom/);
    assert.match(document.getElementById('call-notes').value, /Texted them after the call/);
});

test('a prospect the live check refuses renders as refused, with its history and no outcomes', async () => {
    globalThis.window.confirm = () => true;
    key('s'); // skip r1, leaving r3
    await tick(60);
    const text = dom.text(document.body);
    assert.match(text, /2 of 2/, 'a skipped prospect keeps its place in the count');
    assert.match(text, /Blocked Co/);
    assert.match(text, /Not callable right now\. Do not call: Global opt-out/);
    assert.match(text, /Outcomes are off/);
    assert.equal(document.querySelectorAll('.dw-oc').length, 0);
    assert.match(text, /\+15125550003 is shown for reference only/);
    assert.equal(document.getElementById('call-now'), null, 'no dial button on a refused card');
});

test('a skip holds for the day, and the industry select narrows the queue to that industry', async () => {
    const saved = JSON.parse(localStorage.getItem('staffify-dialer-skipped:' + ME) || '{}');
    assert.ok(saved.r1, 'the skipped prospect is remembered on this device');
    assert.match(dom.text(document.querySelector('.dw-optbody')), /1 skipped today · show them again/);
    const sel = document.querySelector('select[aria-label="Industry"]');
    assert.ok(sel, 'an industry control exists');
    assert.deepEqual(dom.queryAll(sel, 'option').map(o => dom.text(o)), ['All industries', 'Construction', 'Real estate media']);
    sel.value = 'construction'; sel.dispatchEvent(dom.makeEvent('change'));
    await tick(60);
    assert.match(dom.text(document.querySelector('.dw-bar')), /1 of 1.*Construction/);
    assert.match(location.search, /industry=construction/, 'the filter is in the link');
    sel.value = 're-media'; sel.dispatchEvent(dom.makeEvent('change'));
    await tick(60);
    assert.match(dom.text(document.body), /Show the 1 skipped/, 'the only real estate media prospect is the skipped one, and the page says so');
    restore();
});

// ---- the shift gate on a card ---------------------------------------------------------------
test('a caller off shift gets the card without the number; Start on the card brings it back; a break takes the link away again', async () => {
    const dom2 = makeDom(); const restore2 = install(dom2);
    const app = document.createElement('div'); app.id = 'app'; app.className = 'wrap'; document.body.append(app);
    let gated = true; const presses = [];
    globalThis.window.__staffifyShift = { blocked: () => gated, state: () => (gated ? 'off' : 'on'), message: () => 'Start your shift to call.', start: async () => { presses.push('start'); gated = false; globalThis.window.dispatchEvent({ type: 'staffify-shift' }); return { ok: true }; }, resume: async () => ({ ok: true }) };
    const api2 = stubApi(); const inner = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith('/api/outreach-call-brief/?id=') && gated) { const r = await inner(url, opts); const b = await r.json(); return { ok: true, status: 200, json: async () => ({ ...b, phone: null, dial: null, phoneEvidence: { status: 'withheld', detail: 'Start your shift to call.' }, shiftGate: { required: true, state: 'off', allowed: false, reason: 'off', message: 'Start your shift to call.' } }) }; }
        return inner(url, opts);
    };
    await import('../assets/js/dialer-workspace.js?' + Date.now() + 'gate');
    await tick(60);
    let text = dom2.text(document.body);
    assert.match(text, /Loft & Light/); assert.match(text, /Start your shift to call\./); assert.match(text, /Notes and outcomes still save/);
    assert.equal(document.getElementById('call-now'), null, 'no dial link off shift');
    assert.ok(!/\+15125550002/.test(text), 'the number is not on the page');
    assert.ok(document.getElementById('call-notes'), 'notes are still there'); assert.equal(document.querySelectorAll('.dw-oc').length, 7, 'outcomes can still be logged');
    assert.match(text, /Hi Priya, this is Milton/, 'the talk track still loads');
    document.getElementById('shift-gate-action').click(); await tick(80);
    assert.deepEqual(presses, ['start']);
    assert.ok(document.getElementById('call-now'), 'the shift started: the number and the dial link are back');
    assert.match(dom2.text(document.body), /\+15125550002/);
    assert.ok(api2.calls.filter(c => c.url.startsWith('/api/outreach-call-brief/?id=r2')).length >= 2, 'the brief was fetched again once the shift ran');
    // A poll that changes nothing does not redraw the pane under the rep.
    const paneBefore = document.querySelector('.dw-who'); const callBefore = document.getElementById('call-now');
    globalThis.window.dispatchEvent({ type: 'staffify-shift' }); globalThis.window.dispatchEvent({ type: 'staffify-shift' }); await tick(20);
    assert.equal(document.getElementById('call-now'), callBefore, 'same dial link node: nothing was rebuilt');
    assert.equal(document.querySelector('.dw-who'), paneBefore);
    // The shift pauses after the card loaded: the link goes, the card and the notes stay.
    document.getElementById('call-notes').value = 'Spoke to Priya';
    gated = true; globalThis.window.__staffifyShift.state = () => 'break'; globalThis.window.__staffifyShift.message = () => 'You are on a break. Resume your shift to call.';
    globalThis.window.dispatchEvent({ type: 'staffify-shift' }); await tick(20);
    assert.equal(document.getElementById('call-now'), null); assert.match(dom2.text(document.body), /Resume your shift to call/);
    assert.equal(document.getElementById('call-notes').value, 'Spoke to Priya', 'a pause does not touch the notes');
    assert.ok(dom2.queryAll(document.body, '#shift-gate-action').some(b => dom2.text(b) === 'Resume shift'));
    delete globalThis.window.__staffifyShift;
    restore2();
});
