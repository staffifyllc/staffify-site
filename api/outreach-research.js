// Backfill the researched website and business context on queue records that never got one.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "theres a lot of calls with no data in here, you need to go and do the data
// right away" and "go and fix every record asap".
//
// Only _outreach-supply.js ever wrote `source`, and it writes it at enrolment. Records that
// reached the queue another way, or whose site fetch failed that day, carry no website and no
// business context, so a caller opens the card with an email trail and nothing to talk about.
// Measured 2026-10-20: 278 of 800 records with no source.url.
//
// This reads the prospect's website off the HubSpot contact and fetches it with the SAME guarded
// `site()` the supply path uses: public hosts only, four redirects, 500KB, five seconds. It never
// invents a fact. A record whose site cannot be read is left exactly as it was and reported, not
// stamped with a guess.
//
// POST /api/outreach-research/?confirm=yes  -> researches one bounded batch, returns `remaining`
// GET  /api/outreach-research/              -> counts only, writes nothing
//
// It is re-runnable by design: every pass skips records that already have a source, so calling it
// repeatedly walks the backlog without redoing work.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, ownerFor, visibleState } from './_outreach-queue.js';
import { contact } from './_outreach-crm.js';
import { site } from './_outreach-supply.js';

const CAS = `local raw=redis.call('GET',KEYS[1]); local rev=0; if raw then rev=cjson.decode(raw).revision or 0 end; if rev~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1`;

const BATCH = Number(process.env.RESEARCH_BATCH || 8);
const BUDGET_MS = 40000;

// What the business actually says about itself. Prefer the sentence that explains what they do,
// fall back to the opening of the page. Never fabricated: if the page gave us nothing readable,
// the record keeps its empty context.
const ICP = /real[ -]estate.{0,60}(photograph|videograph|media|market)|(?:property|architectural|interior) photograph|drone|matterport|virtual (?:tour|staging)|floor ?plan|listing (?:photo|video|media)/i;
export function excerptFrom(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 40) return '';
    const m = ICP.exec(clean);
    if (m) return clean.slice(Math.max(0, m.index - 60), m.index + 160).trim();
    return clean.slice(0, 200).trim();
}

const needsResearch = r => !(r && r.source && r.source.url);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        // Owners only. A caller reads this queue; they do not get to rewrite its evidence.
        if (!rep || !ownerFor(rep)) return res.status(403).json({ error: 'Sales owner access required' });

        const state = await redis.get(KEY);
        const all = visibleState(state, 'all').records;
        const pending = all.filter(needsResearch);

        if (req.method === 'GET') {
            return res.status(200).json({
                total: all.length, withResearch: all.length - pending.length, missing: pending.length,
                sample: pending.slice(0, 5).map(r => ({ id: r.id, company: r.company, recipient: r.recipient })),
            });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
        const body = readBody(req);
        if (req.query?.confirm !== 'yes' && body.confirm !== 'yes') return res.status(400).json({ error: 'confirm=yes required' });

        const started = Date.now();
        const found = {}, skipped = [];
        for (const row of pending.slice(0, Math.max(1, Math.min(BATCH, Number(body.max) || BATCH)))) {
            if (Date.now() - started > BUDGET_MS) break;
            let website = '';
            try { website = ((await contact(row.recipient))?.properties?.website || '').trim(); }
            catch { skipped.push({ id: row.id, why: 'CRM unavailable' }); continue; }
            if (!website) { skipped.push({ id: row.id, why: 'no website on the CRM record' }); continue; }
            let evidence;
            try { evidence = await site(website); }
            catch (e) { skipped.push({ id: row.id, why: String((e && e.message) || e).slice(0, 80) }); continue; }
            const excerpt = excerptFrom(evidence.text);
            if (!excerpt) { skipped.push({ id: row.id, why: 'site returned nothing readable' }); continue; }
            found[row.id] = { url: evidence.url, checkedAt: new Date().toISOString(), excerpt };
        }

        // Written against a freshly read queue, because the outreach worker rewrites this key every
        // minute. Only the source field is touched, and only on records that still lack one, so a
        // record enrolled or dispositioned mid-run is never clobbered.
        let written = 0;
        if (Object.keys(found).length) {
            let saved = 0;
            for (let attempt = 0; attempt < 6 && !saved; attempt++) {
                const fresh = attempt ? await redis.get(KEY) : state;
                written = 0;
                const next = {
                    ...fresh, revision: (fresh?.revision || 0) + 1,
                    records: (fresh?.records || []).map(r => {
                        if (!found[r.id] || !needsResearch(r)) return r;
                        written++;
                        return { ...r, source: found[r.id] };
                    }),
                };
                saved = Number(await redis.eval(CAS, [KEY], [String(fresh?.revision || 0), JSON.stringify(next)]));
            }
            if (!saved) return res.status(409).json({ error: 'Queue stayed busy; nothing was written. Run it again.', researched: Object.keys(found).length });
        }

        return res.status(200).json({
            researched: written, skipped, attempted: Object.keys(found).length + skipped.length,
            remaining: Math.max(0, pending.length - written),
            note: 'Re-run until remaining is 0. Records with no website on the CRM record cannot be researched here.',
        });
    } catch (e) {
        return res.status(503).json({ error: 'Research unavailable; nothing was written. ' + String((e && e.message) || e).slice(0, 120) });
    }
}
