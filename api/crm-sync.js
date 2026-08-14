// POST /api/crm-sync/  — mirror one piece of sales-hub activity into HubSpot.
// { type:'call'|'text'|'note', lead:{company,name,phone,email,role,motion}, outcome, rep, body, at }
//
// Fire-and-forget from the rep's point of view: it always returns 200 with what happened, and never
// throws back into the dialer, because a CRM hiccup must not interrupt someone mid call.

import { openIdentity, readBody, redis } from './_auth.js';
import { configured, findOrCreateContact, logCall, logText, logNote, setLeadStatus, upsertDeal } from './_hubspot.js';

const BUYING = ['interested', 'booked', 'won'];
const LABEL = { won:'Closed / Won', interested:'Interested', callback:'Callback', no_answer:'No answer',
                voicemail:'Voicemail', gatekeeper:'Gatekeeper', not_interested:'Not interested', bad_number:'Bad number' };

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!configured()) return res.status(200).json({ ok: false, reason: 'hubspot_not_configured' });

    const who = await openIdentity(req).catch(() => null);
    const b = readBody(req) || {};
    const lead = b.lead || {};
    const type = ['call', 'text', 'note'].indexOf(b.type) >= 0 ? b.type : 'call';
    const outcome = (b.outcome || '').toString();
    const rep = (b.rep || (who && who.name) || '').toString();
    const at = Number(b.at) || Date.now();

    const nameParts = String(lead.name || '').trim().split(/\s+/);
    const c = await findOrCreateContact({
        phone: lead.phone, email: lead.email,
        firstname: nameParts[0] || '', lastname: nameParts.slice(1).join(' '),
        company: lead.company,
    });
    if (!c.ok) return res.status(200).json({ ok: false, reason: c.reason, detail: c.detail || '' });

    const out = { ok: true, contactId: c.id, contactCreated: !!c.created, did: [] };
    const who_what = [lead.company, lead.role].filter(Boolean).join(' · ');

    if (type === 'call') {
        const title = `${LABEL[outcome] || 'Call'}${rep ? ' · ' + rep : ''}`;
        const body = [who_what, b.body || '', outcome ? 'Outcome: ' + (LABEL[outcome] || outcome) : '']
            .filter(Boolean).join('\n');
        const r = await logCall({ contactId: c.id, title, body, outcome, repName: rep, at });
        out.did.push({ call: r.ok ? r.id : r.reason });
    } else if (type === 'text') {
        const r = await logText({ contactId: c.id, body: b.body || '', direction: 'OUTBOUND', at });
        out.did.push({ text: r.ok ? r.id : r.reason });
    } else {
        const r = await logNote({ contactId: c.id, body: b.body || '', at });
        out.did.push({ note: r.ok ? r.id : r.reason });
    }

    if (outcome) {
        const s = await setLeadStatus(c.id, outcome);
        out.did.push({ status: s.ok ? 'set' : s.reason || s.status });
    }

    // A real buying signal opens a deal, owned by the rep so the commission engine credits the closer.
    if (BUYING.indexOf(outcome) >= 0) {
        const ownerId = await repOwnerId(rep);
        const d = await upsertDeal({ contactId: c.id, company: lead.company, role: lead.role, ownerId, motion: lead.motion });
        out.did.push({ deal: d.ok ? (d.created ? 'created ' + d.id : 'existing ' + d.id) : d.reason });
        if (d.ok && !ownerId) out.warn = 'deal has no owner: map this rep to a HubSpot owner id or the commission will not attribute';
    }
    return res.status(200).json(out);
}

// rep name -> HubSpot owner id, cached. Set the map once in redis: hset crm:owners "<lower name>" "<ownerId>"
async function repOwnerId(rep) {
    const key = String(rep || '').trim().toLowerCase();
    if (!key) return '';
    try {
        const direct = await redis.hget('crm:owners', key);
        if (direct) return String(direct);
        const first = key.split(/\s+/)[0];
        const byFirst = await redis.hget('crm:owners', first);
        if (byFirst) return String(byFirst);
    } catch (e) { /* fall through */ }
    return '';
}
