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
const MADISON = { email: 'madison@gostaffify.com', name: 'Madison', role: 'rep' };
const STRANGER = { email: 'nobody@gostaffify.com', name: 'Nobody', role: 'rep' };   // no sending mailbox in the Hub
const ROW = { id: 'r1', company: 'Realkit', recipient: 'support@realkit.com', phone: '+14043135871', sender: 'paul@trystaffify.com' };
const decode = raw => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const parts = mime => [...mime.matchAll(/Content-Type: (text\/\w+); charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)].map(m => [m[1], Buffer.from(m[2].replace(/\r\n/g, ''), 'base64').toString('utf8')]);

// ---- the mailbox, the signature ---------------------------------------------------------------
test('Milton sends from milton@trystaffify.com, whichever spelling his Hub record has; Paul from hello@; Madison from her own; nobody else', () => {
    assert.equal(R.mailboxFor(MILTON), 'milton@trystaffify.com');
    assert.equal(R.mailboxFor({ email: 'milton@trystaffify.com' }), 'milton@trystaffify.com');
    assert.equal(R.mailboxFor(PAUL), 'hello@gostaffify.com', 'Paul opened it as himself and was told he had no mailbox');
    assert.equal(R.mailboxFor(MADISON), 'madison@gostaffify.com', 'Paul, 2026-10-28: each rep has their own inbox');
    assert.equal(R.profileFor('madison@gostaffify.com').name, 'Madison Sterling'); assert.equal(R.profileFor('madison@gostaffify.com').title, 'Growth Strategist');
    assert.equal(R.mailboxFor(STRANGER), null, 'a rep with no entry gets no mailbox, never a guessed one');
    assert.equal(R.mailboxFor({ email: 'admin', role: 'admin' }), null);
});

test('the signature: his name, Growth Strategist, the Staffify wordmark, images from gostaffify.com only', () => {
    const html = R.signatureHtml('milton@trystaffify.com', { phone: { e164: '+15551234567', display: '(555) 123-4567' } });
    assert.match(html, />Milton Hodgson</); assert.ok(!/Gaitan/.test(html), 'Paul: no second last name');
    assert.match(html, /Growth Strategist/, 'Paul, 2026-10-27: "his email signautre should be growth strategist"');
    assert.match(html, /mailto:milton@trystaffify\.com/);
    assert.match(html, /tel:\+15551234567/); assert.match(html, /\(555\) 123-4567/);
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.length >= 5 && srcs.every(s => s.startsWith('https://www.gostaffify.com/assets/email/')), 'no vercel.app image hosts in a prospect email');
    assert.ok(srcs.every(s => /width="\d+"/.test(html)), 'images carry explicit sizes for Outlook');
    assert.ok(!/—/.test(html));
    const bare = R.signatureHtml('milton@trystaffify.com');
    assert.ok(!/tel:/.test(bare), 'no phone row when Quo cannot say which line is his');
    assert.match(R.signatureText('milton@trystaffify.com'), /Milton Hodgson\nGrowth Strategist, Staffify\nmilton@trystaffify\.com/);
});

