// One script per Spearhead account, in a single request.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "I need to get scripts that pertain to these different companies for each and
// every single one for spearhead accounts."
//
// The page already loads the queue, so this returns the scripts keyed by the same address and the
// card renders them inline. One request for twenty-one scripts rather than twenty-one requests.
//
// GET /api/spearhead-scripts/  -> { scripts: { "<email>": {...} }, caller }
import { redis, requireAccess } from './_auth.js';
import { KEY, visibleState } from './_outreach-queue.js';
import { spearheadScript } from './_spearhead-scripts.js';

const CAMPAIGN = 'staffify-tobit-outreach';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });

        const campaign = (req.query?.campaign || CAMPAIGN).toString();
        const state = await redis.get(KEY);
        const rows = visibleState(state, 'all').records.filter(r => r.campaignId === campaign);

        const scripts = {};
        for (const r of rows) {
            scripts[r.recipient] = spearheadScript({
                company: r.company,
                firstName: r.verifiedFirstName,
                website: (r.source && r.source.url) || r.website || '',
                excerpt: (r.source && r.source.excerpt) || '',
                caller: rep.name || 'Staffify',
                callerEmail: rep.email,
                sentTouches: r.verifiedSentTouches || r.sentTouches || 0,
                subject: r.subject || '',
            });
        }
        return res.status(200).json({
            campaign, count: Object.keys(scripts).length, caller: rep.name || null, scripts,
            note: 'Sector is inferred unless the company is named in SECTOR_OVERRIDES. It is a starting point for the caller, never a claim to make to the prospect.',
        });
    } catch (e) {
        return res.status(503).json({ error: 'Scripts unavailable. ' + String((e && e.message) || e).slice(0, 160) });
    }
}
