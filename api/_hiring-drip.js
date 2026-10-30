// Enrolment for the Hiring now drip (api/_hiring-drip-copy.js): cards with a verified owner email into the hosted
// worker's queue. Each person gets a CRM contact first, because every draft and send re-checks the CRM
// (api/_outreach-crm.js). Two ways in, one rule set:
//   * the owner's machine action (api/hiring-intent.js drip-enroll): a batch, dry unless write, under the worker's lock;
//   * the worker itself (api/outreach-worker.js hiringSupply): a few new cards a tick, so a card that gets an
//     email address later is picked up without anyone running anything.
import { HIRING_DRIP_ID, SENDERS, dripCandidates, dripRow, dripSender, hiringDripCopy, rebalanceDripRows } from './_hiring-drip-copy.js';

const LOCK = 'outreach:cloud:lock';
const CAS = "local s=redis.call('GET',KEYS[1]); if not s or cjson.decode(s).revision~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";

/** The CRM properties for a card's owner. A phone goes on only when it is the owner's own looked-up mobile. */
export function contactProps(card) {
    const c = card.contact || {}, j = card.job || {}, ph = card.phone || {};
    const [first, ...rest] = String(c.name || c.firstName || '').trim().split(/\s+/);
    const own = ph.source === 'vendor' && /mobile/i.test(String(ph.lineType || '')) && /^\+1\d{10}$/.test(String(ph.number || ''));
    const props = { email: String(c.email).toLowerCase(), firstname: c.firstName || first || '', lastname: rest.join(' '), company: (card.company && card.company.name) || '',
        website: (card.company && card.company.website) || '', jobtitle: c.role || '', city: j.city || '', state: j.usState || '', country: 'United States',
        lifecyclestage: 'lead', rep_email_verified: 'verified', ...(own ? { mobilephone: ph.number } : {}) };
    return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== ''));
}

/** True when the drip runs at all: the worker's allowlist names it (or there is no allowlist). */
export const dripAllowed = cfg => !Array.isArray(cfg && cfg.allowedCampaignIds) || cfg.allowedCampaignIds.includes(HIRING_DRIP_ID);

/**
 * The rows to add for up to `limit` cards. Writes CRM contacts only when write is true; never touches the queue.
 * crm: { find(email) -> contacts[], create(props), patch(id, props) }; block(row, { created }) -> reason or null.
 */
export async function prepareDripRows({ state, cfg, cards, crm, block, limit = 25, write = false, now = Date.now() }) {
    const { cards: picks, skipped } = dripCandidates(cards, state, { limit });
    const results = [], rows = [];
    for (const card of picks) {
        const email = String(card.contact.email).toLowerCase();
        const out = { id: card.id, company: card.company && card.company.name, email, person: card.contact.name || card.contact.firstName };
        results.push(out);
        try {
            const found = await crm.find(email);
            if (found.length > 1) { out.result = 'skipped'; out.why = 'Two CRM contacts share this address'; continue; }
            const p = (found[0] && found[0].properties) || {};
            if (p.rep_email_verified && p.rep_email_verified !== 'verified') { out.result = 'skipped'; out.why = 'The CRM marks this address ' + p.rep_email_verified; continue; }
            const owner = ((state.assignments || []).find(a => a.email === email) || {}).owner;
            const row = dripRow(card, { account: dripSender(cfg.accounts, [...state.records, ...rows], { owner: SENDERS.includes(owner) ? owner : null }), now });
            if (!write) {
                const why = found.length ? await block(row, { created: false }) : null;
                if (why) { out.result = 'skipped'; out.why = why; continue; }
                out.result = found.length ? 'would_enroll' : 'would_create_contact_and_enroll'; out.sender = row.sender;
                if (results.length <= 3) out.preview = hiringDripCopy(card);
                continue;
            }
            if (!found.length) await crm.create(contactProps(card));
            else if (p.rep_email_verified !== 'verified') await crm.patch(found[0].id, { rep_email_verified: 'verified' });
            const why = await block(row, { created: !found.length });
            if (why) { out.result = 'skipped'; out.why = why; continue; }
            rows.push(row); out.result = 'enroll'; out.sender = row.sender;
        } catch (e) { out.result = 'skipped'; out.why = String(e && e.message || e).slice(0, 160); }
    }
    return { rows, results, skipped: Object.fromEntries(Object.entries(skipped).map(([k, v]) => [k, v.length])), skippedCards: skipped };
}

