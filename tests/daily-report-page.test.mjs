// The report page, drawn: every figure with its source, unknowns as unknown, evidence one tap away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDom, install } from './helpers/fake-dom.mjs';
import { buildReport, dayRange } from '../api/_daily-report.js';

const html = readFileSync(new URL('../activity/report/index.html', import.meta.url), 'utf8');
const file = join(mkdtempSync(join(tmpdir(), 'report-')), 'report.mjs');
writeFileSync(file, html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]);
const DAY = '2026-10-23', at = hm => new Date(`${DAY}T${hm}:00-04:00`).toISOString();
const REPORT = buildReport({ user: { email: 'miltion@trystaffify.com', name: 'Milton Hodgson' }, day: DAY, generatedAt: at('23:30'), range: dayRange(DAY),
    quo: { configured: true, ok: true, seat: { email: 'milton@trystaffify.com', actorId: 'US1' }, complete: true, readAt: at('23:00'), calls: [{ id: 'c1', at: at('16:10'), number: '5125550001', answered: true, seconds: 20 }, { id: 'c2', at: at('16:30'), number: '5125550003', answered: false, seconds: 0 }] },
    hub: { ok: true, readAt: at('23:00'), stateUpdatedAt: at('22:59'), entries: [{ id: 'r1#0', recordId: 'r1', company: 'Riley Jones', recipient: 'tom@rj.com', at: at('16:11'), outcome: 'voicemail', numbers: ['5125550001'] }] },
    calendly: { configured: false, ok: false },
    activity: { measured: true, activeMinutes: 90, idleMinutes: 30, elapsedMinutes: 120, sessions: 1 },
    shift: { shifts: 1, clockedMinutes: 240, breakMinutes: 15, needsReview: 0, open: 0, list: [{ startedAt: at('16:00'), endedAt: at('20:15'), state: 'closed', clockedMinutes: 240, breakMinutes: 15, breaks: [{ startedAt: at('18:00'), endedAt: at('18:15') }] }] } });

test('an owner sees the day with sources, coverage, rates over their denominators and the evidence', async () => {
    const dom = makeDom({ href: 'https://www.gostaffify.com/activity/report/?user=miltion%40trystaffify.com&date=2026-10-23' }); const restore = install(dom);
    const app = document.createElement('main'); app.id = 'app'; document.body.append(app);
    const asked = [];
    globalThis.fetch = async url => { const u = String(url); asked.push(u); const ok = b => ({ ok: true, status: 200, json: async () => b });
        if (u.startsWith('/api/auth-me/')) return ok({ rep: { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin', financeAccess: true } });
        if (u.startsWith('/api/daily-report/?people=1')) return ok({ people: [{ email: 'miltion@trystaffify.com', name: 'Milton Hodgson' }] });
        if (u.startsWith('/api/daily-report/?user=')) return ok({ report: REPORT, stored: true, partialDay: false, delivery: { delivered: false, status: 'not_configured' }, schedule: { deliversAt: '8:05 AM Eastern, for the complete previous day', nextRunAt: '2026-10-27T12:05:00.000Z' } });
        return { ok: false, status: 404, json: async () => ({}) }; };
    await import(pathToFileURL(file).href + '?' + Date.now());
    await new Promise(r => setTimeout(r, 40));
    const text = dom.text(document.body);
    assert.match(text, /Friday, Oct 23, 2026/); assert.match(text, /Milton Hodgson/);
    assert.match(text, /generated .* and kept/); assert.match(text, /Slack: not sent: no private destination set/);
    assert.match(text, /2\s*verified dials\s*Quo/); assert.match(text, /1\s*outcomes logged on 1 prospects\s*Hub, manual/);
    assert.match(text, /unknown\s*discovery calls booked by prospects he called\s*Calendly/, 'Calendly not connected reads unknown');
    assert.ok(!/\u2014/.test(document.title || '') && !/\u2014/.test(text), 'no em dash on the page');
    assert.match(text, /Calendly is not connected, so meetings are unknown/);
    assert.match(text, /Line picked up\s*50%\s*1 of 2/);
    assert.match(text, /Numbers dialled with no outcome logged \(missing dispositions\)\s*1/);
    assert.match(text, /4:00 PM to 8:15 PM/); assert.match(text, /Hubstaff is the source for paid hours/);
    assert.match(text, /Quo dials \(2\)/); assert.match(text, /•••0003\s*no\s*0\s*no outcome logged/);
    assert.ok(!/\d{10}/.test(text.replace(/\d{4}-\d{2}-\d{2}/g, '')), 'no full number on the page');
    assert.ok(!/undefined|NaN|\[object/.test(text));
    assert.ok(asked.some(u => u === '/api/daily-report/?user=miltion%40trystaffify.com&date=2026-10-23'));
    restore();
});
