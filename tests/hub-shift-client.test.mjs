// The shift bar, driven: Start, the clock, Break, Resume, End, the phone-link gate, other tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeDom } from './helpers/fake-dom.mjs';

const SRC = readFileSync(new URL('../assets/js/hub-shift.js', import.meta.url), 'utf8');

function boot({ required = true, failReads = false, known = null } = {}) {
    const dom = makeDom({ href: 'https://www.gostaffify.com/dialer/' });
    const { document } = dom;
    const header = document.createElement('header'); header.className = 'topbar portal-header'; document.body.append(header);
    let now = Date.parse('2026-10-23T20:00:00Z');
    class FakeDate extends Date { static now() { return now; } }
    // A small server with the same contract as api/shift.js.
    let shift = null; const posts = []; let gets = 0; let slowNext = false;
    if (known !== null) dom.localStorage.setItem('staffify-shift-required', known);
    const stateOf = () => { if (!shift) return 'off'; const b = shift.breaks.slice(-1)[0]; return b && !b.endedAt ? 'break' : 'on'; };
    const view = () => { const st = stateOf(); return { now: new FakeDate(now).toISOString(), required, state: st, gate: { required, state: st, allowed: !required || st === 'on', reason: st === 'on' ? null : st, message: st === 'on' ? null : st === 'break' ? 'You are on a break. Resume your shift to call.' : 'Start your shift to call.' }, shift, today: { list: shift ? [shift] : [] } }; };
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    const fetch = async (url, opts = {}) => {
        if (!opts.method) { gets++; if (failReads) throw new Error('offline'); if (slowNext) { const v = view(); slowNext = false; await new Promise(r => setTimeout(r, 40)); return ok(v); } return ok(view()); }
        const b = JSON.parse(opts.body); posts.push(b);
        if (b.action === 'start') { if (shift) return { ok: false, status: 409, json: async () => ({ error: 'A shift is already running, possibly from another tab or device.', reason: 'already_on_shift', ...view() }) }; shift = { id: 'sh1', startedAt: new FakeDate(now).toISOString(), breaks: [] }; }
        else if (b.action === 'break') shift.breaks.push({ startedAt: new FakeDate(now).toISOString(), endedAt: null });
        else if (b.action === 'resume') shift.breaks[shift.breaks.length - 1].endedAt = new FakeDate(now).toISOString();
        else if (b.action === 'end') { const ended = { ...shift, status: 'closed', clockedMinutes: 42 }; shift = null; return ok({ ...view(), ended }); }
        return ok(view());
    };
    const intervals = []; const setInterval = fn => { intervals.push(fn); return intervals.length; };
    const winListeners = {}; const window = { confirm: () => true, addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, dispatchEvent: ev => { for (const fn of winListeners[ev.type] || []) fn(ev); return true; } };
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
    const run = () => new Function('window', 'document', 'fetch', 'location', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'localStorage', 'CustomEvent', 'BroadcastChannel', SRC)(window, document, fetch, dom.location, setInterval, () => {}, () => 0, () => {}, FakeDate, dom.localStorage, CustomEvent, undefined);
    run();
    return { dom, document, window, header, posts, slow: () => { slowNext = true; }, get gets() { return gets; }, advance: ms => { now += ms; }, clockTick: () => intervals[1] && intervals[1](), poll: () => intervals[0] && intervals[0](), fire: (t, ev) => { for (const f of winListeners[t] || []) f(ev); }, rerun: run, server: () => ({ shift, state: stateOf() }) };
}
const settle = () => new Promise(r => setTimeout(r, 15));
const bar = s => s.header.querySelector('.portal-shift');
const btn = (s, label, root) => s.dom.queryAll(root || bar(s), 'button').find(b => s.dom.text(b) === label);
const telLink = s => { const a = s.document.createElement('a'); a.setAttribute('href', 'tel:+15125550001'); a.textContent = '+1 512 555 0001'; s.document.body.append(a); return a; };
const clickTel = (s, a) => a.dispatchEvent(s.dom.makeEvent('click', { target: a }));

test('off shift: the bar offers Start, a phone link is stopped and explained, and Start from the explanation opens the clock', async () => {
    const s = boot(); await settle();
    assert.ok(bar(s), 'the bar is in the header'); assert.match(s.dom.text(bar(s)), /Off shift/); assert.ok(btn(s, 'Start shift'));
    assert.equal(s.window.__staffifyShift.blocked(), true);
    const a = telLink(s);
    assert.equal(clickTel(s, a), false, 'the click is prevented');
    const box = s.document.getElementById('shift-gate');
    assert.ok(box, 'an explanation appears'); assert.match(s.dom.text(box), /Calling from the Hub needs a running shift\.\s*Start your shift to call\./);
    assert.equal(s.posts.length, 0, 'nothing was sent yet');
    btn(s, 'Start shift', box).click(); await settle();
    assert.deepEqual(s.posts, [{ action: 'start', page: '/dialer/' }]);
    assert.equal(s.document.getElementById('shift-gate'), null, 'the explanation goes once the shift runs');
    assert.match(s.dom.text(bar(s)), /On shift/); assert.match(s.dom.text(bar(s)), /00:00:00/); assert.ok(btn(s, 'Break')); assert.ok(btn(s, 'End shift'));
    s.advance(65000); s.clockTick();
    assert.equal(s.dom.text(bar(s).querySelector('.ps-time')), '00:01:05', 'the clock runs from the server timestamp');
    assert.equal(clickTel(s, a), true, 'on shift, the phone link works');
    assert.equal(s.window.__staffifyShift.blocked(), false);
});

