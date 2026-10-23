// The Campaigns area, three screens from one endpoint.
// ------------------------------------------------------------------
// GET /api/campaigns-overview/                              -> screen 1, every campaign by industry
// GET /api/campaigns-overview/?view=industry&industry=<key> -> screen 2, one industry
// GET /api/campaigns-overview/?view=campaign&campaign=<id>  -> screen 3, one campaign in full
//
// Every number comes from _campaigns-model.js, which is pure and tested, over the SAME decorated
// records the call queue serves. "Ready to call" here is the queue's own callReady after the phone
// ladder, so a count on this page is the count a caller will actually find.
//
// Read-only. It computes nothing into the queue and sends nothing.
import { redis, requireAccess } from './_auth.js';
import { KEY, visibleState, ownerFor } from './_outreach-queue.js';
import { withCallPhones } from './_outreach-call-phones.js';
import { hubspotRequest } from './_outreach-hubspot.js';
import { INDUSTRY_KEY } from './_campaign-industry.js';
import { overview, industryView, campaignView } from './_campaigns-model.js';

const crm = async (path, body) => {
    const response = await hubspotRequest('https://api.hubapi.com' + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + process.env.HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    }, { redis });
    if (!response.ok) throw Error('CRM unavailable');
    return response.json();
};

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });

        // The tab people land on. Walking 1,630 records through the phone ladder took over five
        // seconds live, so each view is held for 45 seconds per viewer scope. A caller who just
        // logged an outcome can pass fresh=1; the dialer itself never reads this, so a stale count
        // here can never hold back a card.
        const q = req.query || {};
        const scope = ownerFor(rep) || 'all';
        const cacheKey = 'staffify:campaigns-view:' + scope + ':' + String(q.view || 'overview') + ':' + String(q.industry || '') + ':' + String(q.campaign || '');
        if (!q.fresh) {
            const held = await redis.get(cacheKey).catch(() => null);
            if (held && held.builtAt && Date.now() - Date.parse(held.builtAt) < 45000) return res.status(200).json({ ...held, cached: true });
        }

        const state = await redis.get(KEY);
        if (!state) return res.status(503).json({ error: 'The queue could not be read, so no counts are reported. This is not a statement that there are no campaigns.' });

        // Decorated the way the caller sees it. The ladder is isolated per record and degrades to
        // "finding a number" on failure, so a CRM outage still yields a page rather than an error.
        let decorated;
        try { decorated = await withCallPhones(visibleState(state, ownerFor(rep) || 'all'), { redis, crm }); }
        catch { decorated = visibleState(state, ownerFor(rep) || 'all'); }
        const records = decorated.records;
        const stated = (await redis.hgetall(INDUSTRY_KEY).catch(() => null)) || {};

        const view = String(q.view || 'overview');
        const notes = [
            'A rate is withheld below 30 contacted. A dash means no evidence; 0 means we looked and it is zero.',
            'Replied means a message was received on the thread, or the worker held it for a reply. Nothing else counts.',
            'Won is not recorded on the queue, so it reports as unknown rather than zero.',
        ];

        if (view === 'industry') {
            const key = String(q.industry || '').trim();
            if (!key) return res.status(400).json({ error: 'Which industry?' });
            const out = { view, builtAt: new Date().toISOString(), ...industryView(records, key, stated), notes };
            await redis.set(cacheKey, out, { ex: 120 }).catch(() => {});
            return res.status(200).json(out);
        }
        if (view === 'campaign') {
            const id = String(q.campaign || '').trim();
            if (!id) return res.status(400).json({ error: 'Which campaign?' });
            if (!records.some(r => r.campaignId === id)) return res.status(404).json({ error: 'No campaign with that id is in the queue.' });
            const out = { view, builtAt: new Date().toISOString(), ...campaignView(records, id, stated), notes };
            await redis.set(cacheKey, out, { ex: 120 }).catch(() => {});
            return res.status(200).json(out);
        }
        const out = { view: 'overview', builtAt: new Date().toISOString(), ...overview(records, stated), notes };
        await redis.set(cacheKey, out, { ex: 120 }).catch(() => {});
        return res.status(200).json(out);
    } catch (e) {
        return res.status(503).json({ error: 'The campaign view could not be built.', detail: String((e && e.message) || e).slice(0, 200) });
    }
}
