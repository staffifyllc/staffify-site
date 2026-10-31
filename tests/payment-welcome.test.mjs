// The payment welcome cron (api/_payment-welcome.js), the port of the Mac job staffify-payment-welcome.
// Fakes only: nothing here reaches QuickBooks, Resend, Slack or Redis, and every address is example.com.
//
// SCOPE NOTE: the fake store's SET NX is a single-threaded Map, so it proves the control flow around
// the claim, not Upstash's atomicity (which SET NX gives by definition).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { scheduledRun, deliver, plan, backfillView, sendBackfill, importKeys, statusView, sendMode, hourET, backfillSince, doNotContact, KEYS, RUN_HOURS_ET, BACKFILL_FLOOR } from '../api/_payment-welcome.js';
import { TEMPLATE, TEMPLATE_SHA256, SUBJECT, FROM, REPLY_TO, HUBSPOT_BCC, welcomeEmail } from '../api/_payment-welcome-copy.js';
import { claimWelcome, welcomeRecord, emailHash, claimKey, SENT, FAILURES, failureOf, retryExpired } from '../api/_welcome-ledger.js';
import * as utm from '../api/_staffify-utm.js';
import { EXCLUDED_NAMES } from '../api/_rep-email-gates.js';
import { parseLog, parseSuppression, suppressionPath } from '../scripts/seed-payment-welcome-ledger.mjs';

const NOW = Date.parse('2026-11-02T14:05:00Z'); // 9:05 AM Eastern, standard time: the desktop's first slot
const SLOT2 = NOW + 4 * 3600e3; // 1:05 PM Eastern
const SLOT3 = NOW + 9 * 3600e3; // 6:05 PM Eastern
const SALT = 'fake-salt-for-parity';
const LIVE = { PAYMENT_WELCOME_SEND: 'on', LEAD_ID_SALT: SALT, RESEND_API_KEY: 're_test_not_a_key' };
const DRY = { LEAD_ID_SALT: SALT };
const DANA = `welcome-strategy-call:${emailHash('dana@example.com')}`;

function fakeKv() {
    const S = new Map(), H = new Map(), SETS = new Map(), L = new Map(), ttl = new Map();
    const h = k => { if (!H.has(k)) H.set(k, new Map()); return H.get(k); };
    const st = k => { if (!SETS.has(k)) SETS.set(k, new Set()); return SETS.get(k); };
    // Upstash hands back parsed JSON for a stored JSON string; so does this.
    const out = v => { if (v == null) return null; try { return JSON.parse(v); } catch { return v; } };
    return { S, H, SETS, L, ttl,
        async get(k) { return S.has(k) ? out(S.get(k)) : null; },
        async set(k, v, o = {}) { if (o.nx && S.has(k)) return null; S.set(k, typeof v === 'string' ? v : JSON.stringify(v)); if (o.ex) ttl.set(k, o.ex); return 'OK'; },
        async del(k) { return S.delete(k) ? 1 : 0; },
        async eval(script, [k], [nonce]) { if (/GET/.test(script) && S.get(k) === nonce) { S.delete(k); return 1; } return 0; },
        async hget(k, f) { const m = H.get(k); return m && m.has(f) ? out(m.get(f)) : null; },
        async hset(k, o) { const m = h(k); for (const [a, b] of Object.entries(o)) m.set(a, String(b)); return 1; },
        async hgetall(k) { const m = H.get(k); return m && m.size ? Object.fromEntries(m) : null; },
        async hincrby(k, f, n) { const m = h(k); const v = Number(m.get(f) || 0) + n; m.set(f, String(v)); return v; },
        async hlen(k) { return H.has(k) ? H.get(k).size : 0; },
        async sadd(k, ...v) { const s = st(k); let n = 0; for (const x of v) if (!s.has(String(x))) { s.add(String(x)); n++; } return n; },
        async smembers(k) { return [...st(k)]; },
        async sismember(k, v) { return st(k).has(String(v)) ? 1 : 0; },
        async lpush(k, v) { if (!L.has(k)) L.set(k, []); L.get(k).unshift(v); return L.get(k).length; },
        async ltrim() { return 'OK'; },
        async lrange(k, a, b) { return (L.get(k) || []).slice(a, b + 1).map(out); },
    };
}

const cust = (Id, given, email, extra = {}) => ({ Id: String(Id), DisplayName: `${given} Co`, GivenName: given, ...(email ? { PrimaryEmailAddr: { Address: email } } : {}), ...extra });
const pay = (Id, custId, name, date, created, amount = 2499) => ({ Id, TxnDate: date, TotalAmt: amount, CustomerRef: { value: String(custId), name }, MetaData: { CreateTime: created } });

// A small QuickBooks: Dana pays for the first time today; Erin is an existing client; Finn has no email.
function books(extra = {}) {
    const customers = [cust(55, 'Dana', 'Dana@Example.com '), cust(60, 'Erin', 'erin@example.com'), cust(70, 'Finn', null), ...(extra.customers || [])];
    const payments = [
        pay('P1', 55, 'Dana Co', '2026-11-02', '2026-11-02T14:00:00Z'),
        pay('P2', 60, 'Erin Co', '2026-11-01', '2026-11-01T14:00:00Z', 900),
        pay('P0', 60, 'Erin Co', '2026-10-01', '2026-10-01T14:00:00Z', 900),
        pay('P3', 70, 'Finn Co', '2026-10-31', '2026-10-31T14:00:00Z'),
        ...(extra.payments || []),
    ];
    const calls = [];
    const query = async sql => {
        calls.push(sql);
        let m;
        if ((m = /FROM Payment WHERE TxnDate >= '([\d-]+)'/.exec(sql))) return { QueryResponse: { Payment: payments.filter(p => p.TxnDate >= m[1]).sort((a, b) => b.TxnDate.localeCompare(a.TxnDate)) } };
        // QuickBooks: a plain Customer query returns active records only.
        if (/^SELECT \* FROM Customer WHERE Active IN \(true, false\)/.test(sql)) return { QueryResponse: { Customer: customers } };
        if (/^SELECT \* FROM Customer/.test(sql)) return { QueryResponse: { Customer: customers.filter(c => c.Active !== false) } };
        if ((m = /COUNT\(\*\) FROM Payment WHERE CustomerRef = '(\d+)'/.exec(sql))) return { QueryResponse: { totalCount: payments.filter(p => p.CustomerRef.value === m[1]).length } };
        throw Error('unexpected query ' + sql);
    };
    return { query, calls, customers, payments };
}

