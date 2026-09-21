// NOBODY WHO HAS PAID US EVER GETS PITCHED, AND A CHECK THAT FAILED IS NEVER A PASS.
//
// Paul, 2026-09-21: "landing nest IS a client." It was not in the hand-maintained CSV that seven
// scripts read before sending cold email, and a queued sync was about to cold pitch a paying
// customer at homestarphoto.com. HubSpot had it right the whole time.
//
// ~/Claude Code/staffify-client-guard.js is the authority and unions three sources: HubSpot
// customers, the talent console roster, and the CSV. Two of those are not reachable from a Vercel
// function, so this reads a SNAPSHOT that the local guard uploads, and unions it with its own live
// HubSpot pull. If a source that should be there is missing or stale, the answer is `unknown`, not
// `clear`, because a guard that fails open is not a guard.
//
//   clientCheck({ email, company })
//     -> { status: 'client',  reason, matched: 'email' }   certain: this exact address has paid us
//     -> { status: 'possible', reason, matched: 'company' } a normalised company-name match: REVIEW
//     -> { status: 'clear' }                                 every source answered and none matched
//     -> { status: 'unknown', why }                          a source could not be established
//
// A company-name match is deliberately NOT 'client'. Normalising strips llc, inc, media, studios,
// group and productions, which is what makes "Coral Cove Media LLC" match "coral cove", and also
// what would make two unrelated businesses collide. That is a flag for a person, not a verdict.
import { createHash } from 'node:crypto';
import SHIPPED from './_client-snapshot.json' with { type: 'json' };

// Redis is loaded on demand rather than at import time. Importing _auth.js pulls in the Upstash
// client, which is not present outside the deployment, and a guard whose behaviour cannot be
// executed in a test is a guard nobody has actually checked.
let _redis = null;
async function store(deps) {
    if (deps && deps.redis) return deps.redis;
    if (_redis) return _redis;
    ({ redis: _redis } = await import('./_auth.js'));
    return _redis;
}

const HS_CACHE = 'clients:hubspot:cache';        // this module's own live pull
const SNAPSHOT = 'clients:snapshot';             // uploaded by the local guard: roster + CSV + HubSpot
// The talent console roster and the active-clients CSV are not reachable from a serverless function,
// so the union the local guard computes ships with the code as a hashed snapshot. Hashed, because a
// client list in a repository is a client list that leaks, and the guard only ever asks whether a
// given address is one of them. An uploaded snapshot takes precedence when it is fresher.
const hashOf = (v) => createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex').slice(0, 32);
const CACHE_TTL_SECONDS = 24 * 3600;
const SNAPSHOT_MAX_AGE_HOURS = 24 * 8;           // the local guard warns at 7 days; we refuse at 8
const STALE_WARN_HOURS = 36;
const token = () => process.env.HUBSPOT_TOKEN || '';

/** Company names collide on legal suffixes and the words every media company uses. Strip them. */
export function normCompany(v) {
    return String(v || '').toLowerCase()
        .replace(/\b(llc|inc|ltd|co|corp|company|studios?|media|group|productions?)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
}

async function fetchCustomers(fetchImpl = fetch) {
    const t = token();
    if (!t) return { ok: false, why: 'HUBSPOT_TOKEN is not set' };
    const emails = [], companies = [];
    let after = null;
    for (let i = 0; i < 25; i++) {
        let r;
        try {
            r = await fetchImpl('https://api.hubapi.com/crm/v3/objects/contacts/search', {
                method: 'POST',
                headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }] }],
                    properties: ['email', 'company'], limit: 100, ...(after ? { after } : {}),
                }),
                signal: AbortSignal.timeout(20000),
            });
        } catch (e) { return { ok: false, why: 'HubSpot did not answer' }; }
        if (!r.ok) return { ok: false, why: `HubSpot answered ${r.status}` };
        const j = await r.json().catch(() => null);
        if (!j) return { ok: false, why: 'HubSpot sent nothing readable' };
        for (const c of j.results || []) {
            const p = c.properties || {};
            if (p.email) emails.push(String(p.email).toLowerCase());
            const n = normCompany(p.company);
            if (n.length >= 4) companies.push(n);
        }
        after = j.paging && j.paging.next && j.paging.next.after;
        if (!after) break;
    }
    return { ok: true, emails: [...new Set(emails)], companies: [...new Set(companies)] };
}

export async function refreshClients(deps = {}) {
    const kv = await store(deps);
    const got = await fetchCustomers(deps.fetch);
    if (!got.ok) return { ok: false, why: got.why };
    const doc = { ts: new Date().toISOString(), emails: got.emails, companies: got.companies };
    try { await kv.set(HS_CACHE, JSON.stringify(doc), { ex: CACHE_TTL_SECONDS }); }
    catch (e) { return { ok: false, why: 'the customer list was read but could not be cached' }; }
    return { ok: true, emails: got.emails.length, companies: got.companies.length, at: doc.ts };
}

/** The uploaded snapshot if it is fresher than the shipped one, otherwise what shipped with the code. */
async function bestSnapshot(kv) {
    // Reads the KEY. An earlier edit replaced this call with bestSnapshot(store) itself, which is an
    // infinite recursion on every guard call, which is to say on every inbound request.
    const uploaded = await readJson(kv, SNAPSHOT);
    if (uploaded === undefined) return undefined;            // the read itself failed
    const shipped = SHIPPED && Array.isArray(SHIPPED.emails) ? SHIPPED : null;
    if (!uploaded) return shipped;
    if (!shipped) return uploaded;
    return Date.parse(uploaded.ts) >= Date.parse(shipped.ts) ? uploaded : shipped;
}

