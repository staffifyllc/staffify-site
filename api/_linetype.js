// Whether a number is safe to hand a rep.
//
// Line types across this business come from one shared cache that is roughly 40% wrong: on
// 2026-08-24, 120 of 300 numbers cached as "mobile" were re-checked against Twilio and were not
// mobile at all. Landlines and call-tracking lines. The cause was that two sources were allowed to
// declare a number mobile without ever asking a carrier, Findymail's own line_type field and
// HubSpot's phone_type property, and once either wrote into the cache the wrong answer was served
// free to every surface forever.
//
// So a phoneType stamp on its own proves nothing. What proves something is typeCheckedAt, which is
// written only by a real carrier lookup. No timestamp, no call.

export const MOBILE = new Set(['mobile', 'cell', 'cellular', 'wireless']);

// Types a carrier has explicitly told us are not a person's phone. Named so the rep sees why.
const NOT_A_PERSON = {
    landline: 'landline',
    fixedvoip: 'a fixed VoIP line',
    fixedVoip: 'a fixed VoIP line',
    nonfixedvoip: 'a call-tracking or virtual line',
    nonFixedVoip: 'a call-tracking or virtual line',
    voip: 'a VoIP line',
    tollfree: 'a toll-free line',
    toll_free: 'a toll-free line',
    premium: 'a premium-rate line',
    sharedCost: 'a shared-cost line',
    uan: 'a company-wide number',
    voicemail: 'a voicemail box',
    pager: 'a pager',
    unknown: 'a number the carrier could not identify',
};

const norm = (s) => String(s == null ? '' : s).trim();

// The three fields that decide this, in one place, so every layer that rebuilds a lead object can
// copy them across without having to remember what they are called.
export const LINE_FIELDS = ['phoneType', 'typeCheckedAt', 'carrier'];

export function carryLineType(target, source) {
    for (const f of LINE_FIELDS) {
        const v = source && source[f];
        if (v != null && v !== '') target[f] = v;
    }
    return target;
}

// Returns null when the lead is safe to dial, or a plain-English reason when it is not.
export function rejectReason(lead) {
    const phone = norm(lead && lead.phone);
    if (!phone) return 'no phone number on the lead';

    const checkedAt = norm(lead && lead.typeCheckedAt);
    const type = norm(lead && lead.phoneType);

    // The load-bearing rule. A stamp with no carrier check behind it is exactly how the bad numbers
    // got in, so an unverified number is rejected no matter how confidently it claims to be mobile.
    if (!checkedAt) {
        return type
            ? `never carrier-checked, only labelled "${type}" by a data source`
            : 'never carrier-checked';
    }

    const key = type.toLowerCase().replace(/[\s_-]/g, '');
    if (MOBILE.has(key)) return null;

    const known = NOT_A_PERSON[type] || NOT_A_PERSON[key];
    return known ? `carrier says it is ${known}` : `carrier says it is "${type || 'unknown'}"`;
}

export const isCallable = (lead) => rejectReason(lead) === null;

// What the rep sees on the card, so a bad number is visible before dialling rather than discovered
// halfway through a call.
export function lineLabel(lead) {
    const reason = rejectReason(lead);
    const carrier = norm(lead && lead.carrier);
    if (reason) return { ok: false, text: 'UNVERIFIED', detail: reason };
    return {
        ok: true,
        text: 'VERIFIED MOBILE',
        detail: carrier || 'carrier not recorded',
        carrierMissing: !carrier,
    };
}

// Splits a list and counts why each rejection happened, so a shrunken queue can explain itself
// instead of just being smaller than it was yesterday.
export function partition(leads) {
    const kept = [], reasons = {};
    let rejected = 0;
    for (const l of leads || []) {
        const why = rejectReason(l);
        if (!why) { kept.push(l); continue; }
        rejected++;
        reasons[why] = (reasons[why] || 0) + 1;
    }
    return { kept, rejected, reasons };
}