function rig({ env = DRY, kv = fakeKv(), send, extra, now = NOW, optedOut, notify } = {}) {
    const sends = [], notes = [];
    const b = books(extra);
    const deps = {
        kv, query: b.query, env, now, sleep: async () => {}, optedOut: optedOut || (async () => false),
        send: send || (async m => { sends.push(m); return { id: 're_' + sends.length }; }),
        notify: notify || (async text => { notes.push(text); return { ok: true }; }),
    };
    return { deps, kv, sends, notes, books: b };
}
// The Mac seed is imported, the cloud has been watching since Oct 31, and (for live tests) went live on Nov 1.
const seeded = async kv => { await kv.set(KEYS.imports, JSON.stringify({ at: '2026-10-31T12:00:00.000Z', suppressionList: true })); };
const watching = async kv => { await seeded(kv); await kv.set(KEYS.watchSince, '2026-10-31T12:00:00.000Z'); };
const wentLive = async kv => { await watching(kv); await kv.set(KEYS.liveSince, '2026-11-01T12:00:00.000Z'); };

// ─── The approved copy ──────────────────────────────────────────

test('the template is the approved Mac file byte for byte, with no em dashes', () => {
    assert.equal(createHash('sha256').update(TEMPLATE, 'utf8').digest('hex'), TEMPLATE_SHA256);
    assert.equal(TEMPLATE_SHA256, '448f4185f051ac70f97c2819f92e2e7986d1805436b9c2088b4ed29c3a99907e');
    assert.equal(Buffer.byteLength(TEMPLATE), 11006);
    assert.equal(/\u2014|&mdash;|&#8212;/.test(TEMPLATE + SUBJECT), false);
    assert.equal(SUBJECT, "You're in. Book your strategy call.");
    assert.equal(FROM, 'Staffify <staffing@gostaffify.com>');
    assert.equal(REPLY_TO, 'hello@gostaffify.com');
    assert.equal(HUBSPOT_BCC, '51666712@bcc.hubspot.com');
});

test('links are tagged exactly as the Mac tagged them', () => {
    const m = welcomeEmail({ to: 'dana@example.com', firstName: 'Dana', salt: SALT });
    // lid computed by the Mac's own staffify-utm.js with this fake salt.
    assert.equal(m.lid, 'edZ1FYQsy7Kk');
    assert.deepEqual(m.links, [
        'https://calendly.com/d/cmsz-6bs-58k/business-strategy-call?utm_source=staffify&utm_medium=email&utm_campaign=welcome&utm_content=strategy-call&utm_term=edZ1FYQsy7Kk',
        'mailto:staffing@gostaffify.com?subject=Unsubscribe&body=Please%20remove%20me%20from%20future%20emails.',
    ]);
    assert.equal(m.html, TEMPLATE.replace('{{firstName}}', 'Dana').replace('href="https://calendly.com/d/cmsz-6bs-58k/business-strategy-call"',
        'href="https://calendly.com/d/cmsz-6bs-58k/business-strategy-call?utm_source=staffify&amp;utm_medium=email&amp;utm_campaign=welcome&amp;utm_content=strategy-call&amp;utm_term=edZ1FYQsy7Kk"'));
    assert.deepEqual(Object.keys(m.payload), ['from', 'to', 'reply_to', 'bcc', 'subject', 'html']);
    assert.match(welcomeEmail({ to: 'x@example.com', firstName: 'A&B <x>', salt: SALT }).html, /Hey A&amp;B &lt;x&gt;,/);
    assert.equal(welcomeEmail({ to: 'x@example.com', firstName: 'Dana', salt: '' }).lid, null, 'no salt, no lid');
});

test('the shared UTM module carries what both cloud ports import, so the pre-call branch merges onto it', () => {
    for (const name of ['leadIdReady', 'leadId', 'shouldTag', 'tagUrl', 'tagHtml']) assert.equal(typeof utm[name], 'function', name);
    assert.equal(utm.leadIdReady(''), false);
    assert.equal(utm.leadId('dana@example.com', SALT), 'edZ1FYQsy7Kk');
});

// ─── Dry run ────────────────────────────────────────────────────

test('dry-run sends nothing, records exactly what it would send, and keeps it briefly', async () => {
    const { deps, kv, sends, notes } = rig({ env: DRY });
    await watching(kv);
    const r = await scheduledRun(deps);
    assert.equal(r.mode, 'dry-run');
    assert.equal(sends.length, 0);
    assert.deepEqual(r.sent, []);
    assert.equal(r.wouldSend.length, 1);
    const w = r.wouldSend[0];
    assert.equal(w.email, 'dana@example.com', 'the payer, normalised');
    assert.equal(w.firstName, 'Dana');
    assert.equal(w.mail.subject, SUBJECT);
    assert.match(w.mail.links[0], /utm_term=edZ1FYQsy7Kk$/);
    assert.equal(r.existingClients, 1, 'Erin has paid before');
    assert.deepEqual(r.manual.map(x => x.code), ['no-email'], 'Finn is flagged, not guessed');
    assert.equal(r.manual[0].reason, 'FIRST payment but no email on QB customer - FLAG for manual');
    const saved = await kv.get(KEYS.pending);
    assert.equal(saved.wouldSend[0].customerId, '55');
    assert.equal(kv.ttl.get(KEYS.pending), 36 * 3600);
    assert.equal(await kv.get(KEYS.liveSince), null, 'a dry run never starts the go-live clock');
    assert.equal(kv.S.has(claimKey(emailHash('dana@example.com'))), false, 'and claims nobody');
    assert.equal(notes.length, 0, 'and posts nothing to Slack');
});

test('dry-run without LEAD_ID_SALT still shows the links, without the lid', async () => {
    const { deps, kv, sends } = rig({ env: {} });
    await watching(kv);
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 0);
    assert.equal(r.wouldSend[0].mail.lid, null);
    assert.match(r.wouldSend[0].mail.lidNote, /missing LEAD_ID_SALT/);
    assert.match(r.wouldSend[0].mail.links[0], /utm_content=strategy-call$/);
});

