// May we text this person? The gate, and the reason.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "can we also wire up our hub so that we can send messages out (text messages)
// one click via openphone, ensuring they are all personalized".
//
// The one-click part is easy. The part that matters is who is on the other end.
//
// This exact feature was built once and switched off on 2026-09-15, by Paul: "Proceed with
// consent-based OpenPhone texting. Do not build or enable cold SMS." Quo prohibits messaging
// people who have not consented, and the account that does it loses the number. Tonight's opt-out
// sweep found EIGHT people who had replied STOP and were never suppressed, which is exactly the
// state in which turning cold texting back on would be reckless.
//
// So the click stays, and the gate decides. Two things count as consent, both evidenced:
//
//   1. THEY TEXTED US FIRST. An inbound message from that number is unambiguous: they opened a
//      conversation on this channel. Read live from Quo, never from a local flag.
//   2. THEY ASKED ON A CALL. A caller records "send me that" at the point it is said, with who
//      heard it and when. That is a real consent record, and it is the workflow a caller actually
//      needs: they ring, the person asks for the details, one click sends them.
//
// Nothing else counts. Not four unanswered emails, not a no-answer, not a booked meeting. A
// no-answer is the ABSENCE of a conversation, and texting someone because they did not pick up is
// the precise thing that was retired.
import { listMessages, quoConfigured } from './_quo.js';
import { isOptedOut } from './_optout.js';

export const CONSENT_KEY = email => 'staffify:sms-consent:' + String(email || '').toLowerCase();

/**
 * Record that somebody asked us to text them, at the moment they asked.
 * Stored with who heard it, so it can be audited rather than taken on trust.
 */
export async function recordSpokenConsent({ redis, email, phone, by, heardOn = 'a call', note = '' }) {
    const addr = String(email || '').toLowerCase();
    if (!addr) return { ok: false, reason: 'no email' };
    const record = {
        email: addr, phone: String(phone || '') || null, by: String(by || 'unknown'),
        heardOn, note: String(note || '').slice(0, 200), at: new Date().toISOString(),
    };
    try { await redis.set(CONSENT_KEY(addr), record, { ex: 90 * 86400 }); } catch { return { ok: false, reason: 'store failed' }; }
    return { ok: true, record };
}

/**
 * @returns {{allowed: boolean, basis: string|null, reason: string, evidence: object|null}}
 * Fails CLOSED. If the check cannot be completed we do not send, because an unverifiable consent
 * is the same risk as no consent.
 */
export async function mayText({ redis, email, phone, deps = {} }) {
    // The suppression check is injectable so the gate can be exercised without a live store. It
    // defaults to the real one, so production behaviour is unchanged.
    const optedOut = deps.isOptedOut || isOptedOut;
    const addr = String(email || '').toLowerCase();
    const num = String(phone || '').trim();
    if (!num) return { allowed: false, basis: null, reason: 'No phone number for this contact.', evidence: null };

    // A do-not-contact beats every form of consent, including one they gave earlier.
    try {
        if (await optedOut({ email: addr, phone: num })) {
            return { allowed: false, basis: null, reason: 'This person is on the do-not-contact list.', evidence: null };
        }
    } catch {
        return { allowed: false, basis: null, reason: 'The do-not-contact list could not be read, so nothing is sent.', evidence: null };
    }

    // 1. They texted us first.
    if (quoConfigured()) {
        try {
            const { items } = await listMessages({ direction: 'incoming', from: num, maxPages: 1 });
            const first = items.find(m => String(m.text || '').trim());
            if (first) {
                return {
                    allowed: true, basis: 'they_texted_us',
                    reason: 'They opened a text conversation with us, so replying on this channel is expected.',
                    evidence: { at: first.createdAt || null, text: String(first.text || '').slice(0, 120) },
                };
            }
        } catch (e) {
            return { allowed: false, basis: null, reason: 'Quo could not be read, so consent cannot be confirmed and nothing is sent.', evidence: null };
        }
    }

    // 2. They asked on a call.
    let spoken = null;
    try { spoken = await redis.get(CONSENT_KEY(addr)); } catch {
        return { allowed: false, basis: null, reason: 'The consent record could not be read, so nothing is sent.', evidence: null };
    }
    if (spoken && spoken.at) {
        return {
            allowed: true, basis: 'asked_on_a_call',
            reason: `${spoken.by} recorded that they asked for a text on ${spoken.heardOn}.`,
            evidence: spoken,
        };
    }

    return {
        allowed: false, basis: null,
        reason: 'No consent on file. They have not texted us and nobody has recorded them asking for one. '
            + 'A no-answer is not consent. If they ask on a call, log it and the button turns on.',
        evidence: null,
    };
}
