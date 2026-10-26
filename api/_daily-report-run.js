// Generating, storing and delivering a caller's daily report. Shared by the Hub view and the cron.
// ------------------------------------------------------------------
// One snapshot per person per ET day (report:daily:<email>:<day>). Once it has been delivered it is
// never overwritten, so what Paul read in Slack is what the Hub shows for that day. Delivery is
// deduplicated by person and day: a lease (SET NX) stops two runs posting at once, and a delivered
// record stops any later run posting again. Delivery is claimed only when Slack confirms it
// (chat.postMessage answered ok with a message ts, or a webhook answered "ok").
//
// Where it goes: REPORT_SLACK_CHANNEL (a channel or DM id, posted with SLACK_BOT_TOKEN) or
// REPORT_SLACK_WEBHOOK. Neither is set until Paul names a private management destination; until then
// the report is generated and kept for the Hub and delivery reads "not configured". It never falls
// back to the team channel (SLACK_CHANNEL) or to email.
import { withCallPhones } from './_outreach-call-phones.js';
import { hubspotRequest } from './_outreach-hubspot.js';
import { listReps } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { hasCallerPlan } from './_caller-plan.js';
import { gather, buildReport, slackText, RK, RETAIN_DAYS } from './_daily-report.js';
import { randomUUID } from 'node:crypto';

const SITE = 'https://www.gostaffify.com';
export const reportLink = (email, day) => `${SITE}/activity/report/?user=${encodeURIComponent(email)}&date=${day}`;

/** Who gets a daily report: everyone who calls and is not a sales owner. Today that is Milton. */
export async function reportPeople() {
    return (await listReps()).filter(r => r && r.email && !ownerFor(r) && (r.role === 'caller' || hasCallerPlan(r.email)));
}

/** The numbers on each card, the same way the dialer sees them. Best effort; a CRM outage leaves the record's own. */
export function decorator(redis) {
    const crm = async (path, body) => {
        const response = await hubspotRequest('https://api.hubapi.com' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + process.env.HUBSPOT_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, { redis });
        if (!response.ok) throw Error('CRM unavailable');
        return response.json();
    };
    return view => withCallPhones(view, { redis, crm });
}

/** Build a report now, from live sources. Not stored. */
export async function liveReport({ redis, rep, day, now = Date.now(), deps }) {
    const src = await gather({ redis, rep, day, now, decorate: decorator(redis), deps });
    return buildReport({ ...src, generatedAt: new Date(now).toISOString() });
}

/** The stored snapshot, if any, and its delivery record. */
export async function stored(redis, email, day) {
    const [snap, delivery] = await Promise.all([redis.get(RK.snapshot(email, day)).catch(() => null), redis.get(RK.delivery(email, day)).catch(() => null)]);
    return { snapshot: snap || null, delivery: delivery || null };
}

export function destination(env = process.env) {
    if (env.REPORT_SLACK_WEBHOOK) return { kind: 'webhook', url: env.REPORT_SLACK_WEBHOOK, label: 'the report webhook' };
    if (env.REPORT_SLACK_CHANNEL && env.SLACK_BOT_TOKEN) return { kind: 'bot', channel: env.REPORT_SLACK_CHANNEL, token: env.SLACK_BOT_TOKEN, label: env.REPORT_SLACK_CHANNEL };
    return null;
}

/** Post once, and say whether Slack confirmed it. Never throws. */
export async function postToSlack(dest, text, fetchImpl = fetch) {
    try {
        if (dest.kind === 'webhook') {
            const r = await fetchImpl(dest.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(15000) });
            const body = (await r.text()).trim();
            return r.ok && body === 'ok' ? { confirmed: true, via: 'webhook' } : { confirmed: false, error: 'webhook answered ' + r.status };
        }
        const r = await fetchImpl('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { Authorization: 'Bearer ' + dest.token, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ channel: dest.channel, text, unfurl_links: false, unfurl_media: false }), signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        return j.ok && j.ts ? { confirmed: true, via: 'bot', channel: j.channel || dest.channel, ts: j.ts } : { confirmed: false, error: j.error || 'Slack answered ' + r.status };
    } catch (e) { return { confirmed: false, error: String((e && e.message) || e).slice(0, 120) }; }
}

/**
 * Generate (unless already delivered), store, and deliver one person's report for one day.
 * Safe to call any number of times: it posts to Slack at most once per person per day, and once a
 * day is delivered its kept snapshot is never rewritten, so the Hub shows what Slack received.
 * Everything that writes happens under the lease, after re-reading the delivery record; a delivery
 * record that cannot be read stops the run (the next scheduled run retries) rather than risk a repost.
 */
export async function runOne({ redis, rep, day, now = Date.now(), deps, env = process.env, fetchImpl = fetch }) {
    const email = String(rep.email).toLowerCase();
    const first = await redis.get(RK.delivery(email, day));
    if (first && first.delivered) return { email, day, status: 'already_delivered', delivery: first };
    const nonce = randomUUID();
    if ((await redis.set(RK.lease(email, day), nonce, { nx: true, ex: 300 })) === null) return { email, day, status: 'another_run_is_delivering' };
    try {
        const again = await redis.get(RK.delivery(email, day));
        if (again && again.delivered) return { email, day, status: 'already_delivered', delivery: again };
        const attempts = ((again && again.attempts) || 0);
        const report = await liveReport({ redis, rep, day, now, deps });
        await redis.set(RK.snapshot(email, day), report, { ex: RETAIN_DAYS * 86400 });
        const dest = destination(env);
        if (!dest) {
            const d = { delivered: false, status: 'not_configured', note: 'No private management Slack destination is set. The report is in the Hub.', lastAttemptAt: new Date().toISOString(), attempts, generatedAt: report.generatedAt };
            await redis.set(RK.delivery(email, day), d, { ex: RETAIN_DAYS * 86400 });
            return { email, day, status: 'stored_not_delivered', reason: 'not_configured' };
        }
        const res = await postToSlack(dest, slackText(report, { link: reportLink(email, day) }), fetchImpl);
        const d = res.confirmed
            ? { delivered: true, status: 'delivered', at: new Date().toISOString(), via: res.via, channel: res.channel || dest.label, ts: res.ts || null, attempts: attempts + 1, generatedAt: report.generatedAt }
            : { delivered: false, status: 'failed', error: res.error, lastAttemptAt: new Date().toISOString(), attempts: attempts + 1, generatedAt: report.generatedAt };
        await redis.set(RK.delivery(email, day), d, { ex: RETAIN_DAYS * 86400 });
        return { email, day, status: d.status, delivery: d };
    } finally {
        try { if ((await redis.get(RK.lease(email, day))) === nonce) await redis.del(RK.lease(email, day)); } catch { /* expires on its own */ }
    }
}
