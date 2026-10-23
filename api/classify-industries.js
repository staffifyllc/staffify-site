// Classify the queue by industry, from evidence we already hold.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "yes classify the 1,508."
//
// The agency cohort has been reading as "real estate media" because the list was BUILT as that
// ICP, not because any of those 1,508 businesses was checked. 1,448 of the 1,630 records carry a
// researched excerpt from the company's own website, so the evidence to settle it is already here
// and has simply never been read.
//
// This costs nothing: no fetches, no credits, no provider. It reads the queue, runs the same
// classifier the call scripts use, and writes the answer with its provenance.
//
// GET  /api/classify-industries/            -> what it WOULD say. Writes nothing.
// POST /api/classify-industries/?confirm=yes -> persist it.
//
// A classification a person set by hand is never overwritten.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, visibleState, ownerFor } from './_outreach-queue.js';
import { INDUSTRY_KEY, classify } from './_campaign-industry.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        if (!rep || !ownerFor(rep)) return res.status(403).json({ error: 'Sales owner access required' });

        const state = await redis.get(KEY);
        if (!state) return res.status(503).json({ error: 'The queue could not be read, so nothing was classified.' });
        const records = visibleState(state, 'all').records;
        const existing = (await redis.hgetall(INDUSTRY_KEY).catch(() => null)) || {};
        const campaign = (req.query?.campaign || '').toString();
        const scope = campaign ? records.filter(r => r.campaignId === campaign) : records;

        const byIndustry = {}, bySource = {}, byCampaign = {}, writes = {};
        const examples = {};
        let held = 0;
        for (const r of scope) {
            let prior = null;
            try { const raw = existing[r.recipient]; prior = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { prior = null; }
            // A human's answer stands. This job never argues with a person.
            if (prior && prior.source === 'stated') { held++; continue; }

            const v = classify(r, {});
            const key = v.key || '(unclassified)';
            byIndustry[key] = (byIndustry[key] || 0) + 1;
            bySource[v.source] = (bySource[v.source] || 0) + 1;
            const c = r.campaignId || '(none)';
            byCampaign[c] = byCampaign[c] || {};
            byCampaign[c][key] = (byCampaign[c][key] || 0) + 1;
            if (!examples[key]) examples[key] = { company: r.company, why: v.why };

            writes[r.recipient] = JSON.stringify({
                key: v.key, label: v.label, source: v.source, confidence: v.confidence, why: v.why,
                at: new Date().toISOString(), by: 'classifier',
            });
        }

        const summary = {
            scope: campaign || 'whole queue',
            records: scope.length,
            heldBecauseAPersonSetThem: held,
            byIndustry, bySource, byCampaign, examples,
            // The headline Paul is actually asking for.
            readFromTheirOwnWords: bySource.read || 0,
            restingOnTheCohortAssumption: bySource.campaign || 0,
            unclassified: byIndustry['(unclassified)'] || 0,
        };

        if (req.method === 'GET') {
            return res.status(200).json({ ...summary, wrote: false, note: 'Nothing was written. POST with confirm=yes to persist.' });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
        const body = readBody(req);
        if (req.query?.confirm !== 'yes' && body.confirm !== 'yes') return res.status(400).json({ error: 'confirm=yes required' });

        const keys = Object.keys(writes);
        for (let i = 0; i < keys.length; i += 200) {
            const slice = {};
            for (const k of keys.slice(i, i + 200)) slice[k] = writes[k];
            await redis.hset(INDUSTRY_KEY, slice);
        }
        return res.status(200).json({ ...summary, wrote: true, written: keys.length });
    } catch (e) {
        return res.status(503).json({ error: 'Classification could not run.', detail: String((e && e.message) || e).slice(0, 200) });
    }
}
