// Fill in the missing numbers from the businesses' own websites.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "any ones missing numbers, go get them please."
//
// Seven of the twenty-one Spearhead accounts have no number. RocketReach has already been asked
// about all twenty-one and found fourteen, so asking again spends credits to be told the same
// thing. Four of the seven are generic inboxes (info@, hello@, together@) and a vendor that looks
// up a PERSON by their email has no person to find behind a shared mailbox.
//
// Their main line is on their contact page. Free, corroborated because they published it
// themselves, and a main line you can call and ask for someone by name beats nothing at all.
//
// GET  /api/outreach-site-phone/?campaign=...   -> who is missing a number. Fetches nothing.
// POST /api/outreach-site-phone/?confirm=yes    -> fetch and store one bounded batch.
//
// Read-only against the outside world: it fetches public pages and writes only our own store.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, ownerFor, visibleState } from './_outreach-queue.js';
import { withCallPhones } from './_outreach-call-phones.js';
import { hubspotRequest } from './_outreach-hubspot.js';
import { site } from './_outreach-supply.js';
import { findSitePhone } from './_site-phone.js';

export const SITE_PHONE = email => 'staffify:call-site-phone:' + String(email).toLowerCase();
const BATCH = 10;
const BUDGET_MS = 45000;

// The same guarded, queued client the call queue uses, so this cannot bypass its backoff.
const crm = async (path, body) => {
    const response = await hubspotRequest('https://api.hubapi.com' + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer ' + process.env.HUBSPOT_TOKEN, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    }, { redis });
    if (!response.ok) throw Error('CRM unavailable');
    return response.json();
};

/**
 * The SAME view the caller sees, so "missing a number" means missing on the card rather than
 * missing in one store. Reading raw queue state instead is what made /api/outreach-phones report
 * all twenty-one as missing while fourteen of them had a number on screen.
 */
async function decorated(campaign) {
    const state = await redis.get(KEY);
    const withPhones = await withCallPhones(visibleState(state, 'all'), { redis, crm });
    const all = withPhones.records.filter(r => r.callReady);
    return campaign ? all.filter(r => r.campaignId === campaign) : all;
}
const needsPhone = r => !(r.callContact && r.callContact.phone);
const websiteOf = r => (r.source && r.source.url) || r.website || null;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        if (!rep || !ownerFor(rep)) return res.status(403).json({ error: 'Sales owner access required' });

        const campaign = (req.query?.campaign || '').toString();
        const rows = await decorated(campaign);
        const missing = rows.filter(needsPhone);
        const already = [];
        const todo = [];
        for (const r of missing) {
            const stored = await redis.get(SITE_PHONE(r.recipient));
            if (stored && stored.phone) { already.push({ company: r.company, phone: stored.phone, sourceUrl: stored.sourceUrl }); continue; }
            if (stored && stored.checkedAt && !stored.phone) { continue; } // looked and found none
            if (!websiteOf(r)) continue;
            todo.push(r);
        }

        if (req.method === 'GET') {
            return res.status(200).json({
                scope: campaign || 'whole call queue',
                inScope: rows.length,
                missingPhone: missing.length,
                alreadyFound: already,
                noWebsiteToCheck: missing.filter(r => !websiteOf(r)).map(r => r.company),
                wouldFetch: todo.map(r => ({ company: r.company, website: websiteOf(r) })),
                note: 'POST with confirm=yes to fetch. Nothing is charged; these are public pages.',
            });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
        const body = readBody(req);
        if (req.query?.confirm !== 'yes' && body.confirm !== 'yes') return res.status(400).json({ error: 'confirm=yes required' });

        const want = Math.max(1, Math.min(25, Number(body.max) || BATCH));
        const started = Date.now();
        const found = [], none = [];
        for (const row of todo.slice(0, want)) {
            if (Date.now() - started > BUDGET_MS) break;
            const hit = await findSitePhone({ website: websiteOf(row), fetchSite: site });
            if (!hit) {
                // The receipt goes down either way, so the next run does not refetch the same site
                // for the same answer. It carries no number, so nothing can mistake it for one.
                await redis.set(SITE_PHONE(row.recipient), { phone: null, checkedAt: new Date().toISOString(), website: websiteOf(row) });
                none.push({ company: row.company, website: websiteOf(row) });
                continue;
            }
            await redis.set(SITE_PHONE(row.recipient), hit);
            found.push({ company: row.company, phone: hit.phone, sourceUrl: hit.sourceUrl, alternates: hit.alternates.length, context: hit.context });
        }

        return res.status(200).json({
            scope: campaign || 'whole call queue',
            numbersFound: found.length, found,
            noNumberPublished: none,
            remaining: Math.max(0, todo.length - (found.length + none.length)),
            note: 'These are main lines published by the business, not personal direct dials. The card says so and links the page it came from.',
        });
    } catch (e) {
        return res.status(503).json({ error: 'Website number lookup unavailable. ' + String((e && e.message) || e).slice(0, 160) });
    }
}
