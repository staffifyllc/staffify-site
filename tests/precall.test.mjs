// Pre-call emails from Vercel (api/_precall.js): the Mac's staffify-precall-emails job, dry-run by default.
// ------------------------------------------------------------------
// Pinned here: a dry run sends nothing, live sends once, two overlapping runs send once, a missing
// LEAD_ID_SALT refuses live, someone the Mac already emailed is skipped, and a provider error is never
// marked sent. Plus the desktop's own rules (roles, email #2 timing, the copy byte for byte), the
// new stops (cancelled, the booking someone moved away from, a client, the stop list), and the review
// fixes: rebooked people are emailed, live refuses on an unimported ledger or with no notice
// destination, an orphaned claim is held and never re-sent, retries stay inside 20 hours, one bad
// booking never stops a run, dry-run holds show their email, and the run notice. Stubs only: nothing
// here calls Calendly, Resend or Slack or writes a real store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const P = await import('../api/_precall.js');
const { runPrecall, detectRole, nextStage, renderEmail, formatCall, importLedger, pendingView, emailHash, SENT, CLAIM, ATTEMPT, SEEDED, DRY_LOG, LIVE_LOG, TEMPLATES, TEMPLATES2, LID_PLACEHOLDER, loadTemplate,
    roleAnswerOf, noticeText, liveBlockers, CLAIM_SECONDS, RUN_BUDGET_MS } = P;
const { leadId, tagUrl, leadIdReady } = await import('../api/_staffify-utm.js');
const { ledgerEntries } = await import('../scripts/seed-precall-ledger.mjs');

const H = 3600 * 1000, DAY = 24 * H;
const NOW = Date.parse('2026-11-02T13:10:00Z');            // 8:10 ET, the morning slot
const ISO = t => new Date(t).toISOString();
const SALT = 'test-salt-not-real';
const HOOK = 'https://hooks.example.invalid/precall-notice';
const LIVE = { CALENDLY_API_TOKEN: 'cal', RESEND_API_KEY: 'resend', LEAD_ID_SALT: SALT, PRECALL_SEND: 'on', PRECALL_SLACK_WEBHOOK: HOOK };
const DRY = { CALENDLY_API_TOKEN: 'cal', RESEND_API_KEY: 'resend', LEAD_ID_SALT: SALT };
const DISCOVERY = 'https://api.calendly.com/event_types/62ac8330-2bb7-40e4-9b93-68a80b02a049';
const OTHER_TYPE = 'https://api.calendly.com/event_types/00000000-0000-0000-0000-000000000000';

