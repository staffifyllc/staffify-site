// Pre-call emails: the Mac's staffify-precall-emails job, run from Vercel.
// ------------------------------------------------------------------
// The desktop job (~/Claude Code/staffify-calendly-precall.js, 8:00 and 18:00 ET) reads Calendly for
// upcoming Discovery calls, picks a template from the "Which role" answer and sends email #1 on
// booking and email #2 a day later if the call is still at least 12 hours away. Never more than two.
// This is that job, rule for rule: the same two event types, the same 14-day window, the same role
// matching, the same six approved templates (api/_precall-templates/, byte for byte), the same
// subjects, the same reminder banner, the same sender, reply-to and HubSpot BCC, and the same
// lid/UTM links (api/_staffify-utm.js).
//
// What it adds, all of it on the side of sending less:
//   dry-run       nothing is sent unless PRECALL_SEND is 'on'. A dry run computes exactly what would
//                 go out, keeps it for three days (precall:dryrun) and returns it.
//   fail closed   live mode refuses to send without LEAD_ID_SALT (the links would carry the wrong id)
//                 or RESEND_API_KEY, and says which is missing.
//   one claim     each person and email (#1, #2) is claimed with SET NX before the send, so two
//                 overlapping runs never both send it. Marked sent only after Resend accepts; a refusal
//                 or no answer lets the claim go, so the next run tries again under the same
//                 Idempotency-Key (Resend keeps it 24 hours, the same as the claim).
//   re-check      right before a send, the event and the invitee are read again from Calendly. A
//                 cancelled event, a cancelled invitee, or a booking that was rescheduled is not emailed.
//   client guard  api/_client-guard.js: a client never gets a prospect template. A guard that cannot
//                 answer holds the email for the next run.
//   stop list     api/_optout.js: someone who asked not to be contacted is not emailed, the same rule
//                 the Calendly webhook applies to its own booking email.
//   overlap flag  api/calendly-webhook.js sends its own "Before our call" email on booking, with its
//                 own key discovery:sent:<email>:<role> (24 hours). Every email this job would send is
//                 marked with whether that key, or the webhook's booking record, is there. Nothing is
//                 suppressed because of it: which email a booker gets is Paul's decision.
//
// The ledger keys are a hash of the address (sha256, 32 hex, the client snapshot's hash), so the
// desktop log can be imported (scripts/seed-precall-ledger.mjs) without sending a single address.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tagHtml, leadId } from './_staffify-utm.js';

export const FROM = 'Staffify <staffing@gostaffify.com>';
export const REPLY_TO = 'hello@gostaffify.com';   // paul@ is not a real mailbox: replies to it bounce (desktop note, 2026-08-31)
export const HUBSPOT_BCC = '51666712@bcc.hubspot.com';
export const USER_URI = 'https://api.calendly.com/users/7b9e76a9-050c-436f-b226-719606dc462c';

// Discovery Call event type URIs (the desktop's list).
export const DISCOVERY_EVENT_TYPES = [
    'https://api.calendly.com/event_types/62ac8330-2bb7-40e4-9b93-68a80b02a049', // Discovery Call
    'https://api.calendly.com/event_types/ab58fef4-ef16-43b1-aa2e-f2b26290d2c8', // 30 Minute Discovery Call
];

// Email #1 per role.
export const TEMPLATES = {
    video: { file: 'staffify-precall-video-editor.html', subject: "Your call is booked. Here's what we're working with." },
    va: { file: 'staffify-precall-va.html', subject: "Your call is booked. Here's how this works." },
    sales: { file: 'staffify-precall-sales.html', subject: "Your call is booked. Here's what we bring to your pipeline." },
    csr: { file: 'staffify-precall-va.html', subject: "Your call is booked. Here's how this works." },
    photoqc: { file: 'staffify-precall-photo-qc.html', subject: "Your call is booked. Here's how we protect your quality." },
};
// Email #2: video bookings get the Realtour Pilot case study; everyone else the how-the-process-works email.
export const TEMPLATES2 = {
    video: { file: 'staffify-precall2-video.html', subject: 'One story before we talk' },
    default: { file: 'staffify-precall2-general.html', subject: 'What actually happens after our call' },
};
export const STAGE2_MIN_GAP_MS = 22 * 3600 * 1000;   // >=~24h after email 1 (22h tolerates the 8am/6pm run grid)
export const STAGE2_MIN_LEAD_MS = 12 * 3600 * 1000;  // only if the call is still >=12h away
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const SEND_GAP_MS = 600;                              // the desktop's pause after each send
const CALL_ZONE = 'America/New_York';                 // the Mac formatted the banner in its own zone, Eastern

