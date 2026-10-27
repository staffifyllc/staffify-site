// Email them from the dialer: Milton's own mailbox, his signature, the templates, the cleanup pass,
// and every rule a send has to clear. No Google, no Anthropic, no real prospect: the whole send path
// runs against fakes, and the handler against an in-memory Redis.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
process.env.CRON_SECRET = 'test-cron-secret';
process.env.OUTREACH_GOOGLE_CLIENT_ID = 'test-client';
process.env.OUTREACH_GOOGLE_CLIENT_SECRET = 'test-secret';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENPHONE_API_KEY;
delete process.env.QUO_API_KEY;

const R = await import('../api/_rep-email.js');
const C = await import('../api/_email-cleanup.js');
const { sendRepEmail, cleanRepEmail, repEmailStatus, K } = await import('../api/rep-email.js');
const { SESSION_TTL } = await import('../api/_auth.js');

const MILTON = { email: 'miltion@trystaffify.com', name: 'Milton', role: 'caller' };   // the misspelt Hub record
const PAUL = { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' };
const ROW = { id: 'r1', company: 'Realkit', recipient: 'support@realkit.com', phone: '+14043135871', sender: 'paul@trystaffify.com' };
const decode = raw => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const parts = mime => [...mime.matchAll(/Content-Type: (text\/\w+); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map(m => [m[1], Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8')]);

// ---- the mailbox, the signature ---------------------------------------------------------------
test('Milton sends from milton@trystaffify.com, whichever spelling his Hub record has; nobody else has a mailbox', () => {
    assert.equal(R.mailboxFor(MILTON), 'milton@trystaffify.com');
    assert.equal(R.mailboxFor({ email: 'milton@trystaffify.com' }), 'milton@trystaffify.com');
    assert.equal(R.mailboxFor(PAUL), null, 'a rep with no entry gets no mailbox, never a guessed one');
    assert.equal(R.mailboxFor({ email: 'admin', role: 'admin' }), null);
});

test('the signature: his name, Growth Strategist, the Staffify wordmark, images from gostaffify.com only', () => {
    const html = R.signatureHtml('milton@trystaffify.com', { phone: { e164: '+15551234567', display: '(555) 123-4567' } });
    assert.match(html, /Milton Hodgson Gaitan/);
    assert.match(html, /Growth Strategist/, 'Paul, 2026-10-27: "his email signautre should be growth strategist"');
    assert.match(html, /mailto:milton@trystaffify\.com/);
    assert.match(html, /tel:\+15551234567/); assert.match(html, /\(555\) 123-4567/);
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.length >= 5 && srcs.every(s => s.startsWith('https://www.gostaffify.com/assets/email/')), 'no vercel.app image hosts in a prospect email');
    assert.ok(srcs.every(s => /width="\d+"/.test(html)), 'images carry explicit sizes for Outlook');
    assert.ok(!/—/.test(html));
    const bare = R.signatureHtml('milton@trystaffify.com');
    assert.ok(!/tel:/.test(bare), 'no phone row when Quo cannot say which line is his');
    assert.match(R.signatureText('milton@trystaffify.com'), /Milton Hodgson Gaitan\nGrowth Strategist, Staffify\nmilton@trystaffify\.com/);
});

test('his line comes from Quo only when it is unmistakably his', () => {
    const n = (number, ...emails) => ({ number, users: emails.map(email => ({ email })) });
    assert.deepEqual(R.lineFor([n('+15551112222', 'milton@trystaffify.com'), n('+15553334444', 'milton@trystaffify.com', 'hello@gostaffify.com')], ['milton@trystaffify.com']), { e164: '+15551112222', display: '(555) 111-2222' }, 'a personal line beats a shared one');
    assert.equal(R.lineFor([n('+15551112222', 'milton@trystaffify.com'), n('+15559998888', 'milton@trystaffify.com')], ['milton@trystaffify.com']), null, 'two personal lines: no guess');
    assert.equal(R.lineFor([n('+15551112222', 'someone@else.com')], ['milton@trystaffify.com']), null);
    assert.deepEqual(R.lineFor([n('+15553334444', 'miltion@trystaffify.com', 'hello@gostaffify.com')], ['milton@trystaffify.com', 'miltion@trystaffify.com']).display, '(555) 333-4444', 'a single shared line is used when it is the only one');
});

// ---- templates and the rules on copy -----------------------------------------------------------
test('template 1 is thanks for your time, then book a meeting, on the link his agreement requires', () => {
    const [first, second] = R.templatesFor('milton@trystaffify.com');
    assert.equal(first.id, 'thanks-book'); assert.match(first.label, /Thanks for your time, book a meeting/);
    assert.equal(first.link, 'https://calendly.com/go-staffify/discovery-call');
    const f = R.fillTemplate(first, { first: 'Nick', company: 'Realkit', me: 'Milton', link: first.link });
    assert.match(f.body, /^Hi Nick,/); assert.match(f.body, /https:\/\/calendly\.com\/go-staffify\/discovery-call/); assert.match(f.body, /Realkit/); assert.match(f.body, /\nMilton$/);
    assert.equal(R.copyProblem(f), null, 'a filled template passes the copy rules');
    for (const t of R.TEMPLATES) {
        assert.ok(!/[—–]/.test(t.subject + t.body), 'no dashes in the house copy');
        assert.ok(!/\b(testament|crucial|pivotal|landscape|delve|robust|seamless|vibrant)\b/i.test(t.body));
        assert.ok(!/\d+\+?\s+clients/i.test(t.body));
    }
    assert.match(R.fillTemplate(second, {}).body, /^Hi there,/, 'an unknown name reads naturally');
    assert.match(R.fillTemplate(second, {}).body, /your business/);
});

test('copy rules: placeholders, a client count, an empty or broken subject are refused', () => {
    assert.match(R.copyProblem({ subject: 'Hi', body: 'Hi {first}, thanks' }), /Replace \{first\}/);
    assert.match(R.copyProblem({ subject: 'Hi', body: 'Could you pass this to [their name]?' }), /\[their name\]/);
    assert.match(R.copyProblem({ subject: 'Hi', body: 'We work with 120 clients like you.' }), /never says how many clients/);
    assert.match(R.copyProblem({ subject: '', body: 'x' }), /subject/);
    assert.match(R.copyProblem({ subject: 'a\nb', body: 'x' }), /one line/);
    assert.equal(R.copyProblem({ subject: 'Thanks for your time today', body: 'Hi Nick,\n\nThanks again.' }), null);
});

test('the message: named From, both parts, the signature in the HTML only once, no header injection', () => {
    const mime = R.buildMime({ from: 'milton@trystaffify.com', fromName: 'Milton Hodgson Gaitan', to: 'support@realkit.com', subject: 'Gracias, Nick', text: 'Hi Nick,\n\nThanks.\n\n-- \nMilton', html: R.bodyHtml('Hi Nick,\n\nBook here: https://calendly.com/go-staffify/discovery-call\n\n<script>x</script>', R.signatureHtml('milton@trystaffify.com')) });
    assert.match(mime, /^From: "Milton Hodgson Gaitan" <milton@trystaffify\.com>\r\nTo: support@realkit\.com\r\nSubject: Gracias, Nick\r\n/);
    const [[t1, text], [t2, html]] = parts(mime);
    assert.equal(t1, 'text/plain'); assert.equal(t2, 'text/html');
    assert.match(text, /^Hi Nick,/);
    assert.match(html, /<a href="https:\/\/calendly\.com\/go-staffify\/discovery-call">/, 'links are clickable');
    assert.ok(!/<script>/.test(html) && /&lt;script&gt;/.test(html), 'the rep\'s text is escaped');
    assert.equal(html.match(/Growth Strategist/g).length, 1);
    assert.match(R.encodeHeader('Café'), /^=\?UTF-8\?B\?/);
    assert.throws(() => R.buildMime({ from: 'a@b.co', to: 'c@d.co\r\nBcc: x@y.co', subject: 's', text: 't', html: 'h' }), /Invalid mail header/);
});

// ---- the cleanup pass -------------------------------------------------------------------------
test('rules alone fix the non-negotiables without touching links, times or addresses', () => {
    const r = C.ruleClean({ subject: 'thanks — talk soon', body: 'hi nick,\n\ni loved the call — i\'ll send times. we can meet at 10 a.m. on friday. book here https://calendly.com/go-staffify/discovery-call and email support@realkit.com.\n\nthanks,\nMilton' });
    assert.equal(r.subject, 'Thanks, talk soon');
    assert.equal(r.body, "Hi nick,\n\nI loved the call, I'll send times. We can meet at 10 a.m. on friday. Book here https://calendly.com/go-staffify/discovery-call and email support@realkit.com.\n\nThanks,\nMilton");
    assert.deepEqual(r.changes.sort(), ['Capitalized I', 'Capitalized sentence starts', 'Replaced dashes'].sort());
    assert.deepEqual(C.ruleClean({ subject: 'Fine', body: 'Hi Nick,\n\nAll good.' }).changes, []);
});

const fakeClient = reply => ({ calls: [], beta: { messages: { async create(req) { this.parent.calls.push(req); return typeof reply === 'function' ? reply(req) : reply; } } } });
const withParent = c => { c.beta.messages.parent = c; return c; };
const answer = obj => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('the AI pass: Opus 5.5 at low effort, a JSON schema, fallbacks on, and the rules still run over its answer', async () => {
    const client = withParent(fakeClient(answer({ subject: 'Thanks for your time today', body: 'Hi Nick,\n\nThanks for taking my call — I will send the link.\n\nMilton', changes: ['Fixed spelling of taking'] })));
    const out = await C.cleanEmail({ subject: 'Thanks for your time today', body: 'Hi Nick,\n\nThanks for takign my call, i will send the link.\n\nMilton' }, { client });
    const req = client.calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.output_config.effort, 'low');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal(req.fallbacks, 'default'); assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.match(req.system, /lifetime replacement guarantee/); assert.match(req.system, /Never state how many clients/);
    assert.equal(out.by, 'ai');
    assert.equal(out.body, 'Hi Nick,\n\nThanks for taking my call, I will send the link.\n\nMilton', 'an em dash the model left in is still removed');
    assert.ok(out.changes.includes('Fixed spelling of taking') && out.changes.includes('Replaced dashes'));
});

test('an AI answer that changed a link, an address or a number is thrown away for the rules', async () => {
    const draft = { subject: 'Next step', body: 'Hi Nick,\n\nbook here https://calendly.com/go-staffify/discovery-call or call 404-313-5871.\n\nMilton' };
    for (const bad of [
        { subject: 'Next step', body: 'Hi Nick,\n\nBook here https://calendly.com/someone-else or call 404-313-5871.\n\nMilton', changes: [] },
        { subject: 'Next step', body: 'Hi Nick,\n\nBook here https://calendly.com/go-staffify/discovery-call or call 404-313-5870.\n\nMilton', changes: [] },
    ]) {
        const out = await C.cleanEmail(draft, { client: withParent(fakeClient(answer(bad))) });
        assert.equal(out.by, 'rules');
        assert.match(out.body, /Book here https:\/\/calendly\.com\/go-staffify\/discovery-call or call 404-313-5871\./);
        assert.match(out.note, /AI check could not run/);
    }
    const down = await C.cleanEmail(draft, { client: withParent(fakeClient(() => { throw Object.assign(Error('overloaded'), { status: 529 }); })) });
    assert.equal(down.by, 'rules', 'Anthropic down: the rules still run and the rep is told');
    const refused = await C.cleanEmail(draft, { client: withParent(fakeClient({ stop_reason: 'refusal', content: [] })) });
    assert.equal(refused.by, 'rules');
    const none = await C.cleanEmail(draft);
    assert.equal(none.by, 'rules', 'no key on the server: rules only, never a crash');
});

// ---- the send, end to end with fakes -----------------------------------------------------------
function fakeKv() {
    const m = new Map(), lists = new Map();
    const kv = {
        m, lists,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; },
        async del(k) { m.delete(k); return 1; },
        async incr(k) { const n = (Number(m.get(k)) || 0) + 1; m.set(k, n); return n; },
        async expire() { return 1; },
        async lpush(k, ...v) { lists.set(k, [...v.reverse(), ...(lists.get(k) || [])]); return lists.get(k).length; },
        async ltrim(k, a, b) { lists.set(k, (lists.get(k) || []).slice(a, b + 1)); return 'OK'; },
        async lrange(k, a, b) { return (lists.get(k) || []).slice(a, b + 1); },
        async sadd() { return 1; },
    };
    return kv;
}
function fakeGmail({ failSend = false } = {}) {
    const calls = [];
    const gmail = async (token, path, body) => {
        calls.push({ token, path, body });
        if (path === 'drafts') return { id: 'd1', message: { id: 'm1' } };
        if (path === 'drafts/send') { if (failSend) throw Error('Gmail drafts/send failed 500: backend'); return { id: 'm1', threadId: 't1' }; }
        if (path.startsWith('messages/m1')) return { labelIds: ['SENT'], payload: { headers: [{ name: 'To', value: 'support@realkit.com' }] } };
        throw Error('unexpected ' + path);
    };
    return { gmail, calls };
}
const DRAFT = { email: 'support@realkit.com', subject: 'Thanks for your time today', body: 'Hi Nick,\n\nThanks for taking my call today. Here is the link: https://calendly.com/go-staffify/discovery-call\n\nTalk soon,\nMilton', nonce: 'nonce-0001' };
function setup(over = {}) {
    const kv = fakeKv(), g = fakeGmail(over);
    const deps = { redis: kv, findRow: async e => (e === ROW.recipient ? ROW : null), isOptedOut: async () => false, clientCheck: async () => ({ status: 'clear' }), access: async () => 'tok', gmail: g.gmail, line: async () => null, clean: (d, o) => C.cleanEmail(d, { ...o, ai: false }), ...over.deps };
    return { kv, g, deps };
}
const cleaned = async (deps, draft = DRAFT) => (await cleanRepEmail({ rep: MILTON, input: draft, deps })).body;

test('nothing sends until this exact text has been through the cleanup; an edit afterwards needs it again', async () => {
    const { deps, g } = setup();
    const raw = await sendRepEmail({ rep: MILTON, input: DRAFT, deps });
    assert.equal(raw.status, 409); assert.equal(raw.body.review, true);
    assert.equal(g.calls.length, 0, 'Gmail never touched');
    const c = await cleaned(deps);
    const edited = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, subject: c.subject, body: c.body + ' Extra words.' }, deps });
    assert.equal(edited.status, 409, 'edited after the cleanup: cleaned again first');
    const ok = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, subject: c.subject, body: c.body }, deps });
    assert.equal(ok.status, 200); assert.equal(ok.body.sent, true);
});

