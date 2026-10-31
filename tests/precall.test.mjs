// Pre-call emails from Vercel (api/_precall.js): the Mac's staffify-precall-emails job, dry-run by default.
// ------------------------------------------------------------------
// Pinned here: a dry run sends nothing, live sends once, two overlapping runs send once, a missing
// LEAD_ID_SALT refuses live, someone the Mac already emailed is skipped, and a provider error is never
// marked sent. Plus the desktop's own rules (roles, email #2 timing, the copy byte for byte) and the
// new stops (cancelled, rescheduled, a client, the stop list). Stubs only: nothing here calls
// Calendly or Resend or writes a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const P = await import('../api/_precall.js');
const { runPrecall, detectRole, nextStage, renderEmail, formatCall, importLedger, pendingView, emailHash, SENT, CLAIM, DRY_LOG, LIVE_LOG, TEMPLATES, TEMPLATES2, LID_PLACEHOLDER, loadTemplate } = P;
const { leadId, tagUrl, leadIdReady } = await import('../api/_staffify-utm.js');
const { ledgerEntries } = await import('../scripts/seed-precall-ledger.mjs');

const H = 3600 * 1000, DAY = 24 * H;
const NOW = Date.parse('2026-11-02T13:10:00Z');            // 8:10 ET, the morning slot
const ISO = t => new Date(t).toISOString();
const SALT = 'test-salt-not-real';
const LIVE = { CALENDLY_API_TOKEN: 'cal', RESEND_API_KEY: 'resend', LEAD_ID_SALT: SALT, PRECALL_SEND: 'on' };
const DRY = { CALENDLY_API_TOKEN: 'cal', RESEND_API_KEY: 'resend', LEAD_ID_SALT: SALT };
const DISCOVERY = 'https://api.calendly.com/event_types/62ac8330-2bb7-40e4-9b93-68a80b02a049';
const OTHER_TYPE = 'https://api.calendly.com/event_types/00000000-0000-0000-0000-000000000000';

// One fake store: strings with nx, hashes and lists, the shapes Upstash answers in.
function fakeKv(seed = {}, { failSet = null } = {}) {
    const m = new Map(Object.entries(seed.strings || {})), h = new Map(), l = new Map();
    for (const [k, v] of Object.entries(seed.hashes || {})) h.set(k, new Map(Object.entries(v)));
    const ttl = new Map();
    return { m, h, l, ttl,
        async get(k) { return m.has(k) ? m.get(k) : null; },
        async set(k, v, o = {}) { if (failSet && failSet(k)) throw Error('store down'); if (o.nx && m.has(k)) return null; m.set(k, v); if (o.ex) ttl.set(k, o.ex); else ttl.delete(k); return 'OK'; },
        async del(k) { return m.delete(k) ? 1 : 0; },
        async hgetall(k) { return h.has(k) && h.get(k).size ? Object.fromEntries(h.get(k)) : null; },
        async lpush(k, v) { if (!l.has(k)) l.set(k, []); l.get(k).unshift(v); return l.get(k).length; },
        async ltrim(k, a, b) { if (l.has(k)) l.set(k, l.get(k).slice(a, b + 1)); return 'OK'; },
        async expire(k, s) { ttl.set(k, s); return 1; },
        async lrange(k, a, b) { return (l.get(k) || []).slice(a, b + 1); },
    };
}

// Calendly as the desktop reads it: the events list, each event's invitees, and each one read again.
const evUri = n => `https://api.calendly.com/scheduled_events/ev-${n}`;
const event = (n, startTime, extra = {}) => ({ uri: evUri(n), event_type: DISCOVERY, start_time: startTime, status: 'active', ...extra });
const invitee = (n, email, name, answer, extra = {}) => ({ uri: `${evUri(n)}/invitees/inv-${n}`, email, name, status: 'active', rescheduled: false, old_invitee: null,
    questions_and_answers: [{ question: 'Which role are you looking to fill?', answer, position: 0 }], ...extra });
