// "Just send me something." The overview, one click, and the rules that still hold.
// ------------------------------------------------------------------
// Paul, 2026-10-22: a button that sends the Staffify overview when a prospect asks for it on a
// call. It is the clearest consent a prospect gives, which is why it can be one click. What it must
// still never do is go to somebody who said stop, go twice, or be pointed somewhere by the browser.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.ADMIN_TOKEN = 'test-admin';
process.env.RESEND_API_KEY = 'test-resend';

const mod = await import('../api/send-overview.js');
const { composeOverview, OVERVIEW_URL } = mod;
const handler = mod.default;

const ROW = { recipient: 'krista@cincyphotopro.com', company: 'Cincy Photo Pro', verifiedFirstName: 'Krista',
    sender: 'paul@trystaffify.com', callReady: true, campaignId: 'staffify-agency-outreach',
    callContact: { phone: '+15137408860' } };

// Upstash (pipelined and flat, base64), the site's PDF, and Resend.
function world({ rows = [ROW], optedNumbers = [], optedEmails = [], sent = {}, resendStatus = 200 } = {}) {
    const store = { 'staffify:outreach-review:v1': { revision: 1, records: rows, assignments: [], suppressions: [], pausedOwners: [] }, ...sent };
    const resendCalls = [];
    const b64 = v => (typeof v === 'string' ? Buffer.from(v, 'utf8').toString('base64') : v);
    globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url));
        if (u.host === 'www.gostaffify.com') return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 fake').buffer };
        if (u.host === 'api.resend.com') {
            resendCalls.push(JSON.parse(opts.body));
            return resendStatus === 200
                ? { ok: true, status: 200, json: async () => ({ id: 'em_123' }), text: async () => '' }
                : { ok: false, status: resendStatus, text: async () => 'refused' };
        }
        const encoded = (opts?.headers || {})['Upstash-Encoding'] === 'base64';
        const batch = JSON.parse(opts?.body || '[]');
        const answer = cmd => {
            const verb = String(cmd[0] || '').toUpperCase(), key = String(cmd[1] || '');
            if (verb === 'GET') return store[key] !== undefined ? JSON.stringify(store[key]) : null;
            if (verb === 'SET') { try { store[key] = JSON.parse(cmd[2]); } catch { store[key] = cmd[2]; } return 'OK'; }
            if (verb === 'SISMEMBER') {
                if (key === 'optout:numbers') return optedNumbers.includes(String(cmd[2])) ? 1 : 0;
                if (key === 'optout:emails') return optedEmails.includes(String(cmd[2])) ? 1 : 0;
                return 0;
            }
            return null;
        };
        const enc = r => (!encoded ? r : Array.isArray(r) ? r.map(b64) : b64(r));
        const payload = Array.isArray(batch[0]) ? batch.map(c => ({ result: enc(answer(c)) })) : { result: enc(answer(batch)) };
        const text = JSON.stringify(payload);
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => text, json: async () => payload };
    };
    return { store, resendCalls };
}
async function post(body, headers = {}) {
    let code = 200, out = null;
    const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { out = v; return v; } };
    await handler({ method: 'POST', headers: { origin: 'https://www.gostaffify.com', authorization: 'Bearer test-admin', ...headers }, body, query: {} }, res);
    return { code, out };
}

test('the email is built from the record, carries the PDF, and names the caller', () => {
    const m = composeOverview({ firstName: 'Krista', caller: 'Milton' });
    assert.match(m.text, /^Hi Krista,/);
    assert.match(m.text, /Thanks for taking the call from Milton today/);
    assert.ok(m.text.includes(OVERVIEW_URL), 'the link is in the body too, in case the attachment is stripped');
    assert.match(m.text, /It's attached as well/);
});

test('the body carries no statistics, per the September rule on outbound copy', () => {
    const m = composeOverview({ firstName: 'Krista', caller: 'Milton' });
    assert.ok(!/\d+\s?%/.test(m.text + m.html), 'no percentages');
    assert.ok(!/\b\d{2,}\b.*\b(clients?|agencies|employees)\b/i.test(m.text), 'no counts of clients or staff');
});

test('no first name means "Hi," and never "Hey there"', () => {
    const m = composeOverview({ firstName: '', caller: 'Milton' });
    assert.match(m.text, /^Hi,/);
    assert.ok(!/there/i.test(m.text.split('\n')[0]));
});

test('it sends once, attached, with replies routed to the mailbox they already know', async () => {
    const w = world();
    const { code, out } = await post({ email: 'krista@cincyphotopro.com' });
    assert.equal(code, 200);
    assert.equal(out.sent, true);
    assert.equal(w.resendCalls.length, 1);
    const sentMail = w.resendCalls[0];
    assert.deepEqual(sentMail.to, ['krista@cincyphotopro.com']);
    assert.equal(sentMail.reply_to, 'paul@trystaffify.com', 'the reply lands where the worker will see it');
    assert.equal(sentMail.attachments[0].filename, 'Staffify-Overview.pdf');
    assert.ok(sentMail.attachments[0].content.length > 0);
    assert.match(sentMail.text, /Hi Krista/);
});

test('a second click within 30 days does not send again', async () => {
    const w = world({ sent: { 'staffify:overview-sent:krista@cincyphotopro.com': { at: new Date().toISOString(), by: 'Milton' } } });
    const { out } = await post({ email: 'krista@cincyphotopro.com' });
    assert.equal(out.sent, false);
    assert.match(out.reason, /Already sent .* by Milton/);
    assert.equal(w.resendCalls.length, 0);
});

test('a STOP by text blocks it, even with no email on the opt-out list', async () => {
    // The lesson from the sweep: a STOP arrives as a number and links to no email.
    const w = world({ optedNumbers: ['5137408860'] });
    const { out } = await post({ email: 'krista@cincyphotopro.com' });
    assert.equal(out.sent, false);
    assert.match(out.reason, /do-not-contact/);
    assert.equal(w.resendCalls.length, 0);
});

test('the browser cannot point it at somebody outside the queue', async () => {
    const w = world();
    const { code, out } = await post({ email: 'someone-else@example.com' });
    assert.equal(code, 404);
    assert.equal(out.sent, false);
    assert.equal(w.resendCalls.length, 0);
});

test('names typed in the browser are ignored; the record decides', async () => {
    const w = world();
    await post({ email: 'krista@cincyphotopro.com', firstName: '<script>', company: 'Evil Co' });
    assert.match(w.resendCalls[0].text, /Hi Krista/);
    assert.ok(!w.resendCalls[0].text.includes('<script>'));
    assert.ok(!w.resendCalls[0].text.includes('Evil Co'));
});

test('a refused send reports as not sent, and records nothing', async () => {
    const w = world({ resendStatus: 422 });
    const { code, out } = await post({ email: 'krista@cincyphotopro.com' });
    assert.equal(code, 502);
    assert.equal(out.sent, false);
    assert.equal(w.store['staffify:overview-sent:krista@cincyphotopro.com'], undefined, 'no receipt for a send that did not happen');
});

test('wrong origin and no session are refused', async () => {
    world();
    assert.equal((await post({ email: 'krista@cincyphotopro.com' }, { origin: 'https://evil.example' })).code, 403);
    assert.equal((await post({ email: 'krista@cincyphotopro.com' }, { authorization: '' })).code, 403);
});