// One fake store: strings with nx, hashes and lists, the shapes Upstash answers in. It starts with the
// Mac's log imported (precall:seeded) unless a test asks for an empty one.
function fakeKv(seed = {}, { failSet = null, unseeded = false } = {}) {
    const m = new Map(Object.entries(seed.strings || {})), h = new Map(), l = new Map();
    if (!unseeded && !m.has(SEEDED)) m.set(SEEDED, JSON.stringify({ at: ISO(NOW - DAY), count: 1, latestTs: ISO(NOW - 2 * DAY) }));
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
// The notice is caught, never posted; the clock stands still unless a test moves it.
function notices(answer = () => ({ posted: true, via: 'webhook' })) {
    const posted = [];
    return { posted, notify: async text => { posted.push(text); return answer(text); } };
}
const run = (kv, cal, env, extra = {}) => runPrecall({ kv, now: extra.now || NOW, env, deps: { calendlyGet: extra.calendlyGet || cal.get, send: extra.send, optedOutSet: extra.optedOutSet || noStops, clientCheck: extra.clientCheck || clear,
    notify: extra.notify || notices().notify, clock: extra.clock || (() => 0), sleep: async () => {} }, ...(extra.opts || {}) });
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
    for (let i = 0; i < 8; i++) await run(kv, cal, DRY, { send: s.send });
    assert.equal(kv.l.get(DRY_LOG).length, 6, 'the last six runs: two a day for the three days, not twenty');
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
    const n = notices();
    const r = await runPrecall({ kv: fakeKv(), now: NOW, env: LIVE, force: 'dry-run', deps: { calendlyGet: fakeCalendly(oneBooking()).get, send: s.send, optedOutSet: noStops, clientCheck: clear, notify: n.notify, sleep: async () => {} } });
    assert.equal(r.mode, 'dry-run'); assert.equal(r.forced, 'dry-run'); assert.equal(s.sent.length, 0); assert.equal(r.wouldSend.length, 1);
    assert.equal(n.posted.length, 0, 'a forced dry run posts no notice');
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

// ---- the review fixes (S1 to S6, M1 to M4, M7) ---------------------------------------------------

const KIM = 'kim@northlight.co', LEE = 'lee@harborview.net';
const booking = (n, email, name, answer = 'Video Editor', startTime = ISO(NOW + 3 * DAY), extra = {}) => ({ event: event(n, startTime), invitees: [invitee(n, email, name, answer, extra)] });

test('S1: a booking someone moved into is emailed, as on the Mac; the one they left is not', async () => {
    const moved = { old_invitee: 'https://api.calendly.com/scheduled_events/ev-0/invitees/inv-0' };
    const s = sender();
    const r = await run(fakeKv(), fakeCalendly(oneBooking('Video Editor', ISO(NOW + 3 * DAY), moved)), LIVE, { send: s.send });
    assert.equal(s.sent.length, 1, 'never emailed before, so #1 goes');
    assert.equal(r.sent[0].stage, 1);
    // They had #1 from the old booking a day ago: the ledger is by address, so only #2 can follow.
    const kv = fakeKv({ strings: { [SENT(emailHash(PAT), 1)]: JSON.stringify({ ts: ISO(NOW - 24 * H), role: 'video', ok: true, stage: 1 }) } });
    const s2 = sender();
    const r2 = await run(kv, fakeCalendly(oneBooking('Video Editor', ISO(NOW + 3 * DAY), moved)), LIVE, { send: s2.send });
    assert.equal(s2.sent.length, 1); assert.equal(r2.sent[0].stage, 2); assert.equal(s2.sent[0].subject, 'One story before we talk');
    // Had #1 an hour ago: nothing, no third email and no repeat.
    const kv3 = fakeKv({ strings: { [SENT(emailHash(PAT), 1)]: JSON.stringify({ ts: ISO(NOW - H), role: 'video', ok: true, stage: 1 }) } });
    const s3 = sender();
    await run(kv3, fakeCalendly(oneBooking('Video Editor', ISO(NOW + 3 * DAY), moved)), LIVE, { send: s3.send });
    assert.equal(s3.sent.length, 0);
    // The booking they moved away from is still never emailed.
    const s4 = sender();
    const r4 = await run(fakeKv(), fakeCalendly(oneBooking('Video Editor', ISO(NOW + 3 * DAY), { rescheduled: true })), LIVE, { send: s4.send });
    assert.equal(s4.sent.length, 0); assert.equal(r4.skipped[0].reason, 'rescheduled');
});

test('S2: live refuses until the Mac log is imported, and the import marks it', async () => {
    const kv = fakeKv({}, { unseeded: true });
    const cal = fakeCalendly(oneBooking());
    const s = sender(), n = notices();
    const r = await run(kv, cal, LIVE, { send: s.send, notify: n.notify });
    assert.equal(r.mode, 'dry-run'); assert.deepEqual(r.refused, ['desktop log not imported']);
    assert.equal(s.sent.length, 0, 'an empty ledger never sends #1 to everyone again');
    assert.match(n.posted[0], /refused: desktop log not imported/);
    assert.deepEqual((await pendingView(kv, { env: LIVE })).liveBlockers, ['desktop log not imported']);
    // An import that accepted nothing does not count.
    const none = await importLedger(kv, [{ key: 'nope', stage: 1, ts: ISO(NOW), ok: true }], NOW);
    assert.equal(none.seeded, null); assert.ok(!kv.m.has(SEEDED));
    // A real import marks it, and a second import (right before the flip) is safe.
    const entries = [
        { key: emailHash('old@one.com'), stage: 1, ts: ISO(NOW - 5 * DAY), role: 'va', ok: true },
        { key: emailHash('old@two.com'), stage: 1, ts: ISO(NOW - 2 * DAY), role: 'sales', ok: true },
    ];
    const imp = await importLedger(kv, entries, NOW);
    assert.deepEqual(JSON.parse(kv.m.get(SEEDED)), { at: ISO(NOW), count: 2, imported: 2, alreadyThere: 0, rejected: 0, latestTs: ISO(NOW - 2 * DAY) });
    assert.equal(imp.seeded.latestTs, ISO(NOW - 2 * DAY));
    const again = await importLedger(kv, entries, NOW + H);
    assert.equal(again.alreadyThere, 2); assert.equal(again.seeded.count, 2); assert.equal(again.seeded.at, ISO(NOW + H));
    const live = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(live.mode, 'live'); assert.equal(s.sent.length, 1);
    assert.equal(live.seeded.latestTs, ISO(NOW - 2 * DAY), 'every run shows what was imported');
    // A store that cannot say is not a yes.
    const broken = fakeKv({}, { unseeded: true }); broken.get = async () => { throw Error('store down'); };
    assert.deepEqual((await run(broken, cal, LIVE, { send: s.send })).refused, ['desktop log import could not be confirmed: store down']);
    assert.equal(s.sent.length, 1);
});

test('S3: a claim lasts past the 14-day window, and an orphaned one is held, never re-sent', async () => {
    assert.ok(CLAIM_SECONDS > 14 * 86400);
    const h = emailHash(PAT), cal = fakeCalendly(oneBooking());
    const kv0 = fakeKv(); await run(kv0, cal, LIVE, { send: sender().send });
    assert.equal(kv0.ttl.get(CLAIM(h, 1)), 15 * 86400);
    // A run killed after Resend accepted, before the ledger write: the claim is all that is left.
    for (const later of [11 * 60 * 1000, DAY + 60 * 1000, 10 * DAY]) {
        const kv = fakeKv({ strings: { [CLAIM(h, 1)]: `${NOW - 60 * 1000}:dead-run` } });
        const s = sender();
        const r = await run(kv, cal, LIVE, { send: s.send, now: NOW + later });
        assert.equal(s.sent.length, 0, `not re-sent ${later / 60000} minutes later`);
        assert.equal(r.held[0].reason, 'unconfirmed send');
        assert.ok(r.held[0].detail.startsWith(`check Resend: if it did not go, delete ${CLAIM(h, 1)} and ${ATTEMPT(h, 1)} and the next run sends it`));
    }
    // A claim a minute old belongs to a run that is still going.
    const fresh = await run(fakeKv({ strings: { [CLAIM(h, 1)]: `${NOW - 60 * 1000}:busy-run` } }), cal, LIVE, { send: sender().send });
    assert.equal(fresh.skipped[0].reason, 'another run is sending this one');
    // A claim made permanent after a failed ledger write says so.
    const sentClaim = await run(fakeKv({ strings: { [CLAIM(h, 1)]: 'sent:re_9' } }), cal, LIVE, { send: sender().send });
    assert.equal(sentClaim.skipped[0].reason, 'sent, ledger write failed');
    assert.match(sentClaim.skipped[0].detail, /id re_9/);
    // The claim appears between the ledger read and SET NX: the same reading.
    const kv = fakeKv({ strings: { [CLAIM(h, 1)]: `${NOW - 30 * 60 * 1000}:dead-run` } });
    const get = kv.get; let hidden = true;
    kv.get = async k => (k === CLAIM(h, 1) && hidden ? ((hidden = false), null) : get(k));
    const s = sender();
    const r = await run(kv, cal, LIVE, { send: s.send });
    assert.equal(s.sent.length, 0); assert.equal(r.held[0].reason, 'unconfirmed send');
});

test('S3: when Resend may have it, retries go under the same key and only inside 20 hours', async () => {
    const h = emailHash(PAT), cal = fakeCalendly(oneBooking());
    const maybe = () => sender(() => ({ ok: false, status: 503, unknown: true, error: 'Resend 503' }));
    // Retried 10 hours later: the same key, so Resend makes it the same email.
    const kv = fakeKv();
    const bad = maybe();
    const r = await run(kv, cal, LIVE, { send: bad.send });
    assert.equal(r.errors[0].retryUntil, ISO(NOW + 20 * H));
    assert.equal(Number(kv.m.get(ATTEMPT(h, 1))), NOW, 'the first try is kept');
    assert.ok(!kv.m.has(CLAIM(h, 1)), 'the claim let go');
    await run(kv, cal, LIVE, { send: maybe().send, now: NOW + 5 * H });
    assert.equal(Number(kv.m.get(ATTEMPT(h, 1))), NOW, 'a second unknown keeps the first time');
    const good = sender();
    await run(kv, cal, LIVE, { send: good.send, now: NOW + 10 * H });
    assert.equal(good.sent.length, 1); assert.equal(good.sent[0].idempotencyKey, bad.sent[0].idempotencyKey);
    assert.ok(kv.m.has(SENT(h, 1))); assert.ok(!kv.m.has(ATTEMPT(h, 1)), 'cleared once sent');
    // Past 20 hours Resend may have forgotten the key: held for a person, never retried.
    const kv2 = fakeKv();
    await run(kv2, cal, LIVE, { send: maybe().send });
    const late = sender();
    const r2 = await run(kv2, cal, LIVE, { send: late.send, now: NOW + 21 * H });
    assert.equal(late.sent.length, 0);
    assert.equal(r2.held[0].reason, 'unconfirmed send');
    assert.match(r2.held[0].detail, new RegExp(`delete ${ATTEMPT(h, 1)}`));
    // A plain refusal sent nothing, so it starts no window: two days later it still goes.
    const kv3 = fakeKv();
    await run(kv3, cal, LIVE, { send: sender(() => ({ ok: false, status: 422, error: 'Resend 422: invalid' })).send });
    assert.ok(!kv3.m.has(ATTEMPT(h, 1)));
    const later = sender();
    await run(kv3, cal, LIVE, { send: later.send, now: NOW + 2 * DAY });
    assert.equal(later.sent.length, 1);
});

test('S4: one malformed booking is reported and never stops the run', async () => {
    assert.equal(roleAnswerOf({ questions_and_answers: [{ question: null, answer: 'x' }, { question: 'Which role are you looking to fill?', answer: 'Video Editor' }] }), 'Video Editor');
    assert.equal(roleAnswerOf({ questions_and_answers: [{ answer: 'x' }, null] }), '');
    const bookings = [
        { event: event(1, ISO(NOW + 2 * DAY)), invitees: [invitee(1, LEE, 'Lee', 'x', { questions_and_answers: [{ question: null, answer: 'x' }] })] },
        { event: event(2, ISO(NOW + 3 * DAY)), invitees: [invitee(2, KIM, 42, 'Video Editor'), invitee(2, 'q@odd.com', 'Q', 'x', { uri: `${evUri(2)}/invitees/inv-q`, questions_and_answers: 'not a list' })] },
        ...oneBooking('Video Editor', ISO(NOW + 4 * DAY)),
    ];
    bookings[2].event = event(3, ISO(NOW + 4 * DAY)); bookings[2].invitees[0].uri = `${evUri(3)}/invitees/inv-3`;
    const s = sender();
    const r = await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: s.send });
    assert.equal(s.sent.length, 1, 'the good booking still goes');
    assert.equal(s.sent[0].to, PAT);
    assert.equal(r.skipped.find(x => x.email === LEE).reason, 'role other or unknown', 'a question with no text is passed over');
    assert.deepEqual(r.errors.map(e => e.email).sort(), [KIM, 'q@odd.com']);
    assert.ok(r.errors.every(e => /^this booking could not be handled: /.test(e.error)));
    // A throw while the claim is held lets it go, so the next run sends it.
    const kv = fakeKv(); let armed = false;
    const cal = fakeCalendly(oneBooking());
    const get = async url => { const out = await cal.get(url); if (url.endsWith('/invitees/inv-1')) armed = true; return out; };
    const s2 = sender();
    const r2 = await run(kv, cal, LIVE, { send: s2.send, calendlyGet: get, clock: () => { if (armed) throw Error('clock broke'); return 0; } });
    assert.equal(s2.sent.length, 0); assert.match(r2.errors[0].error, /could not be handled: clock broke/);
    assert.ok(!kv.m.has(CLAIM(emailHash(PAT), 1)), 'claim let go');
    await run(kv, cal, LIVE, { send: s2.send });
    assert.equal(s2.sent.length, 1);
});

