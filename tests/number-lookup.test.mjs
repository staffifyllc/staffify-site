// Who is this number: the lookup behind the dialer search, for a number on no prospect card.
// Paul, 2026-10-27: "search bars not working, who is this person??" about (404) 550-5181, Nick at
// Realkit calling Milton back from his own phone 33 minutes after a message on Realkit's line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { likelyRecords, likelyReason, recordsWithNumber, areaOf, fmtPhone } from '../api/_number-lookup.js';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
const { quoCalls } = await import('../api/number-lookup.js');

const REALKIT = { id: 'rk', company: 'Realkit', recipient: 'support@realkit.com', phone: '+14043135871', callContact: null,
    callHistory: [{ outcome: 'no_answer', at: '2026-10-26T21:10:55.629Z', caller: 'miltion@trystaffify.com', notes: 'GENERAL NUMBER of the business' },
        { outcome: 'callback', at: '2026-10-27T19:42:48.755Z', caller: 'miltion@trystaffify.com', notes: 'BIZ line , Nick was not in , left message' }] };
const ELSEWHERE = { id: 'tx', company: 'Austin Shots', phone: '+15125550100', callHistory: [{ outcome: 'voicemail', at: '2026-10-27T20:10:00Z', caller: 'miltion@trystaffify.com' }] };
const OLD = { id: 'old', company: 'Peach Media', phone: '+14045550100', callHistory: [{ outcome: 'voicemail', at: '2026-10-20T20:10:00Z' }] };
const CALL = { number: '4045505181', at: '2026-10-27T20:15:35.680Z' };

test('the Realkit call-back: same area code, a message 33 minutes before, named as likely with the reason', () => {
    const l = likelyRecords([ELSEWHERE, OLD, REALKIT], CALL);
    assert.equal(l.length, 1, 'other area codes and old touches are not named');
    assert.equal(l[0].recordId, 'rk'); assert.equal(l[0].minutesBefore, 33); assert.equal(l[0].businessLineEnds, '5871');
    assert.equal(l[0].note, 'BIZ line , Nick was not in , left message');
    assert.equal(likelyReason({ ...l[0], callerName: 'Milton' }, { area: areaOf(CALL.number) }), 'Milton logged a callback on their business line (ending 5871) 33 minutes before this call, same 404 area code.');
});

test('no likely match without an area code in common or a touch before the call', () => {
    assert.deepEqual(likelyRecords([ELSEWHERE], CALL), []);
    assert.deepEqual(likelyRecords([REALKIT], { ...CALL, at: '2026-10-27T19:00:00Z' }).length, 1, 'the earlier no-answer is still within three days');
    assert.deepEqual(likelyRecords([REALKIT], { ...CALL, at: '2026-10-26T20:00:00Z' }), [], 'nothing before that call');
    assert.deepEqual(likelyRecords([REALKIT], { number: '55505181', at: CALL.at }), [], 'not a whole number');
});

test('a number already on a card or typed into its notes is certain, not likely', () => {
    assert.deepEqual(recordsWithNumber([REALKIT], '(404) 313-5871').map(r => r.id), ['rk']);
    const noted = { ...REALKIT, phone: '+14040000000', callHistory: [{ notes: "his cell is 404 550 5181" }] };
    assert.deepEqual(recordsWithNumber([noted], '+1 404-550-5181').map(r => r.id), ['rk']);
    assert.equal(fmtPhone('+14045505181'), '(404) 550-5181');
});

test('Quo: every line is read, whichever spelling of participants it accepts, and an unread line is said', async () => {
    const seen = [];
    const fetchImpl = async url => {
        const u = String(url); seen.push(u);
        const ok = j => ({ ok: true, status: 200, json: async () => j });
        if (u.endsWith('/phone-numbers')) return ok({ data: [{ id: 'PN1', name: 'Primary' }, { id: 'PN2', number: '+15615550000' }] });
        if (u.includes('PN1') && u.includes('participants%5B%5D') === false && u.includes('participants[]')) return { ok: false, status: 400, json: async () => ({}) };
        if (u.includes('PN1') && u.includes('&participants=')) return ok({ data: [{ id: 'AC1', createdAt: '2026-10-27T20:15:35.680Z', direction: 'incoming', duration: 180, answeredAt: '2026-10-27T20:15:40Z', userId: 'USM22VeXVa' }] });
        if (u.includes('PN2')) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    const r = await quoCalls('4045505181', { fetchImpl, key: 'k' });
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0], { at: '2026-10-27T20:15:35.680Z', direction: 'incoming', seconds: 180, answered: true, line: 'Primary', userId: 'USM22VeXVa' });
    assert.equal(r.ok, false); assert.match(r.why, /1 of 2 Quo lines could not be read/, 'a line that could not be read is never reported as no calls');
    assert.ok(seen.some(u => u.includes('participants=%2B14045505181')), 'the number is sent in E.164');
    assert.deepEqual(await quoCalls('4045505181', { key: '' }), { ok: false, why: 'Quo is not configured', calls: [] });
});