/** Rows into a state the caller holds the lock for; anyone tracked or suppressed since is dropped. Returns the rows added. */
export function addDripRows(state, rows) {
    const tracked = new Set(state.records.map(r => String(r.recipient || '').toLowerCase()));
    const cards = new Set(state.records.map(r => r.hiringId).filter(Boolean));
    const fresh = rows.filter(r => !tracked.has(r.recipient) && !cards.has(r.hiringId) && !(state.suppressions || []).includes(r.recipient));
    state.records.push(...fresh);
    return fresh;
}

/**
 * The machine action: a batch, under the worker's lock. deps: { redis, queueKey, config(), stored(), saveConfig(cfg), records(), crm, block, sleep, now }.
 * allow: also add the campaign to the worker's allowlist, which is what starts drafting and sending.
 */
export async function enrollHiringDrip(deps, { write = false, limit = 25, allow = false, rebalance = true } = {}) {
    const { redis, queueKey, now = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = deps;
    const cfg = await deps.config();
    const state = await redis.get(queueKey);
    if (!state) throw Error('Queue unavailable');
    const cards = await deps.records();
    const prep = await prepareDripRows({ state, cfg, cards, crm: deps.crm, block: deps.block, limit, write, now });
    const summary = { candidates: prep.results.length, enrolled: 0, skipped: prep.skipped };
    if (!write || (!prep.rows.length && !allow && !rebalance)) return { write, summary, results: prep.results, skippedCards: prep.skippedCards };

    // The worker holds its lock for each tick (about a minute apart); wait for a gap rather than race it.
    const nonce = 'hiring-drip-' + now + '-' + Math.random().toString(36).slice(2);
    let locked = false;
    for (let i = 0; i < 45 && !locked; i++) { locked = !!await redis.set(LOCK, nonce, { nx: true, ex: 120 }); if (!locked) await sleep(2000); }
    if (!locked) return { write, summary: { ...summary, error: 'The email worker stayed busy; nothing was enrolled. Run again.' }, results: prep.results };
    try {
        const live = await redis.get(queueKey);
        const rev = live.revision;
        const fresh = addDripRows(live, prep.rows);
        // New and not-yet-started rows are spread over every inbox together, so one batch never lands on a few.
        const moved = rebalance ? rebalanceDripRows(live, new Map(cards.map(c => [c.id, c])), cfg.accounts, now) : 0;
        summary.rebalanced = moved;
        if (fresh.length || moved) {
            const next = { ...live, revision: rev + 1, queueUpdatedAt: new Date(now).toISOString() };
            if (Number(await redis.eval(CAS, [queueKey], [String(rev), JSON.stringify(next)])) !== 1) throw Error('The queue changed during enrolment; run again');
        }
        const byCard = new Map(live.records.filter(x => x.hiringId).map(x => [x.hiringId, x]));
        for (const r of prep.results) if (r.result === 'enroll') { r.result = fresh.some(x => x.hiringId === r.id) ? 'enrolled' : 'skipped'; if (byCard.has(r.id)) r.sender = byCard.get(r.id).sender; }
        summary.enrolled = fresh.length;
        summary.waitingByInbox = live.records.filter(x => x.campaignId === HIRING_DRIP_ID && x.status === 'prepared').reduce((m, x) => (m[x.sender] = (m[x.sender] || 0) + 1, m), {});
        if (allow) {
            const stored = await deps.stored();
            const ids = Array.isArray(stored.allowedCampaignIds) ? stored.allowedCampaignIds : null;
            // No allowlist at all means every campaign already runs; only an explicit list needs this one added.
            if (ids && !ids.includes(HIRING_DRIP_ID)) { await deps.saveConfig({ ...stored, allowedCampaignIds: [...ids, HIRING_DRIP_ID], updatedAt: new Date(now).toISOString() }); summary.allowed = 'added'; }
            else summary.allowed = 'already';
        }
    } finally { await redis.eval(RELEASE, [LOCK], [nonce]); }
    return { write, summary, results: prep.results, skippedCards: prep.skippedCards };
}

/**
 * The worker's own top-up, inside its tick (it already holds the lock): at most `limit` new cards, at most every ten
 * minutes, and only while fewer than ten hiring introductions wait to be drafted.
 */
export async function hiringSupply({ state, cfg, redis, records, crm, block, limit = 5, now = Date.now() }) {
    if (!dripAllowed(cfg)) return { skipped: 'not allowed' };
    const waiting = state.records.filter(r => r.campaignId === HIRING_DRIP_ID && r.status === 'prepared').length;
    if (waiting >= 10) return { waiting };
    if (!await redis.set('staffify:hiring-drip:supply', String(now), { nx: true, ex: 600 })) return { waiting, rested: true };
    const prep = await prepareDripRows({ state, cfg, cards: await records(), crm, block, limit, write: true, now });
    return { waiting, added: addDripRows(state, prep.rows).length, skipped: prep.skipped };
}
