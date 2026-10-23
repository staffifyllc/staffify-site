// Finds the missing numbers, on its own, on a schedule.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "it shouldn't crash the entire system if it can't find it it should just do
// what it needs to in order to get the number."
//
// Works the no-number backlog: the business's own website first because that costs nothing, then a
// vendor direct dial, which is metered and therefore capped per run. Every record is isolated, so
// a dead provider, an expired token, a timeout or a malformed row costs that ONE record a retry on
// a growing delay and nothing else.
//
// A record that gets a number is promoted automatically on the next queue read: callReady is
// recomputed from the phone ladder, so there is no second place where eligibility is decided and
// nothing can be promoted past the four-email rule, the waiting period or the exclusions.
import { redis, adminAuthorized } from './_auth.js';
import { KEY, visibleState } from './_outreach-queue.js';
import { withCallPhones } from './_outreach-call-phones.js';
import { hubspotRequest } from './_outreach-hubspot.js';
import { site } from './_outreach-supply.js';
import { findSitePhone } from './_site-phone.js';
import { lookupByEmail, rrConfigured } from './_rocketreach.js';
import { ATTEMPTS, decide, noteAttempt, websiteOf } from './_number-research.js';
import { SITE_PHONE } from './outreach-site-phone.js';

const VENDOR = email => 'staffify:call-phone-vendor:' + String(email).toLowerCase();
const BUDGET_MS = 45000;
// Metered work is capped per run so a backlog cannot drain the credit balance in one pass.
const VENDOR_PER_RUN = Number(process.env.NUMBER_RESEARCH_VENDOR_PER_RUN || 8);
const SITE_PER_RUN = Number(process.env.NUMBER_RESEARCH_SITE_PER_RUN || 25);

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
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const started = Date.now();
    const out = { checked: 0, website: { tried: 0, found: 0 }, vendor: { tried: 0, found: 0 }, waiting: 0, exhausted: 0, failures: [] };

    let due = [];
    try {
        const state = await redis.get(KEY);
        // The SAME decorated view the caller sees, so "has no number" means exactly what it means
        // on the card rather than in one store.
        const decorated = await withCallPhones(visibleState(state, 'all'), { redis, crm });
        due = decorated.records.filter(r => (r.callReady || r.numberResearch) && !(r.callContact && r.callContact.phone));
    } catch (e) {
        // The queue itself could not be read. That is the one failure worth reporting as a failure,
        // because it means nothing was worked rather than nothing needed working.
        return res.status(503).json({ error: 'The queue could not be read, so no research ran.', detail: String(e.message).slice(0, 200) });
    }

    let vendorSpend = 0, siteFetches = 0;
    for (const row of due) {
        if (Date.now() - started > BUDGET_MS) break;
        out.checked++;
        // Every record is its own try/catch. This is the whole point: one bad row cannot stop the
        // other eight hundred from being worked.
        try {
            let state = null;
            try { state = await redis.get(ATTEMPTS(row.recipient)); } catch { state = null; }
            const plan = decide(row, state);
            if (plan.action === 'wait') { out.waiting++; continue; }
            if (plan.action === 'exhausted') { out.exhausted++; continue; }

            if (plan.source === 'website') {
                if (siteFetches >= SITE_PER_RUN) continue;
                siteFetches++;
                out.website.tried++;
                let hit = null;
                try { hit = await findSitePhone({ website: websiteOf(row), fetchSite: site }); }
                catch (e) { await noteAttempt({ redis, email: row.recipient, source: 'website', found: false, detail: String(e.message).slice(0, 120) }); continue; }
                if (hit && hit.phone) {
                    await redis.set(SITE_PHONE(row.recipient), hit);
                    await noteAttempt({ redis, email: row.recipient, source: 'website', found: true, detail: hit.sourceUrl || '' });
                    out.website.found++;
                } else {
                    await noteAttempt({ redis, email: row.recipient, source: 'website', found: false, detail: 'no number published' });
                }
                continue;
            }

            if (plan.source === 'vendor') {
                if (!rrConfigured()) { await noteAttempt({ redis, email: row.recipient, source: 'vendor', found: false, detail: 'no vendor key configured' }); continue; }
                if (vendorSpend >= VENDOR_PER_RUN) continue;
                vendorSpend++;
                out.vendor.tried++;
                let r = null;
                try { r = await lookupByEmail(row.recipient.toLowerCase()); }
                catch (e) { await noteAttempt({ redis, email: row.recipient, source: 'vendor', found: false, detail: String(e.message).slice(0, 120) }); continue; }
                // A retryable failure is NOT an answer, so it must not burn the source.
                if (r && r.retryable) { out.failures.push({ company: row.company, why: r.reason || 'retryable' }); continue; }
                if (r && r.found && r.phones && r.phones.length) {
                    const best = r.phones.find(p => p.recommended) || r.phones[0];
                    await redis.set(VENDOR(row.recipient.toLowerCase()), {
                        phone: best.number, type: best.type || null, source: 'RocketReach',
                        checkedAt: new Date().toISOString(), name: r.name || null, title: r.title || null,
                        alternates: r.phones.slice(1, 4).map(p => p.number),
                    });
                    await noteAttempt({ redis, email: row.recipient, source: 'vendor', found: true, detail: best.type || 'direct dial' });
                    out.vendor.found++;
                } else {
                    await noteAttempt({ redis, email: row.recipient, source: 'vendor', found: false, detail: (r && r.reason) || 'no number' });
                }
            }
        } catch (e) {
            // Isolated. Recorded, then on to the next record.
            out.failures.push({ company: row.company || row.recipient, why: String((e && e.message) || e).slice(0, 120) });
        }
    }

    return res.status(200).json({
        ...out, backlog: due.length, ranAt: new Date().toISOString(),
        note: 'A record that gained a number is promoted on the next queue read, where call eligibility is recomputed in full. Nothing is promoted past the four-email rule or the exclusions.',
    });
}