test('the send: his mailbox, his signature, drafts then send, read back, receipt kept, activity recorded', async () => {
    const { deps, g, kv } = setup();
    const c = await cleaned(deps);
    const r = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps, now: Date.parse('2026-10-27T21:30:00Z') });
    assert.equal(r.body.sent, true); assert.equal(r.body.from, 'milton@trystaffify.com'); assert.equal(r.body.to, 'support@realkit.com'); assert.equal(r.body.verified, true);
    assert.deepEqual(g.calls.map(x => x.path.split('?')[0]), ['drafts', 'drafts/send', 'messages/m1']);
    const mime = decode(g.calls[0].body.message.raw);
    assert.match(mime, /From: "Milton Hodgson Gaitan" <milton@trystaffify\.com>/);
    assert.match(mime, /To: support@realkit\.com/);
    const html = parts(mime).find(p => p[0] === 'text/html')[1];
    assert.match(html, /Growth Strategist/); assert.match(html, /Thanks for taking my call today/);
    assert.equal((kv.lists.get(K.sent('support@realkit.com')) || []).length, 1, 'a receipt per prospect');
    assert.equal(await kv.get(K.count('milton@trystaffify.com', '2026-10-27')), 1);
});

test('a double click or a retry never sends twice; an unconfirmed send is held, not retried', async () => {
    const { deps, g } = setup();
    const c = await cleaned(deps);
    await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    const again = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(again.body.sent, true); assert.equal(again.body.repeat, true);
    assert.equal(g.calls.filter(x => x.path === 'drafts/send').length, 1);

    const s2 = setup({ failSend: true });
    const c2 = await cleaned(s2.deps);
    const first = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c2 }, deps: s2.deps });
    assert.equal(first.body.sent, false); assert.equal(first.body.uncertain, true); assert.match(first.body.reason, /Sent folder/);
    const retry = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c2 }, deps: s2.deps });
    assert.equal(retry.body.sent, false); assert.match(retry.body.reason, /already sent or is still sending/);
    assert.equal(s2.g.calls.filter(x => x.path === 'drafts/send').length, 1, 'no second attempt at Gmail');
});

