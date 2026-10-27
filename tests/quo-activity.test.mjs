// Reading a rep's real call count out of Quo, and refusing to invent one.
// ------------------------------------------------------------------
// Paul, 2026-10-21: "can we tap into Quo's API to see how many calls Milton makes".
//
// The trap this guards is the one already shipped elsewhere: /api/openphone-calls swallows a failed
// list and answers `connected: true, total: 0`, so a broken request and a quiet day are the same
// number on screen. For a person's call count that is not a cosmetic bug, it is an accusation.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://example.invalid';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test';
process.env.ADMIN_TOKEN = 'test-admin';
process.env.QUO_API_KEY = 'test-key';

const quo = await import('../api/_quo.js');
const handler = (await import('../api/quo-activity.js')).default;

const USERS = [
    { id: 'USpaul', email: 'hello@gostaffify.com', firstName: 'Paul', lastName: 'Chareth', role: 'owner' },
    { id: 'USmilton', email: 'miltion@trystaffify.com', firstName: 'Milton', lastName: 'Hodgson Gaitan', role: 'member' },
];
const call = (over = {}) => ({
    id: 'CA' + Math.random().toString(36).slice(2, 8),
    phoneNumberId: 'PN1', actorId: 'USmilton', direction: 'outgoing', status: 'completed',
    participants: [{ phoneNumber: '+15615551234', actorId: null }],
    answeredAt: '2026-10-21T20:31:00Z', answeredBy: null, initiatedBy: 'USmilton',
    completedAt: '2026-10-21T20:35:00Z', createdAt: '2026-10-21T20:30:00Z',
    updatedAt: '2026-10-21T20:35:00Z', callRoute: null, duration: 240,
    forwardedFrom: null, forwardedTo: null, aiHandled: false, ...over,
});

// A Quo stand-in. Records what was asked for, so the request itself can be asserted.
function stubQuo({ users = USERS, calls = [], fail = null, session = null } = {}) {
    const seen = [];
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url));
        // The session store. @upstash/redis proxies its client, so the honest way to exercise the
        // real requireAccess path is to answer its REST calls rather than monkeypatch the client.
        if (u.host === 'example.invalid') {
            // The client auto-pipelines some reads (POST /pipeline with [[verb, ...args], ...])
            // and sends others as one flat command, and the two want different response shapes.
            const batch = JSON.parse(opts?.body || '[]');
            const answer = cmd => {
                const verb = String(cmd[0] || '').toUpperCase(), key = String(cmd[1] || '');
                if (!session) return null;
                if (verb === 'GET' && key === 'sess:' + session.sid) return session.email;
                if (verb === 'HGETALL' && key === 'rep:' + session.email) return Object.entries(session.rep).flat();
                return null;
            };
            // A pipelined batch arrives as [[verb,...],[verb,...]] and expects an array of
            // results; a single command arrives flat and expects one object.
            const payload = Array.isArray(batch[0]) ? batch.map(cmd => ({ result: answer(cmd) })) : { result: answer(batch) };
            // The client reads headers and parses res.text() itself, so this has to look like a
            // real Response rather than just carrying a json().
            const text = JSON.stringify(payload);
            return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
        }
        seen.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers: opts?.headers || {} });
        if (fail) return { ok: false, status: fail, text: async () => JSON.stringify({ message: 'nope' }) };
        if (u.pathname === '/users') return { ok: true, json: async () => ({ data: users, nextCursor: null }) };
        if (u.pathname === '/calls') {
            const actor = u.searchParams.get('actorId');
            const mine = actor ? calls.filter(c => c.actorId === actor) : calls;
            return { ok: true, json: async () => ({ data: mine, nextCursor: null }) };
        }
        return { ok: false, status: 404, text: async () => 'unknown path' };
    };
    return seen;
}
const run = async (query = {}) => {
    let code = 200, body = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { body = v; return v; } };
    await handler({ method: 'GET', headers: { authorization: 'Bearer test-admin' }, query }, res);
    return { code, body };
};

