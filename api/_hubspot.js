// Shared HubSpot writer. Everything the sales hub does (calls, texts, emails, outcomes) lands on the
// right Contact in HubSpot so the CRM is the single record of what happened.
//
// Env: HUBSPOT_TOKEN. The private app needs, on top of the read scopes:
//   crm.objects.contacts.write, crm.objects.companies.write, crm.objects.deals.write
// Every function degrades quietly: a missing token or scope returns {ok:false, reason} and never throws
// into the caller, because failing to log an activity must never break a rep's call flow.

const HS = 'https://api.hubapi.com';
const token = () => process.env.HUBSPOT_TOKEN || '';
const headers = () => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' });

function digits(p) { return String(p || '').replace(/[^0-9]/g, '').slice(-10); }
function e164(p) { const d = digits(p); return d.length === 10 ? '+1' + d : ''; }

async function hs(path, opts = {}, tries = 2) {
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(HS + path, { ...opts, headers: headers() });
            if (r.status === 429 && i < tries - 1) { await new Promise(s => setTimeout(s, 400)); continue; }
            const text = await r.text().catch(() => '');
            let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
            return { ok: r.ok, status: r.status, body, raw: text.slice(0, 200) };
        } catch (e) {
            if (i === tries - 1) return { ok: false, status: 0, body: null, raw: String((e && e.message) || e).slice(0, 160) };
        }
    }
    return { ok: false, status: 0, body: null, raw: 'unreachable' };
}

// ---- Contact ----------------------------------------------------------------
// Match on phone first (that is what a dialer has), then email. Create only when nothing matches,
// so repeat activity on the same prospect keeps stacking on one record instead of making duplicates.
export async function findOrCreateContact({ phone, email, firstname, lastname, company }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    const filters = [];
    const p = e164(phone), d = digits(phone);
    if (d) filters.push({ filterGroups: [
        { filters: [{ propertyName: 'phone', operator: 'EQ', value: p }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: p }] },
        // Wildcard token catches numbers stored in another format, e.g. (555) 555-0199.
        { filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: '*' + d }] },
        { filters: [{ propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: '*' + d }] },
    ] });
    if (email) filters.push({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: String(email).toLowerCase() }] }] });

    for (const f of filters) {
        const r = await hs('/crm/v3/objects/contacts/search', {
            method: 'POST',
            body: JSON.stringify({ ...f, properties: ['firstname', 'lastname', 'phone', 'email', 'company'], limit: 1 }),
        });
        const hit = r.ok && r.body && r.body.results && r.body.results[0];
        if (hit) return { ok: true, id: hit.id, created: false };
        if (!r.ok && (r.status === 401 || r.status === 403)) return { ok: false, reason: 'scope', detail: r.raw };
    }

    if (!p && !email) return { ok: false, reason: 'no_identifier' };
    const props = { };
    if (p) props.phone = p;
    if (email) props.email = String(email).toLowerCase();
    if (firstname) props.firstname = firstname;
    if (lastname) props.lastname = lastname;
    if (company) props.company = company;
    const c = await hs('/crm/v3/objects/contacts', { method: 'POST', body: JSON.stringify({ properties: props }) });
    if (c.ok && c.body && c.body.id) return { ok: true, id: c.body.id, created: true };
    // A 409 means someone else created it in the meantime; treat as found if HubSpot tells us the id.
    const existing = c.body && c.body.message && (c.body.message.match(/Existing ID:\s*(\d+)/) || [])[1];
    if (existing) return { ok: true, id: existing, created: false };
    return { ok: false, reason: 'create_failed', status: c.status, detail: c.raw };
}