// ─── Live ───────────────────────────────────────────────────────

test('live sends once, to the payer, exactly the desktop email, and marks it sent after Resend accepts', async () => {
    const { deps, kv, sends } = rig({ env: LIVE });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.equal(r.mode, 'live');
    assert.equal(sends.length, 1);
    const p = sends[0].payload;
    assert.deepEqual(p.to, ['dana@example.com']);
    assert.equal(p.from, FROM); assert.equal(p.reply_to, REPLY_TO); assert.deepEqual(p.bcc, [HUBSPOT_BCC]); assert.equal(p.subject, SUBJECT);
    assert.equal(p.html, welcomeEmail({ to: 'dana@example.com', firstName: 'Dana', salt: SALT }).html);
    assert.equal(sends[0].idempotencyKey, `payment-welcome:welcome-strategy-call:${emailHash('dana@example.com')}`);
    assert.deepEqual(r.sent.map(s => [s.customerId, s.status, s.providerId]), [['55', 'sent', 're_1']]);
    const rec = await welcomeRecord(kv, 'dana@example.com');
    assert.equal(rec.sent.providerId, 're_1');
    assert.equal(rec.claim.state, 'sent');

    const again = await scheduledRun({ ...deps, now: SLOT2 });
    assert.equal(sends.length, 1, 'the next run sends nothing new');
    assert.equal(again.skipped.find(s => s.customerId === '55').code, 'welcomed');
});

test('two overlapping runs send once: the run lock, and the per-person claim underneath it', async () => {
    let release;
    const gate = new Promise(r => { release = r; });
    const sends = [];
    const slow = async m => { sends.push(m); await gate; return { id: 're_slow' }; };
    const { deps, kv } = rig({ env: LIVE, send: slow });
    await wentLive(kv);
    const a = scheduledRun(deps), b = scheduledRun(deps);
    setTimeout(release, 20);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal([ra, rb].filter(x => x.status === 'running').length, 1);
    assert.equal(sends.length, 1);

    // Without the lock (it expired, or a backfill send overlaps a run): the claim alone holds.
    const kv2 = fakeKv();
    const sends2 = [];
    let open;
    const wait = new Promise(r => { open = r; });
    const d2 = rig({ env: LIVE, kv: kv2, send: async m => { sends2.push(m); await wait; return { id: 're_x' }; } }).deps;
    await wentLive(kv2);
    const p = await plan(d2, { goLive: '2026-11-01T12:00:00.000Z', salt: SALT });
    const x = deliver(d2, p.rows, { salt: SALT }), y = deliver(d2, p.rows, { salt: SALT });
    setTimeout(open, 20);
    const [rx, ry] = await Promise.all([x, y]);
    assert.equal(sends2.length, 1, 'one email for one person');
    assert.deepEqual([...rx, ...ry].map(s => s.status).sort(), ['sent', 'skipped']);
});

test('live refuses to send without LEAD_ID_SALT, says so, and does not start the go-live clock', async () => {
    const { deps, kv, sends } = rig({ env: { PAYMENT_WELCOME_SEND: 'on', RESEND_API_KEY: 're_test_not_a_key' } });
    await watching(kv);
    const r = await scheduledRun(deps);
    assert.equal(r.refused, 'missing LEAD_ID_SALT');
    assert.equal(sends.length, 0);
    assert.equal(await kv.get(KEYS.liveSince), null);
    assert.equal((await kv.get(KEYS.pending)).refused, 'missing LEAD_ID_SALT', 'the plan is still kept for review');
    // deliver itself refuses too, before claiming anyone.
    const p = await plan(deps, { goLive: null, salt: '' });
    const out = await deliver(deps, p.rows, { salt: '' });
    assert.deepEqual(out.map(o => o.status), ['refused']);
    assert.equal(kv.S.has(claimKey(emailHash('dana@example.com'))), false);
    assert.equal(sendMode({ PAYMENT_WELCOME_SEND: 'on' }).refused, 'missing LEAD_ID_SALT, RESEND_API_KEY');
});

test('live refuses until the Mac seed, with its suppression list, is imported', async () => {
    // No seed at all.
    const a = rig({ env: LIVE });
    await a.kv.set(KEYS.watchSince, '2026-10-31T12:00:00.000Z');
    await a.kv.set(KEYS.liveSince, '2026-11-01T12:00:00.000Z');
    const r = await scheduledRun(a.deps);
    assert.equal(r.refused, 'missing desktop seed import');
    assert.equal(a.sends.length, 0);
    assert.equal(r.wouldSend.length, 1, 'the plan is still shown');
    assert.equal((await statusView(a.deps)).refused, 'missing desktop seed import');
    assert.equal((await statusView(a.deps)).readyForLive, false);
    const b = await sendBackfill(a.deps, ['55']);
    assert.equal(b.refused, 'missing desktop seed import');
    assert.equal(a.sends.length, 0, 'backfill waits for the seed too');

    // A seed without the suppression list is not enough.
    const c = rig({ env: LIVE });
    await c.kv.set(KEYS.watchSince, '2026-10-31T12:00:00.000Z');
    await importKeys(c.kv, { keys: [{ kind: 'welcome-strategy-call', hash: emailHash('ivy@example.com') }] });
    const rc = await scheduledRun(c.deps);
    assert.equal(rc.refused, 'the desktop seed import has no suppression list');
    assert.equal(await c.kv.get(KEYS.liveSince), null, 'the go-live clock waits for the seed');
    assert.equal(c.sends.length, 0);

    // Dry-run never needs it.
    const d = rig({ env: DRY });
    await d.kv.set(KEYS.watchSince, '2026-10-31T12:00:00.000Z');
    const rd = await scheduledRun(d.deps);
    assert.equal(rd.refused, undefined);
    assert.equal(rd.wouldSend.length, 1);
    assert.deepEqual((await statusView(d.deps)).notReady, ['missing RESEND_API_KEY', 'missing desktop seed import']);

    // With the list, live sends.
    await importKeys(c.kv, { suppressed: [], suppressionList: true });
    await c.kv.set(KEYS.liveSince, '2026-11-01T12:00:00.000Z');
    assert.equal((await scheduledRun({ ...c.deps, now: SLOT2 })).sent.length, 1);
});

