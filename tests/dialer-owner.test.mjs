// An owner's dialer: their own follow-ups, not the pool the reps are working.
// Paul, 2026-10-27: "its still showing me like 780 people to call, but thats not true, it should be
// followed if my guys are already doing it I shouldn't be".
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, install } from './helpers/fake-dom.mjs';

const realTimeout = setTimeout;
const tick = (ms = 40) => new Promise(r => realTimeout(r, ms));
const PAUL = 'hello@gostaffify.com';
const rec = (id, o = {}) => ({ id, company: 'Co ' + id, recipient: id + '@x.com', campaignId: 'staffify-agency-outreach', callReady: true, unclaimed: true, dueForMe: false, mine: false, callOwner: null, sentTouches: 4, lastSentAt: '2026-10-01T18:00:00Z', callContact: { phone: '+1512555010' + id.slice(-1), phoneStatus: 'available' }, callHistory: [], ...o });

async function boot(records) {
    const dom = makeDom({ href: 'https://www.gostaffify.com/dialer/' }); install(dom);
    globalThis.setInterval = () => 0;
    const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url); const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/outreach-queue/')) return ok({ revision: 1, viewer: PAUL, viewerOwner: true, records, tasks: [] });
        if (u.startsWith('/api/call-hold/')) return ok(opts.body ? { ok: true, hold: { by: PAUL, kind: 'open', until: new Date(Date.now() + 240000).toISOString() } } : { me: PAUL, holds: { p3: { by: 'miltion@trystaffify.com', name: 'Milton', kind: 'calling', until: new Date(Date.now() + 600000).toISOString(), ms: 600000 } } });
        if (u.startsWith('/api/outreach-call-brief/')) return ok({ callable: true, checkedAt: new Date().toISOString(), company: 'Co', name: 'Pat', phone: '+15125550100', dial: { alternates: [] }, opener: 'Hey Pat', stages: [], tree: { open: { choices: [] } }, objections: [], events: [] });
        return ok({});
    };
    await import('../assets/js/dialer-workspace.js?' + Date.now() + Math.random());
    await tick(80);
    return dom;
}

test('an owner with no follow-ups of their own is not handed the reps\' pool', async () => {
    const dom = await boot([rec('p1'), rec('p2'), rec('p3')]);
    const text = dom.text(document.body);
    assert.match(text, /No follow-ups of yours/);
    assert.match(text, /2 people are left in the team pool\. Milton working now\./, 'the pool, less the card Milton is on, and who is working');
    assert.equal(document.querySelectorAll('.dw-oc').length, 0, 'no card is put in front of him');
    document.querySelectorAll('button').find(b => dom.text(b) === 'Open the team pool').click();
    await tick(80);
    assert.match(dom.text(document.querySelector('.dw-bar')), /Team pool/, 'the pool is one click away when he wants it');
    assert.match(location.search, /pool=team/);
});

test('an owner\'s own follow-up is what their dialer opens on', async () => {
    const due = new Date(Date.now() - 3600000).toISOString();
    const dom = await boot([rec('p1'), rec('p2', { unclaimed: false, mine: true, dueForMe: true, callOwner: PAUL, callOutcome: 'callback', nextCallAt: due })]);
    assert.match(dom.text(document.querySelector('.dw-bar')), /Your follow-ups/);
    assert.match(dom.text(document.querySelector('.dw-bar')), /1 of 1/);
    assert.match(dom.text(document.querySelector('#dw-pool')), /Team pool · 1 left/);
});

test('a caller\'s owned real estate media callback is in the Paused area, not tomorrow\'s worklist', async () => {
    // PM refinement, 2026-10-27: "keep REP cards out of the default active worklist for every caller,
    // including owned REP follow-ups ... in a clearly paused campaign/review area".
    const due = new Date(Date.now() - 3600000).toISOString();
    const MILTON = 'miltion@trystaffify.com';
    const dom = makeDom({ href: 'https://www.gostaffify.com/dialer/' }); install(dom);
    globalThis.setInterval = () => 0;
    const app = document.createElement('div'); app.id = 'app'; document.body.append(app);
    const records = [
        rec('h1', { campaignId: 'staffify-tobit-outreach' }),
        rec('rep', { unclaimed: false, mine: true, dueForMe: false, pausedFollowUp: true, callOwner: MILTON, callOutcome: 'callback', nextCallAt: due }),
    ];
    const briefs = [];
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url); const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/outreach-call-brief/')) briefs.push(u.split('id=')[1]);
        if (u.startsWith('/api/outreach-queue/')) return ok({ revision: 1, viewer: MILTON, viewerOwner: false, records, tasks: [] });
        if (u.startsWith('/api/call-hold/')) return ok(opts.body ? { ok: true, hold: { by: MILTON, kind: 'open', until: new Date(Date.now() + 240000).toISOString() } } : { me: MILTON, holds: {} });
        if (u.startsWith('/api/outreach-call-brief/')) return ok({ callable: true, checkedAt: new Date().toISOString(), company: 'Co', name: 'Pat', phone: '+15125550100', dial: { alternates: [] }, opener: 'Hey Pat', stages: [], tree: { open: { choices: [] } }, objections: [], events: [] });
        return ok({});
    };
    await import('../assets/js/dialer-workspace.js?' + Date.now() + 'paused');
    await tick(80);
    assert.match(dom.text(document.querySelector('.dw-bar')), /1 of 1/, 'only the live campaign\'s card is work');
    assert.deepEqual(briefs, ['h1'], 'the live card is opened; the paused one is not');
    assert.match(dom.text(document.querySelector('#dw-paused')), /Paused · 1/, 'the paused callback is kept and visible');
    document.getElementById('dw-paused').click();
    await tick(80);
    assert.match(dom.text(document.querySelector('.dw-bar')), /Paused: real estate media/);
    assert.equal(briefs[briefs.length - 1], 'rep', 'opened only on purpose');
});
