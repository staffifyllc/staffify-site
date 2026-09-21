// The public role-map request path, with every dependency faked. Nothing here touches a network, an
// inbox, a Slack channel or a calendar. Each test exists because the review found the real failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, saveRequest, withinRate, PUBLIC_MESSAGE, MAX_SUBMISSIONS_KEPT } from '../api/_rolemap.js';

/** Enough Upstash surface for this endpoint, with a switch to make any command fail. */
function fakeRedis() {
    const S = { str: new Map(), hash: new Map(), list: new Map(), z: new Map() };
    const h = (k) => { if (!S.hash.has(k)) S.hash.set(k, new Map()); return S.hash.get(k); };
    return {
        _: S, failOn: new Set(),
        async set(k, v, opts = {}) {
            if (this.failOn.has('set')) throw new Error('boom');
            if (opts.nx && S.str.has(k)) return null;
            S.str.set(k, String(v)); return 'OK';
        },
        async hsetnx(k, f, v) { const m = h(k); if (m.has(f)) return 0; m.set(f, String(v)); return 1; },
        async hset(k, obj) {
            if (this.failOn.has('hset')) throw new Error('boom');
            const m = h(k); for (const [f, v] of Object.entries(obj)) m.set(f, String(v)); return 1;
        },
        async hget(k, f) { const m = S.hash.get(k); return m && m.has(f) ? m.get(f) : null; },
        async hgetall(k) { const m = S.hash.get(k); return m ? Object.fromEntries(m) : null; },
        async hincrby(k, f, n) { const m = h(k); const v = Number(m.get(f) || 0) + n; m.set(f, String(v)); return v; },
        async rpush(k, v) { if (!S.list.has(k)) S.list.set(k, []); S.list.get(k).push(v); return S.list.get(k).length; },
        async ltrim(k, a, b) { const l = S.list.get(k) || []; S.list.set(k, l.slice(a)); return 'OK'; },
        async zadd(k, { member }) { if (!S.z.has(k)) S.z.set(k, new Set()); S.z.get(k).add(member); return 1; },
        async incr(k) { const v = Number(S.str.get(k) || 0) + 1; S.str.set(k, String(v)); return v; },
        async expire() { return 1; },
    };
}

function fakeNotifiers() {
    const sent = { email: [], slack: [] };
    return {
        sent,
        notifyEmail: async (r) => { sent.email.push(r); return { ok: true }; },
        notifySlack: async (r) => { sent.slack.push(r); return { ok: true }; },
        failingEmail: async () => ({ ok: false, error: 'resend 500' }),
        skippedSlack: async () => ({ ok: false, skipped: 'SLACK_BOT_TOKEN missing' }),
    };
}

const deps = (redis, n, now = 1) => ({ redis, hash: (s) => 'H' + String(s).toLowerCase(), now: () => now,
    notifyEmail: n.notifyEmail, notifySlack: n.notifySlack });
const INPUT = { name: 'Sam Reyes', email: 'sam@example.com', company: 'Reyes Media',
    pain: 'I check every file before it goes out.', times: 'Tuesday mornings', source: 'x', path: '/real-estate-media/' };

test('the honeypot and a bad address are turned away before anything is written', () => {
    assert.equal(parseRequest({ ...INPUT, website: 'http://spam' }).bot, true);
    assert.match(parseRequest({ name: '', email: 'a@b.co' }).error, /name/i);
    assert.match(parseRequest({ name: 'A', email: 'nope' }).error, /email/i);
    assert.equal(parseRequest(INPUT).email, 'sam@example.com');
});

test('two identical submissions at the same moment make one record and one alert', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const [a, b] = await Promise.all([
        saveRequest(parseRequest(INPUT), deps(r, n)),
        saveRequest(parseRequest(INPUT), deps(r, n)),
    ]);
    assert.equal(a.saved && b.saved, true);
    assert.equal([a.created, b.created].filter(Boolean).length, 1, 'exactly one of them created the record');
    assert.equal(n.sent.email.length, 1, 'one alert, not two');
    assert.equal(n.sent.slack.length, 1);
    assert.equal(r._.hash.size, 1, 'one record key');
    assert.equal(r._.hash.get('pilot:req:Hsam@example.com').get('submissions'), '2');
});

test('a retry after a partial write does not make a second record', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    r.failOn.add('hset');                       // the claim lands, the rest of the write does not
    const first = await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.equal(first.saved, false);
    r.failOn.delete('hset');
    const retry = await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.equal(retry.saved, true);
    assert.equal(r._.hash.size, 1, 'still one record');
});