function fakeCalendly(bookings, { eventNow = {}, inviteeNow = {}, failRecheck = false } = {}) {
    const calls = [];
    const get = async url => {
        calls.push(url);
        if (url.startsWith('https://api.calendly.com/scheduled_events?user=')) return { collection: bookings.map(b => b.event), pagination: {} };
        for (const b of bookings) {
            if (url === `${b.event.uri}/invitees`) return { collection: b.invitees };
            if (url === b.event.uri) { if (failRecheck) throw Error('Calendly 500: down'); return { resource: { ...b.event, ...(eventNow[b.event.uri] || {}) } }; }
            const inv = b.invitees.find(i => i.uri === url);
            if (inv) { if (failRecheck) throw Error('Calendly 500: down'); return { resource: { ...inv, ...(inviteeNow[url] || {}) } }; }
        }
        throw Error('Calendly 404: ' + url);
    };
    return { get, calls };
}

const PAT = 'pat@brightframe.com';
const clear = async () => ({ status: 'clear', sources: [] });
const noStops = async () => ({ emails: new Set(), numbers: new Set() });
function sender(result = () => ({ ok: true, id: 'resend-1' }), { delay = 0 } = {}) {
    const sent = [];
    const send = async msg => { if (delay) await new Promise(r => setTimeout(r, delay)); sent.push(msg); return result(msg, sent.length); };
    return { send, sent };
}
const run = (kv, cal, env, extra = {}) => runPrecall({ kv, now: NOW, env, deps: { calendlyGet: cal.get, send: extra.send, optedOutSet: extra.optedOutSet || noStops, clientCheck: extra.clientCheck || clear, sleep: async () => {} }, ...(extra.opts || {}) });
const oneBooking = (answer = 'Video Editor', startTime = ISO(NOW + 3 * DAY), extra = {}) => [{ event: event(1, startTime), invitees: [invitee(1, PAT, 'Pat Rivera', answer, extra)] }];

// ---- the copy -----------------------------------------------------------------------------------

test('the six templates are the approved desktop files, byte for byte, and no subject changed', () => {
    const want = {
        'staffify-precall-video-editor.html': 'ebc6b38229d3884af74da6c685f3158968fe5dfd5ff87c37feb730e9c0a86f2b',
        'staffify-precall-va.html': '2d2ea5fa66f55bd32205203c6e7b69b1ba79170e7fc7e74c5290543764fef0bf',
        'staffify-precall-sales.html': '3cab67f6f4f95d3d5267919bcb8c73ffe3cfc0bee37075aade11a1ab9e4bd31b',
        'staffify-precall-photo-qc.html': 'bfef43861fecdef86fb89bf0d96e1216e0a389e592e229aecc009e2e0a6f0869',
        'staffify-precall2-general.html': '8c065e321eb14fa7826c636196c0a688dbe9749e75de06e1550d49ca3f05ce84',
        'staffify-precall2-video.html': 'bee1453b8958bc898945c9c363c2f6d5e2a39e70d1fee57468fa81af52daa2c2',
    };
    for (const [file, sha] of Object.entries(want)) {
        const bytes = readFileSync(new URL(`../api/_precall-templates/${file}`, import.meta.url));
        assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, file);
        assert.equal(loadTemplate(file), bytes.toString('utf8'));
    }
    assert.deepEqual(Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, [v.file, v.subject]])), {
        video: ['staffify-precall-video-editor.html', "Your call is booked. Here's what we're working with."],
        va: ['staffify-precall-va.html', "Your call is booked. Here's how this works."],
        sales: ['staffify-precall-sales.html', "Your call is booked. Here's what we bring to your pipeline."],
        csr: ['staffify-precall-va.html', "Your call is booked. Here's how this works."],
        photoqc: ['staffify-precall-photo-qc.html', "Your call is booked. Here's how we protect your quality."],
    });
    assert.deepEqual(TEMPLATES2, { video: { file: 'staffify-precall2-video.html', subject: 'One story before we talk' }, default: { file: 'staffify-precall2-general.html', subject: 'What actually happens after our call' } });
});

