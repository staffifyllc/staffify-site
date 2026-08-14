// One-off maintenance: strip invented summaries off hot leads already in the store.
// ------------------------------------------------------------------
// Paul, 2026-08-14: a card claimed the owner "agreed to receive more information" from a call
// where the transcript was one line, our own opener, and the recording was 0:00. The cause is
// fixed in call-intel and in hot-lead, but records written before that still carry the false
// summary. This rewrites them in place. Runs on Vercel, where the KV credentials actually live.
//
//   GET /api/hot-rescrub          report only, changes nothing
//   GET /api/hot-rescrub?apply=1  rewrite them
// Signed-in hub session is enough; no token needs to change hands.
// ------------------------------------------------------------------
import { redis, requireAccess } from './_auth.js';

const NO_CONVO = 'No conversation. The line opened but the other side never spoke, so there is no outcome to report.';
const humanTurns = (t) => (String(t || '').match(/^\s*(user|human|customer|prospect)\s*:/gim) || []).length;

export default async function handler(req, res) {
    // A logged-in rep OR an admin token. Paul is already signed into the hub, so he can just
    // open this in the browser rather than anyone passing a secret around.
    const who = await requireAccess(req);
    if (!who) return res.status(401).json({ error: 'sign in to the hub first, then reload this page' });
    const apply = req.query.apply === '1';

    const ids = (await redis.zrange('hotleads', 0, -1)) || [];
    const out = { stored: ids.length, invented: 0, real: 0, noSummary: 0, rewritten: 0, examples: [] };

    for (const id of ids) {
        const lead = await redis.hgetall(id);
        if (!lead || !lead.summary) { out.noSummary++; continue; }
        if (lead.summary === NO_CONVO) { out.invented++; continue; }   // already scrubbed
        if (humanTurns(lead.transcript) > 0) { out.real++; continue; }

        out.invented++;
        if (out.examples.length < 10) {
            out.examples.push({ company: lead.company || lead.phone, claimed: String(lead.summary).slice(0, 140) });
        }
        if (apply) {
            await redis.hset(id, { summary: NO_CONVO, noConversation: 'true', rescrubbedAt: new Date().toISOString() });
            out.rewritten++;
        }
    }
    return res.status(200).json({ ...out, applied: apply, note: apply ? 'Rewritten.' : 'Report only. Add &apply=1 to rewrite.' });
}