/** Store the union the local guard computed. Called by the admin upload endpoint. */
export async function putSnapshot(doc, deps = {}) {
    const kv = await store(deps);
    const emails = [...new Set((doc.emails || []).map((e) => String(e).toLowerCase()))];
    const companies = [...new Set((doc.companies || []).map((c) => String(c)))];
    if (!emails.length) return { ok: false, why: 'an empty snapshot would open every path at once' };
    const body = { ts: new Date().toISOString(), emails, companies, sources: doc.sources || [] };
    try { await kv.set(SNAPSHOT, JSON.stringify(body)); }
    catch (e) { return { ok: false, why: 'the snapshot could not be stored' }; }
    return { ok: true, emails: emails.length, companies: companies.length, at: body.ts };
}

async function readJson(kv, key) {
    try {
        const raw = await kv.get(key);
        if (!raw) return null;
        const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return (doc && Array.isArray(doc.emails)) ? doc : null;
    } catch (e) { return undefined; }        // undefined means the read itself failed
}

const ageHours = (ts) => (Date.now() - Date.parse(ts)) / 3600000;

/**
 * Is this person already a client? Four answers, and two of them are not "no".
 * deps lets tests inject their own store and refresher without touching Redis.
 */
export async function clientCheck({ email, company }, deps = {}) {
    const kv = await store(deps);
    const refresh = deps.refreshClients || refreshClients;

    const snap = await bestSnapshot(kv);
    let hsDoc = await readJson(kv, HS_CACHE);
    if (hsDoc === null) {
        const r = await refresh(deps);
        if (r.ok) hsDoc = await readJson(kv, HS_CACHE);
        else hsDoc = undefined;
    }

    const missing = [];
    if (hsDoc === undefined || !hsDoc) missing.push('the live HubSpot customer list');
    if (snap === undefined) missing.push('the shared client snapshot (its read failed)');
    else if (!snap) missing.push('the shared client snapshot (never uploaded)');
    else if (ageHours(snap.ts) > SNAPSHOT_MAX_AGE_HOURS) {
        missing.push(`the shared client snapshot (${Math.round(ageHours(snap.ts) / 24)} days old, older than the ${SNAPSHOT_MAX_AGE_HOURS / 24} day limit)`);
    }

    const emails = new Set([...(hsDoc && hsDoc.emails || []), ...(snap && snap.emails || [])]);
    const companies = new Set([...(hsDoc && hsDoc.companies || []), ...(snap && snap.companies || [])]);

    const e = String(email || '').toLowerCase().trim();
    if (e && (emails.has(e) || emails.has(hashOf(e)))) {
        return { status: 'client', reason: 'already a client', matched: 'email', sources: sourceList(hsDoc, snap) };
    }
    const n = normCompany(company);
    if (n.length >= 4 && (companies.has(n) || companies.has(hashOf(n)))) {
        // Deliberately not a verdict. Normalisation is lossy and this has to be looked at.
        return { status: 'possible', matched: 'company',
            reason: `the company name normalises to "${n}", which matches an existing client. Check before treating this as a prospect.`,
            sources: sourceList(hsDoc, snap) };
    }
    // Only now may we say clear, and only if every source actually answered.
    if (missing.length) {
        return { status: 'unknown', why: `no match found, but ${missing.join(' and ')} could not be established, so this is not a clear` };
    }
    return { status: 'clear', sources: sourceList(hsDoc, snap), stale: ageHours(hsDoc.ts) > STALE_WARN_HOURS };
}

function sourceList(hsDoc, snap) {
    const out = [];
    if (hsDoc) out.push({ source: 'hubspot-live', at: hsDoc.ts, emails: hsDoc.emails.length });
    if (snap) out.push({ source: 'shared-snapshot', at: snap.ts, emails: snap.emails.length, from: snap.sources || [] });
    return out;
}

/** For the health panel: every source, how old, and whether the guard can currently answer. */
export async function guardHealth(deps = {}) {
    const kv = await store(deps);
    const snap = await bestSnapshot(kv);
    const hsDoc = await readJson(kv, HS_CACHE);
    const problems = [];
    if (!token()) problems.push('HUBSPOT_TOKEN is not set');
    if (!hsDoc) problems.push('no live HubSpot customer cache');
    if (!snap) problems.push('no shared client snapshot is available');
    else if (ageHours(snap.ts) > SNAPSHOT_MAX_AGE_HOURS) problems.push(`the shared snapshot is ${Math.round(ageHours(snap.ts) / 24)} days old`);
    return {
        canAnswer: problems.length === 0,
        problems,
        hubspot: hsDoc ? { at: hsDoc.ts, emails: hsDoc.emails.length, companies: hsDoc.companies.length, ageHours: Math.round(ageHours(hsDoc.ts)) } : null,
        snapshot: snap ? { at: snap.ts, emails: snap.emails.length, companies: snap.companies.length, sources: snap.sources || [], ageHours: Math.round(ageHours(snap.ts)) } : null,
    };
}