test('the email is built as the desktop builds it: name in, banner after the accent bar, owned links tagged', () => {
    const lid = leadId(PAT, SALT);
    const { html, banner, links } = renderEmail({ template: loadTemplate(TEMPLATES.video.file), firstName: 'Pat', startTime: '2026-11-05T18:00:00.000000Z', role: 'video', stage: 1, lid });
    assert.equal(banner, 'Your call: Thursday, November 5 at 1:00 PM EST', 'Eastern, plain spaces, as the Mac printed it');
    assert.ok(html.includes('Your call: Thursday, November 5 at 1:00 PM EST</p>'));
    assert.ok(!html.includes('{{firstName}}') && html.includes('Pat'));
    assert.ok(html.indexOf('Your call:') > html.indexOf('border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>'), 'after the accent bar');
    assert.ok(links.includes(`https://www.gostaffify.com/case-studies/realtor-pilot/?utm_source=staffify&utm_medium=email&utm_campaign=precall&utm_content=video-stage1&lid=${lid}`));
    assert.ok(links.some(u => u.startsWith('https://recruiting.gostaffify.com/editor-demo?utm_source=staffify')), 'a subdomain of ours is tagged');
    assert.ok(links.some(u => u.startsWith('mailto:staffing@gostaffify.com?subject=Unsubscribe&body=')), 'mailto untouched');
    assert.ok(html.includes('href="mailto:staffing@gostaffify.com?subject=Unsubscribe&amp;body='), 'and still encoded as it was');
    assert.equal(formatCall('2026-07-09T14:00:00.000000Z').time, '10:00 AM EDT');
});

test('lead ids are the desktop formula with the salt from LEAD_ID_SALT, and there is no id without one', () => {
    const want = createHash('sha256').update('pat@brightframe.com' + SALT).digest('base64url').slice(0, 12);
    assert.equal(leadId(' Pat@BrightFrame.com ', SALT), want);
    assert.equal(leadId(PAT, ''), null);
    assert.equal(leadIdReady(''), false);
    assert.equal(tagUrl('https://calendly.com/go-staffify/discovery-call', { campaign: 'precall', lid: 'abc' }), 'https://calendly.com/go-staffify/discovery-call?utm_source=staffify&utm_medium=email&utm_campaign=precall&utm_term=abc');
    assert.equal(tagUrl('https://www.gostaffify.com/x?utm_source=hand', { campaign: 'precall' }), 'https://www.gostaffify.com/x?utm_source=hand', 'a hand-set tag wins');
    assert.equal(tagUrl('https://get.quo.com/abc', { campaign: 'precall' }), 'https://get.quo.com/abc');
});

test('roles and email #2 timing are the desktop rules', () => {
    assert.equal(detectRole('Video Editor'), 'video');
    assert.equal(detectRole('Photo Editor / QC'), 'photoqc');
    assert.equal(detectRole('Executive Admin / Assistant'), 'va');
    assert.equal(detectRole('Customer Service Rep'), 'csr');
    assert.equal(detectRole('Sales Support'), 'sales');
    assert.equal(detectRole('photo editor for culling'), 'photoqc', 'photo before editor');
    assert.equal(detectRole('Other'), null);
    assert.equal(detectRole(''), null);
    const call = ISO(NOW + 2 * DAY);
    assert.equal(nextStage(null, null, { now: NOW, startTime: call }), 1);
    assert.equal(nextStage({ ts: ISO(NOW - 23 * H), ok: true }, null, { now: NOW, startTime: call }), 2);
    assert.equal(nextStage({ ts: ISO(NOW - 21 * H), ok: true }, null, { now: NOW, startTime: call }), null, 'too soon after #1');
    assert.equal(nextStage({ ts: ISO(NOW - 23 * H), ok: true }, null, { now: NOW, startTime: ISO(NOW + 11 * H) }), null, 'call too close');
    assert.equal(nextStage({ ts: ISO(NOW - 3 * DAY), ok: false }, null, { now: NOW, startTime: call }), null, 'a hold blocks #2');
    assert.equal(nextStage({ ts: ISO(NOW - 3 * DAY) }, { ts: ISO(NOW - DAY) }, { now: NOW, startTime: call }), null, 'never a third');
});

