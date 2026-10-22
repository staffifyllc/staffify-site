// One script per Spearhead account, in a single request.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "I need to get scripts that pertain to these different companies for each and
// every single one for spearhead accounts."
//
// The page already loads the queue, so this returns the scripts keyed by the same address and the
// card renders them inline. One request for twenty-one scripts rather than twenty-one requests.
//
// GET /api/spearhead-scripts/  -> { scripts: { "<email>": {...} }, caller }
import { redis, requireAccess, getRep } from './_auth.js';
import { KEY, visibleState } from './_outreach-queue.js';
import { spearheadScript } from './_spearhead-scripts.js';
import { callerPlan, designatedCaller } from './_caller-plan.js';

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

        // Whose name goes in the script. Paul reads these lists and does not dial them, so the
        // viewer is the LAST place to take the name from: a script is read aloud by the person
        // making the call, and putting the reviewer's name in it is wrong in the caller's mouth.
        //   1. the teammate who already claimed this call
        //   2. the caller the campaign is assigned to
        //   3. the viewer, when they are the one who works this queue
        const names = new Map();
        const nameFor = async email => {
            const key = String(email || '').toLowerCase();
            if (!key) return null;
            if (names.has(key)) return names.get(key);
            const plan = callerPlan(key);
            let name = plan ? plan.name : null;
            if (!name) { try { name = (await getRep(key))?.name || null; } catch { name = null; } }
            if (!name) name = key.split('@')[0];
            names.set(key, name);
            return name;
        };

        const assigned = designatedCaller(campaign);
        const fallbackEmail = assigned || rep.email;
        const fallbackName = await nameFor(fallbackEmail);

        const scripts = {};
        for (const r of rows) {
            const owner = r.callOwner ? String(r.callOwner).toLowerCase() : null;
            const email = owner || fallbackEmail;
            const name = owner ? await nameFor(owner) : fallbackName;
            scripts[r.recipient] = spearheadScript({
                company: r.company,
                firstName: r.verifiedFirstName,
                website: (r.source && r.source.url) || r.website || '',
                excerpt: (r.source && r.source.excerpt) || '',
                caller: name || 'Staffify',
                callerEmail: email,
                sentTouches: r.verifiedSentTouches || r.sentTouches || 0,
                subject: r.subject || '',
            });
            scripts[r.recipient].callerIs = { name: name || null, email, claimed: !!owner };
        }
        return res.status(200).json({
            campaign, count: Object.keys(scripts).length,
            writtenFor: { name: fallbackName, email: fallbackEmail, assigned: !!assigned },
            viewer: rep.name || null,
            scripts,
            note: 'Scripts are written in the voice of whoever will make the call, not whoever is reading the page. Sector is inferred unless the company is named in SECTOR_OVERRIDES, and is a starting point for the caller, never a claim to make to the prospect.',
        });
    } catch (e) {
        return res.status(503).json({ error: 'Scripts unavailable. ' + String((e && e.message) || e).slice(0, 160) });
    }
}
