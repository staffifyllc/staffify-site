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
// Three gates, all of which must pass. They are the same gates the rest of the sending stack uses,
// read from the provider and the CRM rather than from a local flag, because this adds somebody to
// a list that will email them unattended.
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';

export const NURTURE_SET = 'nurture:active';

/**
 * @returns {{enrolled: boolean, reason: string}} never throws
 */
export async function enrolInNurture({ redis, email, name = '', company = '', caller = '', campaignId = '' }) {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return { enrolled: false, reason: 'no email' };
    try {
        // Already in it. Re-enrolling would restart the day counter and mail them from the top.
        const existing = await redis.hgetall(`nurture:${addr}`);
        if (existing && existing.email) return { enrolled: false, reason: 'already in nurture' };

        // Asked not to be contacted. Read from the provider, never from our own flag.
        if (await isOptedOut({ email: addr })) return { enrolled: false, reason: 'opted out' };

        // Already a client. Marketing drips are for prospects.
        const client = await clientCheck({ email: addr, company });
        if (client && (client.isClient || client.match)) return { enrolled: false, reason: 'existing client' };

        const now = Date.now();
        await redis.hset(`nurture:${addr}`, {
            email: addr,
            name: String(name || ''),
            enrolled_at: now,
            // Provenance, so the drip's results can be read back by where the lead came from and
            // a caller's enrolments are distinguishable from the booked-call path.
            enrolled_source: 'call-timing',
            enrolled_by: String(caller || ''),
            enrolled_campaign: String(campaignId || ''),
            company: String(company || ''),
            day3_sent_at: '',
            day14_sent_at: '',
            day45_sent_at: '',
        });
        await redis.zadd(NURTURE_SET, { score: now, member: addr });
        return { enrolled: true, reason: 'enrolled' };
    } catch (e) {
        return { enrolled: false, reason: 'enrolment failed: ' + String((e && e.message) || e).slice(0, 80) };
    }
}