// ---- the six required behaviours -----------------------------------------------------------------

test('a dry run sends nothing, keeps what it would send, and flags the webhook overlap', async () => {
    const kv = fakeKv({ strings: { [`discovery:sent:${PAT}:editors`]: String(NOW - 2 * H) }, hashes: { [`discovery:${PAT}`]: { email: PAT, role: 'editors', booked_at: String(NOW - 2 * H), start_time: ISO(NOW + 3 * DAY) } } });
    const cal = fakeCalendly([...oneBooking(), { event: event(2, ISO(NOW + 4 * DAY), { event_type: OTHER_TYPE }), invitees: [invitee(2, 'lee@other.com', 'Lee', 'Video Editor')] }]);
    const s = sender();
    const r = await run(kv, cal, DRY, { send: s.send });
    assert.equal(r.mode, 'dry-run');
    assert.equal(s.sent.length, 0, 'nothing sent');
    assert.equal(r.events, 2); assert.equal(r.discovery, 1, 'only the Discovery event types');
    assert.equal(r.wouldSend.length, 1);
    const w = r.wouldSend[0];
    assert.equal(w.email, PAT); assert.equal(w.stage, 1); assert.equal(w.role, 'video');
    assert.equal(w.subject, "Your call is booked. Here's what we're working with.");
    assert.equal(w.from, 'Staffify <staffing@gostaffify.com>'); assert.equal(w.replyTo, 'hello@gostaffify.com'); assert.equal(w.bcc, '51666712@bcc.hubspot.com');
    assert.equal(w.lid, leadId(PAT, SALT));
    assert.equal(w.webhook.overlap, 'confirmed'); assert.equal(w.webhook.emailSent, true);
    assert.deepEqual(r.overlaps, [{ email: PAT, stage: 1, overlap: 'confirmed', webhookRole: 'editors' }]);
    assert.equal([...kv.m.keys()].filter(k => k.startsWith('precall:sent:') || k.startsWith('precall:claim:')).length, 0, 'no ledger write, no claim');
    const kept = JSON.parse(kv.l.get(DRY_LOG)[0]);
    assert.equal(kept.wouldSend[0].email, PAT); assert.equal(kept.wouldSend[0].html, undefined, 'never the HTML');
    assert.equal(kv.ttl.get(DRY_LOG), 3 * 86400, 'a short life');
    assert.ok(cal.calls.includes(evUri(1)) && cal.calls.includes(`${evUri(1)}/invitees/inv-1`), 'the dry run re-checks too');
    const view = await pendingView(kv);
    assert.equal(view.latestDryRun.wouldSend[0].email, PAT);
    assert.equal(view.sendFlag, 'dry-run');
});

test('live sends once, with the desktop envelope, and the next run skips them', async () => {
    const kv = fakeKv();
    const cal = fakeCalendly(oneBooking('Executive Admin / Assistant'));
    const s = sender();
    const r = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(r.mode, 'live');
    assert.equal(s.sent.length, 1);
    const msg = s.sent[0];
    assert.equal(msg.to, PAT); assert.equal(msg.subject, "Your call is booked. Here's how this works.");
    assert.equal(msg.idempotencyKey, `precall/${emailHash(PAT)}/1`);
    assert.ok(msg.html.includes(`lid=${leadId(PAT, SALT)}`));
    const entry = JSON.parse(kv.m.get(SENT(emailHash(PAT), 1)));
    assert.equal(entry.ok, true); assert.equal(entry.role, 'va'); assert.equal(entry.id, 'resend-1'); assert.equal(entry.ts, ISO(NOW));
    assert.equal(r.sent.length, 1); assert.ok(kv.l.get(LIVE_LOG).length === 1);
    const again = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(s.sent.length, 1, 'not twice');
    assert.equal(again.skipped[0].reason, 'already emailed');
});