test('live refuses while the webhook welcome path is configured', async () => {
    const { deps, kv, sends } = rig({ env: { ...LIVE, QB_WEBHOOK_VERIFIER_TOKEN: 'set' } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.match(r.refused, /QB_WEBHOOK_VERIFIER_TOKEN is set/);
    assert.equal(sends.length, 0);
});

test('someone already welcomed is skipped: the Mac log, this ledger, or the webhook path', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, extra: {
        customers: [cust(80, 'Gale', 'gale@example.com'), cust(90, 'Hana', 'hana@example.com')],
        payments: [pay('P8', 80, 'Gale Co', '2026-11-02', '2026-11-02T13:00:00Z'), pay('P9', 90, 'Hana Co', '2026-11-02', '2026-11-02T13:00:00Z')] } });
    await wentLive(kv);
    const imp = await importKeys(kv, { keys: [{ kind: 'welcome-strategy-call', hash: emailHash('dana@example.com'), at: '2026-09-04T22:07:38.885Z' }, { kind: 'welcome-strategy-call', hash: 'not-a-hash' }] });
    assert.deepEqual(imp.welcomed, { added: 1, kept: 0, rejected: 1 });
    assert.equal(imp.suppressionList, true, 'a later import never undoes the suppression list');
    await claimWelcome(kv, 'gale@example.com', { by: 'pilot-activation', ref: 'invoice:1' });
    await kv.hset('subscriber:hana@example.com', { onboarding_email_sent_at: '1' });
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 0);
    assert.equal(r.skipped.find(s => s.customerId === '55').code, 'welcomed');
    assert.equal(r.manual.find(s => s.customerId === '80').code, 'in-flight', 'the webhook path holds Gale');
    assert.equal(r.skipped.find(s => s.customerId === '90').code, 'welcomed');
    // Importing twice changes nothing.
    assert.deepEqual((await importKeys(kv, { keys: [{ kind: 'welcome-strategy-call', hash: emailHash('dana@example.com') }] })).welcomed, { added: 0, kept: 1, rejected: 0 });
});

test('a webhook send whose ledger write failed reads as welcomed, not in-flight', async () => {
    const { deps, kv, sends } = rig({ env: LIVE });
    await wentLive(kv);
    await claimWelcome(kv, 'dana@example.com', { by: 'pilot-activation', ref: 'invoice:9' }); // still "sending"
    await kv.hset('subscriber:dana@example.com', { onboarding_email_sent_at: '1' });
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 0);
    assert.equal(r.skipped.find(s => s.customerId === '55').code, 'welcomed');
    assert.equal(r.manual.some(m => m.customerId === '55'), false);
});

test('a provider error is never marked sent; one retry, then a person decides', async () => {
    let attempt = 0;
    const { deps, kv } = rig({ env: LIVE, send: async () => { attempt++; throw Error('Resend 500: upstream'); } });
    await wentLive(kv);
    const r1 = await scheduledRun(deps);
    assert.equal(r1.sent[0].status, 'failed');
    assert.equal(r1.sent[0].willRetry, true);
    assert.equal(await kv.hget(SENT, DANA), null, 'not marked sent');
    const r2 = await scheduledRun({ ...deps, now: SLOT2 });
    assert.equal(r2.sent[0].status, 'failed');
    assert.equal(r2.sent[0].willRetry, false);
    const r3 = await scheduledRun({ ...deps, now: SLOT3 });
    assert.equal(attempt, 2, 'retried no more than once');
    assert.equal(r3.manual.find(m => m.customerId === '55').code, 'failed');
    const f = failureOf(await kv.hget(FAILURES, DANA));
    assert.equal(f.n, 2);
    assert.equal(f.firstAt, new Date(NOW).toISOString(), 'the first failure time is kept');
    assert.equal(f.lastAt, new Date(SLOT2).toISOString());
    assert.equal(await kv.hget(SENT, DANA), null);
});

test('a retry after a failure succeeds and reuses the provider idempotency key', async () => {
    const keys = [];
    let n = 0;
    const { deps, kv } = rig({ env: LIVE, send: async m => { keys.push(m.idempotencyKey); if (++n === 1) throw Error('timeout'); return { id: 're_ok' }; } });
    await wentLive(kv);
    await scheduledRun(deps);
    const r = await scheduledRun({ ...deps, now: SLOT2 });
    assert.equal(r.sent[0].status, 'sent');
    assert.equal(keys[0], keys[1]);
});