test('a public repeat never resets operator state or overwrites the first thing they told us', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), deps(r, n));
    const id = 'pilot:req:Hsam@example.com';
    // Paul works it: replies, sends the role map, then closes it.
    await r.hset(id, { state: 'CLOSED', answerKind: 'NOT_NOW', answerWords: 'Ask me in January.',
        roleMapSentAt: '2026-09-22T10:00:00Z', owner: 'Paul' });
    const again = await saveRequest(parseRequest({ ...INPUT, pain: 'different text now', company: 'Renamed Co' }), deps(r, n, 2));
    assert.equal(again.created, false);
    const rec = await r.hgetall(id);
    assert.equal(rec.state, 'CLOSED', 'a public submission cannot reopen a closed request');
    assert.equal(rec.answerWords, 'Ask me in January.', 'their recorded answer survives');
    assert.equal(rec.roleMapSentAt, '2026-09-22T10:00:00Z', 'operator evidence survives');
    assert.equal(rec.pain, 'I check every file before it goes out.', 'the first thing Paul read is not overwritten');
    assert.equal(rec.company, 'Reyes Media');
    assert.ok(rec.newSubmissionAfterClose, 'but the new submission is flagged so he can see it');
    assert.equal(r._.list.get(id + ':subs').length, 2, 'both submissions are kept, in order');
});

test('a suppressed request is never resurrected by someone filling the form again', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), deps(r, n));
    const id = 'pilot:req:Hsam@example.com';
    await r.hset(id, { suppressed: 'true', state: 'CLOSED' });
    await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    const rec = await r.hgetall(id);
    assert.equal(rec.suppressed, 'true');
    assert.equal(rec.state, 'CLOSED');
});

test('the visitor gets the same answer whether or not we have seen them', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const a = await saveRequest(parseRequest(INPUT), deps(r, n));
    const b = await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    // The message is a constant, and neither result hands the caller a record id or a "we know you".
    assert.equal(PUBLIC_MESSAGE, 'Got it. Paul will write back himself, usually within one business day. Nothing is booked until you both agree on a time.');
    for (const out of [a, b]) {
        assert.equal(Object.prototype.hasOwnProperty.call(out, 'id'), false, 'no internal key is returned');
        assert.equal(Object.prototype.hasOwnProperty.call(out, 'email'), false);
    }
});

test('a saved request is not a delivered alert, and the record says which', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const out = await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.failingEmail, notifySlack: n.skippedSlack });
    assert.equal(out.saved, true);
    assert.equal(out.alerted, false);
    const rec = await r.hgetall('pilot:req:Hsam@example.com');
    assert.equal(rec.notifyEmail, 'resend 500');
    assert.equal(rec.notifySlack, 'SLACK_BOT_TOKEN missing');
    assert.ok(rec.notifyAt);
});

test('the submission history is bounded', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    for (let i = 0; i < MAX_SUBMISSIONS_KEPT + 4; i++) await saveRequest(parseRequest(INPUT), deps(r, n, i + 1));
    assert.equal(r._.list.get('pilot:req:Hsam@example.com:subs').length, MAX_SUBMISSIONS_KEPT);
});

test('the request lands where the operator queue reads it, and only there', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.ok(r._.z.get('pilot:requests').has('pilot:req:Hsam@example.com'));
    assert.ok(r._.z.get('leads:by_date').has('pilot:req:Hsam@example.com'));
    // Nothing else was written. In particular nothing that looks like a prospect or cohort record.
    const keys = [...r._.hash.keys(), ...r._.str.keys(), ...r._.list.keys(), ...r._.z.keys()];
    for (const k of keys) {
        assert.ok(/^(pilot:req|pilot:requests|leads:by_date|rl:rolemap)/.test(k), 'unexpected key written: ' + k);
    }
});

test('the rate limit holds, and a broken limiter never loses a real request', async () => {
    const r = fakeRedis();
    for (let i = 0; i < 5; i++) assert.equal(await withinRate(r, 'Hip'), true);
    assert.equal(await withinRate(r, 'Hip'), false);
    const broken = { async incr() { throw new Error('down'); }, async expire() {} };
    assert.equal(await withinRate(broken, 'Hip'), true);
    assert.equal(await withinRate(r, ''), true, 'no IP is never rate limited into silence');
});
