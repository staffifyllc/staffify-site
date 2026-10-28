// A Quo contact for every Hiring now card, so a callback shows who it is.
// ------------------------------------------------------------------
// Paul, 2026-10-28: "I also want you to create a contact card or something so that if these numbers call back
// we know whos who". Quo shows a caller's name when the calling number belongs to one of its contacts, so each
// card a rep can call (or has called) gets one: the person, the business, the job they posted, and every number
// on the card. A toll-free line is never added. The card id is the contact's externalId, so a contact is created
// once and updated in place when the card's numbers or person change; nothing is ever deleted from Quo.
//
// Quo's contacts live on its v1 API (api.quo.com/v1/contacts): POST creates, PATCH /contacts/{id} REPLACES the
// contact (every field is sent each time, phone numbers included), GET ?externalIds= finds one.
import { createHash } from 'node:crypto';
import { quoKey } from './_quo.js';
import { allRecords, tollFree } from './_hiring-intent.js';
import { spokenRole } from './_call-scripts.js';

const BASE = 'https://api.quo.com/v1';
export const QK = { synced: 'staffify:quo-contacts' };   // hash: card id -> { quoId, fp, at }
export const SOURCE = 'staffify-hub';

/** The contact a card should have in Quo, or null when it has no number to call. */
export function contactOf(rec) {
    const ph = rec && rec.phone || {};
    const numbers = [ph.number, ...(ph.alternates || [])].filter((n, i, a) => n && /^\+1\d{10}$/.test(n) && !tollFree(n) && a.indexOf(n) === i).slice(0, 8);
    if (!numbers.length) return null;
    const c = rec.contact || {};
    const person = String(c.name || (ph.source === 'vendor' && ph.person) || '').trim();
    const [first, ...rest] = person.split(/\s+/);
    const company = String(rec.company && rec.company.name || '').trim().slice(0, 120);
    const role = ['Hiring: ' + (spokenRole(rec.job && rec.job.title) || 'open role'), c.role].filter(Boolean).join(' · ').slice(0, 120);
    const label = (n, i) => i === 0 ? (ph.source === 'vendor' && ph.person ? (ph.lineType === 'mobile' ? 'Owner mobile' : 'Owner line') : 'Main line') : 'Other';
    return {
        externalId: rec.id, source: SOURCE, sourceUrl: 'https://www.gostaffify.com/dialer/?open=' + encodeURIComponent(rec.id),
        defaultFields: {
            firstName: (first || company || 'Hiring now prospect').slice(0, 60),
            lastName: rest.join(' ').slice(0, 60),
            company, role,
            phoneNumbers: numbers.map((n, i) => ({ name: label(n, i), value: n })),
            emails: c.email ? [{ name: 'Work', value: String(c.email).toLowerCase() }] : [],
        },
    };
}
export const fingerprint = c => createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 16);

async function quo(method, path, body) {
    const key = quoKey();
    if (!key) { const e = new Error('No Quo API key is set'); e.status = 0; throw e; }
    const r = await fetch(BASE + path, { method, headers: { Authorization: key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { j = null; }
    if (!r.ok) { const e = new Error(`Quo ${r.status}: ${(j && (j.message || j.title)) || text.slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
}
export const quoContactsApi = {
    create: c => quo('POST', '/contacts', c).then(j => j && j.data),
    update: (id, c) => quo('PATCH', '/contacts/' + encodeURIComponent(id), c).then(j => j && j.data),
    byExternalId: id => quo('GET', '/contacts?maxResults=1&externalIds=' + encodeURIComponent(id)).then(j => (j && j.data || [])[0] || null),
};

/**
 * Create or update the Quo contact of every card that can be called or has been, a bounded number a run.
 * deps: { kv, api (quoContactsApi), now }. Dry unless `write`. Returns what it did, card by card.
 */
export async function syncQuoContacts(deps, { limit = 40, write = false } = {}) {
    const { kv } = deps, api = deps.api || quoContactsApi;
    const at = new Date(deps.now || Date.now()).toISOString();
    const out = { created: 0, updated: 0, unchanged: 0, skipped: 0, errors: [], planned: [] };
    let synced;
    try { synced = (await kv.hgetall(QK.synced)) || {}; } catch (e) { out.errors.push('the sync record could not be read'); return out; }
    const parse = v => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
    const cards = (await allRecords(kv)).filter(r => ['ready', 'conversation'].includes(r.status) || (r.callHistory || []).length);
    let done = 0;
    for (const rec of cards) {
        const c = contactOf(rec);
        if (!c) { out.skipped++; continue; }
        const fp = fingerprint(c), prev = parse(synced[rec.id]);
        if (prev && prev.fp === fp) { out.unchanged++; continue; }
        if (done >= limit) break;
        done++;
        out.planned.push({ id: rec.id, company: c.defaultFields.company, action: prev && prev.quoId ? 'update' : 'create', numbers: c.defaultFields.phoneNumbers.length });
        if (!write) continue;
        try {
            let quoId = prev && prev.quoId;
            // A contact made on an earlier run whose record here was lost: found by the card id, not made twice.
            if (!quoId) { const found = await api.byExternalId(rec.id).catch(() => null); quoId = found && found.id || null; }
            if (quoId) { await api.update(quoId, c); out.updated++; }
            else { const made = await api.create(c); quoId = made && made.id; out.created++; }
            if (quoId) await kv.hset(QK.synced, { [rec.id]: JSON.stringify({ quoId, fp, at }) });
        } catch (e) {
            out.errors.push(`${c.defaultFields.company}: ${String(e && e.message || e).slice(0, 120)}`);
            if (e && (e.status === 401 || e.status === 403 || e.status === 0)) break;   // a key problem stops the run
            if (e && e.status === 429) break;                                          // rate limited: next run
        }
    }
    return out;
}
