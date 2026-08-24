// POST /api/deal-flow/ — a mockup or an audit went out, so start (or advance) that prospect's deal.
//
// Sending someone a mockup or an audit is the moment the relationship becomes real work, and until now
// none of it reached HubSpot: a deal was only opened when a call was dispositioned interested/booked/won,
// so everything Paul or Madison sent by hand, and every audit the lead-gen engine fired, left no trace
// in the CRM at all.
//
// Body: {
//   kind: 'mockup' | 'audit' | 'outreach',  what went out
//   lead: { company, name, phone, email, role, motion, website },
//   rep:  'Madison Sterling',            who sent it (falls back to the signed-in identity)
//   amount, note, at
// }
//
// Callable three ways, because the senders live in three places: a signed-in rep in the dialer, an
// admin/machine token from the lead-gen engine, or a typed name on a shared link.

import { openIdentity, readBody, redis, listReps } from './_auth.js';
import { configured, findOrCreateContact, logNote, upsertDeal, setLeadStatus, repOwnerId } from './_hubspot.js';
import { isOptedOut } from './_optout.js';

// An audit is the opener, so it lands the deal at Contacted. A mockup is real work in the prospect's
// hands, which is its own stage in the Foundry pipeline.
const KINDS = {
    audit:  { stage: 'contacted', label: 'Audit sent',  motion: 'websites' },
    mockup: { stage: 'mockup',    label: 'Mockup sent', motion: 'websites' },
    // The dialer's email button opens the rep's own mail client offering an audit, so we know it was
    // offered but never that it was sent. Recorded as its own thing rather than as a sent audit,
    // because a CRM that overstates what happened is worse than one that says less.
    outreach: { stage: 'contacted', label: 'Audit offered by email', motion: 'websites' },
};

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    if (!configured()) return res.status(200).json({ ok: false, reason: 'hubspot_not_configured' });

    const who = await openIdentity(req).catch(() => null);
    const b = readBody(req) || {};
    const lead = b.lead || {};
    const kind = KINDS[String(b.kind || '').toLowerCase()] ? String(b.kind).toLowerCase() : '';
    if (!kind) return res.status(400).json({ ok: false, error: 'kind must be mockup, audit or outreach' });
    const spec = KINDS[kind];

    if (!lead.phone && !lead.email) {
        return res.status(400).json({ ok: false, error: 'lead needs a phone or an email' });
    }

    // Someone who opted out should not be worked at all, so we do not quietly build them a deal either.
    if (await isOptedOut({ phone: lead.phone, email: lead.email })) {
        return res.status(200).json({ ok: true, skipped: true, reason: 'opted_out' });
    }

    const rep = (b.rep || (who && who.name) || '').toString();
    const at = Number(b.at) || Date.now();
    // The VA motion has no mockup, so anything sent as a mockup is a Foundry build by definition.
    const motion = kind === 'mockup' ? 'websites' : (lead.motion || spec.motion);

    const nameParts = String(lead.name || '').trim().split(/\s+/);
    const c = await findOrCreateContact({
        phone: lead.phone, email: lead.email,
        firstname: nameParts[0] || '', lastname: nameParts.slice(1).join(' '),
        company: lead.company,
    });
    if (!c.ok) return res.status(200).json({ ok: false, reason: c.reason, detail: c.detail || '' });

    const out = { ok: true, kind, contactId: c.id, contactCreated: !!c.created, did: [] };

    const ownerId = await repOwnerId(rep, (who && who.email) || '', { redis, listReps });
    const d = await upsertDeal({
        contactId: c.id, company: lead.company, role: lead.role,
        ownerId, motion, amount: b.amount, stage: spec.stage,
    });
    out.deal = d.ok
        ? { id: d.id, created: !!d.created, advanced: !!d.advanced, stage: d.to || d.at, pipeline: d.pipeline }
        : { error: d.reason, detail: d.detail || '' };
    if (d.ok && !ownerId && rep) {
        out.warn = `deal has no owner: map "${rep}" to a HubSpot owner id or the commission will not attribute`;
    }

    // The note is what makes the CRM readable later: which of the two went out, when, and by whom.
    const noteBody = [
        `${spec.label}${rep ? ' by ' + rep : ''}`,
        [lead.company, lead.role].filter(Boolean).join(' · '),
        lead.website ? 'Their site: ' + lead.website : '',
        b.note || '',
    ].filter(Boolean).join('\n');
    const n = await logNote({ contactId: c.id, body: noteBody, at });
    out.did.push({ note: n.ok ? n.id : n.reason });

    // They have had something real from us, so they are no longer an untouched name on a list.
    const s = await setLeadStatus(c.id, 'interested');
    out.did.push({ leadStatus: s.ok ? 'set' : (s.reason || s.status) });

    // Local record, so the hub can show what has already gone out without a HubSpot round trip.
    try {
        const digits = String(lead.phone || '').replace(/[^0-9]/g, '').slice(-10);
        const key = digits || String(lead.email || '').toLowerCase();
        if (key) await redis.hset(`sent:${kind}`, { [key]: JSON.stringify({ at, rep, company: lead.company || '', dealId: d.id || '' }) });
    } catch (e) { /* non-fatal: the CRM already has it */ }

    return res.status(200).json(out);
}

