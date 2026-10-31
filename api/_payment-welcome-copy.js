// The approved payment welcome email, verbatim. Do not edit the copy here.
// ------------------------------------------------------------------
// Source: the Mac's staffify-welcome-strategy-call.html, approved by Paul on 2026-08-05 and sent by
// the desktop job staffify-payment-welcome. TEMPLATE is that file byte for byte (11006 bytes, sha256
// below); tests/payment-welcome.test.mjs fails if a single byte changes. A copy change is Paul's call
// and lands in this file and in TEMPLATE_SHA256 together.
//
// Sender, subject, Reply-To and the HubSpot BCC are the desktop script's constants, unchanged.
import { tagHtml, leadId } from './_staffify-utm.js';
// api/_staffify-utm.js is shared with the pre-call port byte for byte, so this helper lives here.

/** Every href in an HTML string, entity-decoded, in order. */
export const hrefs = html => [...String(html).matchAll(/href="([^"]*)"/g)].map(m => m[1].replace(/&amp;/g, '&'));

export const KIND = 'welcome-strategy-call';
export const FROM = 'Staffify <staffing@gostaffify.com>';
export const REPLY_TO = 'hello@gostaffify.com'; // paul@ is not a real mailbox: replies to it bounce (confirmed 2026-08-31)
export const HUBSPOT_BCC = '51666712@bcc.hubspot.com';
export const SUBJECT = "You're in. Book your strategy call.";
export const UTM = { campaign: 'welcome', content: 'strategy-call' };
export const TEMPLATE_SHA256 = '448f4185f051ac70f97c2819f92e2e7986d1805436b9c2088b4ed29c3a99907e';