test('S5: a dry-run hold still shows the email it holds, without the HTML in what is kept', async () => {
    const kv = fakeKv();
    const cal = fakeCalendly(oneBooking());
    const want = (await run(fakeKv(), cal, DRY, { send: sender().send })).wouldSend[0];
    const r = await run(kv, cal, DRY, { send: sender().send, clientCheck: async () => ({ status: 'unknown', why: 'the shared client snapshot (40 days old)' }), opts: { includeHtml: true } });
    assert.equal(r.wouldSend.length, 0);
    const held = r.held[0];
    assert.equal(held.reason, 'client check unavailable');
    for (const k of ['to', 'subject', 'template', 'banner', 'lid', 'links', 'htmlSha256', 'from', 'replyTo', 'bcc', 'webhook']) assert.deepEqual(held.preview[k], want[k], k);
    assert.equal(held.preview.to, PAT);
    assert.ok(held.preview.html.includes('Your call: Thursday, November 5'), '?html=1 shows it');
    assert.equal(JSON.parse(kv.l.get(DRY_LOG)[0]).held[0].preview.html, undefined, 'never kept');
    const stops = await run(fakeKv(), cal, DRY, { send: sender().send, optedOutSet: async () => { throw Error('down'); } });
    assert.equal(stops.held[0].reason, 'stop list unavailable'); assert.equal(stops.held[0].preview.subject, want.subject);
    const live = await run(fakeKv(), cal, LIVE, { send: sender().send, clientCheck: async () => ({ status: 'unknown' }) });
    assert.equal(live.held[0].preview, undefined, 'live holds stay small');
});

