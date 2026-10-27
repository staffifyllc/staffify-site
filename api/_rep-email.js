// A caller emails a prospect from their OWN mailbox, from the call workspace, with their signature.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "milton needs to be able to send emails from here, they should be made with
// his signature", "his email signautre should be growth strategist", and "we should have some
// premade message templates 1) should be thanks for your time -> book a meeting".
//
// The mail goes out through the Gmail API as the rep's own Google Workspace mailbox, using the same
// OAuth client and sealed-token store the outreach worker uses (api/_outreach-gmail.js). So it sits
// in his Sent folder, replies land in his inbox, and Google signs it for his domain. The Hub never
// sends as anyone else: the mailbox comes from the signed-in rep, never from the browser.
//
// Pure apart from nothing: no Redis, no network. api/rep-email.js wires it to the world.
import { emailMismatch } from './_caller-plan.js';
import { bookingLinkFor } from './_call-scripts.js';

const SITE = 'https://www.gostaffify.com';
const IMG = SITE + '/assets/email';
const CYAN = 'rgb(0, 178, 226)';

// Who may send, from which mailbox, signed how. EXPLICIT on purpose, like _login-aliases.js: a rep
// with no entry here has no sending mailbox, and the Hub says so instead of guessing one. The phone
// line is not written here: it is read from the rep's Quo seat at send time (lineFor below), so the
// number in the signature is the one that actually rings him.
export const REP_MAILBOXES = Object.freeze({
    'milton@trystaffify.com': Object.freeze({
        name: 'Milton Hodgson Gaitan',          // as on his signed agreement (api/_caller-plan.js)
        first: 'Milton',
        title: 'Growth Strategist',             // Paul, 2026-10-27
    }),
});

/** The mailbox a signed-in rep sends from. The misspelt Hub record sends from the real address. */
export function mailboxFor(rep) {
    const email = String(rep && rep.email || '').trim().toLowerCase();
    if (!email || email === 'admin') return null;
    const fixed = emailMismatch(email);
    const box = fixed ? fixed.onContract : email;
    return REP_MAILBOXES[box] ? box : null;
}
export const profileFor = mailbox => REP_MAILBOXES[String(mailbox || '').toLowerCase()] || null;

// ---- the signature ---------------------------------------------------------------------------
// The same layout as the team's Gmail signatures (~/Desktop/Claude Code/staffify-signature,
// _src/build_sigs.py): name, title and wordmark, a cyan rule, the contact rows, then the banner.
// No photo column until there is a headshot to put in it. Every image is served from
// gostaffify.com rather than a vercel.app host, and carries explicit width and height because
// Outlook ignores CSS sizing.
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function contactRow(icon, text, href) {
    const inner = href
        ? `<a style="text-decoration:none;color:rgb(0,0,0);font-size:14px;" href="${esc(href)}" rel="noopener noreferrer" target="_blank"><span>${esc(text)}</span></a>`
        : `<span style="font-size:14px;color:rgb(0,0,0);">${esc(text)}</span>`;
    return `<tr style="vertical-align:middle;" height="25"><td style="vertical-align:middle;padding-right:8px;" width="24"><img style="display:block;border:0;" height="14" width="14" alt="" src="${IMG}/${icon}.png"></td><td style="padding:0px;">${inner}</td></tr>`;
}