export const TEMPLATE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Staffify</title></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:32px 0;">
    <tr><td align="center">

      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#000000;">

        <!-- Logo + accent bar -->
        <tr><td style="padding:0 28px 8px 28px;">
          <img src="https://recruiting.gostaffify.com/staffify-logo.png" alt="Staffify" width="120" height="36" style="display:block;border:0;outline:none;text-decoration:none;height:36px;width:120px;">
        </td></tr>
        <tr><td style="padding:0 28px 24px 28px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="80"><tr><td style="height:3px;background:#1ABDE1;border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>
        </td></tr>

        <!-- Hero -->
        <tr><td style="padding:0 28px;">
          <p style="margin:0 0 6px 0;font:400 14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#94A3B8;">
            Hey {{firstName}},
          </p>
          <p style="margin:0 0 16px 0;font:800 34px/1.1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;letter-spacing:-0.5px;">
            You're in.<br>
            <span style="color:#1ABDE1;">Here's what happens next.</span>
          </p>
          <p style="margin:0 0 28px 0;font:400 15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#94A3B8;">
            Welcome to Staffify. Payment received, you're official. The next step is the most important one in the whole process: your strategy call. This is where we map your role, your standards, and exactly who we go recruit for you.
          </p>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 28px;">
          <hr style="border:none;border-top:1px solid #1E293B;margin:0 0 28px 0;">
        </td></tr>

        <!-- Step 1: Book the call -->
        <tr><td style="padding:0 28px 28px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#0C1929;border:1px solid #1ABDE1;border-radius:16px;padding:28px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr>
              <td style="padding-right:10px;" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:28px;height:28px;border-radius:8px;background:#1ABDE1;text-align:center;line-height:28px;font:700 13px/28px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#000000;">1</td></tr></table></td>
              <td valign="middle"><p style="margin:0;font:700 11px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1ABDE1;text-transform:uppercase;letter-spacing:2px;">Book your strategy call</p></td>
            </tr></table>
            <p style="margin:0 0 6px 0;font:600 16px/1.35 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Block 2 hours. It's worth it.</p>
            <p style="margin:0 0 18px 0;font:400 14px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#CBD5E1;">This is a working session, not a meet and greet. We go deep on your business, the role you're filling, and the exact profile of the person who fits it. Everything we recruit against comes out of this call.</p>
            <table role="presentation" cellpadding="0" cellspacing="0"><tr>
              <td style="background:#1ABDE1;border-radius:10px;">
                <a href="https://calendly.com/d/cmsz-6bs-58k/business-strategy-call" style="display:inline-block;padding:14px 28px;font:700 15px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#000000;text-decoration:none;">Pick your time &rarr;</a>
              </td>
            </tr></table>
            <p style="margin:12px 0 0 0;font:400 12px/1.4 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">Grab the earliest slot that works. Your recruitment campaign starts the moment this call ends.</p>
          </td></tr></table>
        </td></tr>

        <!-- Step 2: Homework -->
        <tr><td style="padding:0 28px 28px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#0C1929;border:1px solid #1E293B;border-radius:16px;padding:28px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:14px;"><tr>
              <td style="padding-right:10px;" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="width:28px;height:28px;border-radius:8px;background:#1ABDE1;text-align:center;line-height:28px;font:700 13px/28px -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#000000;">2</td></tr></table></td>
              <td valign="middle"><p style="margin:0;font:700 11px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1ABDE1;text-transform:uppercase;letter-spacing:2px;">Bring a job description</p></td>
            </tr></table>
            <p style="margin:0 0 16px 0;font:400 14px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#CBD5E1;">Before the call, start sketching the role. It doesn't need to be polished, we'll sharpen it together on the call. A rough list beats a blank page. Think through:</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="padding:0 0 12px 0;">
                <p style="margin:0 0 2px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">The tasks you want off your plate</p>
                <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">Be specific. "Answer client emails within 2 hours" beats "help with communication."</p>
              </td></tr>
              <tr><td style="padding:0 0 12px 0;">
                <p style="margin:0 0 2px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">The tools they'll live in</p>
                <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">Your CRM, inbox, scheduling software, editing suite, whatever the role touches daily.</p>
              </td></tr>
              <tr><td style="padding:0 0 12px 0;">
                <p style="margin:0 0 2px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">What a great week looks like</p>
                <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">If this hire is crushing it 90 days in, what's getting done that isn't today?</p>
              </td></tr>
              <tr><td>
                <p style="margin:0 0 2px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Hours and overlap</p>
                <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">How many hours a week, and how much of it needs to overlap with your day.</p>
              </td></tr>
            </table>
          </td></tr></table>
        </td></tr>

        <!-- What happens after -->
        <tr><td style="padding:0 28px 28px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0C1929;border:1px solid #1E293B;border-radius:12px;overflow:hidden;">
            <tr><td style="padding:20px 20px;border-bottom:1px solid #1E293B;">
              <p style="margin:0 0 4px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">After the call, we launch your recruitment campaign</p>
              <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">A targeted campaign built around your role, not a scroll through a bench of resumes.</p>
            </td></tr>
            <tr><td style="padding:20px 20px;border-bottom:1px solid #1E293B;">
              <p style="margin:0 0 4px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Every candidate clears our 4-gate vetting</p>
              <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">AI English screening, a paid test project on real work, recruiter review, and client-fit matching.</p>
            </td></tr>
            <tr><td style="padding:20px 20px;">
              <p style="margin:0 0 4px 0;font:600 14px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">You get a shortlist in your talent console</p>
              <p style="margin:0;font:400 12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">A curated few, not a hundred resumes. You pick, we onboard, and your hire is covered by our free lifetime replacement guarantee.</p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Sign off -->
        <tr><td style="padding:0 28px 32px 28px;">
          <p style="margin:0 0 16px 0;font:400 14px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#94A3B8;">
            Go grab your slot and start jotting down that role. See you on the call.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding-right:14px;" valign="middle">
                <img src="https://www.gostaffify.com/assets/paul-headshot.jpg" alt="Paul Chareth" width="48" height="48" style="display:block;border:0;border-radius:50%;width:48px;height:48px;object-fit:cover;">
              </td>
              <td valign="middle">
                <p style="margin:0;font:600 14px/1.2 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;">Paul Chareth</p>
                <p style="margin:2px 0 0 0;font:400 12px/1.3 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#64748B;">Director of Growth, Staffify</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:0 28px 16px 28px;">
          <hr style="border:none;border-top:1px solid #1E293B;margin:0 0 16px 0;">
          <p style="margin:0;font:400 11px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#334155;">
            Staffify &middot; staffing@gostaffify.com<br>
            You're receiving this because you joined Staffify.<br>
            <a href="mailto:staffing@gostaffify.com?subject=Unsubscribe&amp;body=Please%20remove%20me%20from%20future%20emails." style="color:#475569;text-decoration:underline;">Unsubscribe</a>
          </p>
        </td></tr>

      </table>

    </td></tr>
  </table>

</body></html>
`;

// The Mac used String.replace with the raw name, so a name holding & or < broke the markup and a name
// holding $& inserted the match. The copy is untouched; only the name is escaped.
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The exact email the desktop job sent. lid is null when the salt is missing, and the caller decides. */
export function welcomeEmail({ to, firstName, salt }) {
    const lid = leadId(to, salt);
    const html = tagHtml(TEMPLATE.replace(/\{\{firstName\}\}/g, () => esc(firstName)), { ...UTM, lid });
    return {
        lid, html, links: hrefs(html),
        payload: { from: FROM, to: [to], reply_to: REPLY_TO, bcc: [HUBSPOT_BCC], subject: SUBJECT, html },
    };
}
