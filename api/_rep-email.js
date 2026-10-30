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
import { bookingLinkFor, spokenRole, pluralRole } from './_call-scripts.js';

const SITE = 'https://www.gostaffify.com';
const IMG = SITE + '/assets/email';
const CYAN = 'rgb(0, 178, 226)';

// Who may send, from which mailbox, signed how. EXPLICIT on purpose, like _login-aliases.js: a rep
// with no entry here has no sending mailbox, and the Hub says so instead of guessing one. A caller's
// phone line is not written here: it is read from their Quo seat at send time (lineFor below), so
// the number in the signature is the one that actually rings them. An entry with its own `phone`
// (Paul's, from his existing signature) uses that instead.
export const REP_MAILBOXES = Object.freeze({
    'milton@trystaffify.com': Object.freeze({
        // Paul, 2026-10-27: "can you go and remove his second last name". Milton Hodgson, as on his
        // Slack profile; the agreement's Milton Hodgson Gaitan stays the legal name in _caller-plan.js.
        name: 'Milton Hodgson',
        first: 'Milton',
        title: 'Growth Strategist',             // Paul, 2026-10-27
    }),
    // Paul opened the composer as himself on 2026-10-27 and got "No sending mailbox is set up for
    // you yet." His Hub login is hello@gostaffify.com, a real mailbox and the address on his own
    // signature, so that is the one he sends from. Name, title and phone are copied from that
    // signature (~/Desktop/Claude Code/staffify-signature/_src/build_sigs.py, PEOPLE.paul).
    // Paul, 2026-10-28: "each rep should have their own inbox". From her own signature (staffify-signature/_src/build_sigs.py).
    'madison@gostaffify.com': Object.freeze({
        name: 'Madison Sterling',
        first: 'Madison',
        title: 'Growth Strategist',
        phone: Object.freeze({ e164: '+15616179973', display: '(561) 617-9973' }),
    }),
    'hello@gostaffify.com': Object.freeze({
        name: 'Paul Chareth',
        first: 'Paul',
        title: 'Founder',
        phone: Object.freeze({ e164: '+13056369210', display: '(305) 636-9210' }),
    }),
    // Their Staffify sending mailboxes (see SEND_AS below): same people, same signatures.
    'madison@trystaffify.com': Object.freeze({
        name: 'Madison Sterling',
        first: 'Madison',
        title: 'Growth Strategist',
        phone: Object.freeze({ e164: '+15616179973', display: '(561) 617-9973' }),
    }),
    // Paul, 2026-10-29: "I don't have that email anymore, that email is milton@trystaffify.com". His sending mailbox is
    // paul@staffifyhq.com, one of his Staffify sending mailboxes on the same Workspace.
    'paul@staffifyhq.com': Object.freeze({
        name: 'Paul Chareth',
        first: 'Paul',
        title: 'Founder',
        phone: Object.freeze({ e164: '+13056369210', display: '(305) 636-9210' }),
    }),
});

// Google refuses gostaffify.com accounts for the Hub's Gmail app: it is Internal to the Workspace that holds the
// trystaffify.com and staffifyhq.com mailboxes (checked 2026-10-28: hello@gostaffify.com got "Access blocked ... can
// only be used within its organization", org_internal). Paul: "make sure that all of the sales reps are able to send
// emails out". So a gostaffify.com login sends from that rep's own Staffify sending mailbox, the way Milton does, and
// every send still goes to hello@ (routeCopy). REP_SEND_AS (JSON) overrides it; {} sends from the login's own address.
const sendAs = () => { try { const v = JSON.parse(process.env.REP_SEND_AS || 'null'); if (v && typeof v === 'object') return v; } catch {} return { 'madison@gostaffify.com': 'madison@trystaffify.com', 'hello@gostaffify.com': 'paul@staffifyhq.com' }; };
export const SEND_AS = Object.freeze(Object.fromEntries(Object.entries(sendAs()).map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()])));

/** The mailbox a signed-in rep sends from. The misspelt Hub record sends from the real address. */
export function mailboxFor(rep) {
    const email = String(rep && rep.email || '').trim().toLowerCase();
    if (!email || email === 'admin') return null;
    const fixed = emailMismatch(email);
    const own = fixed ? fixed.onContract : email;
    const box = SEND_AS[own] || own;
    return REP_MAILBOXES[box] ? box : null;
}
export const profileFor = mailbox => REP_MAILBOXES[String(mailbox || '').toLowerCase()] || null;

