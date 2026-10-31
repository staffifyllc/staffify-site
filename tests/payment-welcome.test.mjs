// The payment welcome cron (api/_payment-welcome.js), the port of the Mac job staffify-payment-welcome.
// Fakes only: nothing here reaches QuickBooks, Resend or Redis, and every address is example.com.
//
// SCOPE NOTE: the fake store's SET NX is a single-threaded Map, so it proves the control flow around
// the claim, not Upstash's atomicity (which SET NX gives by definition).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { scheduledRun, deliver, plan, backfillView, sendBackfill, importKeys, statusView, sendMode, hourET, KEYS } from '../api/_payment-welcome.js';
import { TEMPLATE, TEMPLATE_SHA256, SUBJECT, FROM, REPLY_TO, HUBSPOT_BCC, welcomeEmail } from '../api/_payment-welcome-copy.js';
import { claimWelcome, welcomeRecord, emailHash, claimKey, SENT, FAILURES } from '../api/_welcome-ledger.js';
import { parseLog, parseSuppression } from '../scripts/seed-payment-welcome-ledger.mjs';

const NOW = Date.parse('2026-11-02T15:30:00Z'); // 10:30 AM Eastern, standard time
const SALT = 'fake-salt-for-parity';
const LIVE = { PAYMENT_WELCOME_SEND: 'on', LEAD_ID_SALT: SALT, RESEND_API_KEY: 're_test_not_a_key' };
const DRY = { LEAD_ID_SALT: SALT };

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
        if (/^SELECT \* FROM Customer/.test(sql)) return { QueryResponse: { Customer: customers } };
        if ((m = /COUNT\(\*\) FROM Payment WHERE CustomerRef = '(\d+)'/.exec(sql))) return { QueryResponse: { totalCount: payments.filter(p => p.CustomerRef.value === m[1]).length } };
        throw Error('unexpected query ' + sql);
    };
    return { query, calls, customers, payments };
}

function rig({ env = DRY, kv = fakeKv(), send, extra, now = NOW, optedOut } = {}) {
    const sends = [];
    const b = books(extra);
    const deps = {
        kv, query: b.query, env, now, sleep: async () => {}, optedOut: optedOut || (async () => false),
        send: send || (async m => { sends.push(m); return { id: 're_' + sends.length }; }),
    };
    return { deps, kv, sends, books: b };
}
// The cloud has been watching since Oct 31, and (for live tests) went live on Nov 1.
const watching = async kv => { await kv.set(KEYS.watchSince, '2026-10-31T12:00:00.000Z'); };
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

// ─── Dry run ────────────────────────────────────────────────────

