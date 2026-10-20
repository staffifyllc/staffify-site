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
const ICP = /real[ -]estate|photograph|videograph|drone|aerial|matterport|virtual (?:tour|staging)|floor ?plan|listing|property marketing|twilight|3d tour/i;

// site() strips tags and joins everything, so the raw text opens with the nav menu: "Home Gallery
// Our Services Pricing The Team Agent Login". That is not something a caller can open a call with.
// Score candidate sentences and keep the one that actually describes the business.
const NAVVY = /^(home|about|services|pricing|contact|gallery|blog|portfolio|login|menu|book now|order now|skip to|our services|open menu|close menu)\b/i;
function looksLikeProse(s) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length < 8 || words.length > 60) return false;
    if (NAVVY.test(s)) return false;
    // A nav strip is almost all Capitalised words. Prose is not.
    const capped = words.filter(w => /^[A-Z]/.test(w)).length;
    if (capped / words.length > 0.6) return false;
    // Real sentences contain small connecting words.
    return /\b(we|our|is|are|a|the|for|with|to|and|that|your|you)\b/i.test(s);
}

export function excerptFrom(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length < 40) return '';
    // The page title is the first thing in the stripped text and is usually a real description.
    const title = clean.slice(0, 110).split(/[|·—]/)[0].trim();
    const sentences = clean.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    const scored = sentences
        .filter(looksLikeProse)
        .map(x => ({ x, score: (ICP.test(x) ? 2 : 0) + (/\b(we|our)\b/i.test(x) ? 1 : 0) }))
        .sort((a, b) => b.score - a.score);
    const best = scored.length && scored[0].score > 0 ? scored[0].x.slice(0, 220) : '';
    if (best) return best;
    // No prose worth quoting. Fall back to the title only when it says what they do, never to a
    // nav strip, because a meaningless excerpt is worse than an empty one.
    if (title.length >= 15 && ICP.test(title)) return title;
    return '';
}

const needsResearch = r => !(r && r.source && r.source.url);
// A record already stamped by an earlier, worse extraction can be redone by passing redoAfter:
// anything researched at or after that timestamp is treated as missing again. Bounded on purpose,
// so a re-run can never rewrite research the supply path gathered at enrolment.
const stale = (r, redoAfter) => !!redoAfter && !!r?.source?.checkedAt && r.source.checkedAt >= redoAfter;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        // Owners only. A caller reads this queue; they do not get to rewrite its evidence.
        if (!rep || !ownerFor(rep)) return res.status(403).json({ error: 'Sales owner access required' });

        const state = await redis.get(KEY);
        const all = visibleState(state, 'all').records;
        const redoAfter = typeof req.query?.redoAfter === 'string' ? req.query.redoAfter : null;
        const wanted = r => needsResearch(r) || stale(r, redoAfter);
        const pending = all.filter(wanted);

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
        // The time budget is the real limit, not the count: eight sites take about twelve seconds, so
        // a caller-driven run can ask for more and the loop still stops at BUDGET_MS. Capped at 30
        // so one request can never sit on the function for longer than Vercel allows.
        const want = Math.max(1, Math.min(30, Number(body.max) || BATCH));
        for (const row of pending.slice(0, want)) {
            if (Date.now() - started > BUDGET_MS) break;
            let website = '';
            try { website = ((await contact(row.recipient))?.properties?.website || '').trim(); }
            catch { skipped.push({ id: row.id, why: 'CRM unavailable' }); continue; }
            if (!website) { skipped.push({ id: row.id, why: 'no website on the CRM record' }); continue; }
            // Most of these are small studio sites behind bot protection or rendered client side,
            // so the fetch fails or yields no prose. The URL from the CRM is still real and a
            // clickable "Their website" beats an empty card, so it is stored either way and the
            // context is left genuinely empty rather than filled with a guess. `unverified` marks
            // the ones we could not actually read.
            const fallbackUrl = /^https?:\/\//i.test(website) ? website : 'https://' + website.replace(/^\/+/, '');
            let evidence = null;
            try { evidence = await site(website); }
            catch (e) { skipped.push({ id: row.id, why: String((e && e.message) || e).slice(0, 80) }); }
            const excerpt = evidence ? excerptFrom(evidence.text) : '';
            if (evidence && !excerpt) skipped.push({ id: row.id, why: 'site returned nothing readable' });
            found[row.id] = excerpt
                ? { url: evidence.url, checkedAt: new Date().toISOString(), excerpt }
                : { url: (evidence && evidence.url) || fallbackUrl, checkedAt: new Date().toISOString(), excerpt: '', unverified: true };
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
                        if (!found[r.id] || !wanted(r)) return r;
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
