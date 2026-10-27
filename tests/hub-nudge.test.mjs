// The idle prompt, driven: 10 quiet minutes on a running shift asks "Still on your shift?".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDom } from './helpers/fake-dom.mjs';

const SRC = readFileSync(new URL('../assets/js/hub-nudge.js', import.meta.url), 'utf8');
const T0 = Date.parse('2026-10-27T17:00:00Z');
const MIN = 60000;

function boot({ required = true, state = 'on', path = '/hub/', quo = { lastCallAt: null, callInProgress: false }, quoFails = false, startedAt = T0 - 60 * MIN, breaks = [] } = {}) {
    const dom = makeDom({ href: 'https://www.gostaffify.com' + path });
    const { document } = dom;
    document.title = 'Today · Staffify Sales';
    let now = T0;
    class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } }
    const posts = [], gets = [];
    let snap = { required, state, shift: state === 'off' ? null : { startedAt: new Date(startedAt).toISOString(), breaks } };
    const listeners = [];
    const breakCalls = [];
    const shiftApi = { snapshot: () => snap, onChange: fn => listeners.push(fn), break: async () => { breakCalls.push(now); snap = { ...snap, state: 'break' }; for (const fn of listeners) fn(snap); return { ok: true }; } };
    const fetch = async (url, opts = {}) => {
        if (opts.method === 'POST') { posts.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
        gets.push(String(url));
        if (quoFails) return { ok: false, status: 503, json: async () => ({ error: 'Quo could not be read' }) };
        return { ok: true, status: 200, json: async () => ({ reps: [{ dials: 3, lastCallAt: quo.lastCallAt, callInProgress: quo.callInProgress }], totalDials: 3 }) };
    };
    const winListeners = {};
    const location = dom.location;
    const window = { __staffifyShift: shiftApi, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, scrollTo() {} };
    const intervals = [];
    new Function('window', 'document', 'fetch', 'location', 'setInterval', 'clearInterval', 'Date', 'localStorage', 'BroadcastChannel', SRC)(
        window, document, fetch, location, fn => { intervals.push(fn); return 1; }, () => {}, FakeDate, dom.localStorage, undefined);
    return {
        dom, document, window, posts, gets, breakCalls, location,
        nudge: window.__staffifyNudge,
        advance: ms => { now += ms; }, get now() { return now; },
        setShift: s => { snap = s; for (const fn of listeners) fn(snap); },
        prompt: () => document.querySelector('.idle-prompt'),
        button: label => dom.queryAll(document.body, '.idle-prompt button').find(b => dom.text(b) === label),
        interact: () => document.dispatchEvent(dom.makeEvent('keydown', { target: document.body })),
    };
}
const kinds = s => s.posts.filter(p => p.action === 'event').map(p => p.kind);

test('a caller quiet for 10 minutes on a running shift is asked, once, with three answers', async () => {
    const s = boot({ quo: { lastCallAt: new Date(T0 - 30 * MIN).toISOString(), callInProgress: false } });
    s.advance(9 * MIN); assert.equal(await s.nudge.check(s.now), 'active', 'nine quiet minutes: nothing');
    s.advance(2 * MIN); assert.equal(await s.nudge.check(s.now), 'prompted');
    const text = s.dom.text(s.prompt());
    assert.match(text, /Still on your shift\?/); assert.match(text, /Nothing in the Hub or in Quo for 11 minutes\. Your next call is ready in the dialer\./);
    assert.match(text, /This only checks in\. Your shift time is not changed\./);
    assert.ok(s.button('Next call') && s.button("I'm on a call") && s.button('Take a break'));
    assert.equal(s.prompt().getAttribute('role'), 'alertdialog');
    assert.match(s.document.title, /^Still on shift\? · /, 'a hidden tab shows it in its title');
    assert.deepEqual(kinds(s), ['idle_prompt'], 'the prompt is recorded once');
    assert.equal(await s.nudge.check(s.now + MIN), 'showing'); assert.deepEqual(kinds(s), ['idle_prompt']);
    assert.ok(s.gets.every(u => u === '/api/quo-activity/'));
    assert.ok(!/—/.test(text), 'no em dash');
});

