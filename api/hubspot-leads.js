// GET /api/hubspot-leads?token=ADMIN_TOKEN
// Warm leads from HubSpot: contacts touched in the last 30 days, newest activity first.
// Env: HUBSPOT_TOKEN (private app, scope crm.objects.contacts.read). Auth: ADMIN_TOKEN or CRON_SECRET.
// If HUBSPOT_TOKEN is absent it returns { configured: false } so the hub can render a connect card.

import { requireAccess } from './_auth.js';

function authorized(req) {
    const validSecrets = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET].filter(Boolean);
    if (!validSecrets.length) return false;
    const provided = (req.query.token || '').toString();
    if (provided && validSecrets.includes(provided)) return true;
    const hdr = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    return !!m && validSecrets.includes(m[1]);
}

const PROPS = ['firstname', 'lastname', 'email', 'phone', 'company', 'lifecyclestage', 'hs_lead_status', 'createdate', 'lastmodifieddate'];

export default async function handler(req, res) {
    if (!(await requireAccess(req))) return res.status(401).json({ error: 'unauthorized' });

    const token = process.env.HUBSPOT_TOKEN;
    if (!token) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ configured: false, count: 0, leads: [] });
    }

    try {
        const since = Date.now() - 30 * 864e5;
        const body = {
            filterGroups: [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(since) }] }],
            sorts: [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
            properties: PROPS,
            limit: 50,
        };
        const r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const detail = (await r.text()).slice(0, 200);
            return res.status(502).json({ configured: true, error: 'hubspot_error', status: r.status, detail });
        }
        const data = await r.json();
        const leads = (data.results || []).map(c => {
            const p = c.properties || {};
            const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
            return {
                id: c.id,
                name: name || p.email || '(no name)',
                email: p.email || '',
                phone: p.phone || '',
                company: p.company || '',
                stage: p.lifecyclestage || '',
                status: p.hs_lead_status || '',
                lastActivity: p.lastmodifieddate || '',
            };
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ configured: true, count: leads.length, leads });
    } catch (e) {
        return res.status(502).json({ configured: true, error: 'hubspot_error', detail: String(e.message || e) });
    }
}
