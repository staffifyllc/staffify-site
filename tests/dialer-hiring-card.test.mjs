// A Hiring now card in the real dialer script, on a fake DOM: what Milton sees and what a save posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, install } from './helpers/fake-dom.mjs';
import { callRow } from '../api/_hiring-intent.js';
import { hiringCallScript } from '../api/_call-scripts.js';

const ME = 'milton@trystaffify.com';
const NOW = Date.now();
const REC = {
    id: 'hire:6e8d066d903e5975', campaignId: 'staffify-hiring-intent', family: 'support', status: 'ready', priority: 5,
    company: { name: 'Canary Technologies Corp', website: 'https://canarytechnologies.com/', domain: 'canarytechnologies.com', identity: { how: 'backlink', evidenceUrl: 'https://canarytechnologies.com/jobs' } },
    job: { title: 'L1 Technical Support Agent (Spanish and English Speaking)', url: 'https://jobs.lever.co/canarytechnologies/6911aa00-dae1-458d-963d-779302f512ec', postedAt: '2026-09-14T19:57:15.510Z', checkedAt: new Date(NOW - 3600e3).toISOString(), state: 'open', restrictions: { hard: [], soft: [], offshore: 'Latin America' } },
    contact: { name: 'Harman Singh Narula', firstName: 'Harman', email: 'harman@canarytechnologies.com', status: 'verified' },
    phone: { number: '+18777391545', alternates: [], sourceUrl: 'https://canarytechnologies.com/', checkedAt: new Date(NOW - 3600e3).toISOString() },
    callHistory: [],
};
const row = callRow(REC, ME, NOW);
const script = hiringCallScript({ caller: 'Milton', callerEmail: ME, company: 'Canary Technologies Corp', firstName: 'Harman', jobTitle: REC.job.title, family: 'support', offshore: 'Latin America' });
const BRIEF = { callable: true, hiring: true, campaignId: 'staffify-hiring-intent', callerName: 'Milton', company: 'Canary Technologies Corp', website: 'https://canarytechnologies.com/', recipient: 'harman@canarytechnologies.com', name: 'Harman Singh Narula', title: null,
    identity: { status: 'researched', source: 'Findymail domain search, email verified', checkedAt: new Date(NOW).toISOString() }, industry: { key: 'hiring', label: 'Hiring now' }, location: 'Latin America',
    phone: '+18777391545', dial: { number: '+18777391545', label: 'Published on their own website', detail: 'The company line from canarytechnologies.com. It reaches the company, not a named person: ask for Harman Singh Narula.', alternates: [], sourceUrl: 'https://canarytechnologies.com/' },
    shiftGate: { allowed: true, required: true }, checkedAt: REC.job.checkedAt,
    why: 'Hiring now: L1 Technical Support Agent (Spanish and English Speaking), posted Sep 14. Still open on their careers page when checked. Nothing has been emailed; this is the first touch.',
    fact: 'Canary Technologies Corp is hiring a L1 Technical Support Agent.', source: { url: REC.job.url }, job: { title: REC.job.title, url: REC.job.url, more: [] }, companyIdentity: REC.company.identity, events: [], callHistory: [], ...script };

function stubApi() {
    const posts = [];
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url), body = opts.body ? JSON.parse(opts.body) : null;
        if (body) posts.push({ url: u, body });
        const ok = (p, status = 200) => ({ ok: status < 400, status, json: async () => p });
        if (u.startsWith('/api/outreach-queue/?view=calls')) return ok({ revision: 1, viewer: ME, viewerOwner: false, records: [row], tasks: [], shiftGate: { allowed: true, required: true } });
        if (u.startsWith('/api/outreach-call-brief/?id=')) return ok(BRIEF);
        if (u.startsWith('/api/call-hold/')) return ok(body ? { ok: true, hold: { by: ME, kind: body.kind || 'open', until: new Date(NOW + 60000).toISOString() } } : { me: ME, holds: {} });
        if (u.startsWith('/api/quo-activity/')) return ok({ reps: [] });
        if (u.startsWith('/api/calendly-link/')) return ok({ events: [] });
        if (u.startsWith('/api/prospect-names/')) return ok({ names: {} });
        return ok({ error: 'unexpected ' + u }, 404);
    };
    return posts;
}
const realTimeout = setTimeout;
const tick = (ms = 40) => new Promise(r => realTimeout(r, ms));

test('a Hiring now card reads as a first touch about their job post, with the job and the company line', async () => {
    const dom = makeDom(); install(dom);
    globalThis.setInterval = () => 0;
    globalThis.setTimeout = (fn, ms, ...a) => { const t = realTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
    const app = document.createElement('div'); app.id = 'app'; app.className = 'wrap'; document.body.append(app);
    const posts = stubApi();
    await import('../assets/js/dialer-workspace.js?hiring=' + Date.now());
    await tick(80);
    const text = dom.text(document.body);
    assert.match(text, /Canary Technologies Corp/);
    assert.match(text, /Hiring: L1 Technical Support Agent/, 'the meta line names the job, not an email count');
    assert.ok(!/emails · last/.test(text), 'no "4 emails" line on a card nobody emailed');
    assert.match(text, /Nothing has been emailed; this is the first touch/);
    assert.match(text, /this is Milton with Staffify\. I'm looking to speak with Harman, or the person in charge of hiring/);
    assert.ok(!/sent you over a few notes/i.test(text), 'the email campaigns opener never appears');
    assert.match(text, /\+18777391545/); assert.match(text, /Listed on their site/);
    const links = dom.queryAll(document.body, 'a').map(a => [dom.text(a), a.href]);
    assert.ok(links.some(([t, h]) => t === 'Job post' && h === REC.job.url), 'the official job post is one tap away');
    assert.ok(!links.some(([t]) => t === 'Email thread'), 'there is no email thread to open');
    // Texting is back on Hiring now cards (2026-10-28): the approved role text, signed by the caller, with the card id
    // so the server can refuse a card that has left the list.
    const textBtn = dom.queryAll(document.body, 'button').find(b => dom.text(b) === 'Text');
    assert.ok(textBtn, 'a Hiring now card has the Text button');
    const confirmWas = globalThis.window.confirm; globalThis.window.confirm = () => true;
    textBtn.click(); await tick();
    globalThis.window.confirm = confirmWas;
    const sent = posts.filter(x => x.url.startsWith('/api/send-text/')).pop();
    assert.equal(sent.body.id, REC.id); assert.equal(sent.body.motion, 'staffing'); assert.equal(sent.body.role, REC.job.title, 'the server trims it to the role words'); assert.equal(sent.body.rep, 'Milton');
    assert.ok(!('message' in sent.body), 'no message is composed in the browser');
    assert.match(text, /careers page links to this job board/);
    // Not interested / stop posts the card id, so the hiring store records it.
    const stop = document.querySelectorAll('.dw-oc').find(o => o.dataset.outcome === 'suppress');
    stop.click();
    document.getElementById('call-notes').value = 'Asked us to stop';
    document.getElementById('save-outcome').click();
    await tick(60);
    const save = posts.find(p => p.body && p.body.action === 'suppress');
    assert.ok(save, 'a suppress was posted');
    assert.equal(save.body.id, REC.id); assert.equal(save.body.email, 'harman@canarytechnologies.com');
    assert.ok(!/undefined|\[object/.test(text), 'nothing unrendered leaks into the page');
});