test('Paul\'s signature is the one he already uses: Founder, the main line, hello@', () => {
    const html = R.signatureHtml('hello@gostaffify.com', { phone: R.profileFor('hello@gostaffify.com').phone });
    assert.match(html, /Paul Chareth/); assert.match(html, />Founder</);
    assert.match(html, /tel:\+13056369210/); assert.match(html, /\(305\) 636-9210/);
    assert.match(html, /mailto:hello@gostaffify\.com/);
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
test('routed to hello@: every rep but Paul copies hello@ and asks for answers there too; headers stay injection-proof', () => {
    assert.deepEqual(R.routeCopy('hello@gostaffify.com', 'Paul Chareth'), {}, 'Paul already sends from hello@');
    assert.deepEqual(R.routeCopy('madison@gostaffify.com', 'Madison Sterling'), { bcc: 'hello@gostaffify.com', replyTo: '"Madison Sterling" <madison@gostaffify.com>, hello@gostaffify.com' });
    assert.deepEqual(R.routeCopy('Milton@TryStaffify.com'), { bcc: 'hello@gostaffify.com', replyTo: 'milton@trystaffify.com, hello@gostaffify.com' });
    assert.deepEqual([...R.TEAM_MAILBOXES].sort(), ['madison@gostaffify.com', 'milton@trystaffify.com']);
    const paul = R.buildMime({ from: 'hello@gostaffify.com', fromName: 'Paul Chareth', to: 'a@b.co', subject: 's', text: 't', html: 'h', ...R.routeCopy('hello@gostaffify.com', 'Paul Chareth') });
    assert.doesNotMatch(paul, /\r\nBcc:|\r\nReply-To:/);
    assert.throws(() => R.buildMime({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't', html: 'h', bcc: 'x@y.co\r\nX-Evil: 1' }), /Invalid mail header/);
    assert.throws(() => R.buildMime({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't', html: 'h', replyTo: 'x@y.co\nX-Evil: 1' }), /Invalid mail header/);
});

test('owners see which reps can send from their own inbox: yes or no and when, never a token; an unreadable store is unknown', async () => {
    const open = v => v.sealed;
    const kv = { get: async k => ({
        'outreach:oauth:hello@gostaffify.com': { sealed: { scope: 'https://www.googleapis.com/auth/gmail.readonly', connectedAt: '2026-09-01T00:00:00Z', refresh_token: 'secret-1' } },
        'outreach:oauth:milton@trystaffify.com': { sealed: { scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose', connectedAt: '2026-10-27T21:00:00Z', refresh_token: 'secret-2' } },
    })[k] ?? null };
    const { mailboxReport } = await import('../api/rep-email.js');
    const rows = Object.fromEntries((await mailboxReport({ kv, open })).map(r => [r.mailbox, r]));
    assert.deepEqual(rows['milton@trystaffify.com'], { mailbox: 'milton@trystaffify.com', name: 'Milton Hodgson', state: 'can_send', canSend: true, connectedAt: '2026-10-27T21:00:00Z', copiesTo: 'hello@gostaffify.com' });
    assert.equal(rows['hello@gostaffify.com'].state, 'read_only', 'a read-only token cannot send'); assert.equal(rows['hello@gostaffify.com'].copiesTo, null);
    assert.equal(rows['madison@gostaffify.com'].state, 'not_connected');
    assert.doesNotMatch(JSON.stringify(rows), /secret-/, 'no token ever leaves');
    const broken = await mailboxReport({ kv: { get: async () => { throw Error('down'); } }, open });
    assert.ok(broken.every(r => r.state === 'unknown' && r.canSend === false), 'a failed read is not "not connected"');
});

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
    assert.match(mime, /From: "Milton Hodgson" <milton@trystaffify\.com>/);
    assert.match(mime, /To: support@realkit\.com/);
    assert.match(mime, /\r\nBcc: hello@gostaffify\.com\r\n/, 'Paul: his own inbox, routed to hello@');
    assert.match(mime, /\r\nReply-To: "Milton Hodgson" <milton@trystaffify\.com>, hello@gostaffify\.com\r\n/, 'their answer reaches Milton and hello@');
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
    const nobody = await sendRepEmail({ rep: STRANGER, input: DRAFT, deps });
    assert.equal(nobody.status, 403, 'no mailbox, no send'); assert.match(nobody.body.reason, /nobody@gostaffify\.com/, 'it says which login has no mailbox');
});

test('the send refuses a suppressed prospect and whatever the gates stop, before Gmail is touched', async () => {
    const { deps, g } = setup({ deps: { findRow: async () => ({ ...ROW, status: 'suppressed' }), stops: async row => (row.status === 'suppressed' ? 'This person is excluded from all outreach (Not interested / stop).' : null) } });
    const c = await cleaned(deps);
    const r = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(r.body.sent, false); assert.match(r.body.reason, /excluded from all outreach/); assert.equal(g.calls.length, 0);
    const broken = setup({ deps: { stops: async () => { throw Error('down'); } } });
    const c2 = await cleaned(broken.deps);
    const r2 = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c2 }, deps: broken.deps });
    assert.equal(r2.body.sent, false); assert.match(r2.body.reason, /could not run/, 'a check that failed is never a pass');
});