test('two overlapping runs send once', async () => {
    const kv = fakeKv();
    const cal = fakeCalendly(oneBooking());
    const s = sender(undefined, { delay: 20 });
    const [a, b] = await Promise.all([run(kv, cal, LIVE, { send: s.send }), run(kv, cal, LIVE, { send: s.send })]);
    assert.equal(s.sent.length, 1, 'one email');
    assert.equal(a.sent.length + b.sent.length, 1);
    assert.ok([...a.skipped, ...b.skipped].some(x => x.reason === 'another run is sending this one'));
});

test('a missing LEAD_ID_SALT refuses live, and the dry run still shows the links', async () => {
    const kv = fakeKv();
    const cal = fakeCalendly(oneBooking());
    const s = sender();
    const env = { ...LIVE }; delete env.LEAD_ID_SALT;
    const r = await run(kv, cal, env, { send: s.send });
    assert.equal(r.requested, 'live'); assert.equal(r.mode, 'dry-run');
    assert.deepEqual(r.refused, ['missing LEAD_ID_SALT']);
    assert.equal(s.sent.length, 0);
    assert.equal(r.wouldSend[0].lid, LID_PLACEHOLDER);
    assert.ok(r.wouldSend[0].links.some(u => u.includes(`lid=${LID_PLACEHOLDER}`)));
    assert.ok(!kv.m.has(SENT(emailHash(PAT), 1)));
    const noResend = { ...LIVE }; delete noResend.RESEND_API_KEY;
    assert.deepEqual((await run(fakeKv(), cal, noResend, { send: s.send })).refused, ['missing RESEND_API_KEY']);
    assert.equal(s.sent.length, 0);
});

test('someone the Mac already emailed is skipped, and a Mac hold is never sent', async () => {
    const log = [
        JSON.stringify({ ts: ISO(NOW - 30 * H), to: 'Pat@BrightFrame.com', name: 'Pat', role: 'video', roleAnswer: 'Video Editor', subject: 's', ok: true, id: 'x' }),
        '{not json',
        JSON.stringify({ ts: ISO(NOW - 6 * H), to: PAT, role: 'video', stage: 2, ok: true, id: 'y' }),
        JSON.stringify({ ts: ISO(NOW - 9 * DAY), to: 'held@shop.com', name: 'H', role: 'hold', note: 'manual', ok: false }),
    ];
    const { entries, unreadable } = ledgerEntries(log);
    assert.equal(unreadable, 1);
    assert.ok(entries.every(e => !JSON.stringify(e).includes('@')), 'no address leaves the Mac');
    assert.deepEqual(entries.map(e => [e.key, e.stage, e.ok]), [[emailHash(PAT), 1, true], [emailHash(PAT), 2, true], [emailHash('held@shop.com'), 1, false]]);
    const kv = fakeKv();
    const imp = await importLedger(kv, entries, NOW);
    assert.equal(imp.imported, 3);
    assert.equal((await importLedger(kv, entries, NOW)).alreadyThere, 3, 'never overwrites');
    assert.equal((await importLedger(kv, [{ key: 'pat@brightframe.com', stage: 1, ts: ISO(NOW), ok: true }])).rejected.length, 1, 'an address is not a key');
    const cal = fakeCalendly([...oneBooking(), { event: event(3, ISO(NOW + 5 * DAY)), invitees: [invitee(3, 'held@shop.com', 'Hal', 'Sales Support')] }]);
    const s = sender();
    const r = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(s.sent.length, 0);
    assert.deepEqual(r.skipped.map(x => x.reason), ['already emailed', 'already emailed']);
});

