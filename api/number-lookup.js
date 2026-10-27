// GET /api/number-lookup/?phone=<number>  ->  who this number is, for a number with no prospect card.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "search bars not working, who is this person??" about (404) 550-5181, which
// had called Milton back and was on no card. The dialer's search asks here when a ten-digit number
// matches nothing. Read-only: it changes nothing in Quo, HubSpot or the queue.
//
// Three sources, each reported for what it is:
//   cards     prospects whose number or call notes already carry it (certain)
//   quo       calls with this number on every Quo line, in or out (what happened, when, who answered)
//   hubspot   a contact with this phone or mobile (who the CRM says it is)
// and `likely`: the prospect it most probably belongs to, with the reason (api/_number-lookup.js).
import { redis, requireAccess } from './_auth.js';
import { KEY, visibleState, canUseCallQueue, ownerFor } from './_outreach-queue.js';
import { gateFor } from './_shift.js';
import { lookupContact } from './_hubspot.js';
import { listUsers, quoKey } from './_quo.js';
import { callerPlan } from './_caller-plan.js';
import { ten, areaOf, fmtPhone, recordsWithNumber, likelyRecords, likelyReason } from './_number-lookup.js';

const OP = 'https://api.openphone.com/v1';
const CACHE = d => 'staffify:number-lookup:' + d;

/** Calls with this number on every line. Same approach as api/call-followup.js, which works. */
export async function quoCalls(number, { fetchImpl = fetch, key = quoKey() } = {}) {
    if (!key) return { ok: false, why: 'Quo is not configured', calls: [] };
    const headers = { Authorization: key, 'Content-Type': 'application/json' };
    const nr = await fetchImpl(`${OP}/phone-numbers`, { headers, signal: AbortSignal.timeout(8000) });
    if (!nr.ok) return { ok: false, why: `Quo answered ${nr.status} for its lines`, calls: [] };
    const lines = ((await nr.json()).data || []).map(n => ({ id: n.id, name: n.name || fmtPhone(n.number) || 'a Quo line' }));
    const calls = [];
    let unread = 0;
    for (const line of lines) {
        let data = null;
        // OpenPhone has accepted each of these spellings at different times (see call-followup.js).
        for (const enc of ['participants[]', 'participants', 'participants[0]']) {
            const r = await fetchImpl(`${OP}/calls?phoneNumberId=${encodeURIComponent(line.id)}&${enc}=${encodeURIComponent('+1' + number)}&maxResults=10`, { headers, signal: AbortSignal.timeout(8000) });
            if (!r.ok) continue;
            const j = await r.json().catch(() => null);
            if (j && Array.isArray(j.data)) { data = j.data; break; }
        }
        if (!data) { unread++; continue; }
        for (const c of data) calls.push({ at: c.createdAt || c.completedAt || null, direction: c.direction || null, seconds: Number(c.duration) || 0, answered: !!c.answeredAt, line: line.name, userId: c.userId || null });
    }
    calls.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
    return { ok: unread === 0, why: unread ? `${unread} of ${lines.length} Quo lines could not be read` : null, calls: calls.slice(0, 10) };
}

const nameOf = email => { const p = callerPlan(email); return p ? p.name : email ? String(email).split('@')[0] : null; };

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !canUseCallQueue(rep)) return res.status(401).json({ error: 'Sign in to the Hub' });
        // The shift gate: a caller off shift is told nothing about a number, not even its last digits.
        const g = await gateFor(redis, rep, ownerFor).catch(() => ({ allowed: false, message: 'Your shift could not be checked.' }));
        if (!g.allowed) return res.status(403).json({ error: g.message || 'Start your shift to look up numbers.' });
        const d = ten(req.query && req.query.phone);
        if (d.length !== 10) return res.status(400).json({ error: 'Give a ten-digit US number.' });
        const cached = await redis.get(CACHE(d)).catch(() => null);
        const state = await redis.get(KEY);
        const records = visibleState(state, 'all').records;
        const onCard = recordsWithNumber(records, d).map(r => ({ recordId: r.id, company: r.company || r.recipient }));

        let quo = cached && cached.quo, hubspot = cached && cached.hubspot, users = cached && cached.users;
        if (!cached) {
            [quo, hubspot, users] = await Promise.all([
                quoCalls(d).catch(e => ({ ok: false, why: String(e && e.message || e).slice(0, 120), calls: [] })),
                lookupContact({ phone: '+1' + d }).catch(e => ({ status: 'failed', why: String(e && e.message || e).slice(0, 120) })),
                listUsers().then(u => Object.fromEntries(u.map(x => [x.actorId, x.name]))).catch(() => ({})),
            ]);
            await redis.set(CACHE(d), { quo, hubspot, users }, { ex: 60 }).catch(() => {});
        }
        const calls = (quo.calls || []).map(c => ({ ...c, by: (users || {})[c.userId] || null }));
        const props = hubspot && hubspot.properties || {};
        const hs = hubspot && hubspot.status === 'found'
            ? { status: 'found', name: [props.firstname, props.lastname].filter(Boolean).join(' ') || null, company: props.company || null, email: props.email || null,
                recordId: (records.find(r => props.email && String(r.recipient || '').toLowerCase() === String(props.email).toLowerCase()) || {}).id || null }
            : { status: hubspot ? hubspot.status : 'failed', why: hubspot && hubspot.why || null };
        // Likely matches only for a call that happened. With no call there is no moment to match on.
        const latest = calls[0];
        const likely = onCard.length || !latest ? [] : likelyRecords(records, { number: d, at: latest.at })
            .map(l => ({ ...l, callerName: nameOf(l.caller) }))
            .map(l => ({ recordId: l.recordId, company: l.company, reason: likelyReason(l, { area: areaOf(d) }), note: l.note }));
        return res.status(200).json({ number: fmtPhone(d), onCard, quo: { ok: quo.ok, why: quo.why || null }, calls, hubspot: hs, likely });
    } catch (e) {
        return res.status(503).json({ error: 'The number could not be looked up: ' + String((e && e.message) || e).slice(0, 140) });
    }
}
