// Who is this number? For a phone number the Hub has no prospect for.
// ------------------------------------------------------------------
// Paul, 2026-10-27, searching (404) 550-5181: "search bars not working, who is this person??"
//
// The search was right that no prospect carries that number. Nick at Realkit had called Milton back
// from his own phone, 35 minutes after Milton left a message on Realkit's business line, and an
// incoming caller's number is never written onto a prospect. So for a number with no card, this
// looks where the number does exist (Quo's calls on every line, HubSpot) and then says which
// prospect it most likely belongs to, with the reason, and labelled as a likely match, never a fact.
//
// Pure: no network, no Redis. api/number-lookup.js does the reading.
const OUTREACH_OUTCOMES = new Set(['voicemail', 'callback', 'no_answer', 'connected', 'timing']);
export const ten = s => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
export const areaOf = s => { const d = ten(s); return d.length === 10 ? d.slice(0, 3) : null; };
export const fmtPhone = s => { const d = ten(s); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null; };
const ms = s => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : null; };
// Every number known for a card, including the one each logged call actually dialled.
const phonesOf = r => [r && r.callContact && r.callContact.phone, r && r.phone, r && r.crmPhone, ...((r && r.callHistory) || []).map(h => h && h.dialled)].filter(Boolean);

/** Prospects whose card or notes already carry this number. Certain, not likely. */
export function recordsWithNumber(records, number) {
    const want = ten(number);
    if (want.length !== 10) return [];
    return (records || []).filter(r => phonesOf(r).some(p => ten(p) === want)
        || (r.callHistory || []).some(h => String(h.notes || '').replace(/\D/g, '').includes(want)));
}

/**
 * The prospects this number most likely belongs to, for a call at `at`.
 *
 * A person who calls back from their own phone almost always does it after somebody from the Hub
 * left a message or spoke to their business, and usually from the same area. So: cards a caller
 * logged an outreach outcome on in the `windowHours` before the call, whose business number shares
 * the area code, closest first. Without an area-code match the list is empty: a time match alone is
 * too weak to name anyone.
 */
export function likelyRecords(records, { number, at }, { windowHours = 72, limit = 3 } = {}) {
    const area = areaOf(number), when = ms(at);
    if (!area || when === null) return [];
    const out = [];
    for (const r of records || []) {
        if (!phonesOf(r).some(p => areaOf(p) === area)) continue;
        const before = (r.callHistory || []).filter(h => OUTREACH_OUTCOMES.has(h.outcome) && ms(h.at) !== null && ms(h.at) <= when + 5 * 60000 && when - ms(h.at) <= windowHours * 3600000);
        const last = before.sort((a, b) => ms(b.at) - ms(a.at))[0];
        if (!last) continue;
        const businessLine = phonesOf(r).find(p => areaOf(p) === area);
        out.push({
            recordId: r.id, company: r.company || r.recipient, recipient: r.recipient || null,
            minutesBefore: Math.max(0, Math.round((when - ms(last.at)) / 60000)),
            outcome: last.outcome, caller: last.caller || null, note: String(last.notes || '').slice(0, 160) || null,
            businessLineEnds: ten(businessLine).slice(-4),
        });
    }
    return out.sort((a, b) => a.minutesBefore - b.minutesBefore).slice(0, limit);
}

/** One plain sentence for the reason, for the screen. */
export function likelyReason(l, { area }) {
    const what = { voicemail: 'left a voicemail', callback: 'logged a callback', no_answer: 'called with no answer', connected: 'spoke with them', timing: 'logged "not now"' }[l.outcome] || 'called';
    const ago = l.minutesBefore < 60 ? `${l.minutesBefore} minutes` : l.minutesBefore < 48 * 60 ? `${Math.round(l.minutesBefore / 60)} hours` : `${Math.round(l.minutesBefore / 1440)} days`;
    return `${l.callerName || 'Someone'} ${what} on their business line (ending ${l.businessLineEnds}) ${ago} before this call, same ${area} area code.`;
}
