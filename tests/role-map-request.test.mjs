// The public role-map request path, with every dependency faked. Nothing here touches a network, an
// inbox, a Slack channel or a calendar. Each test exists because the review found the real failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, saveRequest, withinRate, retryAlert, channelsNeeded, notifyState, mergeNotify,
    idempotencyKey, UNKNOWN_PREFIX, PUBLIC_MESSAGE, MAX_SUBMISSIONS_KEPT } from '../api/_rolemap.js';

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
        // Just enough Lua for the token-checked lease release the real client performs.
        async eval(script, keys, args) {
            if (/GET.*DEL/.test(script)) {
                if (S.str.get(keys[0]) === args[0]) { S.str.delete(keys[0]); return 1; }
                return 0;
            }
            return 0;
        },
    };
}

function fakeNotifiers({ emailDelayMs = 0 } = {}) {
    const sent = { email: [], slack: [] };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    return {
        sent,
        notifyEmail: async (r) => { if (emailDelayMs) await wait(emailDelayMs); sent.email.push(r); return { ok: true }; },
        notifySlack: async (r) => { sent.slack.push(r); return { ok: true }; },
        failingEmail: async () => ({ ok: false, error: 'resend 400' }),
        skippedSlack: async () => ({ ok: false, skipped: 'SLACK_BOT_TOKEN missing' }),
        // The interesting case: we asked and never found out.
        unknownEmail: async () => ({ ok: false, unknown: true, error: 'the send did not answer' }),
        throwingSlack: async () => { throw new Error('socket hang up'); },
    };
}

const deps = (redis, n, now = 1) => ({ redis, hash: (s) => 'H' + String(s).toLowerCase(), now: () => now,
    notifyEmail: n.notifyEmail, notifySlack: n.notifySlack });
const ID = 'pilot:req:Hsam@example.com';
const INPUT = { name: 'Sam Reyes', email: 'sam@example.com', company: 'Reyes Media',
    pain: 'I check every file before it goes out.', times: 'Tuesday mornings', source: 'x', path: '/real-estate-media/' };

test('the honeypot and a bad address are turned away before anything is written', () => {
    assert.equal(parseRequest({ ...INPUT, website: 'http://spam' }).bot, true);
    assert.match(parseRequest({ name: '', email: 'a@b.co' }).error, /name/i);
    assert.match(parseRequest({ name: 'A', email: 'nope' }).error, /email/i);
    assert.equal(parseRequest(INPUT).email, 'sam@example.com');
});

test('a second caller arriving mid-send does not send a second copy', async () => {
    // The first sender is held open for 40ms, which is exactly the window the old code had: the
    // second caller reads a record with no result written yet and used to take that as a gap to fill.
    const r = fakeRedis(), n = fakeNotifiers({ emailDelayMs: 40 });
    const first = saveRequest(parseRequest(INPUT), deps(r, n));
    await new Promise((res) => setTimeout(res, 10));
    const second = await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    const a = await first;

    assert.equal(a.saved && second.saved, true);
    assert.equal([a.created, second.created].filter(Boolean).length, 1, 'exactly one created the record');
    assert.equal(n.sent.email.length, 1, 'one email, because the lease was held while the first was in flight');
    assert.equal(n.sent.slack.length, 1);
    assert.ok(second.inFlight.includes('email'), 'and the second caller says why it sent no email');
    assert.ok(a.inFlight.includes('slack') || (a.settled || []).includes('slack'),
        'the slow caller finds Slack already done and does not repeat it');
    assert.equal(r._.hash.size, 1, 'one record key');
    assert.equal(r._.hash.get(ID).get('submissions'), '2');
});

test('two simultaneous submissions make one record and one alert', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const [a, b] = await Promise.all([
        saveRequest(parseRequest(INPUT), deps(r, n)),
        saveRequest(parseRequest(INPUT), deps(r, n)),
    ]);
    assert.equal(a.saved && b.saved, true);
    assert.equal(n.sent.email.length, 1);
    assert.equal(n.sent.slack.length, 1);
});