test('S6: every live run posts its notice; a dry run only when asked; no destination refuses live', async () => {
    const bookings = [...oneBooking(), booking(2, LEE, 'Lee Park', 'Sales Support'), booking(3, KIM, 'Kim Ode', 'Executive Admin / Assistant')];
    const n = notices();
    const s = sender(msg => (msg.to === KIM ? { ok: false, status: 422, error: 'Resend 422: bad address' } : { ok: true, id: 'resend-1' }));
    const r = await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: s.send, notify: n.notify, clientCheck: async ({ email }) => (email === LEE ? { status: 'possible', reason: 'company match' } : { status: 'clear' }) });
    assert.equal(n.posted.length, 1); assert.deepEqual(r.notice, { posted: true, via: 'webhook' });
    const text = n.posted[0];
    assert.match(text, /^Pre-call emails, 8:10 AM EST run: 1 sent, 1 held, 1 errors, 0 skipped\./);
    assert.ok(text.includes('Pre-call email #1 sent to Pat Rivera (pat@brightframe.com) for their Thursday, November 5 discovery call. Role: video.'), 'the desktop push, line for line');
    assert.ok(text.includes(`Held: Lee Park (${LEE}), email #1: possible client (company match).`));
    assert.ok(text.includes(`Error: Kim Ode (${KIM}), email #1: Resend 422: bad address.`));
    assert.ok(text.endsWith('Details: https://www.gostaffify.com/api/cron-precall/?view=pending'));
    assert.ok(!/[\u2013\u2014]/.test(text), 'no em or en dash');
    // A quiet run still says so, the way the Mac did.
    const q = notices();
    await run(fakeKv(), fakeCalendly([]), LIVE, { send: sender().send, notify: q.notify });
    assert.match(q.posted[0], /No new discovery call bookings to email\./);
    // A live run that is refused says why.
    const ref = notices(); const env = { ...LIVE }; delete env.LEAD_ID_SALT;
    await run(fakeKv(), fakeCalendly(oneBooking()), env, { send: sender().send, notify: ref.notify });
    assert.match(ref.posted[0], /Live sending is switched on but refused: missing LEAD_ID_SALT\. Nothing was sent\./);
    // A dry run is quiet unless ?notify=1.
    const dq = notices();
    await run(fakeKv(), fakeCalendly(oneBooking()), DRY, { send: sender().send, notify: dq.notify });
    assert.equal(dq.posted.length, 0);
    await run(fakeKv(), fakeCalendly(oneBooking()), DRY, { send: sender().send, notify: dq.notify, opts: { notify: true } });
    assert.match(dq.posted[0], /^Pre-call emails \(dry run, nothing sent\), 8:10 AM EST run: 1 would send/);
    // No destination: live refuses. A channel with the bot token is a destination.
    const noDest = { ...LIVE }; delete noDest.PRECALL_SLACK_WEBHOOK;
    assert.ok(liveBlockers(noDest).some(b => b.startsWith('missing PRECALL_SLACK_WEBHOOK')));
    const ns = sender();
    assert.equal((await run(fakeKv(), fakeCalendly(oneBooking()), noDest, { send: ns.send })).mode, 'dry-run'); assert.equal(ns.sent.length, 0);
    assert.deepEqual(liveBlockers({ ...noDest, PRECALL_SLACK_CHANNEL: 'C0PRECALL', SLACK_BOT_TOKEN: 'xoxb-test' }), []);
    // A notifier that fails never fails the run, and the webhook URL never shows.
    const kv = fakeKv();
    const f = await run(kv, fakeCalendly(oneBooking()), LIVE, { send: sender().send, notify: async () => { throw Error('Slack down'); } });
    assert.equal(f.ok, true); assert.deepEqual(f.notice, { posted: false, error: 'Slack down' }); assert.equal(f.sent.length, 1);
    const view = await pendingView(kv, { env: LIVE });
    assert.equal(view.notice, 'PRECALL_SLACK_WEBHOOK');
    assert.ok(!JSON.stringify(f).includes(HOOK) && !JSON.stringify(view).includes(HOOK) && !kv.l.get(LIVE_LOG)[0].includes(HOOK));
    // Calendly down: the run reports it, posts it and keeps it, instead of dying silently.
    const down = notices(); const kv2 = fakeKv();
    const d = await run(kv2, { get: async () => { throw Error('Calendly 503: down'); } }, LIVE, { send: sender().send, notify: down.notify });
    assert.equal(d.ok, false); assert.match(down.posted[0], /The run stopped early: Calendly events unreadable: Calendly 503: down/);
    assert.equal(kv2.l.get(LIVE_LOG).length, 1);
});