test('a failure older than 23 hours is never retried on its own: a person checks Resend first', async () => {
    const { deps, kv } = rig({ env: LIVE, send: async () => { throw Error('The operation was aborted due to timeout'); } });
    await wentLive(kv);
    await scheduledRun(deps);
    assert.equal(failureOf(await kv.hget(FAILURES, DANA)).n, 1);
    assert.equal(kv.S.has(claimKey(emailHash('dana@example.com'))), false, 'the claim was let go for the retry');

    // Three days later, the backfill view does not offer Dana as if nothing happened.
    const later = NOW + 3 * 86400e3;
    const v = await backfillView({ ...deps, now: later });
    assert.deepEqual(v.sendable.map(s => s.customerId), []);
    assert.equal(v.notSendable.find(s => s.customerId === '55').code, 'retry-expired');
    assert.match(v.notSendable.find(s => s.customerId === '55').reason, /check Resend first/);

    // Approving her without saying Resend was checked does not send.
    const sends = [];
    const ok = { ...deps, now: later, send: async m => { sends.push(m); return { id: 're_after_check' }; } };
    const b1 = await sendBackfill(ok, ['55']);
    assert.equal(b1.notEligible[0].code, 'retry-expired');
    assert.equal(sends.length, 0);
    // With checkedResend, it does: the second and last attempt.
    const b2 = await sendBackfill(ok, ['55'], { checkedResend: ['55'] });
    assert.deepEqual(b2.sent.map(s => s.status), ['sent']);
    assert.equal(sends.length, 1);
    assert.equal((await sendBackfill(ok, ['55'], { checkedResend: ['60'] })).status, 'invalid', 'only ids that were named');

    // The pure rule: inside 23 hours retries, after it does not, an unknown first time does not.
    assert.equal(retryExpired({ n: 1, firstAt: new Date(NOW).toISOString() }, NOW + 22 * 3600e3), false);
    assert.equal(retryExpired({ n: 1, firstAt: new Date(NOW).toISOString() }, NOW + 24 * 3600e3), true);
    assert.equal(retryExpired({ n: 1, firstAt: null }, NOW), true);
    assert.equal(retryExpired({ n: 0, firstAt: null }, NOW), false);
});

test('a log write that fails after the send is recorded still reads as sent', async () => {
    const { deps, kv, sends } = rig({ env: LIVE });
    await wentLive(kv);
    kv.lpush = async () => { throw Error('lpush failed'); };
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 1);
    assert.equal(r.sent[0].status, 'sent');
    assert.match(r.sent[0].logError, /lpush failed/);
    assert.equal((await welcomeRecord(kv, 'dana@example.com')).sent.providerId, 're_1');
});

test('the gap between sends comes before the claim, so a crash in it holds nobody', async () => {
    const extra = { customers: [cust(81, 'Ivy', 'ivy@example.com')], payments: [pay('P81', 81, 'Ivy Co', '2026-11-02', '2026-11-02T13:00:00Z')] };
    const seen = [];
    const { deps, kv } = rig({ env: LIVE, extra });
    await wentLive(kv);
    deps.sleep = async () => { seen.push(['ivy', kv.S.has(claimKey(emailHash('ivy@example.com')))], ['dana', kv.S.has(claimKey(emailHash('dana@example.com')))]); };
    const r = await scheduledRun(deps);
    assert.equal(r.sent.length, 2);
    assert.equal(seen.length, 2, 'one gap, between the two sends');
    const claimedDuringGap = Object.fromEntries(seen);
    const second = r.sent[1].email.startsWith('ivy') ? 'ivy' : 'dana';
    assert.equal(claimedDuringGap[second], false, 'the second person is not claimed while the run waits');
});

// ─── Flags reach a person ───────────────────────────────────────

test('live keeps every flag by name in last-run and pending, and posts each new one to Slack once', async () => {
    const { deps, kv, notes } = rig({ env: LIVE, send: async () => { throw Error('Resend 500'); } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    const last = await kv.get(KEYS.lastRun);
    assert.deepEqual(last.flags.map(f => [f.customerId, f.name, f.code]), [['70', 'Finn Co', 'no-email'], ['55', 'Dana Co', 'failed']]);
    assert.match(last.flags[1].reason, /Resend 500/);
    const pending = await kv.get(KEYS.pending);
    assert.equal(pending.mode, 'live');
    assert.deepEqual(pending.manual.map(m => m.name), ['Finn Co']);
    assert.deepEqual(pending.sent.map(s => [s.name, s.status]), [['Dana Co', 'failed']]);
    assert.equal(notes.length, 2);
    assert.match(notes[0], /Finn Co \(QuickBooks customer 70\)\. FIRST payment but no email/);
    assert.equal(/\u2014/.test(notes.join('')), false, 'no em dashes');
    assert.equal(notes.some(n => n.includes('@')), false, 'no client address in Slack');
    assert.equal(r.newFlags.length, 2);

    // The same flags on the next run are not posted again; Finn's flag stays visible in status.
    await scheduledRun({ ...deps, now: SLOT2 });
    assert.equal(notes.length, 2);
    const s = await statusView(deps);
    assert.deepEqual(s.flags.map(f => f.code).sort(), ['failed', 'no-email']);
    assert.equal(s.lastRun.flags.find(f => f.customerId === '70').name, 'Finn Co');
});

// ─── Go-live and backfill ───────────────────────────────────────

test('live never sends a payment QuickBooks created before go-live; that is backfill', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, extra: {
        customers: [cust(81, 'Ivy', 'ivy@example.com')],
        payments: [pay('P81', 81, 'Ivy Co', '2026-10-30', '2026-10-30T15:00:00Z')] } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.deepEqual(sends.map(s => s.payload.to[0]), ['dana@example.com']);
    assert.equal(r.held.find(h => h.customerId === '81').reason.includes('backfill'), true);
});

test('the first live run starts the clock, so nothing already in QuickBooks goes out', async () => {
    const { deps, kv, sends } = rig({ env: LIVE });
    await watching(kv);
    const r = await scheduledRun(deps);
    assert.equal(r.goLive, new Date(NOW).toISOString());
    assert.equal(sends.length, 0, "today's payment was created before the switch: backfill");
    assert.equal(r.held.length, 1);
});

test('the backfill view lists first-time payers since the Mac stopped, with no welcome, and sends nothing', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, extra: {
        customers: [cust(81, 'Ivy', 'ivy@example.com'), cust(82, 'Jo', 'jo@example.com'), cust(83, 'Kit', 'kit@example.com')],
        payments: [pay('P81', 81, 'Ivy Co', '2026-10-20', '2026-10-20T15:00:00Z'), pay('P82', 82, 'Jo Co', '2026-10-16', '2026-10-16T15:00:00Z'),
            pay('P83', 82, 'Jo Co', '2026-09-01', '2026-09-01T15:00:00Z'), pay('P84', 83, 'Kit Co', '2026-10-01', '2026-10-01T15:00:00Z')] } });
    let v = await backfillView(deps);
    assert.match(v.warning, /missing desktop seed import/);
    await importKeys(kv, { keys: [{ kind: 'welcome-strategy-call', hash: emailHash('ivy@example.com') }], suppressionList: true });
    v = await backfillView(deps);
    assert.equal(v.warning, undefined);
    assert.equal(v.window.since, BACKFILL_FLOOR);
    assert.deepEqual(v.sendable.map(s => s.customerId).sort(), ['55', '83'], 'Ivy was welcomed by the Mac; Jo paid before; Kit paid Oct 1, after the Mac stopped');
    assert.deepEqual(v.notSendable.map(s => s.code), ['no-email']);
    assert.equal(v.alreadyWelcomed, 1);
    assert.equal(sends.length, 0);
});