export function signatureHtml(mailbox, { phone = null } = {}) {
    const p = profileFor(mailbox);
    if (!p) return '';
    const rows = (phone ? contactRow('phone', phone.display, 'tel:' + phone.e164) : '')
        + contactRow('mail', mailbox, 'mailto:' + mailbox)
        + contactRow('globe', 'gostaffify.com', SITE + '/');
    const social = (href, icon, alt) => `<td><a rel="noopener noreferrer" href="${href}" target="_blank"><img style="border:0;display:block;" height="22" width="22" alt="${alt}" src="${IMG}/${icon}.png"></a></td>`;
    const table = 'style="vertical-align:-webkit-baseline-middle;font-size:medium;font-family:Arial;" border="0" cellspacing="0" cellpadding="0"';
    return `<table ${table}><tbody><tr><td>`
        + `<table ${table}><tbody><tr>`
        + `<td style="vertical-align:middle;"><h2 style="margin:0px;font-size:18px;color:rgb(0,0,0);font-weight:600;"><span>${esc(p.name)}</span></h2>`
        + `<div style="color:rgb(0,0,0);font-size:14px;line-height:22px;"><span>${esc(p.title)}</span></div>`
        + `<table style="font-family:Arial;" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td height="10"></td></tr><tr><td style="padding:0px;"><a rel="noopener noreferrer" href="${SITE}/" target="_blank"><img style="display:block;border:0;" alt="Staffify" width="118" height="35" src="${IMG}/staffify-logo.png"></a></td></tr></tbody></table></td>`
        + `<td width="30"><div style="width:30px;"></div></td><td style="width:1px;border-bottom:none;border-left:1px solid ${CYAN};" width="1"></td><td width="30"><div style="width:30px;"></div></td>`
        + `<td style="vertical-align:middle;"><table ${table}><tbody>${rows}</tbody></table></td>`
        + `</tr></tbody></table></td></tr>`
        + `<tr><td><table style="width:100%;font-family:Arial;" border="0" cellspacing="0" cellpadding="0"><tbody><tr><td height="24"></td></tr><tr><td style="width:100%;border-bottom:1px solid ${CYAN};"></td></tr><tr><td height="24"></td></tr></tbody></table></td></tr>`
        + `<tr><td><table ${table} width="100%"><tbody><tr>`
        + `<td style="vertical-align:middle;"><a href="${SITE}/" rel="noopener noreferrer" target="_blank"><img style="display:inline-block;max-width:400px;border:0;" alt="Staffify" width="400" height="96" src="${IMG}/staffify-banner.png"></a></td>`
        + `<td style="vertical-align:middle;text-align:right;"><table style="display:inline-block;" align="right" border="0" cellspacing="0" cellpadding="0"><tbody><tr>`
        + social('https://www.linkedin.com/company/gostaffify/', 'linkedin', 'LinkedIn') + '<td width="10"></td>' + social('https://www.instagram.com/staffify/', 'instagram', 'Instagram')
        + `</tr></tbody></table></td></tr></tbody></table></td></tr>`
        + `</tbody></table>`;
}

/** The plain-text twin, for mail clients that do not show HTML. */
export function signatureText(mailbox, { phone = null } = {}) {
    const p = profileFor(mailbox);
    if (!p) return '';
    return [p.name, p.title + ', Staffify', phone ? phone.display : null, mailbox, 'gostaffify.com'].filter(Boolean).join('\n');
}

// ---- the rep's line, from Quo ----------------------------------------------------------------
const digits = s => String(s || '').replace(/\D/g, '');
export function formatUS(e164) {
    const d = digits(e164).replace(/^1(?=\d{10}$)/, '');
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null;
}
/**
 * The one Quo number assigned to this person, from GET /v1/phone-numbers. A number they share with
 * others is a team line, so a personal line wins; two personal lines, or none, is null. A wrong
 * number under someone's name is worse than no number.
 */
export function lineFor(numbers, emails) {
    const want = new Set((emails || []).map(e => String(e || '').trim().toLowerCase()).filter(Boolean));
    const mine = (numbers || []).filter(n => (n.users || []).some(u => want.has(String(u.email || '').toLowerCase())));
    const own = mine.filter(n => (n.users || []).length === 1);
    const pick = own.length === 1 ? own[0] : !own.length && mine.length === 1 ? mine[0] : null;
    const display = pick && formatUS(pick.number);
    return display ? { e164: '+1' + digits(pick.number).slice(-10), display } : null;
}

