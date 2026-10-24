// The Activity page as an owner sees it: declared shifts next to observed activity, and the
// correction of a forgotten shift posted with a note.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDom, install } from './helpers/fake-dom.mjs';

const html = readFileSync(new URL('../activity/index.html', import.meta.url), 'utf8');
const SRC = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const file = join(mkdtempSync(join(tmpdir(), 'activity-')), 'activity.mjs');
writeFileSync(file, SRC);
const MILTON = 'miltion@trystaffify.com';
const forgotten = { id: 'sh-old', startedAt: '2026-10-24T00:02:00.000Z', endedAt: null, archivedAt: '2026-10-24T13:00:00.000Z', status: 'needs_review', flags: ['open_over_12h', 'never_ended'], breaks: [], state: 'needs_review', elapsedMinutes: 778, breakMinutes: 0, clockedMinutes: 778, day: '2026-10-23' };
const closed = { id: 'sh-ok', startedAt: '2026-10-22T22:00:00.000Z', endedAt: '2026-10-23T00:45:00.000Z', status: 'closed', flags: [], breaks: [{ startedAt: '2026-10-22T23:00:00.000Z', endedAt: '2026-10-22T23:10:00.000Z' }], state: 'closed', elapsedMinutes: 165, breakMinutes: 10, clockedMinutes: 155, day: '2026-10-22' };
const day = (d, over) => ({ day: d, measured: true, activeMinutes: 40, elapsedMinutes: 60, idleMinutes: 20, sessions: 1, sessionList: [], counts: {}, meaningful: 3, events: [], firstSeen: null, lastSeen: null, shift: { list: [], clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, shifts: 0 }, ...over });
const WEEK = () => ({ email: MILTON, from: '2026-10-19', to: '2026-10-23', days: [day('2026-10-19', { measured: false }), day('2026-10-20', { measured: false }), day('2026-10-21'), day('2026-10-22', { shift: { list: [closed], clockedMinutes: 155, breakMinutes: 10, needsReview: 0, open: 0, shifts: 1 } }), day('2026-10-23', { shift: { list: [forgotten], clockedMinutes: 0, breakMinutes: 0, needsReview: 1, open: 0, shifts: 1 } })],
    totals: { activeMinutes: 120, elapsedMinutes: 180, idleMinutes: 60, meaningful: 9, sessions: 3, measuredDays: 3, clockedMinutes: 155, breakMinutes: 10, shifts: 2, shiftsNeedingReview: 1, shiftsOpen: 0 },
    openShiftOutsideRange: { startedAt: '2026-10-24T13:00:00.000Z', day: '2026-10-24' },
    definitions: { heartbeatMs: 60000, idleCutoffMs: 300000, sessionGapMs: 1800000, retainDays: 120, measured: ['This is not payroll.'], declared: ['Declared shift time is what you clocked.'], timezone: 'America/New_York' } });

