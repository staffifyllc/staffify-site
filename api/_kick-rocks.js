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

/** One per touch of a four-email sequence, so no two emails in a row say it the same way. */
export const SEQUENCE_LINES = Object.freeze([
    "P.S. Not the right fit? Just tell me to kick rocks and I'll leave you alone.",
    "If this isn't for you, reply \"kick rocks\" and you won't hear from me again.",
    "Still not for you? A quick \"kick rocks\" takes you off my list, no hard feelings.",
    "This is my last note. If you want off my list for good, just say \"kick rocks.\"",
]);
export const sequenceLine = touch => SEQUENCE_LINES[Math.min(Math.max(Number(touch) || 1, 1), SEQUENCE_LINES.length) - 1];

/** Under a rep's signature in the Hub: a different one each time the same person hears from us. None of them uses a word
 * the worker reads as a stop ("not interested", "stop"), so a quoted copy can never trip it. */
export const REP_LINES = Object.freeze([
    "Not a fit? Just tell me to kick rocks and I'll take you off my list.",
    "If I'm bugging you, reply \"kick rocks\" and you won't hear from me again.",
    "Had enough of me? A quick \"kick rocks\" does it, no hard feelings.",
    "Rather not hear from me? Tell me to kick rocks and I'll leave you alone.",
]);
export const repLine = n => REP_LINES[((Number(n) || 0) % REP_LINES.length + REP_LINES.length) % REP_LINES.length];

// The older sign-offs that name a way out are here too: quoted under a reply they would read as a request to stop.
const OURS = [...SEQUENCE_LINES, ...REP_LINES, 'Not interested? Just tell me to kick rocks and I\'ll take you off my list.', 'Want me to stop reaching out? A quick "kick rocks" does it, no hard feelings.', "Not the right time? Tell me to kick rocks and I'll leave you alone.",
    "If you'd like me to kick rocks and leave you alone, just say so :)", "If you'd prefer no more emails, just let me know.", 'If you would prefer no more emails, just let me know.', "If you'd rather I not follow up, just let me know."];
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Each line as a pattern that survives a mail client's rewrapping and curly quotes: spaces match any whitespace, quotes
// and apostrophes match either kind. Line breaks elsewhere in their text are kept, so "no" at the end of one line and
// "Thanks" on the next never read as "no thanks".
const OURS_RE = OURS.map(line => new RegExp(escapeRe(line).replace(/\\?["']/g, m => (m.includes('"') ? '["“”]' : "['‘’]")).replace(/ +/g, '\\s+'), 'gi'));
// Our own one-click line and links, quoted back, never count either (the link carries their own address, which can hold
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

// "Kick rocks" counts only as their whole answer: a short reply, no question, nothing warm or negated in it. "Ha, love the
// kick rocks line, call me Tuesday" and "you don't have to kick rocks, send pricing" go to a person.
const WARM = /\b(?:yes|yeah|yep|sure|call|send|interested|open|pricing|price|rate|cost|when|schedule|meet|talk|love|great|before|don'?t|do not|not|no need|won'?t|never|have to|need to|want you to|needed)\b/i;
export function kicksRocks(text) {
    const t = authored(text).replace(/\s+/g, ' ').trim();
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
const ALONE = /^(?:please )?(?:stop|stop all|unsubscribe|remove|remove me|end|quit|opt out|kick rocks)(?: please)?$/i;
/** True when a reply asks us to stop. The caller has already removed quoted history (replyText). */
export function asksToStop(text) {
    const t = authored(text);
    const first = (t.split('\n').map(l => l.replace(/[^a-z ]+/gi, ' ').replace(/\s+/g, ' ').trim()).find(Boolean)) || '';
    if (ALONE.test(first)) return true;
    if (kicksRocks(t)) return true;
    const dont = t.match(DONT);
    if (dont && !DONT_BUT.test(dont[1])) return true;
    if (NOT_INT.test(t) && !NOT_INT_BUT.test(t)) return true;
    return PLAIN.some(re => re.test(t));
}
