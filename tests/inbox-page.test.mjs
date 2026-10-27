// The Inbox page, driven: the list, one conversation, a reply that is cleaned and then sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, install } from './helpers/fake-dom.mjs';

const realTimeout = setTimeout;
const tick = (ms = 30) => new Promise(r => realTimeout(r, ms));
let dom, calls = [], connected = true;
const LIST = { mailbox: 'milton@trystaffify.com', connected: true, unreadable: 0, threads: [
    { id: 'thr0001', subject: 'Re: Nick, thanks for your time today', with: 'Nick Rossi', withAddr: 'support@realkit.com', snippet: 'Thursday works', at: new Date().toISOString(), unread: true, count: 2, lastFromMe: false, prospect: { recordId: 'rk', company: 'Realkit' } },
    { id: 'thr0002', subject: 'Your invoice', with: 'Billing', withAddr: 'billing@vendor.example', snippet: 'Receipt attached', at: '2026-10-20T15:00:00Z', unread: false, count: 1, lastFromMe: false, prospect: null },
] };
const THREAD = { mailbox: 'milton@trystaffify.com', gmailUrl: 'https://mail.google.com/mail/u/?authuser=milton%40trystaffify.com#all/thr0001', thread: LIST.threads[0], messages: [
    { id: 'm1', from: 'Milton Hodgson', fromAddr: 'milton@trystaffify.com', mine: true, at: '2026-10-27T21:00:00Z', text: 'Hi Nick,\n\nThanks for taking my call today.' },
    { id: 'm2', from: 'Nick Rossi', fromAddr: 'support@realkit.com', mine: false, at: '2026-10-27T22:00:00Z', text: 'Sounds good, Thursday works. <script>alert(1)</script>' },
] };

test('the inbox lists conversations, marks unread and prospects, opens one, and replies through the cleanup', async () => {
    dom = makeDom({ href: 'https://www.gostaffify.com/inbox/' }); install(dom);
    const app = document.createElement('main'); app.id = 'app'; document.body.append(app);
    const t = document.createElement('div'); t.id = 'ib-toast'; document.body.append(t);
    globalThis.window.__staffifyInboxTest = true;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url), body = opts.body ? JSON.parse(opts.body) : null; calls.push({ u, body });
        const ok = p => ({ ok: true, status: 200, json: async () => p });
        if (u.startsWith('/api/rep-inbox/?view=list')) return ok(connected ? LIST : { mailbox: 'milton@trystaffify.com', connected: false, connectUrl: '/api/rep-email/?action=connect&back=%2Finbox%2F' });
        if (u.startsWith('/api/rep-inbox/?thread=thr0001')) return ok(THREAD);
        if (u === '/api/rep-inbox/' && body.action === 'clean') { const b = body.body.replace(/\bi\b/g, 'I'); return ok({ subject: 'Re: Nick, thanks for your time today', body: b, changed: b !== body.body, changes: b !== body.body ? ['Capitalized I'] : [] }); }
        if (u === '/api/rep-inbox/' && body.action === 'reply') return ok({ sent: true, to: 'support@realkit.com', at: new Date().toISOString() });
        return { ok: false, status: 404, json: async () => ({ error: 'unexpected ' + u }) };
    };
    const mod = await import('../assets/js/rep-inbox.js?' + Date.now());
    await mod.load();
    const rows = document.querySelectorAll('.ib-row');
    assert.equal(rows.length, 2);
    assert.ok(rows[0].classList.contains('unread'), 'unread is marked');
    assert.match(dom.text(rows[0]), /Nick Rossi\s*Realkit/, 'a prospect is named with their company');
    assert.match(dom.text(document.body), /milton@trystaffify\.com · 1 unread/);
    await mod.openThread('thr0001');
    const pane = dom.text(document.getElementById('ib-pane'));
    assert.match(pane, /Thanks for taking my call today/); assert.match(pane, /Thursday works/);
    assert.match(pane, /<script>alert\(1\)<\/script>/, 'their words are shown as text, never run');
    assert.ok(document.querySelectorAll('a').some(a => a.href === '/dialer/?open=rk'), 'the card is one click away');
    assert.ok(!document.querySelector('.ib-row.unread'), 'opened is read here');
    const area = document.getElementById('ib-reply-text');
    assert.match(area.value, /^Hi Nick,/);
    area.value = 'Hi Nick,\n\ni will send the invite.';
    document.getElementById('ib-send').click(); await tick();
    assert.equal(calls.filter(c => c.body && c.body.action === 'reply').length, 0, 'the first press only cleans');
    assert.match(area.value, /I will send the invite/);
    assert.match(dom.text(document.querySelector('.ib-review')), /Capitalized I/);
    document.getElementById('ib-send').click(); await tick();
    const sent = calls.filter(c => c.body && c.body.action === 'reply').pop();
    assert.equal(sent.body.threadId, 'thr0001'); assert.match(sent.body.body, /I will send/); assert.ok(!('to' in sent.body), 'the browser never names the recipient');
    assert.match(dom.text(document.getElementById('ib-toast')), /Reply sent to support@realkit\.com/);
});

test('not connected yet: one button to connect, back to the inbox', async () => {
    connected = false;
    const mod = await import('../assets/js/rep-inbox.js?' + Date.now() + 'b');
    await mod.load();
    const c = document.getElementById('ib-connect');
    assert.ok(c); assert.equal(c.href, '/api/rep-email/?action=connect&back=%2Finbox%2F');
    assert.match(dom.text(document.body), /Connect milton@trystaffify\.com/);
});