test('an unconfirmed send is checked before anything goes to that person again, from any window', async () => {
    let draftStill = 'unknown';
    const { deps, g, kv } = setup({ failSend: true });
    const c = await cleaned(deps);
    const first = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(first.body.uncertain, true);
    assert.ok(await kv.get(K.uncertain('milton@trystaffify.com', 'support@realkit.com')), 'held by recipient, not just by window');
    const gm = async (t, path, body, method) => {
        g.calls.push({ path, method });
        if (path === 'drafts/d1' && !method) { if (draftStill === 'gone') throw Error('Gmail drafts/d1 failed 404: Not Found'); if (draftStill === 'there') return { id: 'd1' }; throw Error('Gmail drafts/d1 failed 500'); }
        if (path === 'drafts/d1' && method === 'DELETE') return {};
        if (path.startsWith('messages?')) return { messages: draftStill === 'gone' ? [{ id: 'm1' }] : [] };   // the Sent folder decides
        if (path === 'drafts') return { id: 'd2' };
        if (path === 'drafts/send') return { id: 'm2', threadId: 't2' };
        if (path.startsWith('messages/')) return { labelIds: ['SENT'], payload: { headers: [{ name: 'To', value: 'support@realkit.com' }] } };
        throw Error('unexpected ' + path);
    };
    const again = (nonce) => sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c, nonce }, deps: { ...deps, gmail: gm } });
    const unknown = await again('nonce-0002');
    assert.equal(unknown.body.sent, false); assert.match(unknown.body.reason, /cannot be checked/, 'Gmail unreadable: refuse');
    draftStill = 'gone';
    const went = await again('nonce-0003');
    assert.equal(went.body.sent, false); assert.equal(went.body.already, true); assert.match(went.body.reason, /did go out/);
    assert.equal(g.calls.filter(x => x.path === 'drafts/send').length, 1, 'the second window never sent');
    assert.equal(await kv.get(K.uncertain('milton@trystaffify.com', 'support@realkit.com')), null);
    await kv.set(K.uncertain('milton@trystaffify.com', 'support@realkit.com'), { draftId: 'd1', at: new Date().toISOString() });
    draftStill = 'there';
    const never = await again('nonce-0004');
    assert.equal(never.body.sent, true, 'the draft was still there, so the first never went: this one sends');
    assert.ok(g.calls.some(x => x.path === 'drafts/d1' && x.method === 'DELETE'), 'and the stuck draft is cleared');
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
    assert.equal(s.templates[0].id, 'thanks-book'); assert.match(s.signatureHtml, /Milton Hodgson/);
    assert.equal(s.history.length, 1); assert.equal(s.history[0].subject, 'Thanks for your time today');
    assert.equal((await repEmailStatus({ rep: STRANGER, kv })).mailbox, null);
    assert.equal((await repEmailStatus({ rep: MADISON, kv, line: async () => null })).mailbox, 'madison@gostaffify.com');
    assert.equal((await repEmailStatus({ rep: PAUL, kv, line: async () => null })).mailbox, 'hello@gostaffify.com');
});

