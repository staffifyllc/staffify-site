// A STOP has to actually stop us. This is the sweep that makes that true.
// ------------------------------------------------------------------
// 2026-10-22: a prospect replied "Stop" in Quo at 6:53pm. At 9pm he was still not on the
// do-not-contact list. The hourly sweep had run, reported ok: true with nothing found, and the
// diagnostics said it had read 81 conversations and seen ZERO incoming messages. It was walking
// the legacy /v1/messages route, which needs a phoneNumberId AND one participant per request, and
// it could not see inbound mail at all.
//
// The failure mode that matters is not "it broke". It is that it reported success while blind.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.QUO_API_KEY = 'test-key';
delete process.env.HUBSPOT_TOKEN;

const { scanOpenPhone } = await import('../api/optout.js');
const { isOptedOut } = await import('../api/_optout.js');

const msg = (from, text, at = '2026-10-22T22:53:00Z') => ({
    id: 'AC' + Math.random().toString(36).slice(2, 8),
    from, to: ['+15616179973'], text, direction: 'incoming', status: 'received',
    phoneNumberId: 'PN1', conversationId: 'CN1', userId: null, createdAt: at, updatedAt: at, media: [],
});

// Redis in memory, plus Quo. The Upstash client pipelines some reads, sends others flat, parses
// res.text() itself and asks for base64 values, so the stub honours the encoding header it is sent.
function stub({ messages = [], quoStatus = 200, store = {} } = {}) {
    const sets = {};
    const b64 = v => (typeof v === 'string' ? Buffer.from(v, 'utf8').toString('base64') : v);
    const asked = [];
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url));
        if (u.host === 'api.quo.com') {
            asked.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), version: (opts?.headers || {})['Quo-Api-Version'] });
            if (quoStatus !== 200) return { ok: false, status: quoStatus, text: async () => JSON.stringify({ message: 'upstream said no' }) };
            return { ok: true, status: 200, json: async () => ({ data: messages, nextCursor: null }) };
        }
        const encoded = (opts?.headers || {})['Upstash-Encoding'] === 'base64';
        const batch = JSON.parse(opts?.body || '[]');
        const answer = cmd => {
            const verb = String(cmd[0] || '').toUpperCase(), key = String(cmd[1] || '');
            if (verb === 'GET') return store[key] ?? null;
            if (verb === 'SET') { store[key] = cmd[2]; return 'OK'; }
            if (verb === 'SADD') { (sets[key] = sets[key] || new Set()).add(String(cmd[2])); return 1; }
            if (verb === 'SISMEMBER') return sets[key] && sets[key].has(String(cmd[2])) ? 1 : 0;
            if (verb === 'SMEMBERS') return [...(sets[key] || [])];
            if (verb === 'LPUSH' || verb === 'LTRIM') return 1;
            return null;
        };
        const enc = r => (!encoded ? r : Array.isArray(r) ? r.map(b64) : b64(r));
        const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: enc(answer(c)) })) : { result: enc(answer(batch)) };
        const text = JSON.stringify(payload);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
    };
    return { sets, store, asked };
}

test('an inbound STOP is found and the sender is suppressed', async () => {
    const { sets, asked } = stub({ messages: [msg('+12399007772', 'Stop')] });
    const out = await scanOpenPhone(0, true);
    assert.equal(out.ok, true);
    assert.equal(out.optOutsFound, 1);
    assert.equal(out.added.length, 1);
    assert.equal(out.added[0].phone, '2399007772');
    assert.ok(sets['optout:numbers']?.has('2399007772'), 'on the do-not-contact list');
    assert.equal(await isOptedOut({ phone: '+1 (239) 900-7772' }), true, 'and found however it is formatted');

    // It asks the question the old route could not answer.
    const req = asked.find(a => a.path === '/messages');
    assert.ok(req, 'it reads messages directly');
    assert.equal(req.version, '2026-03-30');
    assert.equal(req.params.direction, 'incoming', 'inbound only, which is the whole point');
    assert.ok(req.params['createdAt[gt]'], 'bounded by a watermark, not by walking threads');
    assert.ok(!('participants' in req.params), 'no per-person request, so nothing is skipped');
});

test('a sweep that cannot read Quo says so, and never reads as nobody opted out', async () => {
    stub({ quoStatus: 500 });
    const out = await scanOpenPhone(0, false);
    assert.equal(out.ok, false, 'a blind sweep is a failed sweep');
    assert.equal(out.reason, 'quo_read_failed');
    assert.ok(!('added' in out), 'it does not report an empty result it did not earn');
    assert.match(out.detail, /500/);
});

