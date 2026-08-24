// Why is a sign-in link not arriving?
//
// /api/auth-request deliberately returns {ok:true} no matter what, so the endpoint cannot be used to
// work out which addresses have accounts. The cost of that is a completely silent failure: a broken
// mail key looks exactly like a delivered email. This runs the same steps and reports which one broke.
//
// GET /api/auth-diag/?token=ADMIN_TOKEN&email=someone@gostaffify.com[&emailId=<resend id>]
//
// Admin token only, because "does this address have an account" is exactly the question the sign-in
// endpoint refuses to answer. Never returns the API key itself, only whether one is configured.

import { redis, getRep, normEmail, adminAuthorized } from './_auth.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

    const email = normEmail(req.query.email || '');
    const out = { checkedAt: new Date().toISOString(), email: email || '(none given)', steps: {} };

    // 1. Redis: magic links are stored there, so a dead store breaks sign-in even if mail works.
    try {
        const pong = await redis.set('auth:diag', String(Date.now()), { ex: 60 });
        out.steps.redis = { ok: true, detail: String(pong) };
    } catch (e) {
        out.steps.redis = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }

    // 2. Is this address actually a rep? A non-rep is silently ignored by design, which looks identical
    //    to a delivery failure from the sign-in page.
    if (email) {
        try {
            const rep = await getRep(email);
            out.steps.repRecord = rep
                ? { ok: true, name: rep.name, role: rep.role }
                : { ok: false, reason: 'no rep record for this address, so no link is ever sent' };
        } catch (e) {
            out.steps.repRecord = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        }
    }

    try {
        const emails = (await redis.smembers('reps')) || [];
        out.steps.repsOnFile = { ok: true, count: emails.length, emails };
    } catch (e) {
        out.steps.repsOnFile = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }

    // 3. Mail. The key is only ever reported as present or absent, never echoed.
    const key = process.env.RESEND_API_KEY || '';
    const from = process.env.FROM_EMAIL || 'Staffify <hello@gostaffify.com>';
    out.steps.mailConfig = { ok: !!key, keyConfigured: !!key, keyLength: key.length, from };

    // 4. The real send, which is the step that actually breaks in practice. Resend's own error text
    //    names the cause: a revoked key, an unverified sending domain, a rejected recipient.
    if (key && email) {
        try {
            const r = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from, to: [email],
                    subject: 'Staffify sign-in diagnostic',
                    text: 'This is a delivery test from /api/auth-diag. If you received it, mail is working and the problem is elsewhere.',
                }),
            });
            const body = await r.text().catch(() => '');
            out.steps.testSend = { ok: r.ok, status: r.status, detail: body.slice(0, 300) };
        } catch (e) {
            out.steps.testSend = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        }
    }

    // Resend accepting a message is not the same as the mailbox receiving it. This asks Resend what
    // actually happened to a given message: delivered, bounced, or marked as spam. Pass the id from a
    // previous testSend as ?emailId=... to look one up.
    const lookupId = (req.query.emailId || '').toString().trim();
    if (key && lookupId) {
        try {
            const r = await fetch(`https://api.resend.com/emails/${encodeURIComponent(lookupId)}`, {
                headers: { Authorization: `Bearer ${key}` },
            });
            const body = await r.json().catch(() => null);
            out.steps.deliveryStatus = r.ok
                ? { ok: true, last_event: body && body.last_event, to: body && body.to, subject: body && body.subject, created_at: body && body.created_at }
                : { ok: false, status: r.status, detail: JSON.stringify(body).slice(0, 250) };
        } catch (e) {
            out.steps.deliveryStatus = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
        }
    }

    const broke = Object.entries(out.steps).find(([, v]) => v && v.ok === false);
    out.verdict = broke ? `First failing step: ${broke[0]}` : 'Every step passed. Check the spam folder and the Resend dashboard for the delivery record.';
    return res.status(200).json(out);
}
