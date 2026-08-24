// Read-only look at the deal pipelines and stages that actually exist in HubSpot.
//
// The deal-flow wiring has to write a real dealstage id, and those ids are portal-specific hashes, not
// names. This endpoint exists so the ids are read off the live portal and configured, rather than
// guessed at and silently written as an invalid stage.
//
// GET /api/crm-pipelines/  (admin token or signed-in rep)

import { requireAccess } from './_auth.js';

const HS = 'https://api.hubapi.com';

export default async function handler(req, res) {
    if (!(await requireAccess(req))) return res.status(401).json({ error: 'unauthorized' });
    const token = process.env.HUBSPOT_TOKEN || '';
    if (!token) return res.status(200).json({ configured: false });

    // Read one deal back, to check what was actually written rather than what we meant to write.
    // GET /api/crm-pipelines/?deal=<id>
    const dealId = (req.query.deal || '').toString().trim();
    if (dealId) {
        try {
            const props = 'dealname,pipeline,dealstage,amount,hubspot_owner_id,createdate';
            const d = await fetch(`${HS}/crm/v3/objects/deals/${encodeURIComponent(dealId)}?properties=${props}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await d.json().catch(() => null);
            if (!d.ok) return res.status(200).json({ ok: false, status: d.status, detail: JSON.stringify(body).slice(0, 250) });
            const pr = (body && body.properties) || {};
            // Resolve the owner id to a person, because an id alone does not answer "whose deal is this".
            let owner = null;
            if (pr.hubspot_owner_id) {
                const o = await fetch(`${HS}/crm/v3/owners/${encodeURIComponent(pr.hubspot_owner_id)}`, {
                    headers: { Authorization: `Bearer ${token}` },
                }).then(r2 => (r2.ok ? r2.json() : null)).catch(() => null);
                if (o) owner = { id: pr.hubspot_owner_id, email: o.email, name: [o.firstName, o.lastName].filter(Boolean).join(' ') };
            }
            return res.status(200).json({ ok: true, deal: { id: body.id, ...pr }, owner });
        } catch (e) {
            return res.status(200).json({ ok: false, detail: String((e && e.message) || e).slice(0, 200) });
        }
    }

    try {
        const r = await fetch(`${HS}/crm/v3/pipelines/deals`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) return res.status(200).json({ configured: true, ok: false, status: r.status, detail: JSON.stringify(body).slice(0, 300) });
        const pipelines = (body.results || []).map(p => ({
            id: p.id,
            label: p.label,
            stages: (p.stages || [])
                .sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder))
                .map(s => ({ id: s.id, label: s.label, closed: !!(s.metadata && s.metadata.isClosed) })),
        }));
        return res.status(200).json({ configured: true, ok: true, pipelines });
    } catch (e) {
        return res.status(200).json({ configured: true, ok: false, detail: String((e && e.message) || e).slice(0, 200) });
    }
}