// The store.
export const SENT = (hash, stage) => `precall:sent:${hash}:${stage}`;
export const CLAIM = (hash, stage) => `precall:claim:${hash}:${stage}`;
export const DRY_LOG = 'precall:dryrun';
export const LIVE_LOG = 'precall:log';
const CLAIM_SECONDS = 24 * 3600;
const DRY_TTL_SECONDS = 3 * 24 * 3600;
const WEBHOOK_ROLES = ['editors', 'admins', 'csr', 'sales', 'default'];

// Where a lid goes in a dry run that has no salt, so the link still shows its shape. Never sent:
// live mode refuses without the salt.
export const LID_PLACEHOLDER = 'MISSING-SALT';

const norm = e => String(e || '').trim().toLowerCase();
const iso = t => new Date(t).toISOString();
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const errText = e => String((e && e.message) || e).slice(0, 200);

/** The ledger's key for a person: sha256 of the normalised address, 32 hex. */
export const emailHash = e => createHash('sha256').update(norm(e)).digest('hex').slice(0, 32);

/** 'live' only when PRECALL_SEND is exactly 'on'. */
export const requestedMode = (env = process.env) => (String(env.PRECALL_SEND || '').trim() === 'on' ? 'live' : 'dry-run');

/** What stops a live run from sending. Empty means it may send. */
export function liveBlockers(env = process.env) {
    const out = [];
    if (!String(env.LEAD_ID_SALT || '').trim()) out.push('missing LEAD_ID_SALT');
    if (!env.RESEND_API_KEY) out.push('missing RESEND_API_KEY');
    return out;
}

// Role detection from the "Which role" answer. The desktop's function, unchanged.
export function detectRole(answer) {
    if (!answer) return null;
    const a = answer.toLowerCase().trim();
    // "Other" or empty = no email
    if (a === 'other' || a === '') return null;
    // Exact dropdown matches (from Calendly)
    if (a === 'video editor') return 'video';
    if (a === 'photo editor') return 'photoqc';
    if (a === 'photo editor / qc') return 'photoqc';
    if (a === 'photo editor qc') return 'photoqc';
    if (a === 'photo qc') return 'photoqc';
    if (a === 'executive admin / assistant') return 'va';
    if (a === 'executive admin / va') return 'va';
    if (a === 'sales support') return 'sales';
    if (a === 'sales') return 'sales';
    if (a === 'customer service rep') return 'csr';
    // Keyword matching for legacy free-text answers
    // Photo checks must run before the video/editor keywords ("photo editor" would otherwise match "editor")
    if (a.includes('photo') && (a.includes('qc') || a.includes('quality') || a.includes('edit') || a.includes('retouch') || a.includes('cull'))) return 'photoqc';
    if (a.includes('video') || a.includes('editor') || a.includes('editing') || a.includes('premiere') || a.includes('after effects')) return 'video';
    if (/\bsales\s*(rep|role|support|team|hire|position)\b/.test(a) || a.includes('sdr') || a.includes('bdr') || a.includes('lead gen') || a.includes('outbound') || a.includes('cold email') || a.includes('cold call') || a.includes('prospecting')) return 'sales';
    if (a.includes('customer service') || a.includes('csr') || a.includes('support rep')) return 'csr';
    if (a.includes('admin') || a.includes('va') || a.includes('virtual assistant') || a.includes('executive')) return 'va';
    // Can't determine = no email
    return null;
}

/** The "Which role" answer, found the way the desktop finds it: the first question about a role or a fill. */
export function roleAnswerOf(inv) {
    const q = (inv.questions_and_answers || []).find(x =>
        x.question.toLowerCase().includes('role') || x.question.toLowerCase().includes('fill'));
    return q ? q.answer : '';
}

/**
 * Which email is due, from the ledger: 1 if #1 was never recorded; 2 if #1 went (not a hold or a
 * failure), at least 22 hours ago, #2 never did, and the call is at least 12 hours out; otherwise null.
 */
