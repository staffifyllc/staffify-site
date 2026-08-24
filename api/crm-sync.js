// POST /api/crm-sync/  — mirror one piece of sales-hub activity into HubSpot.
// { type:'call'|'text'|'note', lead:{company,name,phone,email,role,motion}, outcome, rep, body, at }
//
// Fire-and-forget from the rep's point of view: it always returns 200 with what happened, and never
// throws back into the dialer, because a CRM hiccup must not interrupt someone mid call.

import { openIdentity, readBody, redis, listReps } from './_auth.js';
import { configured, findOrCreateContact, findContact, logCall, logText, logNote, setLeadStatus, upsertDeal, archiveContact, repOwnerId } from './_hubspot.js';

const BUYING = ['interested', 'booked', 'won'];
// Where a call outcome puts the deal. Contact on the phone is real engagement, a booked call is its own
// stage in the VA pipeline, and a win is a win. upsertDeal only ever moves a deal forward, so an
// interested call after a mockup went out will not drag the deal back down the pipeline.
const OUTCOME_STAGE = { interested: 'engaged', booked: 'booked', won: 'won' };
const LABEL = { won:'Closed / Won', interested:'Interested', booked:'Call booked', callback:'Callback', no_answer:'No answer',
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

    // Bad data is handled BEFORE any create. Blacklist the number so it can never re-enter a queue,
    // and archive the contact only if one already exists: creating a record purely to delete it would
    // leave the real contact untouched and orphan a new one.
    if (b.purge || outcome === 'bad_number') {
        const digits = String(lead.phone || '').replace(/[^0-9]/g, '').slice(-10);
        const out = { ok: true, purged: false, did: [] };
        if (digits) {
            try { await redis.sadd('bad:numbers', digits); out.did.push({ blacklisted: digits }); } catch (e) { /* non-fatal */ }
        }
        if (lead.phone) { try { await redis.sadd('hot:handled', lead.phone); } catch (e) { /* non-fatal */ } }
        const found = await findContact({ phone: lead.phone, email: lead.email });
        if (found.ok && found.id) {
            const del = await archiveContact(found.id);
            out.contactId = found.id;
            out.purged = !!del.ok;
            out.did.push({ hubspot: del.ok ? 'contact archived' : ('archive_failed ' + (del.status || del.reason)) });
        } else {
            out.did.push({ hubspot: 'no contact to archive' });
        }
        return res.status(200).json(out);
    }

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
        out.did.push({ call: r.ok ? r.id : r.reason, status: r.status, detail: r.detail });
    } else if (type === 'text') {
        const r = await logText({ contactId: c.id, body: b.body || '', direction: 'OUTBOUND', at });
        out.did.push({ text: r.ok ? r.id : r.reason, status: r.status, detail: r.detail });
    } else {
        const r = await logNote({ contactId: c.id, body: b.body || '', at });
        out.did.push({ note: r.ok ? r.id : r.reason, status: r.status, detail: r.detail });
    }

    if (outcome) {
        const s = await setLeadStatus(c.id, outcome);
        out.did.push({ status: s.ok ? 'set' : s.reason || s.status });
    }

    // A real buying signal opens a deal, owned by the rep so the commission engine credits the closer.
    if (BUYING.indexOf(outcome) >= 0) {
        const ownerId = await repOwnerId(rep, (who && who.email) || '', { redis, listReps });
        const stage = OUTCOME_STAGE[outcome] || '';
        const d = await upsertDeal({
            contactId: c.id, company: lead.company, role: lead.role,
            ownerId, motion: lead.motion, stage,
        });
        out.did.push({
            deal: d.ok ? (d.created ? 'created ' + d.id : (d.advanced ? `moved ${d.from} -> ${d.to} ` + d.id : 'existing ' + d.id)) : d.reason,
            pipeline: d.pipeline,
        });
        if (d.ok && !ownerId) out.warn = 'deal has no owner: map this rep to a HubSpot owner id or the commission will not attribute';
    }
    return res.status(200).json(out);
}
