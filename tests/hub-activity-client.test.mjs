// The presence script: a heartbeat only from a visible tab that was used, and a leave on the way out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../assets/js/hub-activity.js', import.meta.url), 'utf8');

function boot() {
    const sent = [];
    const listeners = { doc: {}, win: {} };
    const on = bag => (t, fn) => { (bag[t] ||= []).push(fn); };
    const fire = (bag, t) => { for (const fn of bag[t] || []) fn({}); };
    let tick = null, now = Date.parse('2026-10-23T20:00:00Z');
    const document = { visibilityState: 'visible', addEventListener: on(listeners.doc) };
    const window = { addEventListener: on(listeners.win) };
    const navigator = { sendBeacon: (url, blob) => { sent.push({ beacon: true, url, body: JSON.parse(blob.text ? '{}' : '{}'), blob }); return true; } };
    const fetch = async (url, opts) => { sent.push({ beacon: false, url, body: JSON.parse(opts.body), keepalive: opts.keepalive }); return { ok: true }; };
    const location = { pathname: '/dialer/' };
    const setInterval = fn => { tick = fn; return 1; };
    const Date_ = { now: () => now };
    const fn = new Function('window', 'document', 'navigator', 'fetch', 'location', 'setInterval', 'clearInterval', 'Date', 'Blob', SRC);
    class Blob { constructor(parts) { this.parts = parts; } }
    fn(window, document, navigator, fetch, location, setInterval, () => {}, Date_, Blob);
    return { sent, tick: () => tick && tick(), advance: ms => { now += ms; }, show: () => { document.visibilityState = 'visible'; fire(listeners.doc, 'visibilitychange'); }, hide: () => { document.visibilityState = 'hidden'; fire(listeners.doc, 'visibilitychange'); }, interact: () => fire(listeners.doc, 'pointerdown'), pagehide: () => fire(listeners.win, 'pagehide'), window };
}
const beacons = s => s.sent.filter(x => x.beacon).map(x => JSON.parse(x.blob.parts[0]));
const posts = s => s.sent.filter(x => !x.beacon).map(x => x.body);

test('a page view on load, then one heartbeat a minute while visible and recently used', async () => {
    const s = boot();
    assert.deepEqual(posts(s), [{ action: 'event', kind: 'page_view', page: '/dialer/' }]);
    s.advance(30000); s.tick(); await 0;
    assert.equal(posts(s).length, 1, 'no heartbeat inside the first minute');
    s.advance(31000); s.tick(); await 0;
    assert.deepEqual(posts(s)[1], { action: 'heartbeat', page: '/dialer/' });
    s.advance(15000); s.tick(); await 0;
    assert.equal(posts(s).length, 2, 'ticks inside a minute do not repeat the heartbeat');
});

test('idle for five minutes stops the heartbeat; an interaction brings it back', async () => {
    const s = boot();
    s.advance(61000); s.tick(); await 0; assert.equal(posts(s).length, 2);
    s.advance(5 * 60000 + 1000); s.tick(); await 0;
    assert.equal(posts(s).length, 2, 'five quiet minutes: nothing sent, so nothing counted');
    s.interact(); s.tick(); await 0;
    assert.equal(posts(s).length, 3, 'a click resumes the heartbeat');
    assert.equal(s.window.__staffifyActivity.isActive(), true);
});

test('a hidden tab sends a leave by beacon and no heartbeats; showing it again resumes', async () => {
    const s = boot();
    s.advance(61000); s.hide(); await 0;
    assert.deepEqual(beacons(s), [{ action: 'event', kind: 'leave', page: '/dialer/' }]);
    s.advance(61000); s.tick(); await 0;
    assert.equal(posts(s).filter(p => p.action === 'heartbeat').length, 0, 'hidden: no heartbeat');
    s.show(); await 0;
    assert.equal(posts(s).filter(p => p.action === 'heartbeat').length, 1, 'visible again: a heartbeat at once');
    s.pagehide();
    assert.equal(beacons(s).length, 2, 'closing the tab sends a leave too');
    assert.ok(s.sent.every(x => !('notes' in x.body) && !('text' in x.body)), 'the payload is the action and the page, nothing else');
});

test('a second copy of the script on the same page does nothing', () => {
    const s = boot();
    const before = s.sent.length;
    const fn = new Function('window', 'document', 'navigator', 'fetch', 'location', 'setInterval', 'clearInterval', 'Date', 'Blob', SRC);
    fn(s.window, { visibilityState: 'visible', addEventListener() {} }, {}, async () => { s.sent.push({ dup: true }); }, { pathname: '/x/' }, () => 2, () => {}, { now: () => 0 }, class {});
    assert.equal(s.sent.length, before);
});
