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

    // Find a contact and everything already open on them, so a deal is attached to the person we
    // already have rather than creating a second copy of them.
    // GET /api/crm-pipelines/?contact=taddewald@gmail.com
    const q = (req.query.contact || '').toString().trim();
    if (q) {
        try {
            const search = async (propertyName, operator, value) => {
                const r = await fetch(`${HS}/crm/v3/objects/contacts/search`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filterGroups: [{ filters: [{ propertyName, operator, value }] }],
                        properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'website', 'hs_lead_status', 'best_fit_segment'],
                        limit: 10,
                    }),
                });
                if (!r.ok) return [];
                const j = await r.json();
                return j.results || [];
            };
            let hits = await search('email', 'EQ', q);
            if (!hits.length) hits = await search('email', 'CONTAINS_TOKEN', q);
            if (!hits.length) hits = await search('lastname', 'CONTAINS_TOKEN', q);
            if (!hits.length) hits = await search('company', 'CONTAINS_TOKEN', q);

            const out = [];
            for (const c of hits) {
                const assoc = await fetch(`${HS}/crm/v4/objects/contacts/${c.id}/associations/deals`, {
                    headers: { Authorization: `Bearer ${token}` },
                }).then(r2 => (r2.ok ? r2.json() : null)).catch(() => null);
                const dealIds = ((assoc && assoc.results) || []).map(a => a.toObjectId || a.id).filter(Boolean).slice(0, 10);
                const deals = [];
                for (const id of dealIds) {
                    const d = await fetch(`${HS}/crm/v3/objects/deals/${id}?properties=dealname,pipeline,dealstage,amount,hubspot_owner_id`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }).then(r2 => (r2.ok ? r2.json() : null)).catch(() => null);
                    if (d) deals.push({ id: d.id, ...(d.properties || {}) });
                }
                out.push({ id: c.id, ...(c.properties || {}), deals });
            }
            return res.status(200).json({ ok: true, query: q, found: out.length, contacts: out });
        } catch (e) {
            return res.status(200).json({ ok: false, detail: String((e && e.message) || e).slice(0, 200) });
        }
    }

    // Recent deals with their owners. This is the audit that answers "is our reps' work actually being
    // attributed to them", which a per-deal read cannot answer at scale.
    // GET /api/crm-pipelines/?recent=1[&days=30]
    if (req.query.recent) {
        try {
            const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
            const since = Date.now() - days * 86400000;
            const r = await fetch(`${HS}/crm/v3/objects/deals/search`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    filterGroups: [{ filters: [{ propertyName: 'createdate', operator: 'GTE', value: String(since) }] }],
                    properties: ['dealname', 'pipeline', 'dealstage', 'hubspot_owner_id', 'createdate', 'amount'],
                    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
                    limit: 100,
                }),
            });
            const j = await r.json().catch(() => null);
            if (!r.ok) return res.status(200).json({ ok: false, status: r.status, detail: JSON.stringify(j).slice(0, 250) });

            // Resolve owner ids once, so the report names people instead of listing numbers.
            const names = {};
            const ow = await fetch(`${HS}/crm/v3/owners?limit=200`, { headers: { Authorization: `Bearer ${token}` } })
                .then(x => (x.ok ? x.json() : null)).catch(() => null);
            ((ow && ow.results) || []).forEach(o => {
                names[String(o.id)] = [o.firstName, o.lastName].filter(Boolean).join(' ').trim() || o.email || String(o.id);
            });

            const rows = ((j && j.results) || []).map(d => {
                const pr = d.properties || {};
                return {
                    id: d.id,
                    name: pr.dealname || '',
                    pipeline: pr.pipeline || '',
                    stage: pr.dealstage || '',
                    created: pr.createdate || '',
                    amount: pr.amount || null,
                    owner: pr.hubspot_owner_id ? (names[String(pr.hubspot_owner_id)] || pr.hubspot_owner_id) : null,
                };
            });
            const byOwner = {};
            rows.forEach(x => { const k = x.owner || 'NOBODY'; byOwner[k] = (byOwner[k] || 0) + 1; });
            const byPipeline = {};
            rows.forEach(x => { byPipeline[x.pipeline] = (byPipeline[x.pipeline] || 0) + 1; });
            return res.status(200).json({
                ok: true, days, total: rows.length,
                unowned: rows.filter(x => !x.owner).length,
                byOwner, byPipeline,
                deals: rows,
            });
        } catch (e) {
            return res.status(200).json({ ok: false, detail: String((e && e.message) || e).slice(0, 200) });
        }
    }

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
