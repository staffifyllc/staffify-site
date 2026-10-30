// The way out, in Paul's words, on every email we send a prospect.
// ------------------------------------------------------------------
// Paul, 2026-10-30, after Joanna Johnson wrote "Your email is missing an unsubscribe option. Please remove me from your
// mailing and texting list": "we need a really nice way for folks to unsubscribe, maybe not a button but have them tell
// me to kick rocks, and make each different for the sequence".
//
// A reply that takes the offer, or asks plainly to be taken off, stops every channel: the email worker
// (api/_outreach-policy.js classify) for its own mailboxes, and the reps' inbox sweep (api/_rep-optout-sweep.js) for
// replies that reach a rep. Our own lines, quoted back under a reply, never count as their answer. A stop here is
// permanent and everywhere, so a warm reply ("don't call before 2", "take me off the cc", "leave me alone till Monday")
// must never read as one: those go to a person.

// Paul, 2026-10-30, a day later: "do no link, but just tell them to respond with like the kick rocks ... like 5 different
// versions ... So it's not the same thing every single time". The way out is a reply, never a link in the email.
// None of these uses a word the worker reads as a stop ("not interested", "stop", "remove", "unsubscribe"), so a quoted
// copy can never trip it, and each is stripped from a reply before it is read anyway (OURS below).
export const KICK_LINES = Object.freeze([
    "P.S. Not the right fit? Just reply \"kick rocks\" and I'll leave you alone.",
    "If this isn't for you, reply \"kick rocks\" and you won't hear from me again.",
    "Not for you? A quick \"kick rocks\" takes you off my list, no hard feelings.",
    "Remote help not your thing? Reply \"kick rocks\" and I'm gone.",
    "Wrong person or wrong time? Tell me to kick rocks and I'll take the hint.",
    "Rather not hear from me? Two words, \"kick rocks,\" and you're off my list.",
]);
const seedOf = email => [...String(email || '').trim().toLowerCase()].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
/**
 * The line for the nth email (from 0) one person gets. Each person starts somewhere different in the list and moves one
 * on with every email, so nobody reads the same line twice in a row and two owners on the same day rarely read the same one.
 */
export const kickLine = (email, n) => KICK_LINES[(seedOf(email) + Math.max(0, Number(n) || 0)) % KICK_LINES.length];
/** Where one person starts in KICK_LINES (kickLine(email, n) is KICK_LINES[(kickStart(email) + n) % length]). */
export const kickStart = email => seedOf(email) % KICK_LINES.length;

// Lines already sent, earlier versions: a reply can still quote them, so they stay in OURS.
export const SEQUENCE_LINES = Object.freeze([
    "P.S. Not the right fit? Just tell me to kick rocks and I'll leave you alone.",
    "If this isn't for you, reply \"kick rocks\" and you won't hear from me again.",
    "Still not for you? A quick \"kick rocks\" takes you off my list, no hard feelings.",
    "This is my last note. If you want off my list for good, just say \"kick rocks.\"",
]);
export const REP_LINES = Object.freeze([
    "Not a fit? Just tell me to kick rocks and I'll take you off my list.",
    "If I'm bugging you, reply \"kick rocks\" and you won't hear from me again.",
    "Had enough of me? A quick \"kick rocks\" does it, no hard feelings.",
    "Rather not hear from me? Tell me to kick rocks and I'll leave you alone.",
]);

// The older sign-offs that name a way out are here too: quoted under a reply they would read as a request to stop.
const OURS = [...KICK_LINES, ...SEQUENCE_LINES, ...REP_LINES, 'Not interested? Just tell me to kick rocks and I\'ll take you off my list.', 'Want me to stop reaching out? A quick "kick rocks" does it, no hard feelings.', "Not the right time? Tell me to kick rocks and I'll leave you alone.",
    "If you'd like me to kick rocks and leave you alone, just say so :)", "If you'd prefer no more emails, just let me know.", 'If you would prefer no more emails, just let me know.', "If you'd rather I not follow up, just let me know."];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each line as a pattern that survives a mail client's rewrapping and curly quotes: spaces match any whitespace, quotes