test('opt-outs, clients, a check that could not answer, strangers and the daily cap all stop it before Gmail', async () => {
    const cases = [
        [{ isOptedOut: async () => true }, /do-not-contact/],
        [{ clientCheck: async () => ({ status: 'client' }) }, /belongs to a Staffify client/],
        [{ clientCheck: async () => ({ status: 'possible' }) }, /matches an existing client/],
        [{ clientCheck: async () => ({ status: 'unknown' }) }, /could not finish/],
        [{ clientCheck: async () => { throw Error('down'); } }, /could not finish/],
        [{ findRow: async () => null }, /not in the call queue/],
    ];
    for (const [over, why] of cases) {
        const { deps, g } = setup({ deps: over });
        const c = await cleaned(deps);
        const r = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
        assert.equal(r.body.sent, false); assert.match(r.body.reason, why);
        assert.equal(g.calls.length, 0, String(why));
    }
    const { deps, g, kv } = setup();
    kv.m.set(K.count('milton@trystaffify.com', '2026-10-27'), R.LIMITS.perDay);
    const c = await cleaned(deps);
    const capped = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps, now: Date.parse('2026-10-27T21:30:00Z') });
    assert.match(capped.body.reason, /daily limit/); assert.equal(g.calls.length, 0);
    const paul = await sendRepEmail({ rep: PAUL, input: DRAFT, deps });
    assert.equal(paul.status, 403, 'no mailbox, no send');
});