// ---- templates -------------------------------------------------------------------------------
// Filled in the browser so the rep reads and edits the real words before sending. {first} is the
// prospect's first name ("there" when unknown), {company} their business, {me} the rep's first
// name, {link} the booking link the rep is contracted to use (api/_call-scripts.js).
export const TEMPLATES = Object.freeze([
    Object.freeze({
        id: 'thanks-book',
        label: 'Thanks for your time, book a meeting',
        subject: 'Thanks for your time today',
        body: 'Hi {first},\n\nThanks for taking my call today. Here is the link to book a time with our team:\n\n{link}\n\nPick whatever works for you. We will walk through the recurring work at {company} you would like off your plate, and whether Staffify is a fit.\n\nTalk soon,\n{me}',
    }),
    Object.freeze({
        id: 'missed-book',
        label: 'Sorry I missed you, book a time',
        subject: 'Sorry I missed you',
        body: 'Hi {first},\n\nI tried calling today and missed you. I am with Staffify, and we have sent you a few notes about handing off recurring work at {company}.\n\nIf a short call makes sense, you can book a time here:\n\n{link}\n\nThanks,\n{me}',
    }),
]);
export const templatesFor = mailbox => TEMPLATES.map(t => ({ ...t, link: bookingLinkFor(mailbox) }));

export function fillTemplate(t, { first, company, me, link }) {
    const v = { first: first || 'there', company: company || 'your business', me: me || '', link: link || '' };
    const fill = s => String(s).replace(/\{(first|company|me|link)\}/g, (m, k) => v[k]);
    return { subject: fill(t.subject), body: fill(t.body) };
}

// ---- what may not go out -------------------------------------------------------------------
export const LIMITS = Object.freeze({ subject: 150, body: 5000, perDay: 30 });
/** A reason the message cannot be sent as written, or null. */
export function copyProblem({ subject, body }) {
    const s = String(subject || ''), b = String(body || '');
    if (!s.trim()) return 'Add a subject.';
    if (/[\r\n]/.test(s)) return 'The subject has to be one line.';
    if (s.length > LIMITS.subject) return `Keep the subject under ${LIMITS.subject} characters.`;
    if (!b.trim()) return 'Write the message first.';
    if (b.length > LIMITS.body) return `Keep the message under ${LIMITS.body} characters.`;
    const left = (s + '\n' + b).match(/\{[a-z ]+\}|\[\s*(?:first ?name|their name|name|company|link)\s*\]/i);
    if (left) return `Replace ${left[0]} with the real words before sending.`;
    // Paul's standing rule: Staffify never states how many clients it has, anywhere.
    if (/\b\d[\d,]*\+?\s+(?:happy\s+|active\s+|current\s+)?(?:clients|customers)\b/i.test(s + ' ' + b)) return 'Staffify never says how many clients it has. Take the number out.';
    return null;
}

// ---- the message -----------------------------------------------------------------------------
const b64 = s => Buffer.from(String(s), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
// RFC 2047 for anything outside plain ASCII, so a name or subject with an accent arrives intact.
export const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=');
const quoteName = n => (/^[\w .'-]*$/.test(n) ? `"${n}"` : encodeHeader(n));

/** The message body as HTML: the rep's text, escaped, with links made clickable, then the signature. */
export function bodyHtml(text, signature) {
    const paras = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => {
        const safe = esc(p).replace(/(https:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
        return `<p style="margin:0 0 14px;">${safe}</p>`;
    });
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;">${paras.join('')}</div>`
        + (signature ? `<br><div>${signature}</div>` : '');
}

/** multipart/alternative, base64 parts, CRLF line endings. Throws on a header that could inject. */
export function buildMime({ from, fromName, to, subject, text, html, boundary }) {
    for (const h of [from, fromName || '', to, subject]) if (/[\r\n]/.test(h)) throw Error('Invalid mail header');
    const b = boundary || 'sfy-' + Buffer.from(from + to + subject).toString('hex').slice(0, 24);
    return [
        'From: ' + (fromName ? quoteName(fromName) + ' <' + from + '>' : from),
        'To: ' + to,
        'Subject: ' + encodeHeader(subject),
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' + b + '"',
        '',
        '--' + b,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(text),
        '--' + b,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(html),
        '--' + b + '--',
        '',
    ].join('\r\n');
}
export const rawOf = mime => Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