test('S6: the notice poster accepts only a confirmed post', async () => {
    const { postNotice, noticeDestination } = P;
    const answer = (status, body) => async () => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body) });
    const hook = noticeDestination({ PRECALL_SLACK_WEBHOOK: HOOK });
    assert.deepEqual(await postNotice(hook, 'hi', answer(200, 'ok')), { posted: true, via: 'webhook' });
    assert.equal((await postNotice(hook, 'hi', answer(404, 'no_service'))).posted, false);
    const bot = noticeDestination({ PRECALL_SLACK_CHANNEL: 'C0PRECALL', SLACK_BOT_TOKEN: 'xoxb-test' });
    assert.deepEqual(await postNotice(bot, 'hi', answer(200, '{"ok":true,"ts":"1"}')), { posted: true, via: 'bot', channel: 'C0PRECALL' });
    assert.equal((await postNotice(bot, 'hi', answer(200, '{"ok":false,"error":"not_in_channel"}'))).error, 'not_in_channel');
    assert.deepEqual(await postNotice(null, 'hi'), { posted: false, error: 'no notice destination is set' });
    assert.equal(noticeDestination({ SLACK_CHANNEL: 'C0TEAM', SLACK_BOT_TOKEN: 'xoxb-test' }), null, 'never the team channel');
});

