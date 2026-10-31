// The lead agent's endpoint (api/_lead-agent.js). Authorization: Bearer <the agent's key>, from Paul's Staffify vault.
// ------------------------------------------------------------------
//   GET                                            the day so far: lookups used and left, leads submitted
//   POST {action:'check', items:[{company, website|domain, phone, email}]}   known already? (max 100)
//   POST {action:'people', company}                who runs it, by title (RocketReach search, free)
//   POST {action:'lookup', id | name+company}      one person's numbers and addresses (counts against the day's cap)
//   POST {action:'collect', ids:[...]}             lookups RocketReach was still finishing (free)
//   POST {action:'phone', numbers:[...]}           what the carrier says each number is (up to 10, inside the day's cap)
//   POST {action:'submit', leads:[...]}            up to 25 leads into the Hiring now pending queue
// Nothing here calls, texts or emails anyone. Submitted leads meet every Hiring now check when the hourly run works them.
import { redis, readBody } from './_auth.js';
import { KEY } from './_outreach-queue.js';
import { HK, allRecords, parseValue, qualifyLead, tollFree, leadKey, leadDomain } from './_hiring-intent.js';
import { addPending, cellMatch } from './_hiring-run.js';
import { optedOutSet } from './_optout.js';
import { rrConfigured, account, lookupPerson, checkStatus, searchPeople, profileOf } from './_rocketreach.js';
import { dayKey } from './_outreach-policy.js';
import { agentAuthorized, knownIndex, knownWhy, leadProblem, businessLine, capLookup, agentProfile, remember, phoneCheck, rememberLines, lineProof, provenPhone, carrierLookup, carrierConfigured, freeCellsOn, LEAD_FIELDS, LOOKUPS_PER_DAY, CHECKS_PER_DAY, LEAD_AGENT_KEYS as K } from './_lead-agent.js';