// Associate using the "default" endpoint so we never hard-code association type ids.
async function associate(fromType, fromId, toType, toId) {
    if (!fromId || !toId) return false;
    const r = await hs(`/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, { method: 'PUT' });
    return r.ok;
}

// ---- Activities -------------------------------------------------------------
// A logged call, exactly as it happened on the dialer.
export async function logCall({ contactId, title, body, outcome, repName, at }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    const props = {
        hs_timestamp: at || Date.now(),
        hs_call_title: (title || 'Outbound call').slice(0, 250),
        hs_call_body: (body || '').slice(0, 4000),
        hs_call_direction: 'OUTBOUND',
        // Deliberately no hs_activity_type: it must match a call type defined in the portal, and an
        // unknown value fails the whole create with "Activity type name=... does not exist".
    };
    const r = await hs('/crm/v3/objects/calls', { method: 'POST', body: JSON.stringify({ properties: props }) });
    if (!r.ok) return { ok: false, reason: 'call_failed', status: r.status, detail: r.raw };
    await associate('calls', r.body.id, 'contacts', contactId);
    return { ok: true, id: r.body.id };
}

// A text, stored with its verbatim body so the thread is readable in HubSpot.
export async function logText({ contactId, body, direction, at }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    const props = {
        hs_timestamp: at || Date.now(),
        hs_communication_channel_type: 'SMS',
        hs_communication_logged_from: 'CRM',
        hs_communication_body: (body || '').slice(0, 4000),
    };
    const r = await hs('/crm/v3/objects/communications', { method: 'POST', body: JSON.stringify({ properties: props }) });
    if (!r.ok) return { ok: false, reason: 'text_failed', status: r.status, detail: r.raw };
    await associate('communications', r.body.id, 'contacts', contactId);
    return { ok: true, id: r.body.id };
}

// Anything else worth a paper trail (an emailed profile, a note from the rep).
export async function logNote({ contactId, body, at }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    const r = await hs('/crm/v3/objects/notes', {
        method: 'POST',
        body: JSON.stringify({ properties: { hs_timestamp: at || Date.now(), hs_note_body: (body || '').slice(0, 4000) } }),
    });
    if (!r.ok) return { ok: false, reason: 'note_failed', status: r.status, detail: r.raw };
    await associate('notes', r.body.id, 'contacts', contactId);
    return { ok: true, id: r.body.id };
}

// ---- Lead status ------------------------------------------------------------
const STATUS = {
    interested: 'OPEN_DEAL', booked: 'OPEN_DEAL', won: 'OPEN_DEAL',
    callback: 'IN_PROGRESS', gatekeeper: 'IN_PROGRESS', voicemail: 'IN_PROGRESS', no_answer: 'ATTEMPTED_TO_CONTACT',
    not_interested: 'UNQUALIFIED', bad_number: 'UNQUALIFIED',
};
export async function setLeadStatus(contactId, outcome) {
    const v = STATUS[outcome];
    if (!token() || !contactId || !v) return { ok: false, reason: 'skip' };
    const r = await hs(`/crm/v3/objects/contacts/${contactId}`, {
        method: 'PATCH', body: JSON.stringify({ properties: { hs_lead_status: v } }),
    });
    return { ok: r.ok, status: r.status };
}

// ---- Deal -------------------------------------------------------------------
// Created only on a real buying signal. The OWNER is the rep, because the commission engine pays
// whoever owns the deal when it is won. Never created in a closed stage.
export async function upsertDeal({ contactId, company, role, ownerId, motion, amount }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    // One open deal per contact: reuse rather than stacking a new deal on every interested call.
    const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals`, { method: 'GET' });
    const existing = assoc.ok && assoc.body && assoc.body.results && assoc.body.results[0];
    if (existing) return { ok: true, id: existing.toObjectId || existing.id, created: false };

    const props = {
        dealname: `${company || 'New deal'}${role ? ' · ' + role : ''}`.slice(0, 250),
        pipeline: 'default',
    };
    if (amount) props.amount = String(amount);
    if (ownerId) props.hubspot_owner_id = String(ownerId);
    const r = await hs('/crm/v3/objects/deals', { method: 'POST', body: JSON.stringify({ properties: props }) });
    if (!r.ok) return { ok: false, reason: 'deal_failed', status: r.status, detail: r.raw };
    await associate('deals', r.body.id, 'contacts', contactId);
    return { ok: true, id: r.body.id, created: true };
}

// Bad data: take the contact out of HubSpot. This uses the archive endpoint, which is what the UI's
// own delete does, so it is recoverable for 90 days rather than being an unrecoverable wipe.
export async function archiveContact(contactId) {
    if (!token()) return { ok: false, reason: 'no_token' };
    if (!contactId) return { ok: false, reason: 'no_contact' };
    const r = await hs(`/crm/v3/objects/contacts/${contactId}`, { method: 'DELETE' });
    return { ok: r.ok || r.status === 204, status: r.status, detail: r.raw };
}

export function configured() { return !!token(); }
