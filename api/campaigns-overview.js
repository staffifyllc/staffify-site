// The data behind Option B's Campaigns page, from the live queue.
// ------------------------------------------------------------------
// Paul chose Option B: one Campaigns area, grouped by target industry, with CEO and reach
// campaigns inside it rather than off to one side.
//
// Industry and outreach type are two dimensions, not a tree. A campaign that reaches seven
// industries is reported as reaching seven, listed once, with its people counted once. Nothing is
// filed under an industry it does not belong to and no contact is duplicated to make a grid look
// tidy. Whether a campaign spans industries is read from its own prospects, not declared.
//
// Every rate carries its denominator and is withheld below 30, because two replies out of 24 is
// 8.3% and would outrank 38 out of 779 on any page that prints both. Unknown and zero are
// different: a dash means no evidence, 0 means we looked.
//
// GET /api/campaigns-overview/  -> { industries, spanning, unclassified, totals }
// Read-only. It computes nothing into the queue and sends nothing.
import { redis, requireAccess } from './_auth.js';
import { KEY, visibleState, ownerFor } from './_outreach-queue.js';
import { INDUSTRY_KEY, classify, rate, spansIndustries, offTarget } from './_campaign-industry.js';
import { CAMPAIGN_ID } from './_outreach-campaign.js';
import { TOBIT_ID } from './_tobit-campaign.js';
import { TALENT_ID } from './_talent-network-campaign.js';

const NAMES = {
    [CAMPAIGN_ID]: { name: 'Staffify agency outreach', motion: 'Email then call' },
    [TOBIT_ID]: { name: 'CEO B2B outreach', motion: 'Email then call', badge: 'Spearhead' },
    [TALENT_ID]: { name: 'Talent network outreach', motion: 'Email', candidates: true },
};
// Industries Paul has named as targets. Shown even with nothing in them, so "not started" is
// visible and distinguishable from "tried and got nothing".
const PLANNED = [
    { key: 'hvac', label: 'HVAC' },
    { key: 'realestate', label: 'Real estate' },
];

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });

        const state = await redis.get(KEY);
        if (!state) return res.status(503).json({ error: 'The queue could not be read, so no counts are reported. This is not a statement that there are no campaigns.' });
        const records = visibleState(state, ownerFor(rep) || 'all').records;
        const stated = (await redis.hgetall(INDUSTRY_KEY).catch(() => null)) || {};

        // One pass. Each record lands in exactly one campaign and one industry bucket.
        const campaigns = new Map();
        for (const r of records) {
            const id = r.campaignId || '(none)';
            if (!campaigns.has(id)) campaigns.set(id, { id, ...(NAMES[id] || { name: id, motion: 'Unknown' }), total: 0, byIndustry: {}, contacted: 0, replies: 0, meetings: 0, won: 0, unclassified: 0, bySource: {} });
            const c = campaigns.get(id);
            c.total++;

            let s = null;
            try { const raw = stated[r.recipient]; s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { s = null; }
            const verdict = classify(r, { stated: s });
            c.bySource[verdict.source] = (c.bySource[verdict.source] || 0) + 1;
            if (verdict.key) c.byIndustry[verdict.key] = (c.byIndustry[verdict.key] || 0) + 1;
            else c.unclassified++;

            // Counts only, from what the queue actually records. No conversion logic is invented
            // here: a reply is a reply the worker saw, a meeting is one the calendar confirmed.
            if ((r.verifiedSentTouches || r.sentTouches || 0) > 0) c.contacted++;
            if (r.status === 'human_reply_hold' || r.replyId) c.replies++;
            if (r.callOutcome === 'booked') c.meetings++;
        }

        const labelOf = {};
        for (const r of records) {
            const v = classify(r, {});
            if (v.key && !labelOf[v.key]) labelOf[v.key] = v.label;
        }

        const all = [...campaigns.values()];
        const spanning = [], grouped = {};
        for (const c of all) {
            const industries = Object.entries(c.byIndustry)
                .map(([key, n]) => ({ key, label: labelOf[key] || key, n }))
                .sort((a, b) => b.n - a.n);
            const shaped = {
                id: c.id, name: c.name, motion: c.motion, badge: c.badge || null,
                candidates: !!c.candidates,
                total: c.total, contacted: c.contacted, replies: c.replies, meetings: c.meetings,
                // Won is not tracked on the queue, so it is UNKNOWN rather than zero.
                won: null,
                replyRate: rate(c.replies, c.contacted),
                meetingRate: rate(c.meetings, c.contacted),
                industries, unclassified: c.unclassified,
                evidence: c.bySource,
                evidenceNote: c.bySource.campaign
                    ? `${c.bySource.campaign} of ${c.total} are classified from the campaign the list was built as, not from evidence about the business.`
                    : null,
            };
            // A candidate campaign is not a sales campaign and must never land in a conversion rate.
            if (c.candidates) { shaped.replyRate = rate(null, null); shaped.meetingRate = rate(null, null); shaped.note = 'Candidates, not buyers. Deliberately carries no sales conversion.'; }
            if (spansIndustries(c.byIndustry)) { spanning.push(shaped); continue; }
            // A single-industry campaign that picked up off-target names says so, as a list-quality
            // finding, rather than being reclassified as cross-industry because of them.
            const off = offTarget(c.byIndustry);
            if (off.strays) shaped.offTargetNote = `${off.strays} of ${c.total} look like something other than ${labelOf[off.dominant] || off.dominant}. Worth a look before they are called.`;
            const key = industries[0] ? industries[0].key : 'unclassified';
            (grouped[key] = grouped[key] || []).push(shaped);
        }

        const industries = Object.entries(grouped).map(([key, list]) => ({
            key, label: labelOf[key] || key,
            campaigns: list,
            prospects: list.reduce((n, c) => n + c.total, 0),
            started: true,
        })).sort((a, b) => b.prospects - a.prospects);

        for (const p of PLANNED) {
            if (industries.some(i => i.key === p.key)) continue;
            industries.push({ key: p.key, label: p.label, campaigns: [], prospects: 0, started: false,
                note: 'No campaign yet. Nothing has been sent, so every figure is unknown rather than zero.' });
        }

        return res.status(200).json({
            builtAt: new Date().toISOString(),
            totals: { records: records.length, campaigns: all.length },
            spanning, industries,
            unclassified: all.reduce((n, c) => n + c.unclassified, 0),
            notes: [
                'A rate is withheld below 30 contacted. A dash means no evidence; 0 means we looked and it is zero.',
                'Campaigns reaching more than one industry are listed once, under "spanning", with their people counted once.',
                'Won is not recorded on the queue, so it reports as unknown rather than zero.',
            ],
        });
    } catch (e) {
        return res.status(503).json({ error: 'The campaign overview could not be built.', detail: String((e && e.message) || e).slice(0, 200) });
    }
}
