// The real services behind the Hiring now drip (api/_hiring-drip.js): HubSpot, the stop lists, the hiring store, the
// worker's stored config. Kept apart so the rules stay testable without any of them.
import { hubspotRequest } from './_outreach-hubspot.js';
import { draftBlockReason } from './_outreach-crm.js';
import { isOptedOut } from './_optout.js';
import { clientCheck } from './_client-guard.js';
import { bookedIdentity } from './_booked-leads.js';
import { allRecords } from './_hiring-intent.js';
import { CONFIG } from './_outreach-gmail.js';

const PORTAL = '51666712';
export function dripCrm(redis) {
    let checked = false;
    async function hs(path, body, method) {
        const token = process.env.HUBSPOT_TOKEN; if (!token) throw Error('CRM connection missing');
        const r = await hubspotRequest('https://api.hubapi.com' + path, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, { redis });
        if (!r.ok) throw Error('CRM request failed: ' + r.status);
        return r.status === 204 ? {} : r.json();
    }
    async function portal() { if (checked) return; const a = await hs('/account-info/v3/details'); if (String(a.portalId) !== PORTAL) throw Error('Wrong CRM portal'); checked = true; }
    return {
        async find(email) { await portal(); const r = await hs('/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }], properties: ['email', 'rep_email_verified'], limit: 2 }); return r.results || []; },
        async create(props) { await portal(); return hs('/crm/v3/objects/contacts', { properties: props }); },
        async patch(id, props) { await portal(); return hs('/crm/v3/objects/contacts/' + encodeURIComponent(id), { properties: props }, 'PATCH'); },
    };
}

/**
 * Why a row must not be enrolled. A contact made a moment ago is not searchable yet, so for it the checks that do not
 * need it run (booking, opt-out, client); the worker's draft gate runs the full CRM check before anything is written.
 */
export function dripBlock(redis) {
    return async (row, { created }) => {
        if (await bookedIdentity(redis, { email: row.recipient, domain: row.agencyKey })) return 'They booked a call';
        if (!created) return draftBlockReason(row);
        if (await isOptedOut({ email: row.recipient })) return 'Global opt-out';
        const c = await clientCheck({ email: row.recipient, company: row.company });
        return c.status === 'clear' ? null : 'Client check: ' + c.status;
    };
}

export function dripDeps(redis) {
    return { crm: dripCrm(redis), block: dripBlock(redis), records: () => allRecords(redis), stored: async () => (await redis.get(CONFIG)) || {}, saveConfig: cfg => redis.set(CONFIG, cfg) };
}
