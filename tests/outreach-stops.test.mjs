// Paul, 2026-10-30: "when my sales person, Madison or Milton ... are hitting not interested, that person is not getting
// removed from our system".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { STOPS, requestStop, takeStops, doneStops, applyStops } from '../api/_outreach-stops.js';
import { mime } from '../api/_outreach-gmail.js';

function listKv() {
    const lists = new Map();
    const L = k => { if (!lists.has(k)) lists.set(k, []); return lists.get(k); };
    return { lists, async rpush(k, v) { L(k).push(v); return L(k).length; }, async lrange(k, a, b) { const l = L(k); return l.slice(a, b < 0 ? l.length + b + 1 : b + 1); }, async ltrim(k, a, b) { const l = L(k); lists.set(k, l.slice(a, b < 0 ? l.length + b + 1 : b + 1)); return 'OK'; } };
}

test('stop requests queue in order and leave only once applied', async () => {
    const kv = listKv();
    assert.deepEqual(await requestStop(kv, {}), { ok: false, reason: 'nothing to stop' });
    await requestStop(kv, { email: ' Ravi@RoverPass.com ', hiringId: 'hire:1', by: 'miltion@trystaffify.com', why: 'Not interested / stop on a call', at: 'T1' });
    await requestStop(kv, { hiringId: 'hire:2', by: 'madison@gostaffify.com', at: 'T2' });
    const got = await takeStops(kv);
    assert.deepEqual(got.map(q => [q.email, q.hiringId]), [['ravi@roverpass.com', 'hire:1'], [null, 'hire:2']]);
    await doneStops(kv, 1);
    assert.equal((await takeStops(kv)).length, 1);
    await doneStops(kv, 0);
    assert.equal(kv.lists.get(STOPS).length, 1);
});

test('applyStops: every row for the person, by address or their card’s drip row, is suppressed; strangers are not', () => {
    const state = { suppressions: ['old@x.com'], records: [
        { id: 'drip', campaignId: 'staffify-hiring-now-outreach', hiringId: 'hire:1', recipient: 'ravi@roverpass.com', status: 'sent', sentTouches: 1 },
        { id: 'talent', campaignId: 'staffify-talent-network-outreach', recipient: 'RAVI@roverpass.com', status: 'prepared' },
        { id: 'moved', campaignId: 'staffify-hiring-now-outreach', hiringId: 'hire:2', recipient: 'old-address@co.com', status: 'draft_saved', draftId: 'd' },
        { id: 'other', campaignId: 'staffify-hiring-now-outreach', hiringId: 'hire:3', recipient: 'someone@else.com', status: 'sent' },
        { id: 'done', recipient: 'gone@x.com', status: 'suppressed', stopped: { by: 'x' } },
    ] };
    const r = applyStops(state, [
        { email: 'ravi@roverpass.com', hiringId: 'hire:1', by: 'miltion@trystaffify.com', why: 'Not interested / stop on a call', at: 'T' },
        { email: null, hiringId: 'hire:2', by: 'madison@gostaffify.com' },
        { email: 'nobody@nowhere.com', hiringId: null },
        { email: 'gone@x.com' },
        null, {},
    ], Date.parse('2026-10-30T18:00:00Z'));
    const by = id => state.records.find(x => x.id === id);
    assert.equal(r.rows, 3);
    for (const id of ['drip', 'talent', 'moved']) assert.equal(by(id).status, 'suppressed', id);
    assert.equal(by('other').status, 'sent');
    assert.deepEqual(by('drip').stopped, { by: 'miltion@trystaffify.com', why: 'Not interested / stop on a call', at: 'T' });
    assert.deepEqual(by('done').stopped, { by: 'x' }, 'an earlier stop is left as it was');
    assert.deepEqual(state.suppressions.sort(), ['gone@x.com', 'nobody@nowhere.com', 'old-address@co.com', 'old@x.com', 'ravi@roverpass.com']);
    assert.deepEqual(r.unmatched, ['nobody@nowhere.com']);
});

test('worker mail: Reply-To lists each valid address once, and no header can be injected', () => {
    const decode = raw => Buffer.from(raw, 'base64url').toString();
    const head = decode(mime({ sender: 'paul@staffifyhq.com', to: 'ravi@roverpass.com', subject: 'Hi', body: 'x', id: 'a', replyTo: ['paul@staffifyhq.com', 'HELLO@gostaffify.com', 'hello@gostaffify.com', 'milton@trystaffify.com', 'not an address', null] }));
    assert.match(head, /\r\nReply-To: paul@staffifyhq\.com, hello@gostaffify\.com, milton@trystaffify\.com\r\n/);
    assert.doesNotMatch(decode(mime({ sender: 'a@b.com', to: 'c@d.com', subject: 'Hi', body: 'x', id: 'a' })), /Reply-To/);
    assert.doesNotMatch(decode(mime({ sender: 'a@b.com', to: 'c@d.com', subject: 'Hi', body: 'x', id: 'a', replyTo: ['x@y.com\r\nBcc: evil@z.com'] })), /evil|Bcc/);
});
