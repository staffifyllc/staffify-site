// Milton could not sign in at all. This is why, and that it stays fixed.
// ------------------------------------------------------------------
// 2026-10-22: his Google account is milton@trystaffify.com, the Hub rep record was provisioned as
// "miltion", getRep found nothing, and the sign-in was refused with "That Google account is not
// set up as a rep yet." A caller on a 30-day trial was locked out of the platform mid-shift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loginAliases, ALIAS_PAIRS } from '../api/_login-aliases.js';

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://example.invalid';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test';
const auth = await import('../api/_auth.js');

// The Upstash client sends some reads pipelined and some flat, parses res.text() itself, and asks
// for base64 values. Answering in plain text silently returns mangled fields rather than failing,
// so the stub honours the encoding header it is actually sent.
function redisStub(store) {
    const b64 = v => (typeof v === 'string' ? Buffer.from(v, 'utf8').toString('base64') : v);
    globalThis.fetch = async (url, opts) => {
        const encoded = (opts?.headers || {})['Upstash-Encoding'] === 'base64';
        const batch = JSON.parse(opts?.body || '[]');
        const answer = cmd => {
            const verb = String(cmd[0] || '').toUpperCase(), key = String(cmd[1] || '');
            if (verb === 'HGETALL') return store[key] ? Object.entries(store[key]).flat() : [];
            if (verb === 'GET') return store[key] ?? null;
            return null;
        };
        const enc = r => (!encoded ? r : Array.isArray(r) ? r.map(b64) : b64(r));
        const payload = Array.isArray(batch[0])
            ? batch.map(c => ({ result: enc(answer(c)) }))
            : { result: enc(answer(batch)) };
        const text = JSON.stringify(payload);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
    };
}

test('the correct spelling finds the rep record filed under the misspelling', async () => {
    redisStub({ 'rep:miltion@trystaffify.com': { email: 'miltion@trystaffify.com', name: 'Milton', role: 'rep' } });
    const rep = await auth.getRep('milton@trystaffify.com');
    assert.ok(rep, 'he is let in');
    assert.equal(rep.name, 'Milton');
    // The record that exists stays canonical, so his call ownership, outcomes and credited fees
    // do not split across two identities depending on which address he signed in with.
    assert.equal(rep.email, 'miltion@trystaffify.com');
});

test('it works in both directions, and an exact match never pays for the alias lookup', async () => {
    redisStub({ 'rep:milton@trystaffify.com': { email: 'milton@trystaffify.com', name: 'Milton', role: 'rep' } });
    assert.equal((await auth.getRep('miltion@trystaffify.com'))?.email, 'milton@trystaffify.com');
    assert.equal((await auth.getRep('milton@trystaffify.com'))?.email, 'milton@trystaffify.com');
});

test('somebody with no rep record is still refused, alias or not', async () => {
    redisStub({});
    assert.equal(await auth.getRep('milton@trystaffify.com'), null);
    assert.equal(await auth.getRep('miltion@trystaffify.com'), null);
    assert.equal(await auth.getRep('stranger@example.com'), null);
    assert.equal(await auth.getRep(''), null);
});

test('an unrelated address is never aliased onto somebody else', async () => {
    // The whole risk of this mechanism is one rep reading another rep's queue. It is an explicit
    // list, and it must not behave like a fuzzy matcher.
    redisStub({ 'rep:madison@gostaffify.com': { email: 'madison@gostaffify.com', name: 'Madison', role: 'rep' } });
    assert.equal(await auth.getRep('madisonn@gostaffify.com'), null, 'a near-miss is not a match');
    assert.equal(await auth.getRep('madison@trystaffify.com'), null, 'a different domain is not a match');
    assert.deepEqual(loginAliases('madison@gostaffify.com'), ['madison@gostaffify.com']);
});

test('the alias list stays small and declared', () => {
    assert.ok(ALIAS_PAIRS.length <= 3, 'this list is for known provisioning mistakes, not for growth');
    for (const pair of ALIAS_PAIRS) {
        assert.equal(pair.length, 2);
        assert.ok(pair.every(a => /^[^@]+@[^@]+\.[^@]+$/.test(a)), 'every entry is a real address');
    }
    assert.deepEqual(loginAliases('MILTON@TRYSTAFFIFY.COM'), ['milton@trystaffify.com', 'miltion@trystaffify.com']);
    assert.deepEqual(loginAliases(null), []);
});

// Paul, 2026-10-28: "I do want my metrics to also track on my end too". A Quo seat under another address counts the
// right person's dials, without becoming a way to sign in as them.
test('Madison\'s Quo seat (Molly Smith) counts as hers, and is not a sign-in alias', async () => {
    const { findSeat } = await import('../api/_quo.js');
    const users = [{ actorId: 'USM22VeXVa', email: 'molly@gostaffify.com', name: 'Molly Smith' }, { actorId: 'USx', email: 'miltion@trystaffify.com', name: 'Milton' }];
    assert.equal(findSeat(users, ['madison@gostaffify.com']).actorId, 'USM22VeXVa');
    assert.equal(findSeat(users, ['hello@gostaffify.com']), null);
    assert.deepEqual(loginAliases('madison@gostaffify.com'), ['madison@gostaffify.com'], 'never a login alias');
});