test('it asks Quo the question that can actually be answered', async () => {
    const seen = stubQuo({ calls: [call()] });
    await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    const callsReq = seen.find(s => s.path === '/calls');
    assert.ok(callsReq, 'it hit the 2026-03-30 /calls route, not legacy /v1/calls');
    assert.equal(callsReq.headers['Quo-Api-Version'], '2026-03-30', 'the version header is required');
    assert.equal(callsReq.params.actorId, 'USmilton', 'filtered to his seat');
    assert.ok(callsReq.params['createdAt[gte]'] && callsReq.params['createdAt[lte]'], 'bounded by date');
    // Legacy /v1/calls demands a single participant, so it can only ever count one conversation.
    assert.ok(!('participants' in callsReq.params), 'no single-participant restriction');
});

test('the contract spelling and the provisioned misspelling both find his seat', async () => {
    stubQuo({ calls: [call()] });
    const a = await run({ rep: 'milton@trystaffify.com', days: 1, from: '2026-10-21', to: '2026-10-21' });
    const b = await run({ rep: 'miltion@trystaffify.com', days: 1, from: '2026-10-21', to: '2026-10-21' });
    assert.equal(a.code, 200);
    assert.equal(b.code, 200);
    assert.equal(a.body.reps[0].rep.actorId, 'USmilton');
    assert.equal(b.body.reps[0].rep.actorId, 'USmilton');
});