test('break pauses the clock and closes the gate again; resume reopens it; end asks and reports what was clocked', async () => {
    const s = boot(); await settle();
    btn(s, 'Start shift').click(); await settle();
    s.advance(10 * 60000);
    btn(s, 'Break').click(); await settle();
    assert.equal(s.posts.slice(-1)[0].action, 'break'); assert.match(s.dom.text(bar(s)), /On break/); assert.ok(btn(s, 'Resume'));
    s.advance(60000); s.clockTick();
    assert.equal(s.dom.text(bar(s).querySelector('.ps-time')), '00:10:00', 'clocked time does not grow on a break');
    assert.equal(s.dom.text(bar(s).querySelector('.ps-break')), 'break 00:01:00');
    const a = telLink(s);
    assert.equal(clickTel(s, a), false, 'on a break, calls are off');
    assert.match(s.dom.text(s.document.getElementById('shift-gate')), /Resume your shift to call/);
    btn(s, 'Resume shift', s.document.getElementById('shift-gate')).click(); await settle();
    assert.equal(s.posts.slice(-1)[0].action, 'resume'); assert.match(s.dom.text(bar(s)), /On shift/);
    assert.equal(clickTel(s, a), true);
    let asked = 0; s.window.confirm = () => { asked++; return false; };
    btn(s, 'End shift').click(); await settle();
    assert.equal(asked, 1); assert.equal(s.posts.slice(-1)[0].action, 'resume', 'declining the confirm sends nothing');
    s.window.confirm = () => true;
    btn(s, 'End shift').click(); await settle();
    assert.equal(s.posts.slice(-1)[0].action, 'end'); assert.match(s.dom.text(bar(s)), /Off shift/);
    assert.match(s.dom.text(s.document.getElementById('shift-flash')), /Shift ended: 42m clocked/);
    assert.equal(clickTel(s, a), false, 'ended: calls are off again');
});

test('other tabs: a change pings them, a ping or a poll re-reads the server, and a second tab sees the running shift', async () => {
    const s = boot(); await settle();
    const before = s.gets;
    btn(s, 'Start shift').click(); await settle();
    assert.ok(s.dom.localStorage.getItem('staffify-shift-rev'), 'other tabs are pinged through storage');
    s.fire('storage', { key: 'staffify-shift-rev' }); await settle();
    assert.equal(s.gets, before + 1, 'a ping re-reads the server');
    s.poll(); await settle();
    assert.equal(s.gets, before + 2, 'so does the minute poll');
    s.document.visibilityState = 'visible'; s.document.dispatchEvent(s.dom.makeEvent('visibilitychange')); await settle();
    assert.equal(s.gets, before + 3, 'and becoming visible');
    // A second press of Start from another tab is refused by the server and the bar shows the truth.
    const r = await s.window.__staffifyShift.start();
    assert.equal(r.ok, false); assert.equal(r.reason, 'already_on_shift'); assert.match(s.dom.text(bar(s)), /On shift/);
    assert.equal(s.server().state, 'on', 'still one shift');
});

test('an owner with no shift sees no bar and no gate; a second copy of the script does nothing', async () => {
    const s = boot({ required: false }); await settle();
    assert.equal(bar(s), null);
    assert.equal(clickTel(s, telLink(s)), true, 'owners are never gated');
    const gets = s.gets; s.rerun(); await settle();
    assert.equal(s.gets, gets, 'the second copy returned at once');
});

test('a phone link tapped before the first read answers is held, then explained for a caller off shift', async () => {
    const s = boot();
    const a = telLink(s);
    assert.equal(clickTel(s, a), false, 'held while the first read is out');
    await settle();
    assert.match(s.dom.text(s.document.getElementById('shift-gate')), /Calling from the Hub needs a running shift/);
    assert.notEqual(s.dom.location.href, 'tel:+15125550001', 'the call did not go through');
});

test('the same early tap goes through once the read says the shift is running', async () => {
    const s = boot({ required: false });
    const a = telLink(s);
    assert.equal(clickTel(s, a), false, 'held while the first read is out');
    await settle();
    assert.equal(s.dom.location.href, 'tel:+15125550001', 'then dialled');
    assert.equal(s.document.getElementById('shift-gate'), null);
});

test('a failed read fails closed for a caller and offers to try again; an owner this browser knows stays open', async () => {
    const s = boot({ failReads: true }); await settle();
    const a = telLink(s);
    assert.equal(clickTel(s, a), false, 'never told: blocked');
    assert.match(s.dom.text(s.document.getElementById('shift-gate')), /Your shift could not be checked just now\..*Try again/);
    const s2 = boot({ failReads: true, known: '1' }); await settle();
    assert.equal(clickTel(s2, telLink(s2)), false, 'last seen as a caller: blocked');
    const s3 = boot({ failReads: true, known: '0' }); await settle();
    assert.equal(clickTel(s3, telLink(s3)), true, 'last seen as an owner: open');
});

test('a slow read sent before a press does not overwrite the press', async () => {
    const s = boot(); await settle();
    s.slow(); const pending = s.window.__staffifyShift.refresh();   // a poll goes out and hangs, reading "off"
    await s.window.__staffifyShift.start();                         // the rep presses Start meanwhile
    await pending;
    assert.equal(s.window.__staffifyShift.state(), 'on', 'the older read was discarded');
    assert.match(s.dom.text(bar(s)), /On shift/);
});
