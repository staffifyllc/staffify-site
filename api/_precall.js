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
//                 go out, keeps it for three days (precall:dryrun, the last six runs) and returns it. A
//                 held email is shown too (its subject, template, banner and links), so the copy can be
//                 checked even while the client check holds everything.
//   fail closed   live mode refuses to send without LEAD_ID_SALT (the links would carry the wrong id),
//                 RESEND_API_KEY, a run notice destination, or the Mac's log imported (precall:seeded,
//                 written by the import), and says which is missing.
//   one claim     each person and email (#1, #2) is claimed with SET NX before the send, so two
//                 overlapping runs never both send it. Marked sent only after Resend accepts. The claim
//                 lasts 15 days, longer than the 14-day window, so a run killed between Resend's answer
//                 and the ledger write can never lead to a second email: a claim older than ten minutes
//                 with no ledger entry is held as an unconfirmed send for a person to check.
//   retries       a refusal lets the claim go and the next run tries again. When Resend may have taken
//                 it (5xx, 429, no answer), the retry goes under the same Idempotency-Key and only inside
//                 20 hours of the first try (precall:attempt), because Resend forgets the key at 24.
//   re-check      right before a send, the event and the invitee are read again from Calendly. A
//                 cancelled event or a cancelled invitee is not emailed. A booking someone moved into is,
//                 as on the Mac: the ledger is by address, so a person who had #1 can only get #2.
//   one booking   a booking that cannot be handled (a malformed answer, a throw) is reported under
//                 errors and lets go of its claim; it never stops the run for everyone else.
//   time budget   no send starts after 90 seconds of the 120 second limit; the rest is held for the next run.
//   run notice    every live run (and a live run that was refused) posts its counts, holds and errors to
//                 PRECALL_SLACK_WEBHOOK, or PRECALL_SLACK_CHANNEL with SLACK_BOT_TOKEN. Never the team channel.
//   client guard  api/_client-guard.js: a client never gets a prospect template. A guard that cannot
//                 answer holds the email for the next run, and is asked once per run, not once per person.
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
export const ATTEMPT = (hash, stage) => `precall:attempt:${hash}:${stage}`;   // when a send was first tried
export const SEEDED = 'precall:seeded';                                         // the Mac's log was imported
export const DRY_LOG = 'precall:dryrun';
export const LIVE_LOG = 'precall:log';
export const CLAIM_SECONDS = 15 * 24 * 3600;      // longer than the 14-day window: an orphaned claim outlives every booking it covers
export const CLAIM_STALE_MS = 10 * 60 * 1000;     // a run lasts at most 120 seconds, so an older claim has no run behind it
export const RETRY_WINDOW_MS = 20 * 3600 * 1000;  // Resend keeps an Idempotency-Key 24 hours; retries stay inside 20
export const RUN_BUDGET_MS = 90 * 1000;           // no send starts after this, 30 seconds before the function's limit
const BUDGET_NOTE = 'this run used its 90 seconds; the next run picks this one up';
const DRY_TTL_SECONDS = 3 * 24 * 3600;
const DRY_KEEP = 6;                               // two runs a day for three days
const WEBHOOK_ROLES = ['editors', 'admins', 'csr', 'sales', 'default'];
export const PENDING_URL = 'https://www.gostaffify.com/api/cron-precall/?view=pending';

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

/** What in the environment stops a live run from sending. Empty means it may send (seedState adds the store's part). */
export function liveBlockers(env = process.env) {
    const out = [];
    if (!String(env.LEAD_ID_SALT || '').trim()) out.push('missing LEAD_ID_SALT');
    if (!env.RESEND_API_KEY) out.push('missing RESEND_API_KEY');
    if (!noticeDestination(env)) out.push('missing PRECALL_SLACK_WEBHOOK (or PRECALL_SLACK_CHANNEL with SLACK_BOT_TOKEN), where the run notice goes');
    return out;
}

/**
 * Where the run notice goes: a channel Paul picks, never the team channel. label is what reports show;
 * the webhook URL itself is a secret and never leaves this function's caller.
 */
