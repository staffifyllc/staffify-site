// Telling a human that a role-map request arrived. Shared by the public endpoint and by the retry
// the operator queue can trigger, so both send exactly the same thing through exactly the same path.
//
// Neither sender throws. Each returns { ok } or { ok:false, error|skipped }, and that result is what
// gets written onto the request, because a saved request is not a delivered alert.
import { slackNotify } from './_slack.js';

const NOTIFY_TO = 'hello@gostaffify.com';
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function requestBody(r) {
    return [
        (r.reopened ? 'New submission on a request you already closed' : 'Role-map request') + ' from /real-estate-media/',
        '',
        'Name:     ' + (r.name || ''),
        'Email:    ' + (r.email || ''),
        'Company:  ' + (r.company || '(not given)'),
        '',
        'What still comes back to them:',
        r.pain || '(they did not say)',
        '',
        r.times ? ('They would talk, and suggested: ' + r.times) : 'They did not ask for a call.',
        '',
        'This is a REQUEST. Nothing is booked. Reply to them yourself and agree a time if there is one.',
        'Queue: https://www.gostaffify.com/pilot/',
    ].join('\n');
}

export async function notifyEmail(r) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return { ok: false, skipped: 'RESEND_API_KEY missing' };
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    const text = requestBody(r);
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            // Resend keeps an Idempotency-Key for 24 hours, so a retry inside that window is the same
            // email rather than a second one. This is the only duplicate protection either channel has.
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
                ...(r.idempotencyKey ? { 'Idempotency-Key': String(r.idempotencyKey).slice(0, 256) } : {}) },
            body: JSON.stringify({ from, to: NOTIFY_TO, reply_to: r.email,
                subject: (r.reopened ? 'Reopened: ' : '') + 'Role map: ' + (r.name || '')
                    + (r.company ? ' (' + r.company + ')' : ''),
                text, html: '<pre style="font:14px/1.6 ui-monospace,monospace">' + esc(text) + '</pre>' }),
            signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { ok: true };
        // 5xx and a rate limit mean we do not know what happened to the request. A 4xx is a refusal.
        if (res.status >= 500 || res.status === 429) return { ok: false, unknown: true, error: 'resend ' + res.status };
        return { ok: false, error: 'resend ' + res.status };
    } catch (e) {
        // A timeout or a dropped connection is not a failure. We asked and never found out.
        return { ok: false, unknown: true, error: 'the send did not answer' };
    }
}

export async function notifySlack(r) {
    const out = await slackNotify((r.reopened ? 'New submission on a closed role-map request' : 'Role-map request')
        + ': ' + (r.name || '') + (r.company ? ' at ' + r.company : '')
        + '. Wants ' + (r.times ? 'the role map and a time' : 'the role map')
        + '. This is a request, not a booking. https://www.gostaffify.com/pilot/');
    if (out && out.ok) return { ok: true };
    if (out && out.skipped) return { ok: false, skipped: 'Slack is not configured' };
    // slackNotify swallows its own exceptions, so a transport error arrives here as an error string
    // with no status. We cannot tell a refusal from a lost answer, so we do not pretend to.
    const err = (out && out.error) || 'slack failed';
    const refused = /invalid_auth|channel_not_found|not_in_channel|is_archived|msg_too_long/.test(String(err));
    return refused ? { ok: false, error: err } : { ok: false, unknown: true, error: err };
}