test('two retries pressed at once produce one send, and the loser says it is in flight', async () => {
    const r = fakeRedis(), n = fakeNotifiers({ emailDelayMs: 40 });
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.failingEmail });
    assert.equal(n.sent.email.length, 0, 'the first email was refused');

    const dep = { redis: r, notifyEmail: n.notifyEmail, notifySlack: n.notifySlack, now: () => 9 };
    const [x, y] = await Promise.all([retryAlert(ID, dep), retryAlert(ID, dep)]);
    assert.equal(n.sent.email.length, 1, 'one email between the two of them');
    const attempts = [...x.attempted, ...y.attempted];
    assert.deepEqual(attempts, ['email'], 'only one retry actually sent');
    const idle = x.attempted.length ? y : x;
    assert.ok(idle.inFlight.includes('email') || (idle.note || '').includes('in flight'),
        'the other says a retry is already running, rather than pretending it sent');
});

test('the email carries a stable idempotency key, so a retry is the same email to the provider', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.failingEmail });
    await retryAlert(ID, { redis: r, notifyEmail: n.notifyEmail, notifySlack: n.notifySlack, now: () => 9 });
    assert.equal(n.sent.email[0].idempotencyKey, idempotencyKey(ID, 'email', 'first'));
    assert.ok(n.sent.email[0].idempotencyKey.length <= 256);
});

test('a retry after a partial write makes no second record AND still alerts', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    r.failOn.add('hset');                       // the write fails part way through
    const first = await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.equal(first.saved, false);
    assert.equal(n.sent.email.length, 0, 'nothing was sent for a request that was not stored');
    assert.equal(r._.str.has(ID + ':alerted'), false,
        'and no alert claim was burned, which is what starved the retry before');

    r.failOn.delete('hset');
    const retry = await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.equal(retry.saved, true);
    assert.equal(r._.hash.size, 1, 'still one record');
    assert.equal(n.sent.email.length, 1, 'the recovered request alerts');
    assert.equal(n.sent.slack.length, 1);
    assert.equal(retry.notifyState, 'delivered');
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

test('a saved request is not a delivered alert, and the record says which channel', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const out = await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.failingEmail, notifySlack: n.skippedSlack });
    assert.equal(out.saved, true);
    assert.equal(out.notifyState, 'failed');
    const rec = await r.hgetall('pilot:req:Hsam@example.com');
    assert.equal(rec.notifyEmail, 'resend 400');
    assert.equal(rec.notifySlack, 'SLACK_BOT_TOKEN missing');
    assert.ok(rec.notifyEmailAt && rec.notifySlackAt);
});

test('one channel through is partial, not "nobody was alerted"', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const out = await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifySlack: n.skippedSlack });
    const rec = await r.hgetall('pilot:req:Hsam@example.com');
    assert.equal(rec.notifyEmail, 'ok');
    assert.equal(rec.notifySlack, 'SLACK_BOT_TOKEN missing');
    assert.equal(notifyState(rec), 'partial');
    assert.equal(out.notifyState, 'partial');
    assert.deepEqual(channelsNeeded(rec), ['slack'], 'only the channel that failed is still owed');
});

test('a repeat submission heals the channel that failed and never repeats the one that worked', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifySlack: n.skippedSlack });
    assert.equal(n.sent.email.length, 1);
    assert.equal(n.sent.slack.length, 0);
    // Slack is configured by the time they write again.
    const out = await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    assert.equal(n.sent.email.length, 1, 'the email that already landed is not sent twice');
    assert.equal(n.sent.slack.length, 1, 'the one that never landed is tried again');
    assert.equal(out.notifyState, 'delivered');
});

test('a repeat on a fully delivered request sends nothing at all', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), deps(r, n));
    await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    await saveRequest(parseRequest(INPUT), deps(r, n, 3));
    assert.equal(n.sent.email.length, 1);
    assert.equal(n.sent.slack.length, 1);
});