test('M1, M2: the seed reads an escaped line, keeps an untimed entry as a hold, and an odd role imports as none', async () => {
    const escaped = JSON.stringify({ ts: '2026-07-13T19:15:29Z', to: 'sam@ridge.com', role: 'sales', ok: true, manual: true }).replace(/"/g, '\\"');
    const { entries, recovered, untimed, unreadable, latestTs } = ledgerEntries([
        escaped,
        JSON.stringify({ ts: 'sometime', to: 'tess@field.com', role: 'video', ok: true }),
        JSON.stringify({ ts: ISO(NOW - DAY), to: PAT, role: 'Weird Role!', ok: true }),
    ]);
    assert.equal(recovered, 1); assert.equal(untimed, 1); assert.equal(unreadable, 0);
    assert.deepEqual(entries.map(e => [e.key, e.stage, e.ts, e.ok, e.role]), [
        [emailHash('sam@ridge.com'), 1, '2026-07-13T19:15:29.000Z', true, 'sales'],
        [emailHash('tess@field.com'), 1, '1970-01-01T00:00:00.000Z', false, 'video'],
        [emailHash(PAT), 1, ISO(NOW - DAY), true, null],
    ]);
    assert.equal(latestTs, ISO(NOW - DAY), 'the epoch is not the newest');
    const kv = fakeKv({}, { unseeded: true });
    const odd = await importLedger(kv, [{ key: emailHash('rae@x.com'), stage: 1, ts: ISO(NOW), role: 'Not A Role', ok: true }, ...entries], NOW);
    assert.equal(odd.imported, 4); assert.equal(odd.rejected.length, 0);
    assert.equal(JSON.parse(kv.m.get(SENT(emailHash('rae@x.com'), 1))).role, null);
    const cal = fakeCalendly([booking(1, 'tess@field.com', 'Tess'), booking(2, 'sam@ridge.com', 'Sam', 'Sales Support', ISO(NOW + 5 * DAY))]);
    const s = sender();
    const r = await run(kv, cal, LIVE, { send: s.send });
    assert.deepEqual(r.skipped.map(x => [x.email, x.reason]), [['tess@field.com', 'already emailed']], 'the untimed one: never again, as on the Mac');
    assert.equal(s.sent.length, 1, 'the escaped one already had #1, so only #2 can go');
    assert.equal(s.sent[0].to, 'sam@ridge.com'); assert.equal(r.sent[0].stage, 2); assert.equal(s.sent[0].subject, 'What actually happens after our call');
});

test('M3: a booking with no call time is never emailed', async () => {
    const s = sender();
    const bookings = oneBooking(); bookings[0].event.start_time = undefined;
    const r = await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: s.send });
    assert.equal(s.sent.length, 0); assert.equal(r.skipped[0].reason, 'no call time');
    const dry = await run(fakeKv(), fakeCalendly(bookings), DRY, { send: s.send });
    assert.equal(dry.wouldSend.length, 0);
});