export function noticeDestination(env = process.env) {
    if (String(env.PRECALL_SLACK_WEBHOOK || '').trim()) return { kind: 'webhook', url: String(env.PRECALL_SLACK_WEBHOOK).trim(), label: 'PRECALL_SLACK_WEBHOOK' };
    if (String(env.PRECALL_SLACK_CHANNEL || '').trim() && env.SLACK_BOT_TOKEN) return { kind: 'bot', channel: String(env.PRECALL_SLACK_CHANNEL).trim(), token: env.SLACK_BOT_TOKEN, label: String(env.PRECALL_SLACK_CHANNEL).trim() };
    return null;
}

/**
 * Was the Mac's sent log imported? Live mode refuses until it was, so going live on an empty ledger can
 * never email #1 again to everyone the Mac already emailed. A read that fails is not a yes.
 */
export async function seedState(kv) {
    try {
        const s = parse(await kv.get(SEEDED));
        return s && s.at ? { seeded: s, blockers: [] } : { seeded: null, blockers: ['desktop log not imported'] };
    } catch (e) {
        return { seeded: null, blockers: ['desktop log import could not be confirmed: ' + errText(e)] };
    }
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

/**
 * The "Which role" answer, found the way the desktop finds it: the first question about a role or a fill.
 * A question with no text is passed over rather than thrown on.
 */
export function roleAnswerOf(inv) {
    const q = (inv.questions_and_answers || []).find(x => {
        const question = String((x && x.question) || '').toLowerCase();
        return question.includes('role') || question.includes('fill');
    });
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

/**
 * Post the run notice once, the way api/_daily-report-run.js posts: a webhook must answer "ok", the bot
 * must answer ok. Never throws: { posted: true, via } or { posted: false, error }.
 */
export async function postNotice(dest, text, fetchImpl = fetch) {
    if (!dest) return { posted: false, error: 'no notice destination is set' };
    try {
        if (dest.kind === 'webhook') {
            const r = await fetchImpl(dest.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(10000) });
            const body = (await r.text()).trim();
            return r.ok && body === 'ok' ? { posted: true, via: 'webhook' } : { posted: false, error: 'the webhook answered ' + r.status };
        }
        const r = await fetchImpl('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + dest.token, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel: dest.channel, text, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(10000) });
        const j = await r.json().catch(() => ({}));
        return j.ok ? { posted: true, via: 'bot', channel: dest.channel } : { posted: false, error: j.error || 'Slack answered ' + r.status };
    } catch (e) { return { posted: false, error: errText(e) }; }
}

const NOTICE_LINES = 15;
const clip = (s, n = 160) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

/**
 * The run notice. Sent emails read as the desktop's push did ("Pre-call email sent to [Name] ([email])
 * for their [date] discovery call. Role: [role]."), then every hold and error with its reason.
 */
export function noticeText(r) {
    const c = r.counts || {};
    const at = r.ts && Number.isFinite(Date.parse(r.ts)) ? formatCall(r.ts).time : 'unknown time';
    const live = r.mode === 'live';
    const lines = [`Pre-call emails${live ? '' : ' (dry run, nothing sent)'}, ${at} run: ${live ? `${c.sent || 0} sent` : `${c.wouldSend || 0} would send`}, ${c.held || 0} held, ${c.errors || 0} errors, ${c.skipped || 0} skipped.`];
    if (r.refused && r.refused.length) lines.push(`Live sending is switched on but refused: ${r.refused.join('; ')}. Nothing was sent.`);
    if (r.error) lines.push(`The run stopped early: ${clip(r.error)}`);
    if (r.truncated) lines.push(`Note: ${r.truncated}.`);
    const who = x => `${x.name || x.email || 'no name'} (${x.email || 'no address'})`;
    const callDate = x => (x.eventTime && Number.isFinite(Date.parse(x.eventTime)) ? formatCall(x.eventTime).date : 'unknown date');
    const list = (items, line) => {
        for (const x of items.slice(0, NOTICE_LINES)) lines.push(line(x));
        if (items.length > NOTICE_LINES) lines.push(`...and ${items.length - NOTICE_LINES} more.`);
    };
    list(r.sent || [], x => `Pre-call email #${x.stage} sent to ${who(x)} for their ${callDate(x)} discovery call. Role: ${x.role}.`);
    if (!live) list(r.wouldSend || [], x => `Would send email #${x.stage} to ${who(x)} for their ${callDate(x)} discovery call. Role: ${x.role}.`);
    list(r.held || [], x => `Held: ${x.email ? who(x) : x.eventUri || 'a booking'}${x.stage ? `, email #${x.stage}` : ''}: ${x.reason}${x.detail ? ` (${clip(x.detail)})` : ''}.`);
    list(r.errors || [], x => `Error: ${x.email ? who(x) : x.eventUri || 'the run'}${x.stage ? `, email #${x.stage}` : ''}: ${clip(x.error)}${x.unknown ? ' (Resend may have it; retried under the same key)' : ''}.`);
    if (!(r.sent || []).length && !(r.wouldSend || []).length && !(r.held || []).length && !(r.errors || []).length && !r.error && !(r.refused && r.refused.length)) lines.push('No new discovery call bookings to email.');
    lines.push(`Details: ${PENDING_URL}`);
    return lines.join('\n');
}

// ─── The store ──────────────────────────────────────────────────

/** Both ledger entries, both claims and both first-try times for one person. Throws if the store cannot be read. */
async function readLedger(kv, hash) {
    const [s1, s2, c1, c2, a1, a2] = await Promise.all([kv.get(SENT(hash, 1)), kv.get(SENT(hash, 2)), kv.get(CLAIM(hash, 1)), kv.get(CLAIM(hash, 2)), kv.get(ATTEMPT(hash, 1)), kv.get(ATTEMPT(hash, 2))]);
    return { s1: parse(s1), s2: parse(s2), claim1: c1, claim2: c2, attempt1: a1, attempt2: a2 };
}

/**
 * What a claim with no ledger entry means. 'sent': Resend accepted it and the ledger write failed.
 * 'running': a run claimed it in the last ten minutes. 'stale': no run is behind it, so a send may have
 * gone without being recorded (a run killed mid-send); a person checks Resend.
 */
export function claimState(value, now) {
    const v = String(value);
    if (v.startsWith('sent:')) return { state: 'sent', id: v.slice(5) || null };
    const at = Number(v.split(':')[0]);
    return Number.isFinite(at) && at > 0 && now - at < CLAIM_STALE_MS ? { state: 'running' } : { state: 'stale' };
}

/** A first try older than 20 hours: Resend may have it and may have forgotten its key, so no more retries. */
export const retryClosed = (firstTry, now) => { const t = Number(firstTry); return !Number.isFinite(t) || now - t >= RETRY_WINDOW_MS; };

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

/**
 * Right before a send: is the meeting still on, and is this still their booking? null when it is.
 * rescheduled marks the booking someone moved away from. The one they moved into (old_invitee set) is
 * theirs, and is emailed as the Mac emails it.
 */
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
    return null;
}

// ─── The run ────────────────────────────────────────────────────

/** Who a booking is, read without trusting its shape: for reporting a booking that threw. */
const whoOf = (event, inv) => ({
    email: norm(inv && inv.email), name: inv && typeof inv.name === 'string' ? inv.name : '',
    eventUri: (event && event.uri) || null, eventTime: (event && event.start_time) || null,
});

/**
 * One run. Returns the report the handler answers with. deps lets tests stand in for every provider:
 *   calendlyGet(url)  send(msg)  optedOutSet({ strict })  clientCheck({ email, company })  notify(text)
 *   loadTemplate(file)  sleep(ms)  clock()
 * force: 'dry-run' makes a live-configured run a dry run (?dry=1). notify: post the notice from a dry run
 * too (?notify=1); a live run, or a live run that was refused, always posts it.
 */
export async function runPrecall({ kv, now = Date.now(), env = process.env, force = null, includeHtml = false, notify = false, deps = {} } = {}) {
    const d = {
        calendlyGet: calendlyGetter(env.CALENDLY_API_TOKEN),
        send: msg => sendViaResend(msg, { apiKey: env.RESEND_API_KEY }),
        optedOutSet: async (o) => (await import('./_optout.js')).optedOutSet(o),
        clientCheck: async (q) => (await import('./_client-guard.js')).clientCheck(q),
        notify: text => postNotice(noticeDestination(env), text),
        loadTemplate,
        sleep: ms => new Promise(r => setTimeout(r, ms)),
        clock: Date.now,
        ...deps,
    };
    const started = d.clock();
    const overBudget = () => d.clock() - started > RUN_BUDGET_MS;
    const requested = requestedMode(env);
    const seed = await seedState(kv);
    const refused = requested === 'live' ? [...liveBlockers(env), ...seed.blockers] : [];
    const mode = requested === 'live' && !refused.length && force !== 'dry-run' ? 'live' : 'dry-run';
    const salt = String(env.LEAD_ID_SALT || '').trim();
    const runId = `${now}:${randomUUID()}`;
    const report = {
        ok: true, mode, requested, ...(refused.length ? { refused } : {}), ...(force === 'dry-run' && requested === 'live' ? { forced: 'dry-run' } : {}),
        ts: iso(now), window: { from: iso(now), to: iso(now + WINDOW_MS) }, seeded: seed.seeded,
        events: 0, discovery: 0, wouldSend: [], sent: [], skipped: [], held: [], errors: [], overlaps: [],
        ...(salt ? {} : { lidNote: `LEAD_ID_SALT is not set: links show lid=${LID_PLACEHOLDER} (utm_term on Calendly) where the real id goes, and live mode will not send` }),
    };

    // Every run ends here: counts, the notice, and the copy kept for the owner view.
    const finish = async () => {
        report.counts = { wouldSend: report.wouldSend.length, sent: report.sent.length, skipped: report.skipped.length, held: report.held.length, errors: report.errors.length, overlaps: report.overlaps.length };
        if (mode === 'live' || refused.length || notify) {
            let text;
            try { text = noticeText(report); } catch (e) { text = `Pre-call emails: the run notice could not be written (${errText(e)}). ${PENDING_URL}`; }
            try { report.notice = await d.notify(text); } catch (e) { report.notice = { posted: false, error: errText(e) }; }
            if (!report.notice || typeof report.notice !== 'object') report.notice = { posted: false, error: 'no answer from the notifier' };
        }
        // Kept for the owner view: dry runs for three days (the last six), live runs as a log. Never the HTML.
        const stored = JSON.stringify({ ...report, wouldSend: report.wouldSend.map(stripHtml), sent: report.sent.map(stripHtml), held: report.held.map(h => (h.preview ? { ...h, preview: stripHtml(h.preview) } : h)) });
        try {
            if (mode === 'dry-run') { await kv.lpush(DRY_LOG, stored); await kv.ltrim(DRY_LOG, 0, DRY_KEEP - 1); await kv.expire(DRY_LOG, DRY_TTL_SECONDS); }
            else { await kv.lpush(LIVE_LOG, stored); await kv.ltrim(LIVE_LOG, 0, 199); }
        } catch (e) { report.recordError = 'the run could not be kept for the owner view: ' + errText(e); }
        return report;
    };

    if (!env.CALENDLY_API_TOKEN) { report.ok = false; report.error = 'CALENDLY_API_TOKEN is not set'; return finish(); }

    // Upcoming scheduled events, next 14 days: the desktop's exact query, one page of 50.
    const eventsUrl = `https://api.calendly.com/scheduled_events?user=${USER_URI}&status=active&min_start_time=${iso(now)}&max_start_time=${iso(now + WINDOW_MS)}&sort=start_time:asc&count=50`;
    let eventsData;
    try { eventsData = (await d.calendlyGet(eventsUrl)) || {}; }
    catch (e) { report.ok = false; report.error = 'Calendly events unreadable: ' + errText(e); return finish(); }
    const events = Array.isArray(eventsData.collection) ? eventsData.collection : [];
    const discoveryEvents = events.filter(e => e && DISCOVERY_EVENT_TYPES.includes(e.event_type));
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
    // The client guard's sources are the same for everyone: once it cannot answer, it is not asked again
    // this run (each ask can wait on a HubSpot refresh).
    let guardDown = null;

    /** A claim with no ledger entry, reported for what it is. */
    const claimReport = (who, stage, hash, value) => {
        const c = claimState(value, now), key = CLAIM(hash, stage);
        if (c.state === 'sent') report.skipped.push({ ...who, stage, reason: 'sent, ledger write failed', detail: `Resend accepted it${c.id ? ` (id ${c.id})` : ''}; ${key} stops it going again` });
        else if (c.state === 'stale') report.held.push({ ...who, stage, reason: 'unconfirmed send', detail: `check Resend: if it did not go, delete ${key} and ${ATTEMPT(hash, stage)} and the next run sends it; if it went, leave the claim` });
        else report.skipped.push({ ...who, stage, reason: 'another run is sending this one' });
    };
    const unconfirmed = (hash, stage, firstTry) => ({ reason: 'unconfirmed send',
        detail: `first tried ${Number.isFinite(Number(firstTry)) ? iso(Number(firstTry)) : 'at an unknown time'} and Resend never confirmed it; past 20 hours a retry could be a second email. Check Resend: if it did not go, delete ${ATTEMPT(hash, stage)} and the next run sends it` });

    /** One booking. state.claimKey is set while this booking holds a claim; state.sent once Resend accepted. */
    const one = async (event, inv, state) => {
        const email = inv.email;
        const name = inv.name || '';
        const firstName = name.split(/[\s/]+/)[0] || 'there';
        const addr = norm(email);
        const who = { email: addr, name, eventUri: event.uri, eventTime: event.start_time };
        if (!addr) { report.skipped.push({ ...who, reason: 'no email' }); return; }
        // The Mac would send "Your call: Invalid Date at Invalid Date". Never.
        if (!Number.isFinite(Date.parse(event.start_time))) { report.skipped.push({ ...who, reason: 'no call time' }); return; }
        const hash = emailHash(addr);

        // Stage logic: email 1 on booking; email 2 >=24h later if the call is still >=12h out.
        let led;
        try { led = await readLedger(kv, hash); }
        catch (e) { report.held.push({ ...who, reason: 'ledger unreadable', detail: errText(e) }); return; }
        const mine = seen.get(hash) || {};
        const s1 = mine.s1 || led.s1, s2 = mine.s2 || led.s2;
        const stage = nextStage(s1, s2, { now, startTime: event.start_time });
        if (!stage) { report.skipped.push({ ...who, reason: 'already emailed', sent: [s1 && 1, s2 && 2].filter(Boolean) }); return; }
        if (!mine[`s${stage}`] && led[`claim${stage}`] != null && !led[`s${stage}`]) { claimReport(who, stage, hash, led[`claim${stage}`]); return; }
        if (!mine[`s${stage}`] && led[`attempt${stage}`] != null && retryClosed(led[`attempt${stage}`], now)) { report.held.push({ ...who, stage, ...unconfirmed(hash, stage, led[`attempt${stage}`]) }); return; }

        const roleText = roleAnswerOf(inv);
        const role = stage === 2 ? (s1.role && s1.role !== 'hold' ? s1.role : detectRole(roleText)) : detectRole(roleText);
        if (!role) { report.skipped.push({ ...who, stage, reason: 'role other or unknown', roleAnswer: roleText }); return; }
        const template = stage === 1 ? TEMPLATES[role] : (TEMPLATES2[role] || TEMPLATES2.default);

        // Never someone whose booking is cancelled, or the booking they moved away from.
        if (inv.status && inv.status !== 'active') { report.skipped.push({ ...who, stage, reason: 'invitee cancelled' }); return; }
        if (inv.rescheduled) { report.skipped.push({ ...who, stage, reason: 'rescheduled' }); return; }

        const lid = leadId(addr, salt) || (mode === 'dry-run' ? LID_PLACEHOLDER : null);
        let built = null;
        const build = () => built || (built = { lid, ...renderEmail({ template: d.loadTemplate(template.file), firstName, startTime: event.start_time, role, stage, lid }) });
        const fields = (b, webhook) => ({
            kind: `precall${stage}`, role, roleAnswer: roleText,
            from: FROM, replyTo: REPLY_TO, bcc: HUBSPOT_BCC, subject: template.subject, template: template.file,
            banner: b.banner, lid: b.lid, links: b.links,
            htmlBytes: Buffer.byteLength(b.html), htmlSha256: createHash('sha256').update(b.html).digest('hex'),
            webhook, ...(includeHtml ? { html: b.html } : {}),
        });
        // A dry-run hold still shows the email it holds, so the copy, links and recipient can be checked
        // before go-live even while the client check holds everyone.
        const hold = async (reason, detail = null, { preview = true } = {}) => {
            const h = { ...who, stage, reason, detail };
            if (mode === 'dry-run' && preview) {
                try { h.preview = { to: email, firstName, ...fields(build(), await webhookOverlap(kv, addr)) }; }
                catch (e) { h.preview = { error: `template ${template.file} could not be built: ${errText(e)}` }; }
            }
            report.held.push(h);
        };

        // Never someone who asked not to be contacted.
        if (!stops) { await hold('stop list unavailable', stopsWhy); return; }
        if (stops.emails.has(addr)) { report.skipped.push({ ...who, stage, reason: 'opted out' }); return; }
        if (overBudget()) { await hold('run time budget reached', BUDGET_NOTE, { preview: false }); return; }
        // Never a client, for a prospect template. Only 'clear' passes.
        let client = guardDown;
        if (!client) {
            try { client = await d.clientCheck({ email: addr, company: '' }); } catch (e) { client = { status: 'unknown', why: errText(e) }; }
            if (!client || !['clear', 'client', 'possible'].includes(client.status)) guardDown = client || { status: 'unknown' };
        }
        const cs = client && client.status;
        if (cs === 'client') { report.skipped.push({ ...who, stage, reason: 'existing client' }); return; }
        if (cs !== 'clear') { await hold(cs === 'possible' ? 'possible client' : 'client check unavailable', (client && (client.reason || client.why)) || null); return; }

        let b;
        try { b = build(); }
        catch (e) { report.errors.push({ ...who, stage, error: `template ${template.file} could not be built: ${errText(e)}` }); return; }
        const webhook = await webhookOverlap(kv, addr);
        const item = { ...who, to: email, firstName, stage, ...fields(b, webhook) };
        const noteOverlap = () => { if (webhook.overlap) report.overlaps.push({ email: addr, stage, overlap: webhook.overlap, webhookRole: (webhook.sentKeys && webhook.sentKeys[0] && webhook.sentKeys[0].key.split(':').pop()) || (webhook.booking && webhook.booking.role) || null }); };

        if (mode === 'dry-run') {
            // The same re-check a live send makes, read only.
            const r = await recheck(d.calendlyGet, event, inv);
            if (r && r.skip) { report.skipped.push({ ...who, stage, reason: r.skip }); return; }
            if (r) { await hold(r.hold, r.detail); return; }
            report.wouldSend.push(item);
            noteOverlap();
            seen.set(hash, { ...mine, [`s${stage}`]: { ts: iso(now), role, ok: true } });
            return;
        }

        // Live: claim first, so an overlapping run cannot send it too.
        const claimKey = CLAIM(hash, stage);
        let claimed;
        try { claimed = await kv.set(claimKey, runId, { nx: true, ex: CLAIM_SECONDS }); }
        catch (e) { report.held.push({ ...who, stage, reason: 'claim failed', detail: errText(e) }); return; }
        if (!claimed) {
            let v = null;
            try { v = await kv.get(claimKey); } catch { /* reported as another run's */ }
            if (v == null) report.skipped.push({ ...who, stage, reason: 'another run is sending this one' });
            else claimReport(who, stage, hash, v);
            return;
        }
        state.claimKey = claimKey;
        let firstTry = null;
        try {
            if (await kv.get(SENT(hash, stage))) { await release(kv, claimKey, runId); report.skipped.push({ ...who, stage, reason: 'already emailed' }); return; }
            firstTry = await kv.get(ATTEMPT(hash, stage));
            if (firstTry != null && retryClosed(firstTry, now)) { await release(kv, claimKey, runId); report.held.push({ ...who, stage, ...unconfirmed(hash, stage, firstTry) }); return; }
            const r = await recheck(d.calendlyGet, event, inv);
            if (r) { await release(kv, claimKey, runId); (r.skip ? report.skipped : report.held).push({ ...who, stage, reason: r.skip || r.hold, ...(r.detail ? { detail: r.detail } : {}) }); return; }
        } catch (e) { await release(kv, claimKey, runId); report.held.push({ ...who, stage, reason: 'ledger unreadable', detail: errText(e) }); return; }
        if (overBudget()) { await release(kv, claimKey, runId); report.held.push({ ...who, stage, reason: 'run time budget reached', detail: BUDGET_NOTE }); return; }

        // The first try is written before the send, so a run killed mid-send still leaves it, and every
        // retry stays inside Resend's 24 hour key.
        let firstHere = false;
        try { firstHere = !!await kv.set(ATTEMPT(hash, stage), String(now), { nx: true, ex: CLAIM_SECONDS }); }
        catch (e) { await release(kv, claimKey, runId); report.held.push({ ...who, stage, reason: 'claim failed', detail: errText(e) }); return; }
        const firstMs = firstHere ? now : (Number(firstTry) || now);

        let result;
        try { result = await d.send({ to: email, subject: template.subject, html: b.html, idempotencyKey: `precall/${hash}/${stage}` }); }
        catch (e) { result = { ok: false, unknown: true, error: errText(e) }; }
        if (!result || !result.ok) {
            // Not sent, or not known to be: not marked, the claim let go, the next run tries again. A plain
            // refusal sent nothing, so it does not start the 20 hour retry window.
            const unknown = !result || !!result.unknown;
            if (!unknown && firstHere) { try { await kv.del(ATTEMPT(hash, stage)); } catch { /* the window only gets shorter */ } }
            await release(kv, claimKey, runId);
            report.errors.push({ ...who, stage, kind: item.kind, error: (result && result.error) || 'no result from the sender',
                ...(unknown ? { unknown: true, retryUntil: iso(firstMs + RETRY_WINDOW_MS) } : {}) });
            return;
        }
        state.sent = true;
        const entry = { ts: iso(now), role, ok: true, stage, id: result.id || null, eventUri: event.uri, eventTime: event.start_time, source: 'cloud' };
        let marked = false;
        for (let i = 0; i < 2 && !marked; i++) { try { await kv.set(SENT(hash, stage), JSON.stringify(entry)); marked = true; } catch { /* once more */ } }
        if (marked) { try { await kv.del(ATTEMPT(hash, stage)); } catch { /* lapses with the claim */ } }
        else {
            // Resend has it. The claim is made permanent, so no run ever sends it again; a person clears it.
            let kept = false;
            try { kept = !!await kv.set(claimKey, `sent:${result.id || ''}`); } catch { /* the 15 day claim still stands */ }
            report.errors.push({ ...who, stage, kind: item.kind, id: result.id || null,
                error: kept ? 'sent, but the ledger write failed; the claim now holds it for good' : 'sent, but the ledger write failed; the claim holds it for 15 days' });
        }
        report.sent.push({ ...item, id: result.id || null });
        noteOverlap();
        seen.set(hash, { ...mine, [`s${stage}`]: entry });
        await d.sleep(SEND_GAP_MS);
    };

    for (const event of discoveryEvents) {
        if (overBudget()) { report.held.push({ eventUri: event.uri || null, eventTime: event.start_time || null, reason: 'run time budget reached', detail: BUDGET_NOTE }); continue; }
        let invitees;
        try { const got = (await d.calendlyGet(`${event.uri}/invitees`)) || {}; invitees = Array.isArray(got.collection) ? got.collection : []; }
        catch (e) { report.errors.push({ eventUri: event.uri, error: 'invitees unreadable: ' + errText(e) }); continue; }

        for (const inv of invitees) {
            // One booking that cannot be handled is reported and lets go of its claim; the run goes on.
            const state = { claimKey: null, sent: false };
            try { await one(event, inv, state); }
            catch (e) {
                if (state.claimKey && !state.sent) await release(kv, state.claimKey, runId);
                report.errors.push({ ...whoOf(event, inv), error: 'this booking could not be handled: ' + errText(e),
                    ...(state.sent ? { sent: true, note: 'Resend accepted it before the error; the claim stops it going again' } : {}) });
            }
        }
    }

    return finish();
}

const stripHtml = ({ html, ...rest }) => rest;

/** The owner view: the latest dry runs (three days), live runs, and what stops live mode. */
export async function pendingView(kv, { limit = 10, env = process.env } = {}) {
    const read = async k => ((await kv.lrange(k, 0, limit - 1)) || []).map(parse).filter(Boolean);
    const dryRuns = await read(DRY_LOG), live = await read(LIVE_LOG);
    const seed = await seedState(kv);
    const latest = dryRuns[0] || null;
    const dest = noticeDestination(env);
    return {
        sendFlag: requestedMode(env),
        liveBlockers: [...liveBlockers(env), ...seed.blockers],
        seeded: seed.seeded,
        notice: dest ? dest.label : null,
        latestDryRun: latest ? { ts: latest.ts, counts: latest.counts, wouldSend: latest.wouldSend, overlaps: latest.overlaps, held: latest.held, skipped: latest.skipped, errors: latest.errors, refused: latest.refused || [], notice: latest.notice || null } : null,
        dryRuns: dryRuns.map(r => ({ ts: r.ts, counts: r.counts, refused: r.refused || [] })),
        liveRuns: live.map(r => ({ ts: r.ts, counts: r.counts, notice: r.notice || null,
            sent: (r.sent || []).map(s => ({ email: s.email, stage: s.stage, role: s.role, id: s.id })),
            held: (r.held || []).map(h => ({ email: h.email, stage: h.stage, reason: h.reason, detail: h.detail || null })),
            errors: (r.errors || []).map(e => ({ email: e.email, stage: e.stage, error: e.error })) })),
    };
}

/**
 * Import the desktop's sent log as ledger entries (scripts/seed-precall-ledger.mjs), so going live never
 * re-sends to anyone the Mac already emailed. Each entry: { key: 32 hex, stage: 1|2, ts, role, ok }.
 * No address, no name. Never overwrites an entry that is already there. An odd role is kept as no role.
 * Once at least one entry is accepted, precall:seeded records { at, count, latestTs }: live mode refuses
 * without it. Each import rewrites that record, so a second run right before go-live shows the newest.
 */
export async function importLedger(kv, entries, now = Date.now()) {
    if (!Array.isArray(entries)) return { ok: false, error: 'entries must be a list' };
    if (entries.length > 5000) return { ok: false, error: 'at most 5000 entries at a time' };
    const out = { ok: true, received: entries.length, imported: 0, alreadyThere: 0, rejected: [] };
    let latest = null;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i] || {};
        const stage = Number(e.stage);
        const why = !/^[0-9a-f]{32}$/.test(String(e.key || '')) ? 'key is not a 32 hex hash'
            : ![1, 2].includes(stage) ? 'stage is not 1 or 2'
            : !Number.isFinite(Date.parse(e.ts)) ? 'ts is not a time'
            : typeof e.ok !== 'boolean' ? 'ok is not true or false'
            : null;
        if (why) { out.rejected.push({ index: i, why }); continue; }
        const t = Date.parse(e.ts);
        const role = /^[a-z]{1,16}$/.test(String(e.role || '')) ? e.role : null;
        const doc = { ts: iso(t), role, ok: e.ok, stage, source: 'desktop-seed', importedAt: iso(now) };
        const r = await kv.set(SENT(e.key, stage), JSON.stringify(doc), { nx: true });
        if (r) out.imported++; else out.alreadyThere++;
        if (latest == null || t > latest) latest = t;
    }
    const count = out.imported + out.alreadyThere;
    if (!count) return { ...out, seeded: null, seedNote: 'nothing was accepted, so the ledger is not marked as imported and live mode still refuses' };
    const seeded = { at: iso(now), count, imported: out.imported, alreadyThere: out.alreadyThere, rejected: out.rejected.length, latestTs: iso(latest) };
    await kv.set(SEEDED, JSON.stringify(seeded));
    return { ...out, seeded };
}