test('dials, connects and talk time are counted the way a caller would count them', async () => {
    stubQuo({ calls: [
        call({ duration: 240 }),                                                   // answered, 4 min
        call({ duration: 90 }),                                                    // answered, 1.5 min
        call({ answeredAt: null, status: 'no-answer', duration: 0 }),              // rang out
        call({ answeredAt: null, status: 'completed', duration: 22 }),             // voicemail, NOT a connect
        call({ direction: 'incoming', answeredAt: '2026-10-21T21:00:00Z', initiatedBy: null, answeredBy: 'USmilton' }),
    ] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    const r = body.reps[0];
    assert.equal(r.dials, 4, 'four outgoing dials, the inbound one is not a dial');
    assert.equal(r.connected, 2, 'a call that rang out to voicemail is not a connect');
    assert.equal(r.noAnswer, 2);
    assert.equal(r.connectRate, 50);
    assert.equal(r.talkSeconds, 330, 'only answered dials count toward talk time');
    assert.equal(r.longestSeconds, 240);
    assert.equal(r.inboundReturned, 1);
    assert.equal(r.byDay['2026-10-21'].dials, 4);
    assert.equal(body.totalDials, 4);
});

test('the idle prompt can tell a caller on a call from a quiet one: last call time and a call still going', async () => {
    stubQuo({ calls: [
        call({ createdAt: '2026-10-21T20:00:00Z', completedAt: '2026-10-21T20:04:00Z', duration: 240 }),
        call({ createdAt: '2026-10-21T20:30:00Z', completedAt: null, answeredAt: '2026-10-21T20:30:20Z', status: 'in-progress', duration: 0 }),
    ] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    assert.equal(body.reps[0].lastCallAt, '2026-10-21T20:30:00Z'); assert.equal(body.reps[0].callInProgress, true);
    stubQuo({ calls: [call({ createdAt: '2026-10-21T20:00:00Z', completedAt: '2026-10-21T20:04:00Z', status: 'completed', duration: 240 })] });
    const done = (await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' })).body.reps[0];
    assert.equal(done.callInProgress, false);
    assert.equal(done.lastCallEndAt, '2026-10-21T20:04:00Z', 'when the call ended, not when it was placed');
    // A prospect calling back counts as being on the phone; dials stay outgoing only.
    stubQuo({ calls: [call({ createdAt: '2026-10-21T20:00:00Z', completedAt: '2026-10-21T20:01:00Z', duration: 30 }),
        call({ direction: 'incoming', createdAt: '2026-10-21T20:10:00Z', completedAt: null, answeredAt: '2026-10-21T20:10:05Z', status: 'in-progress', initiatedBy: null, answeredBy: 'USmilton' })] });
    const inbound = (await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' })).body.reps[0];
    assert.deepEqual([inbound.dials, inbound.callInProgress, inbound.lastCallAt], [1, true, '2026-10-21T20:10:00Z']);
});

test('eight dials to one number is not eight prospects, and the payload says so', async () => {
    // The distinction the dial count alone cannot make. Milton's first live numbers were eight
    // answered calls averaging 33 seconds, which is either eight gatekeepers or one test number.
    const to = n => ({ participants: [{ phoneNumber: n, actorId: null }] });
    stubQuo({ calls: [
        call({ ...to('+15615550001'), duration: 40 }),
        call({ ...to('+15615550001'), duration: 30 }),
        call({ ...to('+15615550001'), duration: 20 }),
        call({ ...to('+15615550002'), duration: 30 }),
    ] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    const r = body.reps[0];
    assert.equal(r.dials, 4);
    assert.equal(r.uniqueNumbers, 2, 'two people, not four');
    assert.equal(r.repeatDials, 2);
    assert.equal(r.avgAnsweredSeconds, 30, 'thirty seconds is not a conversation, and the number is shown');
    assert.match(r.definitions.connected, /answering machine or a gatekeeper/,
        'a 100% connect rate must not read as a win');
});

test('a Quo failure is reported as a failure, never as zero calls', async () => {
    stubQuo({ fail: 500 });
    const { code, body } = await run({ rep: 'milton@trystaffify.com' });
    assert.equal(code, 503);
    assert.match(body.error, /no call count is being reported/);
    assert.equal(body.reported, null);
    assert.ok(!('totalDials' in body), 'it does not answer the question it could not answer');
});

test('a rejected key is reported as a key problem, not an empty day', async () => {
    stubQuo({ fail: 401 });
    const { code, body } = await run({ rep: 'milton@trystaffify.com' });
    assert.equal(code, 502);
    assert.match(body.detail, /401/);
});

test('a rep with no Quo seat is told so, instead of being shown zero', async () => {
    stubQuo({ users: [USERS[0]] });
    const { code, body } = await run({ rep: 'milton@trystaffify.com' });
    assert.equal(code, 404);
    assert.match(body.error, /No Quo seat is registered/);
    assert.equal(body.seatsChecked, 1);
});

test('a caller reads only himself, and an unsigned session reads nobody', async () => {
    stubQuo({
        calls: [call()],
        session: { sid: 'milton-sid', email: 'miltion@trystaffify.com',
            rep: { email: 'miltion@trystaffify.com', name: 'Milton', role: 'rep' } },
    });

    // No credential at all.
    let code; const res = { setHeader() {}, status(n) { code = n; return this; }, json: v => v };
    await handler({ method: 'GET', headers: {}, query: {} }, res);
    assert.equal(code, 401, 'an unsigned request gets nothing');

    // Signed in as Milton, who is neither Paul nor Madison.
    const asMilton = async query => {
        let c, b;
        const r = { setHeader() {}, status(n) { c = n; return this; }, json(v) { b = v; return v; } };
        await handler({ method: 'GET', headers: { cookie: 'sfy_sess=milton-sid' }, query }, r);
        return { code: c, body: b };
    };
    const own = await asMilton({ from: '2026-10-21', to: '2026-10-21' });
    assert.equal(own.code, 200, 'he can read his own day');
    assert.equal(own.body.reps[0].rep.actorId, 'USmilton');

    const other = await asMilton({ rep: 'hello@gostaffify.com' });
    assert.equal(other.code, 403, 'and nobody else');
    assert.match(other.body.error, /only read your own/);

    assert.equal((await asMilton({ team: '1' })).code, 403);
    assert.equal((await asMilton({ seats: '1' })).code, 403, 'the seat list names the whole team, so it stays private');
});

test('the window is an ET calendar range and is capped at a month', async () => {
    stubQuo({ calls: [] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2020-01-01', to: '2026-10-21' });
    assert.equal(body.window.to, '2026-10-21');
    assert.equal(body.window.from, '2026-09-21', '31 days back, not six years');
    assert.equal(body.window.clamped, 'Range capped at 31 days');
    assert.equal(body.window.timezone, 'America/New_York');
});

test('calls outside the asked-for ET days are trimmed, not counted', async () => {
    stubQuo({ calls: [
        call({ createdAt: '2026-10-21T20:30:00Z' }),            // Oct 21 ET, 4:30pm
        call({ createdAt: '2026-10-21T02:00:00Z' }),            // Oct 20 ET, 10pm: outside
        call({ createdAt: '2026-10-22T03:30:00Z' }),            // Oct 21 ET, 11:30pm: inside
    ] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    assert.equal(body.reps[0].dials, 2, 'the UTC window is wider than the ET day and gets trimmed');
    assert.deepEqual(Object.keys(body.reps[0].byDay), ['2026-10-21']);
});

test('the team view ranks everyone with a seat, and the caveat is stated', async () => {
    stubQuo({ calls: [call(), call(), call({ actorId: 'USpaul', initiatedBy: 'USpaul' })] });
    const { body } = await run({ team: '1', from: '2026-10-21', to: '2026-10-21' });
    assert.equal(body.reps.length, 2);
    assert.equal(body.reps[0].rep.name, 'Milton Hodgson Gaitan');
    assert.equal(body.reps[0].dials, 2);
    assert.equal(body.reps[1].dials, 1);
    assert.match(body.caveat, /not in Quo and is not counted/);
});

test('paging stops and says so rather than presenting a partial count as the total', async () => {
    // A cursor that never ends. Without the ceiling this loops for ever; with it, the count is
    // flagged rather than quietly short.
    globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        if (u.pathname === '/users') return { ok: true, json: async () => ({ data: USERS, nextCursor: null }) };
        return { ok: true, json: async () => ({ data: [call()], nextCursor: 'always-more' }) };
    };
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    assert.equal(body.reps[0].truncated, true);
});

test('ET day maths holds across the daylight-saving change', () => {
    // 2026-11-01 is the US change. A 1:30am ET call must not land on the wrong day.
    assert.equal(quo.etDay('2026-10-21T20:30:00Z'), '2026-10-21');
    assert.equal(quo.etDay('2026-10-22T03:30:00Z'), '2026-10-21');
    assert.equal(quo.etDay('2026-11-01T05:30:00Z'), '2026-11-01');
    assert.equal(quo.etDay('not a date'), null);
    const b = quo.etDayBounds('2026-10-21');
    assert.ok(Date.parse(b.from) < Date.parse('2026-10-21T04:00:00Z'), 'the window opens before ET midnight');
    assert.ok(Date.parse(b.to) > Date.parse('2026-10-22T04:00:00Z'), 'and closes after it');
});

test('a seat is matched on the address, never guessed from a name', () => {
    const users = quo.listUsers ? USERS.map(u => ({ actorId: u.id, email: u.email, name: u.firstName })) : [];
    assert.equal(quo.findSeat(users, ['nobody@example.com']), null);
    assert.equal(quo.findSeat(users, ['miltion@trystaffify.com']).actorId, 'USmilton');
    assert.equal(quo.findSeat(users, ['MILTION@TRYSTAFFIFY.COM']).actorId, 'USmilton');
    assert.equal(quo.findSeat(users, []), null);
});

test('a first dial to a number is a new call; a later dial to the same number is a follow-up', async () => {
    // Paul, 2026-10-22: "new calls, follow up calls made etc". Judged within the window reported.
    const to = n => ({ participants: [{ phoneNumber: n, actorId: null }] });
    stubQuo({ calls: [
        call({ ...to('+15615550001'), createdAt: '2026-10-21T20:00:00Z' }),
        call({ ...to('+15615550002'), createdAt: '2026-10-21T20:10:00Z' }),
        call({ ...to('+15615550001'), createdAt: '2026-10-21T20:20:00Z', answeredAt: null, status: 'no-answer', duration: 0 }),
        call({ ...to('+15615550001'), createdAt: '2026-10-21T20:30:00Z' }),
        call({ direction: 'incoming', initiatedBy: null, answeredBy: 'USmilton', ...to('+15615550003') }),  // inbound: neither
    ] });
    const { body } = await run({ rep: 'milton@trystaffify.com', from: '2026-10-21', to: '2026-10-21' });
    const r = body.reps[0];
    assert.equal(r.newCalls, 2, 'two numbers were reached for the first time');
    assert.equal(r.followUpCalls, 2, 'two more dials went back to the first number, answered or not');
    assert.equal(r.newCalls + r.followUpCalls, r.dials, 'every outgoing dial is one or the other');
    assert.match(r.definitions.newCalls, /within this window/);
});