test('M7: a guard that cannot answer is asked once per run, and no send starts after 90 seconds', async () => {
    const bookings = [...oneBooking(), booking(2, LEE, 'Lee'), booking(3, KIM, 'Kim')];
    let asked = 0;
    const r = await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: sender().send, clientCheck: async () => { asked++; return { status: 'unknown', why: 'HubSpot did not answer' }; } });
    assert.equal(asked, 1); assert.equal(r.held.length, 3); assert.ok(r.held.every(h => h.reason === 'client check unavailable'));
    let asked2 = 0;
    await run(fakeKv(), fakeCalendly(bookings), LIVE, { send: sender().send, clientCheck: async () => { asked2++; return { status: 'clear' }; } });
    assert.equal(asked2, 3, 'a clear answer is per person');
    // The clock runs out before the first booking: nothing starts.
    let t = 0;
    const s = sender(); const kv = fakeKv();
    const late = await run(kv, fakeCalendly(bookings), LIVE, { send: s.send, clock: () => (t++ === 0 ? 0 : RUN_BUDGET_MS + 1) });
    assert.equal(s.sent.length, 0); assert.ok(late.held.length === 3 && late.held.every(h => h.reason === 'run time budget reached'));
    // It runs out after the claim, during the re-check: the claim is let go for the next run.
    let spent = false;
    const cal = fakeCalendly(oneBooking());
    const get = async url => { const out = await cal.get(url); if (url.endsWith('/invitees/inv-1')) spent = true; return out; };
    const s2 = sender(); const kv2 = fakeKv();
    const r2 = await run(kv2, cal, LIVE, { send: s2.send, calendlyGet: get, clock: () => (spent ? RUN_BUDGET_MS + 1 : 0) });
    assert.equal(s2.sent.length, 0); assert.equal(r2.held[0].reason, 'run time budget reached');
    assert.ok(!kv2.m.has(CLAIM(emailHash(PAT), 1)) && !kv2.m.has(ATTEMPT(emailHash(PAT), 1)));
    await run(kv2, cal, LIVE, { send: s2.send });
    assert.equal(s2.sent.length, 1);
});

test('the notice text holds up on an empty or odd report', () => {
    assert.match(noticeText({ mode: 'live', ts: ISO(NOW), counts: {} }), /No new discovery call bookings to email\./);
    const many = Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@x.com`, stage: 1, reason: 'client check unavailable' }));
    const text = noticeText({ mode: 'live', ts: ISO(NOW), counts: { held: 20 }, held: many });
    assert.match(text, /\.\.\.and 5 more\./);
});
