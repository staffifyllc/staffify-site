// POST /api/auth-request  { email }
// Emails a one-time sign-in link if that email belongs to a rep.
// Always returns ok so the endpoint cannot be used to enumerate accounts.

import { getRep, createMagicLink, sendMail, readBody, normEmail } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const email = normEmail(readBody(req).email);
    res.setHeader('Cache-Control', 'no-store');

    if (email) {
        try {
            const rep = await getRep(email);
            if (rep) {
                const link = await createMagicLink(email);
                const html = `<!doctype html><html><body style="margin:0;background:#050507;font-family:Inter,-apple-system,sans-serif;color:#fff;padding:32px">
<div style="max-width:480px;margin:0 auto;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.09);border-radius:16px;padding:32px">
<div style="font-size:22px;font-weight:900;letter-spacing:-0.02em;margin-bottom:10px">Sign in to the Staffify sales hub</div>
<p style="color:#9ba1ab;font-size:15px;line-height:1.55;margin:0 0 24px">Hey ${rep.name || ''}, click below to sign in. This link works once and expires in 20 minutes.</p>
<a href="${link}" style="display:inline-block;background:#1abde1;color:#04222b;font-weight:800;font-size:15px;padding:14px 28px;border-radius:999px;text-decoration:none">Sign in &rarr;</a>
<p style="color:#6f7680;font-size:12.5px;line-height:1.5;margin:24px 0 0">If you did not request this, ignore it. Nobody can sign in without this link.</p>
</div></body></html>`;
                await sendMail({
                    to: email,
                    subject: 'Your Staffify sales hub sign-in link',
                    html,
                    text: `Sign in to the Staffify sales hub: ${link}\n\nThis link works once and expires in 20 minutes.`,
                });
            }
        } catch (e) {
            // The response stays {ok:true} so this endpoint can never be used to work out which
            // addresses have accounts. But swallowing the reason entirely made a broken mail key look
            // exactly like a delivered email, with nothing anywhere to say otherwise, so the reason is
            // logged server-side where only we can see it. /api/auth-diag reports it on demand.
            console.error('[auth-request] failed to send sign-in link:', (e && e.message) || e);
        }
    }

    return res.status(200).json({ ok: true });
}