// and apostrophes match either kind. Line breaks elsewhere in their text are kept, so "no" at the end of one line and
// "Thanks" on the next never read as "no thanks".
const OURS_RE = OURS.map(line => new RegExp(escapeRe(line).replace(/\\?["']/g, m => (m.includes('"') ? '["“”]' : "['‘’]")).replace(/ +/g, '\\s+'), 'gi'));
// Our older one-click line and links, quoted back, never count either (the link carries their own address, which can hold
// a word like "stop").
const OUR_LINKS = [/One\s+click\s+works\s+too[.:]?/gi, /https?:\/\/(?:www\.)?gostaffify\.com\/(?:kick-rocks\/?|api\/unsubscribe\/?)\?\S*/gi];
// What a mail app adds under a message. A bare "STOP" sent from a phone is still a bare "STOP".
const FOOTERS = /^[ \t]*(?:sent from my [^\n]*|get outlook for [^\n]*|sent from (?:mail for windows|yahoo mail|outlook)[^\n]*|sent via [^\n]*)[ \t]*$/gim;
/** Their text with our own lines and links taken out, so a quoted copy of ours is never read as their answer. */
export function withoutOurLines(text) {
    let t = String(text || '');
    for (const re of [...OURS_RE, ...OUR_LINKS]) t = t.replace(re, ' ');
    return t;
}
const authored = text => withoutOurLines(text).replace(FOOTERS, ' ');

/**
 * "Kick rocks" on the first line they wrote (under a greeting at most) is the answer, whatever signature a mail app puts
 * under it, unless the rest takes it back: a "?", a "just kidding", or anything warm in the same paragraph ("Kick rocks!
 * \nJust kidding, call me Tuesday" goes to a person). A signature sits after a blank line.
 */
function firstLineKick(all) {
    const raw = all.split('\n').map(l => l.trim());
    let i = raw.findIndex(Boolean);
    if (i < 0) return false;
    if ((GREETING.test(raw[i]) || GREETING_I.test(raw[i])) && raw.slice(i + 1).some(Boolean)) i = raw.findIndex((l, j) => j > i && l);
    if (!FIRST_KICK.test(unquote(raw[i]))) return false;
    const rest = raw.slice(i + 1).join('\n');
    if (/\?/.test(rest) || JEST.test(rest)) return false;
    const end = raw.findIndex((l, j) => j > i && !l);
    const paragraph = raw.slice(i + 1, end < 0 ? raw.length : end).join(' ');
    return !WARM.test(paragraph);
}

// "Kick rocks" counts only as their whole answer: a short reply, no question, nothing warm or negated in it. "Ha, love the
// kick rocks line, call me Tuesday" and "you don't have to kick rocks, send pricing" go to a person.
// "Kick rocks." alone on the first line they wrote (under a greeting at most) is the answer, whatever signature a mail app
// puts under it; so is "Yes, kick rocks" to a line that asked "Not for you?".
// A greeting is "Hi Paul," / "Morning Paul," / a bare "Paul,". Their answer may be quoted back as we wrote it ("kick
// rocks", or with an iPhone's curly quotes) and may end ", thanks" or with an emoji.
const GREETING = /^(?:(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|morning|afternoon|evening)\b[\w .'-]{0,30}|[A-Z][a-z]{1,20}),?$/;
const GREETING_I = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|morning|afternoon|evening)\b[\w .'-]{0,30},?$/i;
// "Yes, kick rocks" answers a line that asked "Not for you?"; a "no" or "rather not" counts only with a stop after it
// ("No. Kick rocks"), never "No kick rocks needed" or "I'd rather not kick rocks".
const FIRST_KICK = /^(?:(?:(?:yes|yeah|yep|yup|ok|okay|sure|please)[\s,.!-]+)|(?:(?:no|nope|rather not)[,.!]+\s*))?(?:please\s+)?kick(?:ing)?\s+rocks(?:\s+please)?(?:,?\s*(?:thanks|thank you|thx|ty))?[\s.!]*$/i;
const JEST = /\b(?:kidding|jk|j\/k|joking|joke|lol|haha+|lmao)\b/i;
const unquote = l => l.replace(/^["“”'‘’]+|["“”'‘’]+(?=[\s.!,]*$)/g, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]+/gu, '').trim();
const WARM = /\b(?:yes|yeah|yep|sure|call|send|interested|open|pricing|price|rate|cost|when|schedule|meet|talk|love|great|before|don'?t|do not|not|no need|won'?t|never|have to|need to|want you to|needed)\b/i;
export function kicksRocks(text) {
    const all = authored(text);
    if (firstLineKick(all)) return true;
    const t = all.replace(/\s+/g, ' ').trim();
    if (!/\bkick(?:ing)? rocks\b/i.test(t) || /\?/.test(t) || WARM.test(t)) return false;
    return t.replace(/[^a-z' ]+/gi, ' ').trim().split(/\s+/).filter(Boolean).length <= 8;
}

// A plain ask to be taken off. Each names a list or "me/us" and hangs no time, condition or other channel on it.
const PLAIN = [
    /\bunsubscribe (?:me|us)\b/i,
    /\bunsubscribe (?:from )?(?:your|the|this|all|any)\b[^.!?\n]{0,30}?\b(?:list|lists|emails|texts|messages|calls)\b/i,
    /\bopt (?:me|us) out\b/i,
    /\bopt(?:-|\s)?out of (?:your|the|this|all|any)\b[^.!?\n]{0,30}?\b(?:list|lists|emails|texts|messages|calls)\b/i,
    /\bremove (?:me|us)\b(?=\s*(?:[.!]|$|please\b))/im,
    /\b(?:remove|take) (?:me|us|my (?:name|email|number)) (?:off|from) (?:of )?(?:your|the|this|all|any)\b[^.!?\n]{0,30}?\b(?:list|lists|emails|texts|messages|calls|database|system|contacts)\b/i,
    /\bremove (?:this|my|our) (?:address|email|name|number|info|details|contact)\b/i,
    /\b(?:stop|quit) (?:emailing|texting|calling|contacting|messaging|spamming|bothering|harassing) (?:me|us)\b/i,
    /\bno more (?:emails|texts|messages|calls)\b/i,
    /\bleave (?:me|us) alone\b(?!\s+(?:until|till|for (?:now|a bit|the day|today)|today|tonight|this|right now))/i,
    /\bdelete my (?:info|email|number|contact|details|data)\b/i,
];
// "Don't call me" is a stop only when nothing in the same sentence offers another way, a time, or a "back".
const DONT = /\b(?:do not|don['’]?t|dont|never) (?:ever )?(?:contact|email|call|text|message) (?:me|us)\b([^.!?\n]*)/i;
const DONT_BUT = /\b(?:back|prefer|instead|rather|only|but|before|after|until|till|between|during|tomorrow|today|this|next|for now|at)\b/i;
// "Not interested" is a no, unless it is "not yet", "right now, but", "check back", "maybe later".
const NOT_INT = /\bnot interested\b/i;
const NOT_INT_BUT = /\b(?:yet|but|check back|later|maybe|circle back|reach out again|follow up in|next (?:year|quarter|month)|in the (?:spring|summer|fall|winter|new year))\b/i;
// "kick rocks" is read by kicksRocks, which checks what follows it; a first line asked as a question is never a stop here.
const ALONE = /^(?:please )?(?:stop|stop all|unsubscribe|remove|remove me|end|quit|opt out)(?: please)?$/i;
/** True when a reply asks us to stop. The caller has already removed quoted history (replyText). */
export function asksToStop(text) {
    const t = authored(text);
    const first = (t.split('\n').map(l => l.replace(/[^a-z ]+/gi, ' ').replace(/\s+/g, ' ').trim()).find(Boolean)) || '';
    const rawFirst = (t.split('\n').map(l => l.trim()).find(Boolean)) || '';
    if (ALONE.test(first) && !/\?/.test(rawFirst)) return true;
    if (kicksRocks(t)) return true;
    const dont = t.match(DONT);
    if (dont && !DONT_BUT.test(dont[1])) return true;
    if (NOT_INT.test(t) && !NOT_INT_BUT.test(t)) return true;
    return PLAIN.some(re => re.test(t));
}