test('no Gmail connection: it says connect, keeps the message, and lets the same window send after', async () => {
    let connected = false;
    const { deps, g } = setup({ deps: { access: async () => { if (!connected) throw Error('Mailbox authorization missing: milton@trystaffify.com'); return 'tok'; } } });
    const c = await cleaned(deps);
    const r = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(r.body.connect, true); assert.match(r.body.reason, /Connect your Gmail \(milton@trystaffify\.com\)/);
    connected = true;
    const after = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(after.body.sent, true, 'the nonce was released, so the same compose window can send');
    assert.equal(g.calls.filter(x => x.path === 'drafts/send').length, 1);
});

test('status: mailbox, templates, signature and what was already sent to this prospect', async () => {
    const kv = fakeKv();
    await kv.lpush(K.sent('support@realkit.com'), JSON.stringify({ at: '2026-10-27T21:00:00Z', by: 'Milton', from: 'milton@trystaffify.com', subject: 'Thanks for your time today' }));
    const s = await repEmailStatus({ rep: MILTON, email: 'Support@Realkit.com', kv, line: async () => null });
    assert.equal(s.mailbox, 'milton@trystaffify.com'); assert.equal(s.title, 'Growth Strategist'); assert.equal(s.connected, false);
    assert.equal(s.templates[0].id, 'thanks-book'); assert.match(s.signatureHtml, /Milton Hodgson Gaitan/);
    assert.equal(s.history.length, 1); assert.equal(s.history[0].subject, 'Thanks for your time today');
    assert.equal((await repEmailStatus({ rep: PAUL, kv })).mailbox, null);
});