test('the backfill start never slides past the day the Mac stopped', async () => {
    assert.equal(BACKFILL_FLOOR, '2026-09-28');
    assert.equal(backfillSince(Date.parse('2026-10-05T12:00:00Z')), '2026-09-14', '21 days back when that is earlier');
    assert.equal(backfillSince(Date.parse('2026-11-02T12:00:00Z')), '2026-09-28');
    assert.equal(backfillSince(Date.parse('2026-12-20T12:00:00Z')), '2026-09-28');
    // Weeks after Nov 4, a payer from Oct 1 is still offered, and can still be approved.
    const late = Date.parse('2026-11-25T15:00:00Z');
    const extra = { customers: [cust(83, 'Kit', 'kit@example.com')], payments: [pay('P84', 83, 'Kit Co', '2026-10-01', '2026-10-01T15:00:00Z')] };
    const { deps, kv, sends } = rig({ env: LIVE, extra, now: late });
    await wentLive(kv);
    assert.ok((await backfillView(deps)).sendable.some(s => s.customerId === '83'));
    const r = await sendBackfill(deps, ['83']);
    assert.deepEqual(r.sent.map(s => [s.customerId, s.status]), [['83', 'sent']]);
    assert.equal(sends.length, 1);
});

test('send-backfill sends only the named ids, live only; dry-run shows them', async () => {
    const extra = { customers: [cust(81, 'Ivy', 'ivy@example.com')], payments: [pay('P81', 81, 'Ivy Co', '2026-10-20', '2026-10-20T15:00:00Z')] };
    const dry = rig({ env: DRY, extra });
    const d = await sendBackfill(dry.deps, ['81']);
    assert.equal(d.mode, 'dry-run');
    assert.deepEqual(d.wouldSend.map(w => w.customerId), ['81']);
    assert.equal(dry.sends.length, 0);

    const live = rig({ env: LIVE, extra });
    await wentLive(live.kv);
    const r = await sendBackfill(live.deps, ['81', '60', '999']);
    assert.deepEqual(live.sends.map(s => s.payload.to[0]), ['ivy@example.com'], 'not Dana, who was not named');
    assert.deepEqual(r.notEligible.map(n => n.customerId).sort(), ['60', '999']);
    assert.equal((await sendBackfill(live.deps, [])).status, 'invalid');
    assert.equal((await sendBackfill(live.deps, ["1' OR 1=1"])).status, 'invalid');
    await sendBackfill(live.deps, ['81']);
    assert.equal(live.sends.length, 1, 'approving twice sends once');
});

// ─── Only the payer, only when sure ─────────────────────────────

