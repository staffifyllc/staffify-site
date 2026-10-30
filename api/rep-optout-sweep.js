// Every two minutes: one rep inbox read for "please remove me" (api/_rep-optout-sweep.js).
// ------------------------------------------------------------------
// Its own schedule and its own lock, not a step of the email worker: a paused, failing or slow worker must never leave a
// "remove me" unread. Bearer CRON_SECRET. Nothing here sends anything.
import { randomUUID } from 'node:crypto';
import { redis, adminAuthorized } from './_auth.js';
import { KEY } from './_outreach-queue.js';
import { access, gmail, headers, messageText } from './_outreach-gmail.js';
import { replyText } from './_outreach-policy.js';
import { sweepRepInboxes } from './_rep-optout-sweep.js';
import { mailboxFor, ROUTE_TO, REP_MAILBOXES } from './_rep-email.js';
import { optOutEverywhere } from './_optout.js';
import { requestStop } from './_outreach-stops.js';
import { stopHiringCards } from './_hiring-calls.js';
import { allRecords } from './_hiring-intent.js';

const LOCK = 'staffify:rep-optout:lock';
// The Hub mailboxes Milton, Madison and Paul send from. hello@ has no connection here; every Hub email copies the rep, so
// the rep's box holds the reply.
export const REP_BOXES = [...new Set(Object.keys(REP_MAILBOXES).map(k => mailboxFor({ email: k })).filter(b => b && b !== ROUTE_TO))];

/** Someone we have contacted: in the email queue, emailed from the Hub, or the person on a Hiring now card. */
export function prospectCheck({ kv, queue, cards }) {
    let all = null;
    return async email => {
        if (((queue && queue.records) || []).some(r => String(r.recipient || '').toLowerCase() === email)) return true;
        if (Number(await Promise.resolve().then(() => kv.llen('staffify:rep-email:sent:' + email)).catch(() => 0)) > 0) return true;   // api/rep-email.js K.sent
        all ||= await cards();
        return all.some(r => r.contact && [r.contact.email, r.contact.candidateEmail].some(x => String(x || '').toLowerCase() === email));
    };
}

/** Off everything: the stop list and CRM, every email-queue row, the Hiring now card. */
export async function stopFromInbox({ email, box, text }, kv = redis) {
    const why = 'Asked by email to be removed';
    const r = await optOutEverywhere({ email, reason: why, source: 'rep-inbox:' + box, text });
    if (!r.ok) throw Error('Stop list write failed');
    await requestStop(kv, { email, by: box, why });
    await stopHiringCards(kv, { email }, { why, by: box });
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const nonce = randomUUID();
    if (!await redis.set(LOCK, nonce, { nx: true, ex: 90 })) return res.status(200).json({ status: 'already_running' });
    try {
        const queue = await redis.get(KEY);
        const out = await sweepRepInboxes({ kv: redis, boxes: REP_BOXES, access, gmail, headers, messageText, replyText,
            isProspect: prospectCheck({ kv: redis, queue, cards: () => allRecords(redis) }), stop: q => stopFromInbox(q) }, { deadline: Date.now() + 45000 });
        const report = { ...out, at: new Date().toISOString() };
        await redis.set('staffify:rep-optout:last-run', report);
        return res.status(200).json(report);
    } catch (e) {
        return res.status(503).json({ error: String(e && e.message || e).slice(0, 160) });
    } finally {
        await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", [LOCK], [nonce]).catch(() => {});
    }
}