// Paul, 2026-10-28: "each rep should have their own inbox BUT it needs to route to hello@gostaffify.com". A rep's email
// goes out from their own mailbox with hello@ as a blind copy, and replies go to the rep and to hello@ together, so the
// company inbox holds every conversation and the rep keeps their own thread. Paul's own mailbox is hello@ already.
export const ROUTE_TO = String(process.env.REP_EMAIL_ROUTE_TO || 'hello@gostaffify.com').trim().toLowerCase();
export function routeCopy(box, name) {
    const from = String(box || '').toLowerCase();
    if (!ROUTE_TO || !from || from === ROUTE_TO) return {};
    return { bcc: ROUTE_TO, replyTo: [(name ? quoteName(name) + ' <' + from + '>' : from), ROUTE_TO].join(', ') };
}
// The other reps' own mailboxes: a copy one of them routes into hello@ is the team's mail, not a stranger's.
export const TEAM_MAILBOXES = Object.freeze(Object.keys(REP_MAILBOXES).filter(b => b !== ROUTE_TO));

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

export function signatureHtml(mailbox, { phone = null, photo: photoUrl = null } = {}) {
    const p = profileFor(mailbox);
    if (!p) return '';
    // A headshot, once there is one: uploaded in the composer (photoUrl, served from gostaffify.com) or
    // set on the profile. Same column as the team's signatures.
    const src = photoUrl || p.photo || null;
    const photo = src ? `<td style="vertical-align:middle;" width="150"><span style="margin-right:20px;display:block;"><img style="max-width:130px;border-radius:50%;" width="130" height="130" alt="${esc(p.name)}" src="${esc(src)}"></span></td>` : '';
    const rows = (phone ? contactRow('phone', phone.display, 'tel:' + phone.e164) : '')
        + contactRow('mail', mailbox, 'mailto:' + mailbox)
        + contactRow('globe', 'gostaffify.com', SITE + '/');
    const social = (href, icon, alt) => `<td><a rel="noopener noreferrer" href="${href}" target="_blank"><img style="border:0;display:block;" height="22" width="22" alt="${alt}" src="${IMG}/${icon}.png"></a></td>`;
    const table = 'style="vertical-align:-webkit-baseline-middle;font-size:medium;font-family:Arial;" border="0" cellspacing="0" cellpadding="0"';
    return `<table ${table}><tbody><tr><td>`
        + `<table ${table}><tbody><tr>` + photo
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

// ---- another address at the same company ------------------------------------------------------
// Milton, 2026-10-27: "We also needs to be able to edit email addresses because the one that you
// texted is not the right email I got a different one from the GK which is: deana@mckinstry.com".
// A card may be sent to another address only at that company: its email's domain, or its website's.
// A free mailbox domain proves nothing about a company, so it never counts as the company's.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'att.net', 'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com']);
const hostOf = u => { try { return new URL(/^https?:/i.test(String(u)) ? String(u) : 'https://' + u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
/** The domains another address for this card may use. */
export function companyDomains(row) {
    const out = new Set();
    const d = String(row && row.recipient || '').toLowerCase().split('@')[1];
    if (d && !FREE_MAIL.has(d)) out.add(d);
    const w = hostOf(row && (row.website || (row.source && row.source.url)) || '');
    if (w && !FREE_MAIL.has(w)) out.add(w);
    return [...out];
}
/** Why `to` cannot be used for this card, or null. The card's own address is always fine. */
export function otherAddressProblem(row, to) {
    const card = String(row && row.recipient || '').toLowerCase();
    const t = String(to || '').trim().toLowerCase();
    if (!t || t === card) return null;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(t)) return 'That is not an email address.';
    const doms = companyDomains(row), d = t.split('@')[1];
    if (!doms.length) return 'This card has no company domain to check a new address against, so only its own address can be used.';
    if (!doms.some(x => d === x || d.endsWith('.' + x))) return `Use an address at ${doms.join(' or ')}. An address at another company cannot be sent from this card.`;
    return null;
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
        subject: '{first}, thanks for your time today',
        subjectNoName: 'Thanks for your time today',
        body: 'Hi {first},\n\nThanks for taking my call today. Here is the link to book a time with our team:\n\n{link}\n\nPick whatever works for you. We will walk through the recurring work at {company} you would like off your plate, and whether Staffify is a fit.\n\nTalk soon,\n{me}',
    }),
    Object.freeze({
        id: 'missed-book',
        label: 'Sorry I missed you, book a time',
        subject: 'Sorry I missed you, {first}',
        subjectNoName: 'Sorry I missed you',
        body: 'Hi {first},\n\nI tried calling today and missed you. I am with Staffify, and we have sent you a few notes about handing off recurring work at {company}.\n\nIf a short call makes sense, you can book a time here:\n\n{link}\n\nThanks,\n{me}',
    }),
    // Paul, 2026-10-28: "a few hot buttons that allows them to send follow-ups that we would typically send". The two a
    // call most often ends on after these: "send me some information" and a second touch when nothing came back.
    Object.freeze({
        id: 'info-requested',
        label: 'The info you asked for',
        subject: '{first}, the info you asked for',
        subjectNoName: 'The info you asked for',
        body: 'Hi {first},\n\nAs promised, here is a quick look at Staffify.\n\nWe help businesses hire dedicated team members from Latin America and the Philippines. We handle the recruiting, vetting, and ongoing management, and every placement comes with our lifetime replacement guarantee.\n\nYou can see how it works at https://www.gostaffify.com/. If you would like to talk it through, you can book a time with our team here:\n\n{link}\n\nThanks,\n{me}',
    }),
    Object.freeze({
        id: 'follow-up',
        label: 'Following up',
        subject: 'Following up, {first}',
        subjectNoName: 'Following up',
        body: 'Hi {first},\n\nFollowing up on my call. If handing off some of the recurring work at {company} is still on your mind, we would be glad to walk you through how it works.\n\nYou can grab a time here:\n\n{link}\n\nThanks,\n{me}',
    }),
]);
// Hiring now is call first: nothing was emailed before the call, so these never say it was. Paul, 2026-10-28: "make sure
// that button signifies the rep sending over an email summarizing us and sharing what we do too ... it's not leaving a
// trail of breadcrumbs". {role} is the job they posted, as a person says it; {roles} the people we place for it.
export const HIRING_TEMPLATES = Object.freeze([
    Object.freeze({
        id: 'hiring-stay-in-touch',
        label: 'Filled the role: stay in touch',
        subject: '{first}, good speaking with you',
        subjectNoName: 'Good speaking with you',
        body: 'Hi {first},\n\nThanks for taking my call today, and congratulations on filling the {role} role.\n\nAs promised, here is a quick summary of who we are. Staffify helps companies hire dedicated {roles} from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. Our team members typically cost 50% of what the advertised position pays.\n\nIf the new hire does not work out, or another seat opens up, I would be glad to put a few vetted candidates in front of you. I will check back in about a month, and you can always book a time with our team here:\n\n{link}\n\nTalk soon,\n{me}',
    }),
    Object.freeze({
        id: 'hiring-thanks',
        label: 'Thanks for your time, book a call',
        subject: '{first}, thanks for your time today',
        subjectNoName: 'Thanks for your time today',
        body: 'Hi {first},\n\nThanks for taking my call today about the {role} role at {company}.\n\nAs a quick summary, Staffify helps companies hire dedicated {roles} from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. Here is the link to book a time with our team, so we can learn more about the role and put a few great candidates in front of you:\n\n{link}\n\nTalk soon,\n{me}',
    }),
    Object.freeze({
        id: 'hiring-missed',
        label: 'Sorry I missed you',
        subject: 'Sorry I missed you, {first}',
        subjectNoName: 'Sorry I missed you',
        body: 'Hi {first},\n\nI just tried calling about the {role} role you posted.\n\nStaffify helps companies hire dedicated {roles} from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. If it would help to see a few vetted candidates, you can book a time with our team here:\n\n{link}\n\nThanks,\n{me}',
    }),
    Object.freeze({
        id: 'hiring-info',
        label: 'The info you asked for',
        subject: '{first}, the info you asked for',
        subjectNoName: 'The info you asked for',
        body: 'Hi {first},\n\nAs promised, here is a quick look at Staffify.\n\nWe help companies hire dedicated {roles} from Latin America and the Philippines. We handle the recruiting, vetting, and ongoing management, and every placement comes with our lifetime replacement guarantee.\n\nYou can see how it works at https://www.gostaffify.com/. If it makes sense to talk about the {role} role, you can book a time with our team here:\n\n{link}\n\nThanks,\n{me}',
    }),
    Object.freeze({
        id: 'hiring-follow-up',
        label: 'Following up',
        subject: 'Following up, {first}',
        subjectNoName: 'Following up',
        body: 'Hi {first},\n\nFollowing up on my call about the {role} role at {company}.\n\nIf you are still looking, we can put a few vetted {roles} in front of you, and we handle the recruiting and management from there. Worth a quick call?\n\n{link}\n\nThanks,\n{me}',
    }),
]);
/** The templates for this prospect: the email campaigns' pair, or for a Hiring now card the call-first set with its role in. */
export function templatesFor(mailbox, row = null) {
    const link = bookingLinkFor(mailbox);
    if (!row || row.kind !== 'hiring') return TEMPLATES.map(t => ({ ...t, link }));
    const role = spokenRole(row.hiring && row.hiring.title) || 'open';
    const put = x => String(x).replace(/\{role\}/g, role).replace(/\{roles\}/g, role === 'open' ? 'team members' : pluralRole(role));
    return HIRING_TEMPLATES.map(t => ({ ...t, subject: put(t.subject), subjectNoName: put(t.subjectNoName), body: put(t.body), link }));
}