test('nobody but the payer is ever written to, and an unsure address is a flag', async () => {
    const { deps, sends, kv } = rig({ env: LIVE, extra: {
        customers: [cust(91, 'Kai', 'kai@example.com, ops@example.com'), cust(92, 'Lu', 'shared@example.com'), cust(93, 'Mo', 'shared@example.com'),
            cust(94, 'Ned', 'ned@example.com', { ParentRef: { value: '60' }, Job: true })],
        payments: [pay('P91', 91, 'Kai Co', '2026-11-02', '2026-11-02T13:00:00Z'), pay('P92', 92, 'Lu Co', '2026-11-02', '2026-11-02T13:00:00Z'),
            pay('P94', 94, 'Erin Co:Ned', '2026-11-02', '2026-11-02T13:00:00Z'), pay('P95', 95, 'Gone Co', '2026-11-02', '2026-11-02T13:00:00Z'),
            pay('P96', 55, 'Dana Co', '2026-11-02', '2026-11-02T13:30:00Z', 0)] } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.deepEqual(sends.map(s => s.payload.to), [], 'Dana now has two payments, so she is an existing client');
    const codes = Object.fromEntries(r.manual.map(m => [m.customerId, m.code]));
    assert.deepEqual(codes, { 70: 'no-email', 91: 'unclear-email', 92: 'shared-email', 94: 'sub-customer', 95: 'no-customer' });
});

test('an inactive QuickBooks record with the same email makes the payer an existing client to check', async () => {
    const { deps, kv, sends, books: b } = rig({ env: LIVE, extra: {
        customers: [cust(40, 'Old', 'dana@example.com', { Active: false }), cust(41, 'Pat', 'pat@example.com', { Active: false })],
        payments: [pay('P41', 41, 'Pat Co', '2026-11-02', '2026-11-02T13:00:00Z')] } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 0, 'Dana is not "You\'re in." when an old record of hers exists');
    assert.equal(r.manual.find(m => m.customerId === '55').code, 'shared-email');
    assert.equal(r.manual.find(m => m.customerId === '41').code, 'inactive-customer');
    assert.ok(b.calls.some(c => c.startsWith('SELECT * FROM Customer WHERE Active IN (true, false)')));
});

test('the legal and named exclusions are never emailed, with or without a seeded text rule', async () => {
    // Built from the Hub's own list, so no name is written into this file.
    const title = n => n.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    const legal = EXCLUDED_NAMES.find(n => n.startsWith('mike ')), other = EXCLUDED_NAMES.find(n => !n.includes(legal.split(' ')[1]));
    const [first, last] = legal.split(' ');
    const { deps, kv, sends } = rig({ env: LIVE, extra: {
        customers: [cust(101, 'M', `m.${last}@example.com`), cust(102, 'M', 'mh@lawfirm.example', { DisplayName: title(legal), FamilyName: title(last) }),
            cust(103, 'M', null, { DisplayName: title(legal) + ' LLC' }), cust(104, 'B', 'b@example.com', { DisplayName: 'Acme', CompanyName: title(other) + ' Media' })],
        payments: [pay('PA', 101, 'M Co', '2026-11-02', '2026-11-02T14:00:00Z'), pay('PB', 102, title(legal), '2026-11-02', '2026-11-02T14:00:00Z'),
            pay('PC', 103, title(legal) + ' LLC', '2026-11-02', '2026-11-02T14:00:00Z'), pay('PD', 104, 'Acme', '2026-11-02', '2026-11-02T14:00:00Z')] } });
    await wentLive(kv); // the seed carries no --substring rule
    const r = await scheduledRun(deps);
    assert.deepEqual(sends.map(s => s.payload.to[0]), ['dana@example.com']);
    assert.deepEqual(r.skipped.filter(s => s.code === 'do-not-contact').map(s => s.customerId).sort(), ['101', '102', '103', '104']);
    assert.equal(r.manual.some(m => m.customerId === '103'), false, 'never put in front of a person as "no email, send by hand"');
    assert.equal(doNotContact({ CustomerRef: { name: `${title(first)}  ${title(last)}` } }, null), true, 'spacing does not matter');
    assert.equal(doNotContact({ CustomerRef: { name: 'Dana Co' } }, cust(55, 'Dana', 'dana@example.com')), false);
});

test('suppressed people are skipped (the Mac list and its text rule); an opted-out payer is flagged, never sent', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, optedOut: async e => e === 'oz@example.com', extra: {
        customers: [cust(71, 'Pia', 'pia@blocked.example'), cust(72, 'Quin', 'quin.someone@example.com'), cust(73, 'Oz', 'oz@example.com')],
        payments: ['71', '72', '73'].map(i => pay('P' + i, i, 'X', '2026-11-02', '2026-11-02T13:00:00Z')) } });
    await wentLive(kv);
    await importKeys(kv, { suppressed: parseSuppression('# comment\n@Blocked.example\n'), substrings: ['someone'], suppressionList: true });
    const r = await scheduledRun(deps);
    assert.deepEqual(sends.map(s => s.payload.to[0]), ['dana@example.com']);
    assert.deepEqual(r.skipped.filter(s => s.code === 'suppressed').map(s => s.customerId).sort(), ['71', '72']);
    const oz = r.manual.find(m => m.customerId === '73');
    assert.equal(oz.code, 'opted-out');
    assert.match(oz.reason, /global opt-out list/);
    assert.equal((await kv.get(KEYS.lastRun)).flags.some(f => f.code === 'opted-out'), true);
});

test('an unreadable opt-out list flags the person as unreadable instead of skipping them', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, optedOut: async () => { throw Error('The do-not-contact list could not be read'); } });
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.equal(sends.length, 0);
    assert.equal(r.manual.find(m => m.customerId === '55').code, 'unreadable');
});

// ─── The webhook path shares the claim ──────────────────────────

test('a person the webhook path already claimed is never sent the cron welcome, and the reverse', async () => {
    const kv = fakeKv();
    await claimWelcome(kv, 'dana@example.com', { by: 'pilot-activation', ref: 'invoice:900' });
    const { deps, sends } = rig({ env: LIVE, kv });
    await wentLive(kv);
    await scheduledRun(deps);
    assert.equal(sends.length, 0);

    const kv2 = fakeKv();
    const live = rig({ env: LIVE, kv: kv2 });
    await wentLive(kv2);
    await scheduledRun(live.deps);
    const theirs = await claimWelcome(kv2, 'dana@example.com', { by: 'pilot-activation', ref: 'invoice:900', resume: true });
    assert.equal(theirs.ok, false, 'the webhook path cannot take a slot the cron used');
    const again = await claimWelcome(kv2, 'dana@example.com', { by: 'payment-welcome', ref: 'customer:55' });
    assert.equal(again.ok, false, 'and the cron never resumes its own slot');
});

// ─── Schedule, status, seed ─────────────────────────────────────

test('the cron path ends in a slash and runs at exactly 9 AM, 1 PM and 6 PM Eastern all year', async () => {
    const v = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
    const c = v.crons.find(x => x.path.startsWith('/api/payment-welcome'));
    assert.equal(c.path, '/api/payment-welcome/');
    for (const x of v.crons) assert.match(x.path, /\/(\?|$)/, `${x.path} ends in a slash`);
    assert.deepEqual(RUN_HOURS_ET, [9, 13, 18]);
    const [min, hours, ...rest] = c.schedule.split(' ');
    assert.deepEqual(rest, ['*', '*', '*']);
    const list = hours.split(',').map(Number);
    for (const day of ['2026-10-15', '2026-11-15', '2027-03-20']) {
        const fires = list.map(h => Date.parse(`${day}T${String(h).padStart(2, '0')}:${min.padStart(2, '0')}:00Z`));
        const runs = fires.map(t => hourET(t)).filter(h => RUN_HOURS_ET.includes(h));
        assert.deepEqual(runs.sort((a, b) => a - b), [9, 13, 18], `${day}: each desktop hour once, nothing else`);
        // And the run itself does nothing at the other fire times.
        for (const t of fires.filter(t => !RUN_HOURS_ET.includes(hourET(t)))) {
            const { deps, kv, books: b } = rig({ env: LIVE, now: t });
            await wentLive(kv);
            assert.equal((await scheduledRun(deps)).status, 'skipped');
            assert.equal(b.calls.length, 0);
        }
    }
    assert.equal(v.functions['api/payment-welcome.js'].maxDuration, 120);
});