test('connected means the stored token may SEND: a read-only connection asks to connect again', async () => {
    const { seal } = await import('../api/_outreach-gmail.js');
    const { canSendWith } = await import('../api/rep-email.js');
    const ro = seal({ refresh_token: 'r', connectedAt: 'x', scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    const rw = seal({ refresh_token: 'r', connectedAt: 'x', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' });
    const old = seal({ refresh_token: 'r', connectedAt: 'x' });
    assert.equal(canSendWith(ro), false, 'hello@ was connected read-only for website replies');
    assert.equal(canSendWith(old), false, 'a token from before scopes were recorded cannot be trusted to send');
    assert.equal(canSendWith(rw), true);
    assert.equal(canSendWith(null), false); assert.equal(canSendWith({ iv: 'bad', tag: 'bad', body: 'bad' }), false);
    const kv = fakeKv(); kv.m.set(K.token('hello@gostaffify.com'), ro);
    assert.equal((await repEmailStatus({ rep: PAUL, kv, line: async () => null })).connected, false);
    kv.m.set(K.token('hello@gostaffify.com'), rw);
    assert.equal((await repEmailStatus({ rep: PAUL, kv, line: async () => null })).connected, true);
});

test('Gmail refusing the draft for lack of permission asks to connect again, and keeps the message', async () => {
    const { deps, g } = setup({ deps: { gmail: async (t, path) => { if (path === 'drafts') throw Error('Gmail drafts failed 403: Request had insufficient authentication scopes.'); throw Error('unexpected'); } } });
    const c = await cleaned(deps);
    const r = await sendRepEmail({ rep: MILTON, input: { ...DRAFT, ...c }, deps });
    assert.equal(r.body.sent, false); assert.equal(r.body.connect, true); assert.match(r.body.reason, /permission to send/);
    void g;
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
    const owners = await call(handler, { bearer: 'test-admin', query: { action: 'mailboxes' } });
    assert.equal(owners.code, 200); assert.equal(owners.body.routeTo, 'hello@gostaffify.com');
    assert.deepEqual(owners.body.mailboxes.map(m => m.mailbox).sort(), ['hello@gostaffify.com', 'madison@gostaffify.com', 'milton@trystaffify.com']);
    assert.equal((await call(handler, { cookie: 'milton-sid', query: { action: 'mailboxes' } })).code, 403, 'a caller does not see who else is connected');
    assert.equal((await call(handler, { cookie: 'paul-sid', query: { action: 'mailboxes' } })).code, 200);
});

test('connect: Google consent for HIS mailbox only, and the callback brings him back to the card', async () => {
    seed();
    const start = await call(handler, { cookie: 'milton-sid', query: { action: 'connect', back: '/dialer/?open=r1' } });
    assert.equal(start.code, 302);
    const g = new URL(start.location);
    assert.equal(g.host, 'accounts.google.com'); assert.equal(g.searchParams.get('login_hint'), 'milton@trystaffify.com');
    assert.equal(g.searchParams.get('hd'), 'trystaffify.com', 'Google lists only that domain\'s accounts, so a Flylisted login is never offered');
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
    const { canSendWith } = await import('../api/rep-email.js');
    assert.equal(canSendWith(store.get('outreach:oauth:milton@trystaffify.com')), true, 'the granted scopes are sealed with it, so the composer knows it can send');
    const paulTries = await call(connect, { cookie: 'paul-sid', query: { action: 'callback', state: 'nope', code: 'c' } });
    assert.equal(paulTries.code, 400, 'a state nobody started is refused');
});

test('outreach paused by an unreadable mailbox is reported to owners only, with the reconnect link', async () => {
    // Paul, 2026-10-27: "our campaigns aren't going so hot". paul@trystaffify.com had expired and
    // every new draft and follow-up waited eight days with nothing on screen saying so.
    seed();
    store.set('outreach:cloud:config', JSON.stringify({ enabled: true, accounts: [{ email: 'paul@trystaffify.com', owner: 'Paul', brand: 'Staffify', draftEnabled: true }], expectedAccounts: 1 }));
    store.set('outreach:cloud:last-run', JSON.stringify({ startedAt: '2026-10-27T22:12:32.297Z', reason: 'One or more mailbox histories are unavailable; new drafts paused to prevent duplicate outreach', mailboxErrors: [{ email: 'paul@trystaffify.com', error: 'Mailbox authorization expired: paul@trystaffify.com' }] }));
    const owner = await call(connect, { cookie: 'paul-sid', query: { action: 'paused' } });
    assert.equal(owner.code, 200); assert.equal(owner.body.paused, true);
    assert.deepEqual(owner.body.mailboxes.map(m => m.reconnect), ['/api/outreach-connect/?action=start&email=paul%40trystaffify.com']);
    assert.equal((await call(connect, { cookie: 'milton-sid', query: { action: 'paused' } })).code, 401, 'a caller is not shown the outreach controls');
    store.set('outreach:cloud:last-run', JSON.stringify({ startedAt: '2026-10-27T23:00:00Z', reason: null, mailboxErrors: [] }));
    assert.equal((await call(connect, { cookie: 'paul-sid', query: { action: 'paused' } })).body.paused, false);
});

test('another address at the same company, from a gatekeeper: allowed, checked, and remembered on the card', async () => {
    // Milton, 2026-10-27: "the one that you texted is not the right email I got a different one from the GK which is: deana@mckinstry.com"
    const MCK = { id: 'mk', company: 'McKinstry', recipient: 'dean@mckinstry.com', website: 'https://www.mckinstry.com', status: 'sent' };
    assert.deepEqual(R.companyDomains(MCK), ['mckinstry.com']);
    assert.equal(R.otherAddressProblem(MCK, 'deana@mckinstry.com'), null);
    assert.equal(R.otherAddressProblem(MCK, 'Deana@McKinstry.com'), null);
    assert.equal(R.otherAddressProblem(MCK, 'deana@ops.mckinstry.com'), null, 'a subdomain of the company');
    assert.match(R.otherAddressProblem(MCK, 'deana@gmail.com'), /Use an address at mckinstry\.com/);
    assert.match(R.otherAddressProblem(MCK, 'deana@mckinstry.com.evil.example'), /Use an address at/);
    assert.match(R.otherAddressProblem({ recipient: 'owner@gmail.com' }, 'x@gmail.com'), /no company domain/, 'a free mailbox proves no company');
    const seenTo = [];
    const { deps, g, kv } = setup({ deps: { findRow: async () => MCK, firstName: async () => 'Dean', stops: async (row, to) => { seenTo.push(to); return null; } } });
    const draft = { ...DRAFT, email: 'dean@mckinstry.com', to: 'deana@mckinstry.com', first: 'Deana', subject: 'Thanks for your time today', body: 'Hi Deana,\n\nThanks for passing me along.\n\nMilton' };
    const c = (await cleanRepEmail({ rep: MILTON, input: draft, deps })).body;
    assert.equal(c.subject, 'Deana, thanks for your time today', 'the name typed for the new address, not the card\'s');
    const r = await sendRepEmail({ rep: MILTON, input: { ...draft, subject: c.subject, body: c.body }, deps });
    assert.equal(r.body.sent, true); assert.equal(r.body.to, 'deana@mckinstry.com');
    assert.deepEqual(seenTo, ['deana@mckinstry.com', 'dean@mckinstry.com'], 'the checks ran on the address it went to, and the card\'s own contact still counts');
    const mime = decode(g.calls.find(x => x.path === 'drafts').body.message.raw);
    assert.match(mime, /\r\nTo: deana@mckinstry\.com\r\n/);
    assert.equal((kv.lists.get(K.sent('dean@mckinstry.com')) || []).length, 1, 'the card shows it was emailed');
    const bad = await sendRepEmail({ rep: MILTON, input: { ...draft, to: 'deana@gmail.com', subject: c.subject, body: c.body, nonce: 'nonce-9999' }, deps });
    assert.equal(bad.status, 400); assert.match(bad.body.reason, /mckinstry\.com/);
});

test('the headshot: a real JPEG or PNG only, small, versioned, and in the signature', async () => {
    const { savePhoto, photoUrlFor } = await import('../api/rep-email.js');
    const kv = fakeKv();
    const jpeg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    const r = await savePhoto('milton@trystaffify.com', jpeg, kv, Date.parse('2026-10-27T23:00:00Z'));
    assert.equal(r.ok, true); assert.match(r.url, /^https:\/\/www\.gostaffify\.com\/api\/rep-photo\/\?m=milton%40trystaffify\.com&v=\d+$/);
    assert.equal(await photoUrlFor('milton@trystaffify.com', kv), r.url);
    assert.equal((await savePhoto('milton@trystaffify.com', 'data:image/jpeg;base64,' + Buffer.from('<svg onload=x>').toString('base64'), kv)).ok, false, 'not a picture');
    assert.equal((await savePhoto('milton@trystaffify.com', 'data:text/html;base64,PGI+', kv)).ok, false);
    assert.equal((await savePhoto('milton@trystaffify.com', 'data:image/jpeg;base64,' + Buffer.alloc(300 * 1024, 0xff).toString('base64'), kv)).ok, false, 'too large');
    const html = R.signatureHtml('milton@trystaffify.com', { photo: r.url });
    assert.match(html, /border-radius:50%/); assert.ok(html.includes(r.url.replace('&', '&amp;')), 'the address is in the src, escaped as HTML');
});