test('the operator retry re-sends only what never got through', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.failingEmail });
    const id = 'pilot:req:Hsam@example.com';
    assert.equal(n.sent.slack.length, 1);
    assert.equal(n.sent.email.length, 0);

    const out = await retryAlert(id, { redis: r, notifyEmail: n.notifyEmail, notifySlack: n.notifySlack, now: () => 5 });
    assert.equal(out.ok, true);
    assert.deepEqual(out.attempted, ['email'], 'Slack already landed, so Slack is left alone');
    assert.equal(n.sent.slack.length, 1, 'no duplicate Slack message');
    assert.equal(n.sent.email.length, 1);
    assert.equal(out.state, 'delivered');

    const again = await retryAlert(id, { redis: r, notifyEmail: n.notifyEmail, notifySlack: n.notifySlack, now: () => 6 });
    assert.deepEqual(again.attempted, [], 'pressing it again sends nothing');
    assert.equal(n.sent.email.length, 1);
});

test('a merge never downgrades a channel that already succeeded', () => {
    const before = { notifyEmail: 'ok', notifySlack: 'boom' };
    const patch = mergeNotify(before, { email: { ok: false, error: 'resend 500' }, slack: { ok: true } }, 'T');
    assert.equal(patch.notifyEmail, undefined, 'a success is never overwritten by a later failure');
    assert.equal(patch.notifySlack, 'ok');
    assert.equal(notifyState({ ...before, ...patch }), 'delivered');
});

test('a request nobody has tried to alert about reads as pending, not failed', () => {
    assert.equal(notifyState({}), 'pending');
    assert.equal(notifyState({ notifyEmail: 'boom' }), 'failed');
    assert.equal(notifyState({ notifyEmail: 'ok', notifySlack: 'ok' }), 'delivered');
    assert.equal(notifyState({ notifyEmail: UNKNOWN_PREFIX + 'timeout' }), 'uncertain');
    assert.equal(notifyState({ notifyEmail: 'ok', notifySlack: UNKNOWN_PREFIX + 'timeout' }), 'partial');
});

test('a send that never answered is unknown, and is never retried on its own', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    const out = await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifyEmail: n.unknownEmail });
    assert.equal(out.notifyState, 'partial', 'Slack landed, email is unknown');
    const rec = await r.hgetall(ID);
    assert.ok(rec.notifyEmail.startsWith(UNKNOWN_PREFIX));
    assert.deepEqual(channelsNeeded(rec), [], 'a repeat submission will not quietly send it again');
    assert.deepEqual(channelsNeeded(rec, { includeUnknown: true }), ['email'], 'but a person may ask for it');

    // A later repeat must not touch it.
    await saveRequest(parseRequest(INPUT), deps(r, n, 2));
    assert.equal(n.sent.email.length, 0);
});

test('a sender that throws is recorded as unknown, not as a failure', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifySlack: n.throwingSlack });
    const rec = await r.hgetall(ID);
    assert.ok(rec.notifySlack.startsWith(UNKNOWN_PREFIX), rec.notifySlack);
    assert.match(rec.notifySlack, /socket hang up/);
});

test('retrying an unknown Slack message says plainly that it may post twice', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    await saveRequest(parseRequest(INPUT), { ...deps(r, n), notifySlack: n.throwingSlack });
    // The lease on an unknown is deliberately left to expire, so clear it the way time would.
    r._.str.delete(ID + ':lease:slack:first');
    const out = await retryAlert(ID, { redis: r, notifyEmail: n.notifyEmail, notifySlack: n.notifySlack, now: () => 9 });
    assert.deepEqual(out.attempted, ['slack']);
    assert.match(out.caution, /no provider-side duplicate protection/);
});

test('a result we could not write down is reported as uncertain, not as delivered', async () => {
    const r = fakeRedis(), n = fakeNotifiers();
    // Let the record persist, then break writes before the results are stored.
    const real = r.hset.bind(r);
    let calls = 0;
    r.hset = async function (k, obj) { calls++; if (calls > 1) throw new Error('down'); return real(k, obj); };
    const out = await saveRequest(parseRequest(INPUT), deps(r, n));
    assert.equal(out.saved, true);
    assert.equal(n.sent.email.length, 1, 'the email did go out');
    assert.equal(out.resultsRecorded, false);
    assert.equal(out.notifyState, 'uncertain', 'because what we stored is behind what happened');
    assert.equal(out.alerted, false, 'and we do not claim it was alerted');
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