test('dry-run sends nothing, records exactly what it would send, and keeps it briefly', async () => {
    const { deps, kv, sends } = rig({ env: DRY });
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

    const again = await scheduledRun({ ...deps, now: NOW + 3600e3 });
    assert.equal(sends.length, 1, 'the next hour sends nothing new');
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

test('a provider error is never marked sent; one retry, then a person decides', async () => {
    let attempt = 0;
    const { deps, kv } = rig({ env: LIVE, send: async () => { attempt++; throw Error('Resend 500: upstream'); } });
    await wentLive(kv);
    const r1 = await scheduledRun(deps);
    assert.equal(r1.sent[0].status, 'failed');
    assert.equal(r1.sent[0].willRetry, true);
    assert.equal(await kv.hget(SENT, `welcome-strategy-call:${emailHash('dana@example.com')}`), null, 'not marked sent');
    const r2 = await scheduledRun({ ...deps, now: NOW + 3600e3 });
    assert.equal(r2.sent[0].status, 'failed');
    assert.equal(r2.sent[0].willRetry, false);
    const r3 = await scheduledRun({ ...deps, now: NOW + 7200e3 });
    assert.equal(attempt, 2, 'retried no more than once');
    assert.equal(r3.manual.find(m => m.customerId === '55').code, 'failed');
    assert.equal(await kv.hget(FAILURES, `welcome-strategy-call:${emailHash('dana@example.com')}`), 2);
    assert.equal(await kv.hget(SENT, `welcome-strategy-call:${emailHash('dana@example.com')}`), null);
});

test('a retry after a failure succeeds and reuses the provider idempotency key', async () => {
    const keys = [];
    let n = 0;
    const { deps, kv } = rig({ env: LIVE, send: async m => { keys.push(m.idempotencyKey); if (++n === 1) throw Error('timeout'); return { id: 're_ok' }; } });
    await wentLive(kv);
    await scheduledRun(deps);
    const r = await scheduledRun({ ...deps, now: NOW + 3600e3 });
    assert.equal(r.sent[0].status, 'sent');
    assert.equal(keys[0], keys[1]);
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

test('the backfill view lists 21 days of first-time payers with no welcome, and sends nothing', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, extra: {
        customers: [cust(81, 'Ivy', 'ivy@example.com'), cust(82, 'Jo', 'jo@example.com')],
        payments: [pay('P81', 81, 'Ivy Co', '2026-10-20', '2026-10-20T15:00:00Z'), pay('P82', 82, 'Jo Co', '2026-10-16', '2026-10-16T15:00:00Z'),
            pay('P83', 82, 'Jo Co', '2026-09-01', '2026-09-01T15:00:00Z')] } });
    let v = await backfillView(deps);
    assert.match(v.warning, /has not been imported/);
    await importKeys(kv, { keys: [{ kind: 'welcome-strategy-call', hash: emailHash('ivy@example.com') }] });
    v = await backfillView(deps);
    assert.equal(v.warning, undefined);
    assert.equal(v.window.since, '2026-10-12');
    assert.deepEqual(v.sendable.map(s => s.customerId), ['55'], 'Ivy was welcomed by the Mac; Jo paid before');
    assert.deepEqual(v.notSendable.map(s => s.code), ['no-email']);
    assert.equal(v.alreadyWelcomed, 1);
    assert.equal(sends.length, 0);
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

test('suppressed people are skipped: the Mac list (hashed), its text rule, and the do-not-contact list', async () => {
    const { deps, kv, sends } = rig({ env: LIVE, optedOut: async e => e === 'oz@example.com', extra: {
        customers: [cust(71, 'Pia', 'pia@blocked.example'), cust(72, 'Quin', 'quin.someone@example.com'), cust(73, 'Oz', 'oz@example.com')],
        payments: ['71', '72', '73'].map(i => pay('P' + i, i, 'X', '2026-11-02', '2026-11-02T13:00:00Z')) } });
    await wentLive(kv);
    await importKeys(kv, { suppressed: parseSuppression('# comment\n@Blocked.example\n'), substrings: ['someone'] });
    const r = await scheduledRun(deps);
    assert.deepEqual(sends.map(s => s.payload.to[0]), ['dana@example.com']);
    assert.deepEqual(r.skipped.filter(s => s.code === 'suppressed').map(s => s.customerId).sort(), ['71', '72', '73']);
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

test('the cron path ends in a slash and its hours cover 8 AM to 8 PM Eastern all year', () => {
    const v = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
    const c = v.crons.find(x => x.path.startsWith('/api/payment-welcome'));
    assert.equal(c.path, '/api/payment-welcome/');
    const [min, hours] = c.schedule.split(' ');
    const list = hours.split(',').flatMap(p => p.includes('-') ? (([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i))(p.split('-').map(Number)) : [Number(p)]);
    for (const day of ['2026-10-15', '2026-11-15']) {
        const covered = new Set(list.map(h => hourET(Date.parse(`${day}T${String(h).padStart(2, '0')}:${min}:00Z`))));
        for (let et = 8; et <= 20; et++) assert.ok(covered.has(et), `${day}: ${et}:00 ET has a run`);
    }
    assert.equal(v.functions['api/payment-welcome.js'].maxDuration, 120);
});

test('runs outside 8 AM to 8 PM Eastern do nothing', async () => {
    const { deps, kv, sends, books: b } = rig({ env: LIVE, now: Date.parse('2026-11-02T12:17:00Z') }); // 7:17 AM EST
    await wentLive(kv);
    const r = await scheduledRun(deps);
    assert.equal(r.status, 'skipped');
    assert.equal(b.calls.length, 0);
    assert.equal(sends.length, 0);
});

test('status names what is missing without any value', async () => {
    const { deps } = rig({ env: { PAYMENT_WELCOME_SEND: 'on', LEAD_ID_SALT: SALT } });
    const s = await statusView(deps);
    assert.equal(s.refused, 'missing RESEND_API_KEY');
    assert.equal(JSON.stringify(s).includes(SALT), false);
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
