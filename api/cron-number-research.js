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
import { checkBusinessPhone } from './_outreach-phone-evidence.js';
import { contact } from './_outreach-crm.js';
import { fillBlankContactProps } from './_hubspot.js';
import { researchIdentity, needsName, triedRecently } from './_contact-identity.js';
export const LAST_RUN_KEY = 'staffify:number-research:last-run';
import { lookupByEmail, rrConfigured, searchPeople } from './_rocketreach.js';
import { ATTEMPTS, decide, noteAttempt, websiteOf } from './_number-research.js';
import { loadBad, isBad } from './_bad-numbers.js';
import { SITE_PHONE } from './outreach-site-phone.js';
import { contactLinks } from './_site-phone.js';
import { industryFor } from './_industry.js';
import { IG_KEY, researchInstagram, MAX_CHECK_AGE_DAYS } from './_instagram-research.js';

const VENDOR = email => 'staffify:call-phone-vendor:' + String(email).toLowerCase();
const BUDGET_MS = 45000;
// Metered work is capped per run so a backlog cannot drain the credit balance in one pass.
const VENDOR_PER_RUN = Number(process.env.NUMBER_RESEARCH_VENDOR_PER_RUN || 8);
const SITE_PER_RUN = Number(process.env.NUMBER_RESEARCH_SITE_PER_RUN || 25);
const IG_PER_RUN = Number(process.env.INSTAGRAM_RESEARCH_PER_RUN || 12);
const EVIDENCE_PER_RUN = Number(process.env.PHONE_EVIDENCE_PER_RUN || 25);
const IDENTITY_PER_RUN = Number(process.env.IDENTITY_RESEARCH_PER_RUN || 10);
// Names run FIRST and on their own clock. Two runs in a row never reached McKinstry because the
// shared 45 seconds went on number research and website fetches ahead of it.
const IDENTITY_BUDGET_MS = Number(process.env.IDENTITY_RESEARCH_BUDGET_MS || 15000);

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
    // Who is this. Paul, 2026-10-23: a card that says "McKinstry" and no person is not enough to
    // call on; "the system should be capable of conducting research based on incomplete data."
    // For due records whose CRM contact has no first name: a vendor answer already paid for is
    // used first, then a RocketReach lookup inside the same per-run vendor budget as the numbers.
    // What is found fills the BLANK CRM fields only. The CEO cohort goes first; it is worked by name.
    const idn = { checked: 0, found: 0, credits: 0, skipped: 0 };
    try {
        const state = await redis.get(KEY);
        const due = visibleState(state, 'all').records.filter(r => r.callReady && r.recipient)
            .sort((a, b) => Number(b.campaignId === 'staffify-tobit-outreach') - Number(a.campaignId === 'staffify-tobit-outreach'));
        for (const row of due) {
            if (Date.now() - started > IDENTITY_BUDGET_MS) break;
            if (idn.checked >= IDENTITY_PER_RUN) break;
            const e = row.recipient.toLowerCase();
            if (await triedRecently(redis, e)) { idn.skipped++; continue; }
            let c = null;
            try { c = await contact(row.recipient); } catch { continue; }
            if (!c || !needsName(c.properties)) continue;
            idn.checked++;
            const vendorCached = await redis.get(VENDOR(e)).catch(() => null);
            const canSpend = rrConfigured() && vendorSpend < VENDOR_PER_RUN;
            try {
                const r = await researchIdentity({ redis, email: e, contactId: c.id, vendorCached, company: (c.properties && c.properties.company) || row.company || '',
                    lookup: canSpend ? (async a => { vendorSpend++; idn.credits++; return lookupByEmail(a); }) : null,
                    search: rrConfigured() ? searchPeople : null, fill: fillBlankContactProps });
                if (r.found) idn.found++;
            } catch (err) { out.failures.push({ company: row.company || row.recipient, why: 'identity: ' + String((err && err.message) || err).slice(0, 90) }); }
        }
    } catch (e) {
        out.failures.push({ company: 'identity pass', why: String((e && e.message) || e).slice(0, 120) });
    }

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
                // Skip any number a caller has already proved wrong for this person; take the first
                // published alternate that is not, or treat the site as having nothing usable.
                const bad = await loadBad(redis, row.recipient);
                if (hit && hit.phone && bad.size) {
                    const usable = [hit.phone, ...(hit.alternates || [])].find(n => !isBad(bad, n));
                    if (usable) { hit.alternates = [hit.phone, ...(hit.alternates || [])].filter(n => n !== usable && !isBad(bad, n)); hit.phone = usable; }
                    else hit.phone = null;
                }
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
                const badV = await loadBad(redis, row.recipient);
                if (r && r.found && r.phones && badV.size) r.phones = r.phones.filter(p => !isBad(badV, p.number));
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

    // Phone evidence: is the CRM number published on the business's own site? This used to run
    // live on first card open, up to three page fetches, and was most of the 2.1 seconds a caller
    // waited. It now runs here, bounded, newest-due first, and the card reads the stored answer.
    const ev = { checked: 0, listed: 0, unconfirmed: 0 };
    try {
        const state = await redis.get(KEY);
        const decorated = await withCallPhones(visibleState(state, 'all'), { redis, crm });
        const withNumber = decorated.records.filter(r => r.callReady && r.callContact && r.callContact.phone && websiteOf(r));
        for (const row of withNumber) {
            if (Date.now() - started > BUDGET_MS) break;
            if (ev.checked >= EVIDENCE_PER_RUN) break;
            try {
                const prior = await redis.get('staffify:call-phone-evidence:' + row.recipient).catch(() => null);
                if (prior && prior.checkedAt && Date.now() - Date.parse(prior.checkedAt) < 7 * 86400000) continue;
                ev.checked++;
                const result = await checkBusinessPhone({ phone: row.callContact.phone, website: websiteOf(row), fetchSite: site });
                await redis.set('staffify:call-phone-evidence:' + row.recipient, result, { ex: 14 * 86400 });
                if (result.status === 'business_listed') ev.listed++; else ev.unconfirmed++;
            } catch (e) {
                out.failures.push({ company: row.company || row.recipient, why: 'evidence: ' + String((e && e.message) || e).slice(0, 90) });
            }
        }
    } catch (e) {
        out.failures.push({ company: 'evidence pass', why: String((e && e.message) || e).slice(0, 120) });
    }

    // Instagram, for marketing agencies only, on the same pass. Paul asked for this to be a
    // datapoint a caller can see rather than something guessed at mid-call. It is the cheapest
    // possible look: their own website, which is also the only source that confirms the account
    // is actually theirs. Isolated per record like everything else here.
    const ig = { checked: 0, confirmed: 0, unresolved: 0 };
    try {
        const state = await redis.get(KEY);
        const all = visibleState(state, 'all').records.filter(r => r.callReady);
        const marketing = all.filter(r => {
            const g = industryFor({ campaignId: r.campaignId, company: r.company, excerpt: r.source?.excerpt });
            return g && g.key === 'marketing';
        });
        for (const row of marketing) {
            if (Date.now() - started > BUDGET_MS) break;
            if (ig.checked >= IG_PER_RUN) break;
            try {
                const prior = await redis.get(IG_KEY(row.recipient)).catch(() => null);
                // Re-look only when the evidence is stale or was never gathered.
                if (prior && prior.checkedAt && Date.now() - Date.parse(prior.checkedAt) < MAX_CHECK_AGE_DAYS * 86400000) continue;
                ig.checked++;
                const ev = await researchInstagram({ website: websiteOf(row), fetchSite: site, contactLinks });
                await redis.set(IG_KEY(row.recipient), ev, { ex: 120 * 86400 });
                if (ev.profileConfirmed) ig.confirmed++; else ig.unresolved++;
            } catch (e) {
                out.failures.push({ company: row.company || row.recipient, why: 'instagram: ' + String((e && e.message) || e).slice(0, 90) });
            }
        }
    } catch (e) {
        out.failures.push({ company: 'instagram pass', why: String((e && e.message) || e).slice(0, 120) });
    }

    const summary = {
        ...out, instagram: ig, evidence: ev, identity: idn, backlog: due.length, ranAt: new Date().toISOString(),
        note: 'A record that gained a number is promoted on the next queue read, where call eligibility is recomputed in full. Nothing is promoted past the four-email rule or the exclusions.',
    };
    try { await redis.set(LAST_RUN_KEY, { ...summary, failureCount: (summary.failures || []).length, failures: (summary.failures || []).slice(0, 8) }, { ex: 7 * 86400 }); } catch { /* the response still reports */ }
    return res.status(200).json(summary);
}
