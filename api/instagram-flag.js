// A rep says the Instagram evidence is wrong, and the question stops.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "Allow a rep to flag wrong profile/date and suppress the claim pending
// correction."
//
// The person on the phone is the best detector we have of a wrong profile, because they are the
// one about to say it out loud. One click suppresses the question for that prospect immediately,
// before anybody else dials them, and records who said so.
//
// POST /api/instagram-flag/ { email, note? }            -> suppress
// POST /api/instagram-flag/ { email, clear: true }      -> owners only, lift it
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';

export const FLAG = email => 'staffify:instagram-flag:' + String(email || '').toLowerCase();

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });
        const body = readBody(req);
        const email = String(body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Which prospect?' });

        if (body.clear) {
            // Lifting a flag is an owner's call. A caller flagged it for a reason, and clearing it
            // should mean somebody looked, not that the next person disagreed.
            if (!ownerFor(rep)) return res.status(403).json({ error: 'Only Paul or Madison can clear a flag' });
            await redis.del(FLAG(email));
            return res.status(200).json({ ok: true, cleared: true, email });
        }

        const record = {
            wrong: true,
            by: rep.name || rep.email,
            note: String(body.note || '').slice(0, 200),
            at: new Date().toISOString(),
        };
        await redis.set(FLAG(email), record, { ex: 365 * 86400 });
        return res.status(200).json({ ok: true, flagged: record, email,
            note: 'The Instagram question is suppressed for this prospect until an owner clears it.' });
    } catch (e) {
        return res.status(503).json({ error: 'The flag could not be saved, so assume the question is still live. ' + String((e && e.message) || e).slice(0, 140) });
    }
}
