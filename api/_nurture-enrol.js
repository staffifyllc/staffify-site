// Put a "not interested: timing" prospect into the email nurture.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "that not interested / timing button should push them into our email marketing
// drips... so that our sales person is enabling our email marketing".
//
// A caller who hears "not now, try me next quarter" is handing us a warm lead with a date on it.
// Until now that went nowhere between the callback and the next conversation. This enrols them in
// the same nurture the booked-call path uses (nurture:active, day 3 / 14 / 45), so the drip keeps
// the relationship warm while the callback date approaches.
//
// IT IS BEST EFFORT AND NEVER BLOCKS THE DISPOSITION. A caller is on the phone; recording what
// happened on the call matters more than enrolling them, so every failure here is swallowed and
// reported rather than thrown.
//
// Four gates, all of which must pass. They are the same gates the rest of the sending stack uses,
// read from the provider and the CRM rather than from a local flag, because this adds somebody to
// a list that will email them unattended. The cron asks again before every touch, with more
// (api/_nurture-gates.js sendGate), because a person can book or become a client by day 21.
//
// A skip comes back with a reason and a plain message the dialer shows the rep ("Not added to the
// nurture: already a client"), so a save that enrolled nobody never reads as if it had.
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';
import { CALL_SOURCE, skipped, clientVerdict, bookingsFor } from './_nurture-gates.js';

export const NURTURE_SET = 'nurture:active';

/**
 * domain is the company's own site (the queue row's agencyKey), so a booking by a colleague counts.
 * deps lets tests stand in for the opt-out list and the client guard.
 * @returns {{enrolled: boolean, reason: string, message?: string}} never throws
 */
export async function enrolInNurture({ redis, email, name = '', company = '', domain = '', caller = '', campaignId = '' }, deps = {}) {
    const d = { isOptedOut, clientCheck, ...deps };
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return skipped('no email');
    try {
        // Already in it, finished it, or stopped. Re-enrolling would restart the day counter and mail them from the top.
        const existing = await redis.hgetall(`nurture:${addr}`);
        if (existing && existing.email) return skipped('already in nurture');

        // Asked not to be contacted. Read from the provider, never from our own flag.
        if (await d.isOptedOut({ email: addr })) return skipped('opted out');

        // Booked a Discovery call, they or their company: the call is the next step, not a drip.
        // A list that cannot be read is not "no booking".
        let booked;
        try { booked = await bookingsFor(redis, addr, [domain]); } catch { return skipped('booking check unavailable'); }
        if (booked.length) return skipped('booked');

        // Already a client. Marketing drips are for prospects. Only the guard's 'clear' passes: a
        // client, a company-name match and a guard that could not answer all leave them out.
        let client = null;
        try { client = await d.clientCheck({ email: addr, company }); } catch { client = null; }
        const verdict = clientVerdict(client);
        if (verdict) return skipped(verdict.reason, client && (client.reason || client.why) || '');

        const now = Date.now();
        await redis.hset(`nurture:${addr}`, {
            email: addr,
            name: String(name || ''),
            enrolled_at: now,
            // Provenance, so the drip's results can be read back by where the lead came from and
            // a caller's enrolments are distinguishable from the booked-call path.
            enrolled_source: CALL_SOURCE,
            enrolled_by: String(caller || ''),
            enrolled_campaign: String(campaignId || ''),
            company: String(company || ''),
            // The company's own site, so the send-time booking check matches a colleague's booking too.
            domain: String(domain || ''),
            day3_sent_at: '',
            day14_sent_at: '',
            day45_sent_at: '',
        });
        await redis.zadd(NURTURE_SET, { score: now, member: addr });
        return { enrolled: true, reason: 'enrolled' };
    } catch (e) {
        return { ...skipped('enrolment failed'), reason: 'enrolment failed: ' + String((e && e.message) || e).slice(0, 80) };
    }
}
