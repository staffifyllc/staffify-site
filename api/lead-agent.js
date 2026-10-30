// The lead agent's endpoint (api/_lead-agent.js). Authorization: Bearer <the agent's key>, from Paul's Staffify vault.
// ------------------------------------------------------------------
//   GET                                            the day so far: lookups used and left, leads submitted
//   POST {action:'check', items:[{company, website|domain, phone, email}]}   known already? (max 100)
//   POST {action:'people', company}                who runs it, by title (RocketReach search, free)
//   POST {action:'lookup', id | name+company}      one person's numbers and addresses (counts against the day's cap)
//   POST {action:'collect', ids:[...]}             lookups RocketReach was still finishing (free)
//   POST {action:'submit', leads:[...]}            up to 25 leads into the Hiring now pending queue
// Nothing here calls, texts or emails anyone. Submitted leads meet every Hiring now check when the hourly run works them.
import { redis, readBody } from './_auth.js';
import { KEY } from './_outreach-queue.js';
import { HK, allRecords, parseValue, qualifyLead, tollFree, leadKey } from './_hiring-intent.js';
import { addPending } from './_hiring-run.js';
import { optedOutSet } from './_optout.js';
import { rrConfigured, account, lookupPerson, checkStatus, searchPeople, profileOf } from './_rocketreach.js';
import { dayKey } from './_outreach-policy.js';
import { agentAuthorized, knownIndex, knownWhy, leadProblem, capLookup, agentProfile, remember, LEAD_FIELDS, LOOKUPS_PER_DAY, LEAD_AGENT_KEYS as K } from './_lead-agent.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!agentAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
    const now = Date.now(), day = dayKey(now);
    const index = () => knownIndex({ cards: () => allRecords(redis), pending: async () => Object.values((await redis.hgetall(HK.pending)) || {}).map(parseValue).filter(Boolean), queue: () => redis.get(KEY), stops: () => optedOutSet({ strict: true }) });
    try {
        const body = req.method === 'POST' ? readBody(req) || {} : {};
        const action = req.method === 'GET' ? 'status' : String(body.action || '');
        if (action === 'status') {
            const [used, submitted] = await Promise.all([redis.get(K.lookups(day)), redis.get(K.submitted(day))]);
            const cap = LOOKUPS_PER_DAY();
            return res.status(200).json({ day, lookups_used: Number(used) || 0, lookups_cap: cap, lookups_left: Math.max(0, cap - (Number(used) || 0)), submitted_today: Number(submitted) || 0, rocketreach: rrConfigured() });
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
            return res.status(200).json({ results: ids.map(id => { const s = st[id]; return { id, done: !!(s && s.done), profile: s ? agentProfile(s.profile || profileOf({ id, name: s.name, phones: s.phones })) : null }; }) });
        }
        if (action === 'submit') {
            const leads = (Array.isArray(body.leads) ? body.leads : []).slice(0, 25).map(x => Object.fromEntries(LEAD_FIELDS.map(f => [f, x && x[f] != null ? String(x[f]).trim().slice(0, f === 'notes' ? 600 : 300) : null])));
            if (!leads.length) return res.status(400).json({ error: 'leads: [...] (up to 25)' });
            const idx = await index();
            const at = new Date(now).toISOString(), results = [];
            let accepted = 0;
            for (const [i, l] of leads.entries()) {
                const problem = leadProblem(l, { idx, qualify: qualifyLead, tollFree, now });
                if (problem) { results.push({ i, business: l.business, accepted: false, why: problem }); continue; }
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
        return res.status(400).json({ error: 'Unknown action. Use check, people, lookup, collect or submit.' });
    } catch (e) {
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
}
