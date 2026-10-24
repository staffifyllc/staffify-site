// My Day, rendered: promises first, then the next card, then everything else.
// ------------------------------------------------------------------
// Paul, 2026-10-23: "the dashboard should present call backs and highest priority items first for
// the salesperson." The page script runs against the fake DOM with a stubbed API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDom, install } from './helpers/fake-dom.mjs';

const ME = 'milton@trystaffify.com';
const html = readFileSync(new URL('../my-day/index.html', import.meta.url), 'utf8');
const SRC = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
// The page imports its modules by site path; in Node they are files next to this test.
const assets = pathToFileURL(new URL('../assets/js/', import.meta.url).pathname).href;
const file = join(mkdtempSync(join(tmpdir(), 'myday-')), 'my-day.mjs');
writeFileSync(file, SRC.replace(/from '\/assets\/js\//g, `from '${assets}`));

const hourAgo = new Date(Date.now() - 3600000).toISOString();
const inTwoHours = new Date(Date.now() + 5 * 60000).toISOString();   // minutes out, so it is still today in an evening run
const rec = (id, over) => ({ id, company: 'Co ' + id, recipient: id + '@x.com', campaignId: 'staffify-agency-outreach', callReady: true, unclaimed: true, lastSentAt: '2026-10-01T12:00:00Z', sentTouches: 4,
    callContact: { phone: '+1512555000' + id.replace(/\D/g, ''), phoneStatus: 'available' }, callHistory: [], ...over });
const QUEUE = { viewer: ME, records: [
    rec('r1', { company: 'Riley Jones Real Estate Media', industry: { key: 're-media', label: 'Real estate media' } }),
    rec('r2', { company: 'Loft & Light', callOwner: ME, unclaimed: false, dueForMe: true, callOutcome: 'callback', nextCallAt: hourAgo, callHistory: [{ at: hourAgo, outcome: 'callback', notes: 'after lunch', caller: ME, nextCallAt: hourAgo }] }),
    rec('r3', { company: 'Eastside Pics', callOwner: ME, unclaimed: false, callReady: false, callOutcome: 'voicemail', nextCallAt: inTwoHours, callHistory: [{ at: hourAgo, outcome: 'voicemail', notes: 'left one', caller: ME, nextCallAt: inTwoHours }] }),
    rec('r4', { company: 'Zenoti', campaignId: 'staffify-tobit-outreach', industry: { key: 'software', label: 'Software and security' } }),
], tasks: [{ id: 't1', title: 'Send pricing', dueAt: new Date(Date.now() + 2 * 60000).toISOString(), doneAt: null, company: 'Loft & Light', recordId: 'r2' }] };

test('the first panel is Right now: the overdue callback, then the task and the later one, then the next card', async () => {
    const dom = makeDom({ href: 'https://www.gostaffify.com/my-day/' }); const restore = install(dom);
    for (const id of ['greeting', 'sub', 'stats', 'panels']) { const n = document.createElement(id === 'greeting' ? 'h1' : 'div'); n.id = id; document.body.append(n); }
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => { const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ u, body });
        const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/auth-me/')) return ok({ rep: { email: ME, name: 'Milton Hodgson', role: 'caller' } });
        if (u.startsWith('/api/outreach-queue/?view=calls')) return body ? ok({ ok: true, task: { ...QUEUE.tasks[0], doneAt: 'now' } }) : ok(QUEUE);
        if (u.startsWith('/api/training-progress')) return ok({ me: { done: { a: true } } });
        if (u.startsWith('/api/shift/')) return body ? ok({ ok: true, state: 'on', gate: { allowed: true }, shift: { startedAt: new Date().toISOString(), breaks: [] } }) : ok({ required: true, state: 'off', gate: { required: true, state: 'off', allowed: false, reason: 'off', message: 'Start your shift to call.' }, shift: null });
        return { ok: false, status: 404, json: async () => ({}) }; };
    await import(pathToFileURL(file).href + '?' + Date.now());
    await new Promise(r => setTimeout(r, 40));
    const panels = dom.queryAll(document.getElementById('panels'), 'section');
    assert.equal(dom.text(panels[0].querySelector('h2')), 'Right now', 'promises come first');
    const rows = dom.queryAll(panels[0], 'li').map(li => dom.text(li));
    assert.match(rows[0], /^Loft & Light.*Callback · after lunch.*Overdue/, 'the overdue callback is the first row');
    assert.match(rows[1], /Send pricing|Eastside Pics/, 'then what is due later today');
    assert.ok(rows.some(r => /Riley Jones Real Estate Media.*Real estate media.*4 emails, no reply.*Ready/.test(r)), 'the next card in queue order, with its industry');
    assert.ok(!rows.some(r => /^Loft & Light.*Ready/.test(r)), 'a prospect already listed as a promise is not repeated as next up');
    const hrefs = dom.queryAll(panels[0], 'a').map(a => a.href);
    assert.ok(hrefs.includes('/dialer/?open=r2'), 'the callback opens its own card');
    assert.ok(hrefs.includes('/dialer/?open=r1'), 'and so does the next card');
    assert.equal(hrefs[hrefs.length - 1], '/dialer/?open=r2', 'the big button starts with the callback');
    assert.match(dom.text(document.getElementById('sub')), /1 callback waiting for you/);
    assert.match(dom.text(document.getElementById('stats')), /1due now.*later today.*coming up.*calls you logged today/);
    // Done on the task posts it and removes the row.
    const done = dom.queryAll(panels[0], 'button').find(b => dom.text(b) === 'Done');
    done.click(); await new Promise(r => setTimeout(r, 20));
    assert.ok(calls.some(c => c.body && c.body.action === 'task-done' && c.body.taskId === 't1'));
    assert.ok(!dom.queryAll(panels[0], 'li').some(li => /Send pricing/.test(dom.text(li))), 'the done task is gone');
    // Off shift: the first panel says so, with the press, before any card.
    const lead = document.getElementById('shift-lead');
    assert.ok(lead, 'the shift notice is on the page'); assert.match(dom.text(lead), /^Calling from the Hub needs a running shift\. Start your shift to call\. Notes and outcomes still save\. Start shift$/);
    assert.equal(panels[0].children.indexOf(lead) < panels[0].children.indexOf(panels[0].querySelector('ul')), true, 'it sits above the promises');
    document.getElementById('shift-lead-action').click(); await new Promise(r => setTimeout(r, 20));
    assert.ok(calls.some(c => c.u.startsWith('/api/shift/') && c.body && c.body.action === 'start' && c.body.page === '/my-day/'), 'Start posts the press');
    assert.match(dom.text(lead), /Shift running since .*Numbers show on the dialer now/);
    assert.equal(dom.text(panels[1].querySelector('h2')), 'Team calls');
    assert.ok(!/undefined|\[object/.test(dom.text(document.body)));
    restore();
});