export function nextStage(s1, s2, { now, startTime }) {
    if (!s1) return 1;
    if (!s2 && s1.ok !== false
        && (now - Date.parse(s1.ts)) >= STAGE2_MIN_GAP_MS
        && (Date.parse(startTime) - now) >= STAGE2_MIN_LEAD_MS) return 2;
    return null;
}

/** The banner's date and time, as the Mac printed them (Eastern, plain spaces whatever the ICU build). */
export function formatCall(startTime) {
    const d = new Date(startTime);
    const plain = s => s.replace(/[  ]/g, ' ');
    return {
        date: plain(d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: CALL_ZONE })),
        time: plain(d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: CALL_ZONE })),
    };
}

// Reminder banner HTML (injected right after the accent bar). The desktop's markup, byte for byte.
export function reminderBanner(callFormatted, callTime) {
    return `
        <tr><td style="padding:0 28px 20px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="background:#0C1929;border:1px solid #1E293B;border-radius:10px;padding:14px 18px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
                <td style="padding-right:12px;" valign="middle" width="28">
                  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:28px;height:28px;border-radius:8px;background:#1ABDE1;text-align:center;line-height:28px;font-size:14px;">&#128197;</td></tr></table>
                </td>
                <td valign="middle">
                  <p style="margin:0;font:600 13px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Your call: ${callFormatted} at ${callTime}</p>
                </td>
              </tr></table>
            </td>
          </tr></table>
        </td></tr>`;
}

const templateCache = new Map();
/** One approved template, read as it was copied from the Mac. */
export function loadTemplate(file) {
    if (!templateCache.has(file)) templateCache.set(file, readFileSync(new URL(`./_precall-templates/${file}`, import.meta.url), 'utf8'));
    return templateCache.get(file);
}

/**
 * The email exactly as the desktop builds it: first name in, banner after the accent bar, every
 * owned link tagged. lid is the person's lead id, or null to tag without one.
 */
