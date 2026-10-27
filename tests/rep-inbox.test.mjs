// My inbox: the rep's own Gmail in the Hub, and replies from it.
// Paul, 2026-10-27: "he should have an area where he can check his inbox, its only notifying him to
// check it if he has a notification". No Google here: every Gmail call is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.CRON_SECRET = 'test-cron-secret';
const I = await import('../api/rep-inbox.js');
const { K } = await import('../api/rep-email.js');

const BOX = 'milton@trystaffify.com';
const MILTON = { email: 'miltion@trystaffify.com', name: 'Milton', role: 'caller' };
const hdr = (o) => ({ payload: { headers: Object.entries(o).map(([name, value]) => ({ name, value })) } });
const msg = (id, from, o = {}) => ({ id, internalDate: String(Date.parse(o.at || '2026-10-27T20:00:00Z')), labelIds: o.unread ? ['INBOX', 'UNREAD'] : ['INBOX'], snippet: o.snippet || '', ...hdr({ From: from, To: o.to || BOX, Subject: o.subject || 'Thanks for your time today', 'Message-ID': '<' + id + '@mail.example>', ...(o.refs ? { References: o.refs } : {}) }) });
const THREAD = { id: 'thr0001', messages: [
    msg('m1', '"Milton Hodgson" <milton@trystaffify.com>', { to: 'support@realkit.com', subject: 'Nick, thanks for your time today', at: '2026-10-27T21:00:00Z' }),
    msg('m2', 'Nick Rossi <support@realkit.com>', { subject: 'Re: Nick, thanks for your time today', unread: true, snippet: 'Sounds good, Thursday works', at: '2026-10-27T22:00:00Z', refs: '<m1@mail.example>' }),
] };
const RECORDS = [{ id: 'rk', company: 'Realkit', recipient: 'support@realkit.com' }];

test('a conversation row: who, which prospect, unread, and whether he wrote last', () => {
    const r = I.threadRow({ ...THREAD, snippet: 'Sounds good' }, BOX, RECORDS);
    assert.equal(r.with, 'Nick Rossi'); assert.equal(r.withAddr, 'support@realkit.com');
    assert.deepEqual(r.prospect, { recordId: 'rk', company: 'Realkit' });
    assert.equal(r.unread, true); assert.equal(r.lastFromMe, false); assert.equal(r.count, 2);
    assert.equal(r.subject, 'Re: Nick, thanks for your time today');
    const mineLast = I.threadRow({ id: 't2', messages: [THREAD.messages[0]] }, BOX, RECORDS);
    assert.equal(mineLast.lastFromMe, true); assert.equal(mineLast.withAddr, 'support@realkit.com', 'a thread he started is with whoever it went to');
    assert.equal(I.threadRow({ id: 't3', messages: [msg('x', 'someone@else.com')] }, BOX, RECORDS).prospect, null);
});

test('a reply keeps the thread\'s own subject, with one Re:', () => {
    assert.equal(I.replySubject('Nick, thanks'), 'Re: Nick, thanks');
    assert.equal(I.replySubject('RE: Nick, thanks'), 'RE: Nick, thanks');
    assert.equal(I.replySubject(''), 'Re: (no subject)');
});

function fakeKv() {
    const m = new Map(), lists = new Map();
    return { m, lists,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; },
        async del(k) { m.delete(k); return 1; }, async incr(k) { const n = (Number(m.get(k)) || 0) + 1; m.set(k, n); return n; }, async expire() { return 1; },
        async lpush(k, ...v) { lists.set(k, [...v, ...(lists.get(k) || [])]); return 1; }, async ltrim() { return 'OK'; }, async sadd() { return 1; } };
}
function fakeGmail({ failSend = false } = {}) {
    const calls = [];
    const gmail = async (token, path, body) => {
        calls.push({ path, body });
        if (path.startsWith('threads/thr0001')) return THREAD;
        if (path === 'drafts') return { id: 'd1' };
        if (path === 'drafts/send') { if (failSend) throw Error('Gmail drafts/send failed 500'); return { id: 'm3', threadId: 'thr0001' }; }
        throw Error('unexpected ' + path);
    };
    return { gmail, calls };
}
const deps = (over = {}) => { const kv = fakeKv(), g = fakeGmail(over); return { kv, g, d: { redis: kv, access: async () => 'tok', gmail: g.gmail, isOptedOut: async () => false, records: async () => RECORDS, clean: async (x, o) => ({ subject: x.subject, body: x.body.replace(/\bi\b/g, 'I'), changes: ['Capitalized I'], by: o.ai ? 'ai' : 'rules' }), ...over.d } }; };
const BODY = 'Hi Nick,\n\ni will send the invite for Thursday.\n\nMilton';

test('the reply cleanup cleans the body only and keeps the thread subject, then the reply sends in the thread', async () => {
    const { d, kv, g } = deps();
    const c = await I.cleanReply({ box: BOX, input: { threadId: 'thr0001', body: BODY }, deps: d });
    assert.equal(c.body.subject, 'Re: Nick, thanks for your time today');
    assert.match(c.body.body, /I will send the invite/); assert.equal(c.body.changed, true);
    const before = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: BODY, nonce: 'nonce-1234' }, deps: d });
    assert.equal(before.status, 409, 'the uncleaned text cannot go');
    const r = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: c.body.body, nonce: 'nonce-1234', to: 'someone@else.com' }, deps: d });
    assert.equal(r.body.sent, true); assert.equal(r.body.to, 'support@realkit.com', 'the recipient comes from the thread, never the browser');
    assert.equal(r.body.recordId, 'rk'); assert.equal(r.body.reply, true);
    const draft = g.calls.find(x => x.path === 'drafts');
    assert.equal(draft.body.message.threadId, 'thr0001', 'Gmail files it in the same conversation');
    const mime = Buffer.from(draft.body.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    assert.match(mime, /\r\nIn-Reply-To: <m2@mail\.example>\r\n/); assert.match(mime, /\r\nReferences: <m1@mail\.example> <m2@mail\.example>\r\n/);
    assert.match(mime, /Subject: Re: Nick, thanks for your time today/); assert.match(mime, /From: "Milton Hodgson" <milton@trystaffify\.com>/);
    const again = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: c.body.body, nonce: 'nonce-1234' }, deps: d });
    assert.equal(again.body.repeat, true); assert.equal(g.calls.filter(x => x.path === 'drafts/send').length, 1, 'never twice');
    assert.equal(kv.lists.get(K.sent('support@realkit.com')).length, 1);
});