test('a provider error is not marked sent, lets the claim go, and the next run sends it', async () => {
    const kv = fakeKv();
    const cal = fakeCalendly(oneBooking());
    const bad = sender(() => ({ ok: false, status: 500, unknown: true, error: 'Resend 500' }));
    const r = await run(kv, cal, LIVE, { send: bad.send });
    assert.equal(bad.sent.length, 1, 'it was tried');
    assert.equal(r.sent.length, 0); assert.equal(r.errors[0].error, 'Resend 500'); assert.equal(r.errors[0].unknown, true);
    assert.ok(!kv.m.has(SENT(emailHash(PAT), 1)), 'not marked sent');
    assert.ok(!kv.m.has(CLAIM(emailHash(PAT), 1)), 'claim let go');
    const thrown = sender(() => { throw Error('socket hang up'); });
    await run(kv, cal, LIVE, { send: thrown.send });
    assert.ok(!kv.m.has(SENT(emailHash(PAT), 1)), 'a throw is not a send either');
    const good = sender();
    await run(kv, cal, LIVE, { send: good.send });
    assert.equal(good.sent.length, 1);
    assert.equal(good.sent[0].idempotencyKey, bad.sent[0].idempotencyKey, 'the same key, so Resend makes it the same email');
    assert.ok(kv.m.has(SENT(emailHash(PAT), 1)));
});

test('sent but the ledger write failed: reported, and the claim keeps it from going again', async () => {
    const kv = fakeKv({}, { failSet: k => k.startsWith('precall:sent:') });
    const cal = fakeCalendly(oneBooking());
    const s = sender();
    const r = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(s.sent.length, 1);
    assert.match(r.errors[0].error, /ledger write failed; the claim now holds it for good/);
    assert.ok(kv.m.has(CLAIM(emailHash(PAT), 1)));
    assert.ok(!kv.ttl.has(CLAIM(emailHash(PAT), 1)), 'no expiry: it can never go twice');
    await run(kv, cal, LIVE, { send: s.send });
    assert.equal(s.sent.length, 1, 'the claim holds');
});

// ---- the stops ----------------------------------------------------------------------------------

test('never someone who cancelled or rescheduled, read again right before the send', async () => {
    for (const [why, opts, extra] of [
        ['event cancelled', { eventNow: { [evUri(1)]: { status: 'canceled' } } }],
        ['invitee cancelled', { inviteeNow: { [`${evUri(1)}/invitees/inv-1`]: { status: 'canceled' } } }],
        ['rescheduled', { inviteeNow: { [`${evUri(1)}/invitees/inv-1`]: { rescheduled: true } } }],
        ['rescheduled booking', {}, { old_invitee: 'https://api.calendly.com/scheduled_events/ev-0/invitees/inv-0' }],
    ]) {
        const kv = fakeKv(); const s = sender();
        const r = await run(kv, fakeCalendly(oneBooking('Video Editor', ISO(NOW + 3 * DAY), extra || {}), opts), LIVE, { send: s.send });
        assert.equal(s.sent.length, 0, why);
        assert.equal(r.skipped[0].reason, why);
        assert.ok(!kv.m.has(CLAIM(emailHash(PAT), 1)), why + ': claim let go');
    }
    const kv = fakeKv(); const s = sender();
    const r = await run(kv, fakeCalendly(oneBooking(), { failRecheck: true }), LIVE, { send: s.send });
    assert.equal(s.sent.length, 0); assert.equal(r.held[0].reason, 'Calendly re-check failed');
});

test('never a client, never the stop list, and a check that cannot answer holds', async () => {
    const cal = fakeCalendly(oneBooking());
    const cases = [
        [{ clientCheck: async () => ({ status: 'client', reason: 'already a client' }) }, 'skipped', 'existing client'],
        [{ clientCheck: async () => ({ status: 'unknown', why: 'HubSpot did not answer' }) }, 'held', 'client check unavailable'],
        [{ clientCheck: async () => { throw Error('down'); } }, 'held', 'client check unavailable'],
        [{ clientCheck: async () => ({ status: 'possible', reason: 'company match' }) }, 'held', 'possible client'],
        [{ optedOutSet: async () => ({ emails: new Set([PAT]), numbers: new Set() }) }, 'skipped', 'opted out'],
        [{ optedOutSet: async () => { throw Error('The do-not-contact list could not be read'); } }, 'held', 'stop list unavailable'],
    ];
    for (const [deps, list, reason] of cases) {
        const s = sender();
        const r = await run(fakeKv(), cal, LIVE, { send: s.send, ...deps });
        assert.equal(s.sent.length, 0, reason);
        assert.equal(r[list][0].reason, reason);
    }
    const r = await run(fakeKv(), fakeCalendly(oneBooking('Other')), LIVE, { send: sender().send });
    assert.equal(r.skipped[0].reason, 'role other or unknown');
});