export function renderEmail({ template, firstName, startTime, role, stage, lid }) {
    const { date, time } = formatCall(startTime);
    let html = template
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/(border-radius:2px;font-size:0;line-height:0;">&nbsp;<\/td><\/tr><\/table>\s*<\/td><\/tr>)/, `$1\n${reminderBanner(date, time)}`);
    html = tagHtml(html, { campaign: 'precall', content: `${role}-stage${stage}`, lid });
    const links = [...new Set([...html.matchAll(/href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&')))];
    return { html, banner: `Your call: ${date} at ${time}`, links };
}

// ─── Providers ──────────────────────────────────────────────────

/** A Calendly GET, as the desktop makes it. THROWS on failure, so a broken read is never an empty calendar. */
export function calendlyGetter(token = process.env.CALENDLY_API_TOKEN, fetchImpl = fetch) {
    return async function calendlyGet(url) {
        const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`Calendly ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return res.json();
    };
}

/**
 * One email through Resend, the desktop's request plus an Idempotency-Key. Never throws:
 * { ok: true, id } when Resend accepted it, otherwise { ok: false, error, unknown? }. unknown means
 * Resend may or may not have taken it (5xx, 429, no answer); the key makes the retry the same email.
 */
export async function sendViaResend({ to, subject, html, idempotencyKey }, { apiKey = process.env.RESEND_API_KEY, fetchImpl = fetch } = {}) {
    if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
    let res;
    try {
        res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': String(idempotencyKey).slice(0, 256) },
            body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, bcc: [HUBSPOT_BCC], subject, html }),
            signal: AbortSignal.timeout(15000),
        });
    } catch { return { ok: false, unknown: true, error: 'Resend did not answer' }; }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        return { ok: false, status: res.status, unknown: res.status >= 500 || res.status === 429,
            error: `Resend ${res.status}${data && (data.message || data.name) ? ': ' + String(data.message || data.name).slice(0, 160) : ''}` };
    }
    return { ok: true, id: (data && data.id) || null };
}

// ─── The store ──────────────────────────────────────────────────

/** Both ledger entries and both claims for one person. Throws if the store cannot be read. */
async function readLedger(kv, hash) {
    const [s1, s2, c1, c2] = await Promise.all([kv.get(SENT(hash, 1)), kv.get(SENT(hash, 2)), kv.get(CLAIM(hash, 1)), kv.get(CLAIM(hash, 2))]);
    return { s1: parse(s1), s2: parse(s2), claim1: c1 != null, claim2: c2 != null };
}

/** Let go of a claim, only if it is still this run's. A failed read leaves it to expire. */
async function release(kv, key, runId) {
    try { if (await kv.get(key) === runId) await kv.del(key); } catch { /* expires after CLAIM_SECONDS */ }
}

/**
 * Did the Calendly webhook (api/calendly-webhook.js) email this booker too? Its send key lives 24 hours;
 * its booking record (discovery:<email>) stays. Read only. Never stops a send.
 */
export async function webhookOverlap(kv, email) {
    const e = norm(email);
    try {
        const sentKeys = [];
        for (const role of WEBHOOK_ROLES) {
            const v = await kv.get(`discovery:sent:${e}:${role}`);
            if (v != null) sentKeys.push({ key: `discovery:sent:${e}:${role}`, at: Number(v) ? iso(Number(v)) : String(v) });
        }
        const rec = await kv.hgetall(`discovery:${e}`);
        const booking = rec && rec.email ? { role: rec.role || null, bookedAt: Number(rec.booked_at) ? iso(Number(rec.booked_at)) : null, startTime: rec.start_time || null } : null;
        return {
            overlap: sentKeys.length ? 'confirmed' : booking ? 'likely' : null,
            emailSent: sentKeys.length > 0, sentKeys, booking,
            ...(sentKeys.length ? {} : booking ? { note: 'the webhook recorded this booking; its 24 hour send key is gone, so whether its email went cannot be proved here' } : {}),
        };
    } catch (err) {
        return { overlap: 'unknown', note: 'the webhook keys could not be read: ' + errText(err) };
    }
}

/** Right before a send: is the meeting still on, and is this still their booking? null when it is. */
async function recheck(calendlyGet, event, inv) {
    let ev, iv;
    try { ev = ((await calendlyGet(event.uri)) || {}).resource || {}; }
    catch (e) { return { hold: 'Calendly re-check failed', detail: errText(e) }; }
    if (ev.status !== 'active') return { skip: 'event cancelled' };
    if (!inv.uri) return { hold: 'Calendly re-check failed', detail: 'the invitee has no uri to read again' };
    try { iv = ((await calendlyGet(inv.uri)) || {}).resource || {}; }
    catch (e) { return { hold: 'Calendly re-check failed', detail: errText(e) }; }
    if (iv.status !== 'active') return { skip: 'invitee cancelled' };
    if (iv.rescheduled) return { skip: 'rescheduled' };
    if (iv.old_invitee) return { skip: 'rescheduled booking' };
    return null;
}

// ─── The run ────────────────────────────────────────────────────

/**
 * One run. Returns the report the handler answers with. deps lets tests stand in for every provider:
 *   calendlyGet(url)  send(msg)  optedOutSet({ strict })  clientCheck({ email, company })  loadTemplate(file)  sleep(ms)
 * force: 'dry-run' makes a live-configured run a dry run (?dry=1).
 */
export async function runPrecall({ kv, now = Date.now(), env = process.env, force = null, includeHtml = false, deps = {} } = {}) {
    const d = {
        calendlyGet: calendlyGetter(env.CALENDLY_API_TOKEN),
        send: msg => sendViaResend(msg, { apiKey: env.RESEND_API_KEY }),
        optedOutSet: async (o) => (await import('./_optout.js')).optedOutSet(o),
        clientCheck: async (q) => (await import('./_client-guard.js')).clientCheck(q),
        loadTemplate,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        ...deps,
    };
    const requested = requestedMode(env);
    const refused = requested === 'live' ? liveBlockers(env) : [];
    const mode = requested === 'live' && !refused.length && force !== 'dry-run' ? 'live' : 'dry-run';
    const salt = String(env.LEAD_ID_SALT || '').trim();
    const runId = `${now}:${randomUUID()}`;
    const report = {
        ok: true, mode, requested, ...(refused.length ? { refused } : {}), ...(force === 'dry-run' && requested === 'live' ? { forced: 'dry-run' } : {}),
        ts: iso(now), window: { from: iso(now), to: iso(now + WINDOW_MS) },
        events: 0, discovery: 0, wouldSend: [], sent: [], skipped: [], held: [], errors: [], overlaps: [],
        ...(salt ? {} : { lidNote: `LEAD_ID_SALT is not set: links show lid=${LID_PLACEHOLDER} (utm_term on Calendly) where the real id goes, and live mode will not send` }),
    };
    if (!env.CALENDLY_API_TOKEN) return { ...report, ok: false, error: 'CALENDLY_API_TOKEN is not set' };

    // Upcoming scheduled events, next 14 days: the desktop's exact query, one page of 50.
    const eventsUrl = `https://api.calendly.com/scheduled_events?user=${USER_URI}&status=active&min_start_time=${iso(now)}&max_start_time=${iso(now + WINDOW_MS)}&sort=start_time:asc&count=50`;
    const eventsData = await d.calendlyGet(eventsUrl);
    const events = eventsData.collection || [];
    const discoveryEvents = events.filter(e => DISCOVERY_EVENT_TYPES.includes(e.event_type));
    report.events = events.length;
    report.discovery = discoveryEvents.length;
    if (eventsData.pagination && eventsData.pagination.next_page_token) report.truncated = 'more than 50 events in the window; like the desktop, only the first 50 were read';

    // The stop list, read once and strictly. Unreadable: every email this run is held.
    let stops = null, stopsWhy = null;
    if (discoveryEvents.length) {
        try { stops = await d.optedOutSet({ strict: true }); } catch (e) { stopsWhy = errText(e); }
        if (stops && !(stops.emails instanceof Set)) { stops = null; stopsWhy = 'the stop list came back in an unknown shape'; }
    }
    // What this run has already decided, so a person on two bookings gets one email, dry run or live.
    const seen = new Map();

    for (const event of discoveryEvents) {
        let invitees;
        try { invitees = ((await d.calendlyGet(`${event.uri}/invitees`)) || {}).collection || []; }
        catch (e) { report.errors.push({ eventUri: event.uri, error: 'invitees unreadable: ' + errText(e) }); continue; }

        for (const inv of invitees) {
            const email = inv.email;
            const name = inv.name || '';
            const firstName = name.split(/[\s/]+/)[0] || 'there';
            const addr = norm(email);
            const who = { email: addr, name, eventUri: event.uri, eventTime: event.start_time };
            if (!addr) { report.skipped.push({ ...who, reason: 'no email' }); continue; }
            const hash = emailHash(addr);

            // Stage logic: email 1 on booking; email 2 >=24h later if the call is still >=12h out.
            let led;
            try { led = await readLedger(kv, hash); }
            catch (e) { report.held.push({ ...who, reason: 'ledger unreadable', detail: errText(e) }); continue; }
            const mine = seen.get(hash) || {};
            const s1 = mine.s1 || led.s1, s2 = mine.s2 || led.s2;
            const stage = nextStage(s1, s2, { now, startTime: event.start_time });
            if (!stage) { report.skipped.push({ ...who, reason: 'already emailed', sent: [s1 && 1, s2 && 2].filter(Boolean) }); continue; }
            if (!mine[`s${stage}`] && led[`claim${stage}`] && !led[`s${stage}`]) { report.skipped.push({ ...who, stage, reason: 'another run is sending this one' }); continue; }

            const roleText = roleAnswerOf(inv);
            const role = stage === 2 ? (s1.role && s1.role !== 'hold' ? s1.role : detectRole(roleText)) : detectRole(roleText);
            if (!role) { report.skipped.push({ ...who, stage, reason: 'role other or unknown', roleAnswer: roleText }); continue; }
            const template = stage === 1 ? TEMPLATES[role] : (TEMPLATES2[role] || TEMPLATES2.default);

            // Never someone whose booking is cancelled or was moved.
            if (inv.status && inv.status !== 'active') { report.skipped.push({ ...who, stage, reason: 'invitee cancelled' }); continue; }
            if (inv.rescheduled) { report.skipped.push({ ...who, stage, reason: 'rescheduled' }); continue; }
            if (inv.old_invitee) { report.skipped.push({ ...who, stage, reason: 'rescheduled booking' }); continue; }
            // Never someone who asked not to be contacted.
            if (!stops) { report.held.push({ ...who, stage, reason: 'stop list unavailable', detail: stopsWhy }); continue; }
            if (stops.emails.has(addr)) { report.skipped.push({ ...who, stage, reason: 'opted out' }); continue; }
            // Never a client, for a prospect template. Only 'clear' passes.
            let client = null;
            try { client = await d.clientCheck({ email: addr, company: '' }); } catch { client = null; }
            const cs = client && client.status;
            if (cs === 'client') { report.skipped.push({ ...who, stage, reason: 'existing client' }); continue; }
            if (cs !== 'clear') { report.held.push({ ...who, stage, reason: cs === 'possible' ? 'possible client' : 'client check unavailable', detail: (client && (client.reason || client.why)) || null }); continue; }

            let built;
            try {
                const lid = leadId(addr, salt) || (mode === 'dry-run' ? LID_PLACEHOLDER : null);
                built = { lid, ...renderEmail({ template: d.loadTemplate(template.file), firstName, startTime: event.start_time, role, stage, lid }) };
            } catch (e) { report.errors.push({ ...who, stage, error: `template ${template.file} could not be built: ${errText(e)}` }); continue; }
            const webhook = await webhookOverlap(kv, addr);
            const item = {
                ...who, to: email, firstName, stage, kind: `precall${stage}`, role, roleAnswer: roleText,
                from: FROM, replyTo: REPLY_TO, bcc: HUBSPOT_BCC, subject: template.subject, template: template.file,
                banner: built.banner, lid: built.lid, links: built.links,
                htmlBytes: Buffer.byteLength(built.html), htmlSha256: createHash('sha256').update(built.html).digest('hex'),
                webhook, ...(includeHtml ? { html: built.html } : {}),
            };
            const noteOverlap = () => { if (webhook.overlap) report.overlaps.push({ email: addr, stage, overlap: webhook.overlap, webhookRole: (webhook.sentKeys && webhook.sentKeys[0] && webhook.sentKeys[0].key.split(':').pop()) || (webhook.booking && webhook.booking.role) || null }); };

            if (mode === 'dry-run') {
                // The same re-check a live send makes, read only.
                const r = await recheck(d.calendlyGet, event, inv);
                if (r && r.skip) { report.skipped.push({ ...who, stage, reason: r.skip }); continue; }
                if (r) { report.held.push({ ...who, stage, reason: r.hold, detail: r.detail }); continue; }
                report.wouldSend.push(item);
                noteOverlap();
                seen.set(hash, { ...mine, [`s${stage}`]: { ts: iso(now), role, ok: true } });
                continue;
            }

            // Live: claim first, so an overlapping run cannot send it too.
            const claimKey = CLAIM(hash, stage);
            let claimed;
            try { claimed = await kv.set(claimKey, runId, { nx: true, ex: CLAIM_SECONDS }); }
            catch (e) { report.held.push({ ...who, stage, reason: 'claim failed', detail: errText(e) }); continue; }
            if (!claimed) { report.skipped.push({ ...who, stage, reason: 'another run is sending this one' }); continue; }
            try {
                if (await kv.get(SENT(hash, stage))) { await release(kv, claimKey, runId); report.skipped.push({ ...who, stage, reason: 'already emailed' }); continue; }
                const r = await recheck(d.calendlyGet, event, inv);
                if (r) { await release(kv, claimKey, runId); (r.skip ? report.skipped : report.held).push({ ...who, stage, reason: r.skip || r.hold, ...(r.detail ? { detail: r.detail } : {}) }); continue; }
            } catch (e) { await release(kv, claimKey, runId); report.held.push({ ...who, stage, reason: 'ledger unreadable', detail: errText(e) }); continue; }

            let result;
            try { result = await d.send({ to: email, subject: template.subject, html: built.html, idempotencyKey: `precall/${hash}/${stage}` }); }
            catch (e) { result = { ok: false, unknown: true, error: errText(e) }; }
            if (!result || !result.ok) {
                // Not sent, or not known to be: not marked, the claim let go, the next run tries again.
                await release(kv, claimKey, runId);
                report.errors.push({ ...who, stage, kind: item.kind, error: (result && result.error) || 'no result from the sender', ...(result && result.unknown ? { unknown: true } : {}) });
                continue;
            }
            const entry = { ts: iso(now), role, ok: true, stage, id: result.id || null, eventUri: event.uri, eventTime: event.start_time, source: 'cloud' };
            let marked = false;
            for (let i = 0; i < 2 && !marked; i++) { try { await kv.set(SENT(hash, stage), JSON.stringify(entry)); marked = true; } catch { /* once more */ } }
            if (!marked) {
                // Resend has it. The claim is made permanent, so no run ever sends it again; a person clears it.
                let kept = false;
                try { kept = !!await kv.set(claimKey, `sent:${result.id || ''}`); } catch { /* the 24 hour claim still stands */ }
                report.errors.push({ ...who, stage, kind: item.kind, id: result.id || null,
                    error: kept ? 'sent, but the ledger write failed; the claim now holds it for good' : 'sent, but the ledger write failed; the claim holds it for 24 hours' });
            }
            report.sent.push({ ...item, id: result.id || null });
            noteOverlap();
            seen.set(hash, { ...mine, [`s${stage}`]: entry });
            await d.sleep(SEND_GAP_MS);
        }
    }

    report.counts = { wouldSend: report.wouldSend.length, sent: report.sent.length, skipped: report.skipped.length, held: report.held.length, errors: report.errors.length, overlaps: report.overlaps.length };
    // Kept for the owner view: dry runs for three days, live runs as a log. Never the HTML.
    const stored = JSON.stringify({ ...report, wouldSend: report.wouldSend.map(stripHtml), sent: report.sent.map(stripHtml) });
    try {
        if (mode === 'dry-run') { await kv.lpush(DRY_LOG, stored); await kv.ltrim(DRY_LOG, 0, 19); await kv.expire(DRY_LOG, DRY_TTL_SECONDS); }
        else { await kv.lpush(LIVE_LOG, stored); await kv.ltrim(LIVE_LOG, 0, 199); }
    } catch (e) { report.recordError = 'the run could not be kept for the owner view: ' + errText(e); }
    return report;
}

const stripHtml = ({ html, ...rest }) => rest;

/** The owner view: the latest dry runs (three days) and live runs. */
export async function pendingView(kv, { limit = 10 } = {}) {
    const read = async k => ((await kv.lrange(k, 0, limit - 1)) || []).map(parse).filter(Boolean);
    const dryRuns = await read(DRY_LOG), live = await read(LIVE_LOG);
    const latest = dryRuns[0] || null;
    return {
        sendFlag: requestedMode(),
        liveBlockers: liveBlockers(),
        latestDryRun: latest ? { ts: latest.ts, counts: latest.counts, wouldSend: latest.wouldSend, overlaps: latest.overlaps, held: latest.held, skipped: latest.skipped, errors: latest.errors, refused: latest.refused || [] } : null,
        dryRuns: dryRuns.map(r => ({ ts: r.ts, counts: r.counts, refused: r.refused || [] })),
        liveRuns: live.map(r => ({ ts: r.ts, counts: r.counts, sent: (r.sent || []).map(s => ({ email: s.email, stage: s.stage, role: s.role, id: s.id })) })),
    };
}

/**
 * Import the desktop's sent log as ledger entries (scripts/seed-precall-ledger.mjs), so going live never
 * re-sends to anyone the Mac already emailed. Each entry: { key: 32 hex, stage: 1|2, ts, role, ok }.
 * No address, no name. Never overwrites an entry that is already there.
 */
export async function importLedger(kv, entries, now = Date.now()) {
    if (!Array.isArray(entries)) return { ok: false, error: 'entries must be a list' };
    if (entries.length > 5000) return { ok: false, error: 'at most 5000 entries at a time' };
    const out = { ok: true, received: entries.length, imported: 0, alreadyThere: 0, rejected: [] };
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i] || {};
        const stage = Number(e.stage);
        const why = !/^[0-9a-f]{32}$/.test(String(e.key || '')) ? 'key is not a 32 hex hash'
            : ![1, 2].includes(stage) ? 'stage is not 1 or 2'
            : !Number.isFinite(Date.parse(e.ts)) ? 'ts is not a time'
            : typeof e.ok !== 'boolean' ? 'ok is not true or false'
            : e.role != null && !/^[a-z]{1,16}$/.test(String(e.role)) ? 'role is not a role'
            : null;
        if (why) { out.rejected.push({ index: i, why }); continue; }
        const doc = { ts: iso(Date.parse(e.ts)), role: e.role || null, ok: e.ok, stage, source: 'desktop-seed', importedAt: iso(now) };
        const r = await kv.set(SENT(e.key, stage), JSON.stringify(doc), { nx: true });
        if (r) out.imported++; else out.alreadyThere++;
    }
    return out;
}