test('do-not-contact, an unconfirmed send and a missing connection all stop a reply honestly', async () => {
    const a = deps({ d: { isOptedOut: async () => true } });
    const ca = await I.cleanReply({ box: BOX, input: { threadId: 'thr0001', body: BODY }, deps: a.d });
    const ra = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: ca.body.body, nonce: 'nonce-2222' }, deps: a.d });
    assert.equal(ra.body.sent, false); assert.match(ra.body.reason, /do-not-contact/); assert.ok(!a.g.calls.some(x => x.path === 'drafts'));
    const b = deps({ failSend: true });
    const cb = await I.cleanReply({ box: BOX, input: { threadId: 'thr0001', body: BODY }, deps: b.d });
    const rb = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: cb.body.body, nonce: 'nonce-3333' }, deps: b.d });
    assert.equal(rb.body.uncertain, true);
    const rb2 = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: cb.body.body, nonce: 'nonce-3333' }, deps: b.d });
    assert.match(rb2.body.reason, /already sent or is still sending/);
    const c = deps({ d: { access: async () => { throw Error('Mailbox authorization missing'); } } });
    const rc = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: BODY, nonce: 'nonce-4444' }, deps: c.d });
    assert.equal(rc.body.connect, true);
    assert.equal((await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: '../x', body: BODY, nonce: 'nonce-5555' }, deps: c.d })).status, 400);
});

test('the access token is kept sealed for 50 minutes, so a page load is not a token refresh', async () => {
    const kv = fakeKv(); let refreshes = 0;
    const refresh = async () => { refreshes++; return 'access-' + refreshes; };
    const now = Date.parse('2026-10-27T22:00:00Z');
    assert.equal(await I.accessFor(BOX, { kv, refresh, now }), 'access-1');
    assert.equal(await I.accessFor(BOX, { kv, refresh, now: now + 30 * 60000 }), 'access-1');
    assert.ok(!JSON.stringify([...kv.m.values()]).includes('access-1'), 'never stored in the clear');
    assert.equal(await I.accessFor(BOX, { kv, refresh, now: now + 55 * 60000 }), 'access-2');
});

test('second review: a reply only where they wrote, never a client count, and the queue\'s own stop list holds', async () => {
    const mine = { id: 'thr0002', messages: [msg('m9', '"Milton Hodgson" <milton@trystaffify.com>', { to: 'support@realkit.com', subject: 'Nick, quick one' })] };
    const d0 = deps({ d: { gmail: async (t, path) => { if (path.startsWith('threads/thr0002')) return mine; throw Error('unexpected ' + path); } } });
    await d0.kv.set(K.clean(BOX, 'Re: Nick, quick one', 'Hi Nick,\n\nFollowing up.'), { at: 'x' });
    const solo = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0002', body: 'Hi Nick,\n\nFollowing up.', nonce: 'nonce-6000' }, deps: d0.d });
    assert.equal(solo.status, 400); assert.match(solo.body.reason, /not written back/, 'a thread with only his own email is a new email, with the new-email checks');
    const count = deps();
    const c = await I.cleanReply({ box: BOX, input: { threadId: 'thr0001', body: 'Hi Nick,\n\nWe already work with 40 clients like you.' }, deps: count.d });
    assert.match(c.body.problem, /never says how many clients/);
    const r = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: c.body.body, nonce: 'nonce-6001' }, deps: count.d });
    assert.equal(r.status, 400); assert.match(r.body.reason, /never says how many clients/);
    const stopped = deps({ d: { records: async () => ({ records: [], suppressions: ['support@realkit.com'] }) } });
    const c2 = await I.cleanReply({ box: BOX, input: { threadId: 'thr0001', body: BODY }, deps: stopped.d });
    const r2 = await I.sendReply({ rep: MILTON, box: BOX, input: { threadId: 'thr0001', body: c2.body.body, nonce: 'nonce-6002' }, deps: stopped.d });
    assert.equal(r2.body.sent, false); assert.match(r2.body.reason, /excluded from all outreach/, 'the record left the snapshot; the stop list did not');
});

test('second review: drafts are not messages, Reply-To wins, and a display name is not an address', () => {
    const draft = { ...msg('m3', '"Milton Hodgson" <milton@trystaffify.com>', { to: 'support@realkit.com' }), labelIds: ['DRAFT'] };
    const r = I.threadRow({ id: 't', messages: [...THREAD.messages, draft] }, BOX, RECORDS);
    assert.equal(r.lastFromMe, false, 'an unsent draft is not "You:"'); assert.equal(r.count, 2);
    const viaForm = msg('m4', 'Website <hello@gostaffify.com>', {});
    viaForm.payload.headers.push({ name: 'Reply-To', value: 'lead@prospect.example' });
    assert.equal(I.otherParty([viaForm], 'milton@trystaffify.com').addr, 'lead@prospect.example');
    assert.equal(I.otherParty([msg('m5', '"info@realkit.com via Form" <noreply@forms.example>', {})], BOX).addr, 'noreply@forms.example');
});