test('email #2 goes a day later with its own template and the role email #1 recorded', async () => {
    const kv = fakeKv({ strings: { [SENT(emailHash(PAT), 1)]: JSON.stringify({ ts: ISO(NOW - 24 * H), role: 'video', ok: true, stage: 1 }) } });
    const s = sender();
    const r = await run(kv, fakeCalendly(oneBooking('Executive Admin / Assistant')), LIVE, { send: s.send });
    assert.equal(s.sent.length, 1);
    assert.equal(s.sent[0].subject, 'One story before we talk', 'the role recorded with #1 picks #2');
    assert.ok(s.sent[0].html.includes('utm_content=video-stage2'));
    assert.equal(r.sent[0].template, 'staffify-precall2-video.html');
    const kv2 = fakeKv({ strings: { [SENT(emailHash(PAT), 1)]: JSON.stringify({ ts: ISO(NOW - 24 * H), role: 'sales', ok: true, stage: 1 }) } });
    const s2 = sender();
    await run(kv2, fakeCalendly(oneBooking('Sales Support')), LIVE, { send: s2.send });
    assert.equal(s2.sent[0].subject, 'What actually happens after our call');
});

test('a person on two bookings gets one email in a run, dry or live', async () => {
    const bookings = [...oneBooking(), { event: event(2, ISO(NOW + 6 * DAY)), invitees: [invitee(2, PAT.toUpperCase(), 'Pat', 'Video Editor')] }];
    const dry = await run(fakeKv(), fakeCalendly(bookings), DRY, { send: sender().send });
    assert.equal(dry.wouldSend.length, 1);
    const s = sender();
    await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: s.send });
    assert.equal(s.sent.length, 1);
});

test('?dry=1 makes a live-configured run a dry run', async () => {
    const s = sender();
    const r = await runPrecall({ kv: fakeKv(), now: NOW, env: LIVE, force: 'dry-run', deps: { calendlyGet: fakeCalendly(oneBooking()).get, send: s.send, optedOutSet: noStops, clientCheck: clear, sleep: async () => {} } });
    assert.equal(r.mode, 'dry-run'); assert.equal(r.forced, 'dry-run'); assert.equal(s.sent.length, 0); assert.equal(r.wouldSend.length, 1);
});

test('the endpoint: runs need the cron token, the pending view an owner, the import a token', async () => {
    const { default: handler } = await import('../api/cron-precall.js');
    const call = async (method, query = {}) => {
        let code = 0, body = null;
        const res = { setHeader() {}, status(n) { code = n; return this; }, json(v) { body = v; return this; } };
        await handler({ method, headers: {}, query }, res);
        return { code, body };
    };
    assert.equal((await call('GET')).code, 401);
    assert.equal((await call('GET', { view: 'pending' })).code, 403);
    assert.equal((await call('POST', { action: 'import' })).code, 401);
    assert.equal((await call('DELETE')).code, 405);
});

test('the cron runs at the desktop slots, with the trailing slash the runner needs', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    const cron = vercel.crons.find(c => c.path.startsWith('/api/cron-precall'));
    assert.deepEqual(cron, { path: '/api/cron-precall/', schedule: '10 13,23 * * *' });
    assert.equal(vercel.functions['api/cron-precall.js'].includeFiles, 'api/_precall-templates/**');
});