export function fillTemplate(t, { first, company, me, link }) {
    const v = { first: first || 'there', company: company || 'your business', me: me || '', link: link || '' };
    const fill = s => String(s).replace(/\{(first|company|me|link)\}/g, (m, k) => v[k]);
    return { subject: fill(first ? t.subject : (t.subjectNoName || t.subject)), body: fill(t.body) };
}

// ---- their first name in the subject ------------------------------------------------------
// Paul, 2026-10-27: "the subject line should have their first name for any emails Milton sends".
// The cleanup adds it when it is missing; the send refuses a subject without it. Only a name we
// actually have is used, never a guess: with no name known the subject goes as written.
export const cleanFirst = s => { const t = String(s || '').trim().split(/\s+/)[0] || ''; return /^[\p{L}][\p{L}'.-]{0,30}$/u.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : ''; };
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const subjectHasName = (subject, first) => !first || new RegExp('(^|[^\\p{L}])' + escRe(first) + '($|[^\\p{L}])', 'iu').test(String(subject || ''));
const STARTERS = /^(thanks|thank|sorry|quick|following|great|good|just|here|your|our|the|a|an|one|checking|nice|hello|hi|re|about|following|catching|today|tomorrow)\b/i;
/** "Thanks for your time today" -> "Nick, thanks for your time today". Unchanged if the name is there. */
export function withFirstName(subject, first) {
    const s = String(subject || '').trim();
    if (!first || !s || subjectHasName(s, first)) return s;
    return first + ', ' + (STARTERS.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
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
export function bodyHtml(text, signature, footer = null) {
    const paras = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => {
        const safe = esc(p).replace(/(https:\/\/[^\s<]+[^\s<.,;:!?)'"])/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>');
        return `<p style="margin:0 0 14px;">${safe}</p>`;
    });
    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;">${paras.join('')}</div>`
        + (signature ? `<br><div>${signature}</div>` : '')
        + (footer ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b6b6b;margin:18px 0 0;">${esc(footer)}</p>` : '');
}

/** multipart/alternative, base64 parts, CRLF line endings. Throws on a header that could inject. */
export function buildMime({ from, fromName, to, subject, text, html, boundary, inReplyTo = '', references = '', bcc = '', replyTo = '', unsubscribe = '' }) {
    for (const h of [from, fromName || '', to, subject, inReplyTo, references, bcc, replyTo, unsubscribe]) if (/[\r\n]/.test(h)) throw Error('Invalid mail header');
    const b = boundary || 'sfy-' + Buffer.from(from + to + subject).toString('hex').slice(0, 24);
    return [
        'From: ' + (fromName ? quoteName(fromName) + ' <' + from + '>' : from),
        'To: ' + to,
        ...(bcc ? ['Bcc: ' + bcc] : []),
        ...(replyTo ? ['Reply-To: ' + replyTo] : []),
        'Subject: ' + encodeHeader(subject),
        // A reply names the message it answers, so every mail client keeps it in the conversation.
        ...(inReplyTo ? ['In-Reply-To: ' + inReplyTo] : []),
        ...(references ? ['References: ' + references] : []),
        // The mail client's own Unsubscribe link (RFC 8058 one-click), to the same /kick-rocks/ address as the footer.
        ...(unsubscribe ? ['List-Unsubscribe: <' + unsubscribe + '>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click'] : []),
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
