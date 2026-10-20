// Find direct dials for prospects whose number is published nowhere, via RocketReach.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "use rocketreach to go and get the corresponding contact info for those folks."
// The Tobit cohort is twenty-one chief executives with four emails sent each and not one phone
// number, because a CEO's direct line is not on the corporate website and the site-scraping path
// that feeds the rest of the queue therefore finds nothing.
//
// GET  /api/outreach-phones/            -> key check, credit balance and how many records qualify.
//                                          Free: proves the key WITHOUT spending a lookup.
// POST /api/outreach-phones/?confirm=yes -> looks up one bounded batch. Every call costs credits.
//
// Spend discipline, because this is metered: a lookup only ever happens for a record that has no
// number from any source, each email is looked up at most once ever (the receipt is kept whether or
// not a number came back), and the batch is both count- and time-bounded.
//
// The result is stored as its own provenance, never as `business_listed`, which means "we found
// this on their own website" and has to keep meaning that. The card says where the number came
// from and that it is not carrier-verified.
import { redis, requireAccess, SITE, readBody } from './_auth.js';
import { KEY, ownerFor, visibleState } from './_outreach-queue.js';
import { account, lookupByEmail, rrConfigured } from './_rocketreach.js';

const VENDOR = email => 'staffify:call-phone-vendor:' + String(email).toLowerCase();
const TRIED = 'staffify:rocketreach:tried';
const BATCH = 10;
const BUDGET_MS = 40000;

// Only a record with nothing at all. A corroborated website number always wins and is never
// replaced by a vendor's claim.
const needsPhone = r => r.callReady && !(r.callContact && r.callContact.phone);

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const rep = await requireAccess(req);
        if (!rep || !ownerFor(rep)) return res.status(403).json({ error: 'Sales owner access required' });
        if (!rrConfigured()) return res.status(503).json({ error: 'ROCKETREACH_KEY is not set on this project' });

        const state = await redis.get(KEY);
        const all = visibleState(state, 'all').records;
        const campaign = (req.query?.campaign || '').toString();
        const scope = campaign ? all.filter(r => r.campaignId === campaign) : all;
        const tried = new Set((await redis.get(TRIED)) || []);
        const pending = scope.filter(r => needsPhone(r) && !tried.has(r.recipient.toLowerCase()));

        // Free. Proves the key and reads the balance before anything is spent.
        const acct = await account();

        if (req.method === 'GET') {
            return res.status(200).json({
                keyWorks: acct.ok, account: acct,
                scope: campaign || 'whole queue',
                inScope: scope.length,
                missingPhone: scope.filter(needsPhone).length,
                alreadyLookedUp: scope.filter(r => tried.has(r.recipient.toLowerCase())).length,
                wouldLookUp: pending.length,
                note: 'POST with confirm=yes to spend credits. Each lookup is charged whether or not a number comes back.',
            });
        }
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid origin' });
        const body = readBody(req);
        if (req.query?.confirm !== 'yes' && body.confirm !== 'yes') return res.status(400).json({ error: 'confirm=yes required' });
        if (!acct.ok) return res.status(503).json({ error: 'RocketReach rejected the key; nothing was spent', detail: acct.error });

        const want = Math.max(1, Math.min(25, Number(body.max) || BATCH));
        const started = Date.now();
        const found = [], none = [];
        let fatal = null;

        for (const row of pending.slice(0, want)) {
            if (Date.now() - started > BUDGET_MS) break;
            const email = row.recipient.toLowerCase();
            const r = await lookupByEmail(email);
            if (r.fatal) { fatal = r.reason; break; }
            // The receipt goes down either way. A lookup that found nothing still cost a credit and
            // must never be paid for twice.
            if (!r.retryable) tried.add(email);
            if (!r.found) { none.push({ company: row.company, why: r.reason || 'no number', pending: !!r.pending }); continue; }
            const best = r.phones.find(p => p.recommended) || r.phones[0];
            await redis.set(VENDOR(email), {
                phone: best.number, type: best.type || null, source: 'RocketReach',
                checkedAt: new Date().toISOString(),
                name: r.name || null, title: r.title || null, alternates: r.phones.slice(1, 4).map(p => p.number),
            });
            found.push({ company: row.company, title: r.title || null, type: best.type || null, alternates: r.phones.length - 1 });
        }

        await redis.set(TRIED, [...tried].slice(-20000));

        return res.status(200).json({
            spentLookups: found.length + none.filter(n => !n.pending).length,
            numbersFound: found.length, found,
            noNumber: none,
            remaining: Math.max(0, pending.length - (found.length + none.length)),
            creditsAfter: (await account()).lookupsRemaining ?? null,
            ...(fatal ? { stopped: fatal } : {}),
            note: 'Numbers appear on the card as a vendor direct dial, not as a website-published number, and are not carrier-verified.',
        });
    } catch (e) {
        return res.status(503).json({ error: 'Phone lookup unavailable. ' + String((e && e.message) || e).slice(0, 120) });
    }
}
