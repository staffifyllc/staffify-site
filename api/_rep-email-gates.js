// Who may not be emailed from the Hub, beyond the global opt-out list and the client guard.
// ------------------------------------------------------------------
// The pre-release review (2026-10-27) proved two gaps with fakes: a prospect marked "Not interested
// / stop" in the dialer could still be emailed, because that lands in the queue's own suppression
// list and the send read only the global one; and a STOP texted from the number on the card was
// missed, because the send checked a phone field the stored record never has. Every other outbound
// path (the sequence worker, the nurture, deal follow-ups) checks these, so the rep's email does too.
//
//   rowStop      the queue says suppressed (Not interested / stop) or bounced
//   numbers      every number on file for them, each checked against the STOP list
//   crmStop      HubSpot: opted out, do not contact, DNC or not interested, a client, an open deal,
//                or a conversation Paul or Madison owns. A reply to someone who wrote in skips the
//                last three: they started it.
// A store or CRM read that fails is a stop, never a pass.

// The same three named exclusions as api/_outreach-crm.js draftBlockReason.
export const EXCLUDED_NAMES = ['trey tatro', 'mike haymes', 'michael haymes', 'blake watkins'];

export function rowStop(row) {
    if (row && row.status === 'suppressed') return 'This person is excluded from all outreach (Not interested / stop).';
    if (row && row.status === 'bounce_hold') return 'Email to this address bounced.';
    return null;
}

/** HubSpot's stops for a human 1:1 email. `p` is the contact's properties. */
export function crmStop(p, { reply = false } = {}) {
    if (!p) return null;
    const name = (String(p.firstname || '') + ' ' + String(p.lastname || '')).toLowerCase();
    if (EXCLUDED_NAMES.some(n => name.includes(n))) return 'This person is on the do-not-contact list.';
    if (p.hs_email_optout === 'true' || p.do_not_contact === 'true') return 'The CRM marks this person do not contact.';
    if (['DNC', 'NOT_INTERESTED', 'LEGAL'].includes(p.rep_lifecycle_state) || /DNC|NOT_INTERESTED|OPT|LEGAL/i.test(String(p.rep_terminal_state || ''))) return 'The CRM says this person asked not to be contacted.';
    // Any other end state the sequences stop on (a booked or closed record): not a cold email either.
    if (p.rep_terminal_state) return 'The CRM records this person as finished (' + p.rep_terminal_state + '). Check with Paul first.';
    // The human-led cohort: Paul is handling them himself (rep_outreach_mode HUMAN_LED).
    if (p.rep_outreach_mode && p.rep_outreach_mode !== 'AUTOMATED') return 'Paul is handling this person himself. Check with him first.';
    if (reply) return null;
    if (p.lifecyclestage === 'customer') return 'This person is a Staffify client.';
    if (p.lifecyclestage === 'opportunity') return 'This person has an open deal in the CRM, which Paul handles.';
    if (p.rep_lifecycle_state === 'HUMAN_OWNED') return 'Paul or Madison owns this conversation in the CRM. Check with Paul first.';
    return null;
}

const digits = s => String(s || '').replace(/\D/g, '').slice(-10);
/**
 * Every number on file for this prospect: the card, the CRM copy, and the stores the dialer reads
 * (the same four outreach-queue.js reads when a number is marked wrong). Throws if a store cannot
 * be read, so the caller fails closed.
 */
export async function knownNumbers(row, kv) {
    const e = String(row && row.recipient || '').toLowerCase();
    const reads = await Promise.all(['staffify:call-phone-evidence:' + (row && row.recipient), 'staffify:call-phone-vendor:' + e, 'staffify:call-site-phone:' + e, 'staffify:call-phone:' + e].map(k => kv.get(k)));
    const [ev, vd, st, cp] = reads;
    const all = [row && row.phone, row && row.crmPhone, ev && ev.phone, vd && vd.phone, ...((vd && vd.alternates) || []), st && st.phone, ...((st && st.alternates) || []), cp && cp.phone];
    return [...new Set(all.map(digits).filter(d => d.length === 10))];
}

/**
 * The first reason this person may not be emailed, or null. `contact` reads the HubSpot contact by
 * email (api/_outreach-crm.js) and throws 'CRM contact missing' when there is none.
 */
export async function stopsFor(row, email, { kv, isOptedOut, contact, reply = false }) {
    const fromRow = rowStop(row);
    if (fromRow) return fromRow;
    let numbers;
    try { numbers = await knownNumbers(row || { recipient: email }, kv); }
    catch { return 'The do-not-contact list could not be checked just now.'; }
    for (const n of numbers) if (await isOptedOut({ phone: n })) return 'A number on file for this person replied STOP.';
    let props = null;
    try { const c = await contact(email); props = (c && c.properties) || null; }
    catch (e) { if (!/CRM contact missing/.test(String(e && e.message))) return 'The CRM could not be checked just now.'; }
    const crm = crmStop(props, { reply });
    if (crm) return crm;
    // The CRM's own numbers too: row.phone keeps only one of phone and mobile, and a STOP can come from either.
    for (const n of [props && props.phone, props && props.mobilephone].map(x => String(x || '').replace(/\D/g, '').slice(-10)).filter(d => d.length === 10 && !numbers.includes(d)))
        if (await isOptedOut({ phone: n })) return 'A number on file for this person replied STOP.';
    return null;
}