test('runs outside the desktop hours do nothing', async () => {
    for (const t of ['2026-11-02T12:17:00Z', '2026-11-02T15:05:00Z', '2026-11-03T01:00:00Z']) { // 7:17 AM, 10:05 AM, 8 PM EST
        const { deps, kv, sends, books: b } = rig({ env: LIVE, now: Date.parse(t) });
        await wentLive(kv);
        const r = await scheduledRun(deps);
        assert.equal(r.status, 'skipped', t);
        assert.equal(b.calls.length, 0);
        assert.equal(sends.length, 0);
    }
});

test('status names what is missing without any value, and what to do with the Mac task', async () => {
    const { deps, kv } = rig({ env: { PAYMENT_WELCOME_SEND: 'on', LEAD_ID_SALT: SALT } });
    await seeded(kv);
    const s = await statusView(deps);
    assert.equal(s.refused, 'missing RESEND_API_KEY');
    assert.equal(JSON.stringify(s).includes(SALT), false);
    assert.match(s.desktopTask, /staffify-payment-welcome/);
    assert.match(s.goLiveClock, /turned off and on again/);
    assert.equal(/\u2014/.test(JSON.stringify(s)), false);
    const ready = await statusView({ ...deps, env: LIVE });
    assert.equal(ready.readyForLive, true);
    assert.deepEqual(ready.notReady, []);
});

test('the seed reads only real welcome sends from the Mac log and sends hashes only', () => {
    const log = [
        JSON.stringify({ ts: '2026-08-05T18:15:35.681Z', to: 'Dana@Example.com', type: 'welcome-strategy-call', ok: true }),
        JSON.stringify({ ts: '2026-09-04T22:07:38.885Z', to: 'dana@example.com', type: 'welcome-strategy-call', ok: true }),
        JSON.stringify({ ts: '2026-09-05T10:00:00.000Z', to: 'ivy@example.com', type: 'welcome-strategy-call', dry: true }),
        JSON.stringify({ ts: '2026-09-06T10:00:00.000Z', to: 'jo@example.com', type: 'welcome-strategy-call', ok: false }),
        JSON.stringify({ ts: '2026-09-07T10:00:00.000Z', to: 'kai@example.com', type: 'precall-1' }),
        'not json',
    ].join('\n');
    const { keys, counts } = parseLog(log);
    assert.deepEqual(keys.map(k => k.hash), [emailHash('dana@example.com'), emailHash('jo@example.com')]);
    assert.deepEqual(counts, { rows: 4, dry: 1, unreadable: 1, failed: 1 });
    assert.equal(JSON.stringify(keys).includes('@'), false, 'no address leaves the Mac');
    assert.deepEqual(parseSuppression('# x\n\nA@B.example\n@c.example\n'), [emailHash('a@b.example'), emailHash('@c.example')]);
});

test('the seed finds the desktop suppression list next to the log, and an import records it once for good', async () => {
    assert.equal(suppressionPath('/mac/dir/staffify-email-log.jsonl', null, p => p === '/mac/dir/staffify-suppression-list.txt'), '/mac/dir/staffify-suppression-list.txt');
    assert.equal(suppressionPath('/mac/dir/staffify-email-log.jsonl', null, () => false), null);
    assert.equal(suppressionPath('/mac/dir/log.jsonl', '/elsewhere/list.txt', () => false), '/elsewhere/list.txt');
    const kv = fakeKv();
    const first = await importKeys(kv, { keys: [], suppressed: [emailHash('a@b.example')], suppressionList: true }, '2026-11-01T00:00:00.000Z');
    assert.equal(first.suppressionList, true);
    const second = await importKeys(kv, { keys: [] }, '2026-11-02T00:00:00.000Z');
    assert.equal(second.suppressionList, true);
    assert.equal(second.suppressionListAt, '2026-11-01T00:00:00.000Z');
    assert.equal(second.imports, 2);
    assert.equal(await kv.sismember(KEYS.suppressed, emailHash('a@b.example')), 1);
});

test('every view and action is owner-only, and the run itself needs the cron token', async () => {
    const { default: handler } = await import('../api/payment-welcome.js');
    const call = async (method, query = {}, body) => {
        let code = 0, value = null;
        await handler({ method, query, headers: {}, body }, { setHeader() {}, status(n) { code = n; return this; }, json(v) { value = v; return v; }, send(v) { value = v; return v; } });
        return { code, value };
    };
    for (const view of ['pending', 'backfill', 'status', 'preview']) assert.equal((await call('GET', { view })).code, 401, view);
    assert.equal((await call('GET')).code, 401, 'no token, no run');
    assert.equal((await call('POST', {}, { action: 'send-backfill', customerIds: ['55'] })).code, 401);
    assert.equal((await call('POST', {}, { action: 'import', keys: [] })).code, 401);
});

test('QuickBooks unreadable is an error, never "nobody paid", and the lock is let go', async () => {
    const { deps, kv, sends } = rig({ env: LIVE });
    await wentLive(kv);
    await assert.rejects(scheduledRun({ ...deps, query: async () => { throw Error('qb_refresh_failed 400: invalid_grant'); } }), /invalid_grant/);
    assert.equal(sends.length, 0);
    assert.match((await kv.get(KEYS.lastRun)).error, /invalid_grant/);
    assert.equal(kv.S.has(KEYS.lock), false);
    assert.equal((await scheduledRun(deps)).sent.length, 1, 'the next run works');
});