// The Hub's own test for a RocketReach profile (api/_hiring-run.js cellMatch): this lead's owner, at this business, in its
// state. The domain is the Hub's (a shared host like statefarm.com or facebook.com ties nobody), and a profile with no
// state is refused, as the Hub does for ids found by a people search.
// The state is the one the Hub files the card under (qualifyLead), never the raw field. When the tie is not the
// business's own domain (a carrier agency, a franchise, a shared host, no website), the person must also hold an owner's
// or agent's title and be in the business's city: another State Farm agent named John Smith in Houston is not this one.
const OWNERISH = /\b(owner|co-?owner|founder|co-?founder|president|principal|ceo|proprietor|managing|partner|agent|agency|broker|attorney|lawyer|esq|member|director|operator|franchisee)\b/i;
export const ownerMatch = (l, proof, now = Date.now()) => {
    const dom = l.website ? leadDomain(l.website) : null;
    const usState = ((qualifyLead(l, now) || {}).usState) || (/^[A-Za-z]{2}$/.test(String(l.state || '').trim()) ? String(l.state).trim().toUpperCase() : null);
    const m = cellMatch({ company: { name: l.business, domain: dom }, contact: { name: [l.owner_first, l.owner_last].filter(Boolean).join(' ') }, job: { usState } },
        { name: proof.person, employer: proof.employer, employerDomain: proof.employerDomain, title: proof.title, region: proof.region, location: proof.location }, { strictState: true });
    if (!m.ok) return m;
    const ownDomain = !!(dom && proof.employerDomain && String(proof.employerDomain).toLowerCase().replace(/^www\./, '') === dom);
    if (ownDomain) return m;
    if (!OWNERISH.test(String(proof.title || ''))) return { ok: false, why: `${proof.person} is listed as ${proof.title || 'no title'} at ${proof.employer || 'an unknown employer'}, not as its owner` };
    const city = String(l.city || '').split(',')[0].trim().toLowerCase();
    if (city && !String(proof.location || '').toLowerCase().includes(city)) return { ok: false, why: `${proof.person} is in ${proof.location || 'an unknown city'}, the business is in ${l.city}` };
    return m;
};

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!agentAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const now = Date.now(), day = dayKey(now);
    const index = () => knownIndex({ cards: () => allRecords(redis), pending: async () => Object.values((await redis.hgetall(HK.pending)) || {}).map(parseValue).filter(Boolean), queue: () => redis.get(KEY), stops: () => optedOutSet({ strict: true }) });
    try {
        const body = req.method === 'POST' ? readBody(req) || {} : {};
        const action = req.method === 'GET' ? 'status' : String(body.action || '');
        if (action === 'status') {
            const [used, submitted, checked] = await Promise.all([redis.get(K.lookups(day)), redis.get(K.submitted(day)), redis.get(K.checks(day))]);
            const cap = LOOKUPS_PER_DAY(), ccap = CHECKS_PER_DAY();
            return res.status(200).json({ day, lookups_used: Number(used) || 0, lookups_cap: cap, lookups_left: Math.max(0, cap - (Number(used) || 0)), submitted_today: Number(submitted) || 0, rocketreach: rrConfigured(),
                carrier_check: carrierConfigured(), free_cells: freeCellsOn(), phone_checks_used: Number(checked) || 0, phone_checks_left: carrierConfigured() ? Math.max(0, ccap - (Number(checked) || 0)) : 0 });
        }
        if (action === 'check') {
            const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100);
            if (!items.length) return res.status(400).json({ error: 'items: [{company, website, phone, email}]' });
            const idx = await index();
            return res.status(200).json({ results: items.map((it, i) => { const why = knownWhy(idx, it || {}); return { i, company: it && it.company || null, known: !!why, why }; }) });
        }
        if (action === 'people') {
            if (!rrConfigured()) return res.status(503).json({ error: 'RocketReach is not configured' });
            const company = String(body.company || '').trim().slice(0, 120);
            if (!company) return res.status(400).json({ error: 'company is required' });
            const r = await searchPeople({ company, ...(Array.isArray(body.titles) && body.titles.length ? { titles: body.titles.slice(0, 12).map(String) } : {}) });
            return res.status(r.fatal ? 503 : 200).json({ profiles: r.profiles || [], reason: r.reason || null });
        }
        if (action === 'lookup') {
            if (!rrConfigured()) return res.status(503).json({ error: 'RocketReach is not configured' });
            const r = await capLookup({ kv: redis, rr: { account, lookupPerson }, day }, { id: body.id ? String(body.id).slice(0, 40) : null, name: String(body.name || '').trim().slice(0, 120), company: String(body.company || '').trim().slice(0, 120) });
            if (!r.ok) return res.status(r.status || 400).json({ error: r.error, lookups_left: r.lookups_left });
            return res.status(200).json(r);
        }
        if (action === 'collect') {
            if (!rrConfigured()) return res.status(503).json({ error: 'RocketReach is not configured' });
            const ids = (Array.isArray(body.ids) ? body.ids : []).slice(0, 20).map(String);
            const st = await checkStatus(ids);
            const results = ids.map(id => { const s = st[id]; return { id, done: !!(s && s.done), profile: s ? agentProfile(s.profile || profileOf({ id, name: s.name, phones: s.phones })) : null }; });
            for (const r of results) if (r.profile) await rememberLines(redis, r.profile).catch(() => {});
            return res.status(200).json({ results });
        }
        if (action === 'phone') {
            if (!carrierConfigured()) return res.status(503).json({ error: 'The carrier check is not connected yet. For this owner, use one lookup if lookups are left; otherwise skip the lead.' });
            const numbers = (Array.isArray(body.numbers) ? body.numbers : []).slice(0, 10).map(String);
            if (!numbers.length) return res.status(400).json({ error: 'numbers: ["5615550100", ...] (up to 10)' });
            return res.status(200).json({ results: await phoneCheck({ kv: redis, day, lookup: d => carrierLookup(d), tollFree }, numbers, now) });
        }
        if (action === 'submit') {
            const leads = (Array.isArray(body.leads) ? body.leads : []).slice(0, 25).map(x => Object.fromEntries(LEAD_FIELDS.map(f => [f, x && x[f] != null ? String(x[f]).trim().slice(0, f === 'notes' || f === 'phone_evidence' ? 600 : 300) : null])));
            if (!leads.length) return res.status(400).json({ error: 'leads: [...] (up to 25)' });
            const idx = await index();
            const at = new Date(now).toISOString(), results = [];
            let accepted = 0;
            for (const [i, l] of leads.entries()) {
                const proof = await lineProof(redis, l.phone);
                const problem = leadProblem(l, { idx, qualify: qualifyLead, tollFree, proof, match: (lead, p) => ownerMatch(lead, p, now), freeCells: freeCellsOn(), now });
                if (problem) { results.push({ i, business: l.business, accepted: false, why: problem }); continue; }
                // A business line goes in as the company's main line (callers ask for the owner); a cell as the proven cell.
                Object.assign(l, businessLine(l) ? { phone_type: "main line (the business's own published number)", phone_source: null } : provenPhone(l, proof));
                const key = leadKey(l);
                if (await redis.hget(HK.pending, key)) { results.push({ i, business: l.business, accepted: false, why: 'already waiting to be checked' }); continue; }
                await addPending(redis, { kind: 'lead', key, lead: { ...l, vertical: l.vertical || 'lead agent' } }, { seed: true, discoveredBy: 'provided', source: 'Lead agent', addedBy: 'lead-agent', discoveredAt: at, file: 'lead-agent ' + day });
                remember(idx, l);   // a second lead for the same business in this batch is a duplicate too
                accepted++;
                results.push({ i, business: l.business, accepted: true });
            }
            if (accepted) { await redis.incrby(K.submitted(day), accepted); await redis.expire(K.submitted(day), 7 * 86400); }
            await redis.lpush(K.log, JSON.stringify({ at, received: leads.length, accepted, refused: leads.length - accepted })).catch(() => {});
            await redis.ltrim(K.log, 0, 199).catch(() => {});
            return res.status(200).json({ received: leads.length, accepted, refused: leads.length - accepted, results });
        }
        return res.status(400).json({ error: 'Unknown action. Use check, people, lookup, collect, phone or submit.' });
    } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
}
