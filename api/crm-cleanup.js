// Removes the ZZZ test records that wiring work leaves behind in HubSpot.
//
// Deliberately narrow: it only ever touches records whose name starts with "ZZZ", so it cannot reach a
// real prospect even if it is called by mistake. HubSpot's delete is an archive, recoverable in the
// portal for 90 days, rather than an unrecoverable wipe.
//
// GET  /api/crm-cleanup/                    -> list what WOULD be removed, changes nothing
// POST /api/crm-cleanup/ {confirm:true}     -> archive them

import { adminAuthorized, currentRep, readBody } from './_auth.js';

const HS = 'https://api.hubapi.com';
const PREFIX = 'ZZZ';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    // A signed-in admin or a machine token. Deliberately NOT openIdentity: this one deletes.
    const rep = await currentRep(req).catch(() => null);
    const isAdmin = (rep && rep.role === 'admin') || adminAuthorized(req);
    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
    const token = process.env.HUBSPOT_TOKEN || '';
    if (!token) return res.status(200).json({ configured: false });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const find = async (obj, prop) => {
        const r = await fetch(`${HS}/crm/v3/objects/${obj}/search`, {
            method: 'POST', headers,
            body: JSON.stringify({
                filterGroups: [{ filters: [{ propertyName: prop, operator: 'CONTAINS_TOKEN', value: PREFIX + '*' }] }],
                properties: [prop], limit: 100,
            }),
        });
        if (!r.ok) return { error: `${obj} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 140)}` };
        const j = await r.json();
        // CONTAINS_TOKEN is a loose match, so the prefix is enforced here rather than trusted from search.
        return {
            items: (j.results || [])
                .map(x => ({ id: x.id, name: (x.properties || {})[prop] || '' }))
                .filter(x => x.name.trim().toUpperCase().startsWith(PREFIX)),
        };
    };

    const [contacts, deals, companies] = await Promise.all([
        find('contacts', 'firstname'), find('deals', 'dealname'), find('companies', 'name'),
    ]);
    const plan = { contacts, deals, companies };

    if (req.method !== 'POST' || !readBody(req).confirm) {
        return res.status(200).json({ dryRun: true, wouldArchive: plan });
    }

    const done = {};
    for (const [obj, set] of [['contacts', contacts], ['deals', deals], ['companies', companies]]) {
        done[obj] = [];
        for (const it of (set.items || [])) {
            const r = await fetch(`${HS}/crm/v3/objects/${obj}/${it.id}`, { method: 'DELETE', headers });
            done[obj].push({ id: it.id, name: it.name, archived: r.ok || r.status === 204 });
        }
    }
    return res.status(200).json({ dryRun: false, archived: done });
}