test('the watermark only moves when the window was finished and every suppression landed', async () => {
    const { store } = stub({ messages: [msg('+12399007772', 'Stop')] });
    await scanOpenPhone(0, false);
    const first = store['optout:scan:since'];
    assert.ok(first, 'a clean run records where it got to');

    // A failed read must not advance it, or that window is never looked at again.
    const held = stub({ quoStatus: 503, store: { 'optout:scan:since': first } });
    await scanOpenPhone(0, false);
    assert.equal(held.store['optout:scan:since'], first, 'a failed run leaves the bookmark alone');
});

test('the next run overlaps the last one rather than starting exactly where it stopped', async () => {
    const at = '2026-10-22T20:00:00Z';
    const { asked } = stub({ messages: [], store: { 'optout:scan:since': at } });
    await scanOpenPhone(0, false);
    const from = Date.parse(asked.find(a => a.path === '/messages').params['createdAt[gt]']);
    assert.ok(from < Date.parse(at), 'it looks back past the watermark');
    assert.ok(Date.parse(at) - from <= 3600000 + 1000, 'by about an hour, not by a week');
});

test('ordinary replies are not suppressed, and opt-out language is', async () => {
    const { sets } = stub({ messages: [
        msg('+15615550001', 'Stop by tomorrow and we can chat'),
        msg('+15615550002', 'sounds good, call me Friday'),
        msg('+15615550003', 'STOP'),
        msg('+15615550004', 'please remove me from your list'),
        msg('+15615550005', 'Who is this?'),
    ] });
    const out = await scanOpenPhone(0, false);
    assert.equal(out.optOutsFound, 2, 'the real ones, and only those');
    assert.ok(sets['optout:numbers'].has('5615550003'));
    assert.ok(sets['optout:numbers'].has('5615550004'));
    assert.ok(!sets['optout:numbers'].has('5615550001'), '"stop by tomorrow" is a person being friendly');
    assert.ok(!sets['optout:numbers'].has('5615550002'));
});

test('a message with no sender cannot suppress an empty number', async () => {
    const { sets } = stub({ messages: [msg('', 'stop'), msg('+15615550009', 'stop')] });
    const out = await scanOpenPhone(0, false);
    assert.equal(out.added.length, 1);
    assert.ok(!(sets['optout:numbers'] || new Set()).has(''));
});

// ------------------------------------------------------------------
// The second hole, found the same night. All eight recovered opt-outs were suppressed by PHONE and
// linked to NO email: the contacts those texts reached carry a number and nothing else. Every
// outbound gate keys on email, so each of those eight stayed callable and kept their sequence.
test('a number that replied STOP blocks the call and the send, even with no email linked', async () => {
    const calls = [];
    const crm = await import('../api/_outreach-crm.js');
    const optout = await import('../api/_optout.js');

    // Suppressed by phone only, exactly as the sweep leaves them.
    const suppressedNumbers = new Set(['2399007772']);
    const realIsOptedOut = optout.isOptedOut;
    assert.equal(typeof realIsOptedOut, 'function');

    // Drive the real gate through its own CRM call, with the contact the sweep actually produced:
    // a phone number and an empty email.
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url));
        if (u.host === 'api.hubapi.com') {
            calls.push(u.pathname);
            if (u.pathname.includes('/account-info')) return { ok: true, status: 200, json: async () => ({ portalId: 51666712 }) };
            return { ok: true, status: 200, json: async () => ({ total: 1, results: [{ id: '248485814606', properties: { email: '', phone: '+1 239 900-7772', firstname: 'Leo', lastname: 'W' } }] }) };
        }
        // Upstash: the number is on the list, the address is not.
        const encoded = (opts?.headers || {})['Upstash-Encoding'] === 'base64';
        const b64 = v => (typeof v === 'string' ? Buffer.from(v, 'utf8').toString('base64') : v);
        const batch = JSON.parse(opts?.body || '[]');
        const answer = cmd => {
            const verb = String(cmd[0] || '').toUpperCase(), key = String(cmd[1] || '');
            if (verb === 'SISMEMBER') return key === 'optout:numbers' && suppressedNumbers.has(String(cmd[2])) ? 1 : 0;
            return null;
        };
        const enc = r => (!encoded ? r : Array.isArray(r) ? r.map(b64) : b64(r));
        const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: enc(answer(c)) })) : { result: enc(answer(batch)) };
        const text = JSON.stringify(payload);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
    };
    process.env.HUBSPOT_TOKEN = 'test-token';

    const reason = await crm.draftBlockReason({ recipient: 'leopaul@example.com', company: 'Realty Media 360' }, { requireVerified: false });
    assert.match(String(reason), /replied STOP/, 'the number alone is enough to stop us');
    delete process.env.HUBSPOT_TOKEN;
});