// ---- the handlers, with the real auth path ------------------------------------------------------
const store = new Map();
const run = cmd => {
    const [verb, key, ...args] = cmd; const v = String(verb).toUpperCase();
    const str = x => (typeof x === 'string' ? x : JSON.stringify(x));
    if (v === 'GET') return store.has(key) ? store.get(key) : null;
    if (v === 'SET') { if (args.some(a => String(a).toUpperCase() === 'NX') && store.has(key)) return null; store.set(key, str(args[0])); return 'OK'; }
    if (v === 'GETDEL') { const x = store.has(key) ? store.get(key) : null; store.delete(key); return x; }
    if (v === 'DEL') { store.delete(key); return 1; }
    if (v === 'EXPIRE') return 1;
    if (v === 'INCR') { const n = (Number(store.get(key)) || 0) + 1; store.set(key, String(n)); return n; }
    if (v === 'LRANGE') return [];
    if (v === 'HGETALL') { const h = store.get(key); return h && typeof h === 'object' ? Object.entries(h).flat() : []; }
    throw new Error('unhandled ' + v);
};
const b64 = v => (typeof v === 'string' ? Buffer.from(v).toString('base64') : Array.isArray(v) ? v.map(b64) : v);
let google = {};
globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => google.token };
    if (u.host === 'gmail.googleapis.com') return { ok: true, status: 200, json: async () => google.profile };
    if (u.host !== 'example.invalid') return { ok: false, status: 404, text: async () => '' };
    const batch = JSON.parse(opts?.body || '[]');
    const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: b64(run(c)) })) : { result: b64(run(batch)) };
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
};
const seed = () => {
    store.clear();
    store.set('sess:milton-sid', 'miltion@trystaffify.com'); store.set('sess:paul-sid', 'hello@gostaffify.com');
    store.set('rep:miltion@trystaffify.com', { email: 'miltion@trystaffify.com', name: 'Milton', role: 'caller' });
    store.set('rep:hello@gostaffify.com', { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin' });
};
const handler = (await import('../api/rep-email.js')).default;
const connect = (await import('../api/outreach-connect.js')).default;
const call = async (h, { method = 'GET', cookie = null, bearer = null, query = {}, body = null, origin = null }) => {
    let code = 200, out = null, location = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; }, writeHead(n, hd) { code = n; location = hd.Location; return this; }, end() {} };
    await h({ method, headers: { ...(cookie ? { cookie: 'sfy_sess=' + cookie } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(origin ? { origin } : {}) }, query, body: body ? JSON.stringify(body) : undefined }, res);
    return { code, body: out, location };
};
void SESSION_TTL;

test('handler: signed-in Milton gets his status; an admin token is not a caller; a cross-site POST is refused', async () => {
    seed();
    const s = await call(handler, { cookie: 'milton-sid' });
    assert.equal(s.code, 200); assert.equal(s.body.mailbox, 'milton@trystaffify.com'); assert.equal(s.body.connected, false);
    assert.equal((await call(handler, { bearer: 'test-admin' })).code, 403);
    assert.equal((await call(handler, {})).code, 401);
    assert.equal((await call(handler, { method: 'POST', cookie: 'milton-sid', body: DRAFT, origin: 'https://evil.example' })).code, 403);
});

test('connect: Google consent for HIS mailbox only, and the callback brings him back to the card', async () => {
    seed();
    const start = await call(handler, { cookie: 'milton-sid', query: { action: 'connect', back: '/dialer/?open=r1' } });
    assert.equal(start.code, 302);
    const g = new URL(start.location);
    assert.equal(g.host, 'accounts.google.com'); assert.equal(g.searchParams.get('login_hint'), 'milton@trystaffify.com');
    assert.equal(g.searchParams.get('redirect_uri'), 'https://www.gostaffify.com/api/outreach-connect/?action=callback');
    const state = g.searchParams.get('state');
    assert.deepEqual(JSON.parse(store.get('outreach:oauth-state:' + state)), { email: 'milton@trystaffify.com', rep: 'miltion@trystaffify.com', returnTo: '/dialer/?open=r1' });
    const evil = await call(handler, { cookie: 'milton-sid', query: { action: 'connect', back: '//evil.example/x' } });
    assert.equal(JSON.parse(store.get('outreach:oauth-state:' + new URL(evil.location).searchParams.get('state'))).returnTo, '/dialer/', 'no open redirect');

    google = { token: { access_token: 'a', refresh_token: 'r', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' }, profile: { emailAddress: 'someone.else@gmail.com' } };
    const wrong = await call(connect, { cookie: 'milton-sid', query: { action: 'callback', state, code: 'c' } });
    assert.equal(wrong.code, 302); assert.match(decodeURIComponent(wrong.location), /^\/dialer\/\?open=r1&gmail=Wrong Google account selected\. Choose milton@trystaffify\.com\./);
    assert.equal(store.get('outreach:oauth:milton@trystaffify.com'), undefined, 'nothing stored for the wrong account');

    const again = await call(handler, { cookie: 'milton-sid', query: { action: 'connect', back: '/dialer/?open=r1' } });
    const state2 = new URL(again.location).searchParams.get('state');
    google.profile = { emailAddress: 'milton@trystaffify.com' };
    const ok = await call(connect, { cookie: 'milton-sid', query: { action: 'callback', state: state2, code: 'c' } });
    assert.equal(ok.code, 302); assert.equal(ok.location, '/dialer/?open=r1&gmail=connected');
    assert.ok(store.get('outreach:oauth:milton@trystaffify.com'), 'his token is stored, sealed');
    const paulTries = await call(connect, { cookie: 'paul-sid', query: { action: 'callback', state: 'nope', code: 'c' } });
    assert.equal(paulTries.code, 400, 'a state nobody started is refused');
});