test('the owner sees clocked time, each shift with its flag, the open one outside the range, and can set the end of a forgotten shift with a note', async () => {
    const dom = makeDom({ href: 'https://www.gostaffify.com/activity/?user=' + encodeURIComponent(MILTON) + '&from=2026-10-19&to=2026-10-23' }); const restore = install(dom);
    const app = document.createElement('main'); app.id = 'app'; document.body.append(app);
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => { const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null; calls.push({ u, body });
        const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/auth-me/')) return ok({ rep: { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin', financeAccess: true } });
        if (u.startsWith('/api/activity/?users=1')) return ok({ users: [{ email: 'hello@gostaffify.com' }, { email: MILTON }] });
        if (u.startsWith('/api/activity/?user=')) return ok(WEEK());
        if (u.startsWith('/api/shift/') && body && body.action === 'correct') return ok({ ok: true, shift: { ...forgotten, status: 'corrected', correctedEndedAt: body.endedAt } });
        return { ok: false, status: 404, json: async () => ({ error: 'nope' }) }; };
    await import(pathToFileURL(file).href + '?' + Date.now());
    await new Promise(r => setTimeout(r, 40));
    const text = dom.text(document.body);
    assert.match(text, /2h 35m\s*clocked, declared shifts · 1 needs review/, 'the clocked total leads, with the review count');
    assert.match(text, /A shift started .*Oct 24 at .* has been open for more than 12 hours/, 'the forgotten shift outside the range is called out');
    const heads = dom.queryAll(document.body, 'th').map(th => dom.text(th));
    assert.deepEqual(heads.slice(0, 3), ['Day', 'Shift (declared)', 'Active (est.)']);
    const rows = dom.queryAll(document.body, 'tbody tr').map(tr => dom.text(tr));
    assert.ok(rows.some(r => /Oct 22.*6:00 PM to 8:45 PM · 2h 35m · 10m break/.test(r)), 'a closed shift: start to end, clocked, break');
    assert.ok(rows.some(r => /Oct 23.*8:02 PM to never ended · needs review\s*Review/.test(r)), 'the forgotten shift says so and is tagged');
    assert.ok(rows.some(r => /Oct 19.*Not measured/.test(r)));
    // Drill into the 23rd and set the end time.
    const tr = dom.queryAll(document.body, 'tbody tr').find(r => /Oct 23/.test(dom.text(r)));
    dom.queryAll(tr, 'button').find(b => dom.text(b) === 'Events').click();
    const drill = tr.parentNode.children[tr.parentNode.children.indexOf(tr) + 1];
    assert.match(dom.text(drill), /Declared shifts.*8:02 PM to never ended · needs review: never ended, not counted/);
    const fix = dom.queryAll(drill, 'button').find(b => dom.text(b) === 'Set end time');
    assert.ok(fix, 'an owner can set the end');
    const answers = ['2026-10-23 22:00', 'Milton said he stopped at ten'];
    globalThis.prompt = () => answers.shift();
    fix.click(); await new Promise(r => setTimeout(r, 40));
    const posted = calls.find(c => c.body && c.body.action === 'correct');
    assert.ok(posted, 'the correction was posted');
    assert.deepEqual(posted.body, { action: 'correct', user: MILTON, day: '2026-10-23', shiftId: 'sh-old', endedAt: new Date('2026-10-23T22:00').toISOString(), note: 'Milton said he stopped at ten' });
    assert.ok(calls.filter(c => c.u.startsWith('/api/activity/?user=')).length >= 2, 'the week re-renders from the server after a correction');
    assert.ok(!/undefined|\[object/.test(dom.text(document.body)));
    restore();
});

test('a rep sees their own week without correction controls', async () => {
    const dom = makeDom({ href: 'https://www.gostaffify.com/activity/' }); const restore = install(dom);
    const app = document.createElement('main'); app.id = 'app'; document.body.append(app);
    globalThis.fetch = async url => { const u = String(url); const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/auth-me/')) return ok({ rep: { email: MILTON, name: 'Milton', role: 'rep', financeAccess: false } });
        if (u.startsWith('/api/activity/?user=')) return ok({ ...WEEK(), openShiftOutsideRange: null });
        return { ok: false, status: 403, json: async () => ({ error: 'Owners and admins only' }) }; };
    await import(pathToFileURL(file).href + '?' + Date.now() + 'rep');
    await new Promise(r => setTimeout(r, 40));
    const text = dom.text(document.body);
    assert.match(text, /Your Hub activity/); assert.match(text, /8:02 PM to never ended · needs review/);
    assert.equal(document.querySelector('select'), null, 'no person picker for a rep');
    const tr = dom.queryAll(document.body, 'tbody tr').find(r => /Oct 23/.test(dom.text(r)));
    dom.queryAll(tr, 'button').find(b => dom.text(b) === 'Events').click();
    assert.ok(!dom.queryAll(document.body, 'button').some(b => /Set end time|Correct end/.test(dom.text(b))), 'no correction controls for a rep');
    restore();
});