test('a call in Quo is not idle: a recent dial or one still going means no prompt', async () => {
    const recent = boot({ quo: { lastCallAt: new Date(T0 + 7 * MIN).toISOString(), callInProgress: false } });
    recent.advance(12 * MIN); assert.equal(await recent.nudge.check(recent.now), 'dialled'); assert.equal(recent.prompt(), null);
    const live = boot({ quo: { lastCallAt: new Date(T0 - 40 * MIN).toISOString(), callInProgress: true } });
    live.advance(25 * MIN); assert.equal(await live.nudge.check(live.now), 'on a call'); assert.equal(live.prompt(), null);
});

test('Quo unreadable: it still asks, because asking costs nothing', async () => {
    const s = boot({ quoFails: true });
    s.advance(10 * MIN); assert.equal(await s.nudge.check(s.now), 'prompted');
});

test('owners, breaks and an ended shift are never prompted; a shift just started or resumed gets its full 10 minutes', async () => {
    for (const opts of [{ required: false }, { state: 'break' }, { state: 'off' }]) {
        const s = boot(opts); s.advance(30 * MIN); assert.equal(await s.nudge.check(s.now), 'not running', JSON.stringify(opts)); assert.equal(s.prompt(), null);
    }
    const resumed = boot({ startedAt: T0 - 120 * MIN, breaks: [{ startedAt: new Date(T0 - 90 * MIN).toISOString(), endedAt: new Date(T0 + 5 * MIN).toISOString() }] });
    resumed.advance(12 * MIN); assert.equal(await resumed.nudge.check(resumed.now), 'active', 'resumed 7 minutes ago');
    resumed.advance(4 * MIN); assert.equal(await resumed.nudge.check(resumed.now), 'prompted');
});

test('any click, key or scroll in the Hub resets the 10 minutes', async () => {
    const s = boot();
    s.advance(8 * MIN); s.interact();
    s.advance(8 * MIN); assert.equal(await s.nudge.check(s.now), 'active');
    s.advance(3 * MIN); assert.equal(await s.nudge.check(s.now), 'prompted');
});

test('"I\'m on a call" closes it and asks again 10 minutes later if still quiet', async () => {
    const s = boot(); s.advance(10 * MIN); await s.nudge.check(s.now);
    s.button("I'm on a call").click();
    assert.equal(s.prompt(), null); assert.equal(s.document.title, 'Today · Staffify Sales', 'the title comes back');
    s.advance(9 * MIN); assert.equal(await s.nudge.check(s.now), 'snoozed');
    s.advance(1 * MIN); assert.equal(await s.nudge.check(s.now), 'prompted');
    assert.deepEqual(kinds(s), ['idle_prompt', 'idle_prompt_on_call', 'idle_prompt']);
});

test('"Next call" goes to the dialer from any other page, and stays put on the dialer', async () => {
    const s = boot({ path: '/hub/' }); s.advance(10 * MIN); await s.nudge.check(s.now);
    s.button('Next call').click();
    assert.equal(s.location.href, '/dialer/'); assert.equal(s.prompt(), null); assert.deepEqual(kinds(s), ['idle_prompt', 'idle_prompt_next']);
    const d = boot({ path: '/dialer/' }); d.advance(10 * MIN); await d.nudge.check(d.now);
    assert.match(d.dom.text(d.prompt()), /Your next call is on screen\./);
    d.button('Next call').click();
    assert.equal(d.location.href, 'https://www.gostaffify.com/dialer/'); assert.equal(d.prompt(), null);
});

test('"Take a break" uses the shift bar\'s own Break, and a break or end from anywhere closes the prompt', async () => {
    const s = boot(); s.advance(10 * MIN); await s.nudge.check(s.now);
    s.button('Take a break').click(); await new Promise(r => setTimeout(r, 5));
    assert.equal(s.breakCalls.length, 1); assert.equal(s.prompt(), null); assert.deepEqual(kinds(s), ['idle_prompt', 'idle_prompt_break']);
    const t = boot(); t.advance(10 * MIN); await t.nudge.check(t.now);
    t.setShift({ required: true, state: 'off', shift: null });
    assert.equal(t.prompt(), null, 'ending the shift in another tab closes it');
});

test('Escape answers "on a call", never a silent dismiss', async () => {
    const s = boot(); s.advance(10 * MIN); await s.nudge.check(s.now);
    s.prompt().dispatchEvent(s.dom.makeEvent('keydown', { key: 'Escape' }));
    assert.equal(s.prompt(), null); assert.deepEqual(kinds(s), ['idle_prompt', 'idle_prompt_on_call']);
});
