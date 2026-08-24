// Shared HubSpot writer. Everything the sales hub does (calls, texts, emails, outcomes) lands on the
// right Contact in HubSpot so the CRM is the single record of what happened.
//
// Env: HUBSPOT_TOKEN. The private app needs, on top of the read scopes:
//   crm.objects.contacts.write, crm.objects.companies.write, crm.objects.deals.write
// Every function degrades quietly: a missing token or scope returns {ok:false, reason} and never throws
// into the caller, because failing to log an activity must never break a rep's call flow.

const HS = 'https://api.hubapi.com';
const OWNER_KEY = 'crm:owners';
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
export async function findContact({ phone, email }) {
    const r = await findOrCreateContact({ phone, email, __findOnly: true });
    return r;
}

export async function findOrCreateContact({ phone, email, firstname, lastname, company, __findOnly }) {
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

    if (__findOnly) return { ok: false, reason: 'not_found' };
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
// ---- Deals ------------------------------------------------------------------
// The two pipelines are real objects in the portal, and their stage ids are portal-specific hashes
// rather than names, so they are pinned here and overridable by env if the portal is ever rebuilt.
//
// Routing by motion matters for money, not just tidiness: commissions.js reads the pipeline label to
// decide whether a deal pays the flat Foundry rate or the VA percentage, so a staffing deal filed in
// the Foundry pipeline is paid the wrong amount.
export const PIPELINES = {
    website: {
        id: process.env.HS_PIPELINE_FOUNDRY || 'default',
        stages: {
            new:      process.env.HS_STAGE_FOUNDRY_NEW      || '1402153538',
            contacted:process.env.HS_STAGE_FOUNDRY_CONTACTED|| '1402153539',
            engaged:  process.env.HS_STAGE_FOUNDRY_ENGAGED  || '1402153540',
            mockup:   process.env.HS_STAGE_FOUNDRY_MOCKUP   || '1402153541',
            won:      process.env.HS_STAGE_FOUNDRY_WON      || '1402153543',
            lost:     process.env.HS_STAGE_FOUNDRY_LOST     || '1402153544',
            dropped:  process.env.HS_STAGE_FOUNDRY_DROPPED  || '1402153542',
        },
    },
    va: {
        id: process.env.HS_PIPELINE_VA || '914670001',
        stages: {
            new:      process.env.HS_STAGE_VA_NEW       || '1390230871',
            contacted:process.env.HS_STAGE_VA_CONTACTED || '1390230872',
            engaged:  process.env.HS_STAGE_VA_ENGAGED   || '1390230873',
            booked:   process.env.HS_STAGE_VA_BOOKED    || '1390230874',
            won:      process.env.HS_STAGE_VA_WON       || '1390230875',
            lost:     process.env.HS_STAGE_VA_LOST      || '1390230876',
            dropped:  process.env.HS_STAGE_VA_DROPPED   || '1402034032',
        },
    },
};

// The hub calls the website motion "websites"/"foundry" and the staffing motion "staffing"/"va".
export function pipelineFor(motion) {
    return /websit|foundry|build|site|design/i.test(String(motion || '')) ? PIPELINES.website : PIPELINES.va;
}

// How far along the pipeline a stage is, so a deal is only ever moved FORWARD. Without this, a
// later no-answer call would drag a deal that already reached Mockup Sent back to Contacted.
const ORDER = ['new', 'contacted', 'engaged', 'booked', 'mockup', 'won', 'lost', 'dropped'];
const rank = (k) => { const i = ORDER.indexOf(k); return i < 0 ? -1 : i; };
const stageKey = (pipe, id) => Object.keys(pipe.stages).find(k => pipe.stages[k] === String(id)) || '';
// Won/Lost/Dropped are terminal: that deal is finished and a new approach deserves a new deal.
const TERMINAL = new Set(['won', 'lost', 'dropped']);

// The two pipelines do not have the same stages: only VA has 'booked', only Foundry has 'mockup'.
// Asking for a stage the pipeline does not have used to write no stage at all, dropping the deal at the
// pipeline's first stage, so a booked call on a Foundry lead looked untouched. Fall back to the nearest
// earlier stage that pipeline does have, which is the most that can be said truthfully about progress.
function resolveStage(pipe, stage) {
    if (!stage) return '';
    if (pipe.stages[stage]) return stage;
    for (let i = ORDER.indexOf(stage) - 1; i >= 0; i--) {
        if (pipe.stages[ORDER[i]]) return ORDER[i];
    }
    return '';
}

// Opens a deal, or moves an already-open one forward. `stage` is a key like 'mockup' or 'contacted'.
export async function upsertDeal({ contactId, company, role, ownerId, motion, amount, stage, dealname }) {
    if (!token()) return { ok: false, reason: 'no_token' };
    const pipe = pipelineFor(motion);
    const want = resolveStage(pipe, stage);

    // Look at the contact's existing deals and pick the open one in THIS pipeline. A finished deal is
    // deliberately left alone: someone who was Lost last quarter and is being pitched again should get
    // a fresh deal rather than having their closed one quietly reopened.
    const assoc = await hs(`/crm/v4/objects/contacts/${contactId}/associations/deals`, { method: 'GET' });
    const ids = (assoc.ok && assoc.body && assoc.body.results || [])
        .map(a => a.toObjectId || a.id).filter(Boolean).slice(0, 25);

    let open = null;
    for (const id of ids) {
        const d = await hs(`/crm/v3/objects/deals/${id}?properties=dealstage,pipeline,hs_is_closed_won,hs_is_closed`, { method: 'GET' });
        if (!d.ok || !d.body) continue;
        const pr = d.body.properties || {};
        if (String(pr.pipeline) !== String(pipe.id)) continue;
        const k = stageKey(pipe, pr.dealstage);
        // HubSpot returns these as the STRINGS "true"/"false", so compare rather than trusting truthiness.
        const closed = String(pr.hs_is_closed) === 'true' || String(pr.hs_is_closed_won) === 'true';
        if (closed || TERMINAL.has(k)) continue;
        open = { id, key: k };
        break;
    }

    if (open) {
        // Only ever forward. Re-sending a mockup to someone already at Mockup Sent is a no-op, not a bounce.
        if (want && rank(want) > rank(open.key)) {
            const up = await hs(`/crm/v3/objects/deals/${open.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ properties: { dealstage: pipe.stages[want] } }),
            });
            if (!up.ok) return { ok: false, reason: 'stage_update_failed', status: up.status, detail: up.raw, id: open.id };
            return { ok: true, id: open.id, created: false, advanced: true, from: open.key, to: want, pipeline: pipe.id };
        }
        return { ok: true, id: open.id, created: false, advanced: false, at: open.key, pipeline: pipe.id };
    }

    const props = {
        dealname: (dealname || `${company || 'New deal'}${role ? ' · ' + role : ''}`).slice(0, 250),
        pipeline: pipe.id,
    };
    if (want) props.dealstage = pipe.stages[want];
    if (amount) props.amount = String(amount);
    if (ownerId) props.hubspot_owner_id = String(ownerId);
    const r = await hs('/crm/v3/objects/deals', { method: 'POST', body: JSON.stringify({ properties: props }) });
    if (!r.ok) return { ok: false, reason: 'deal_failed', status: r.status, detail: r.raw };
    await associate('deals', r.body.id, 'contacts', contactId);
    return { ok: true, id: r.body.id, created: true, to: want || 'new', pipeline: pipe.id };
}


// Bad data: take the contact out of HubSpot. This uses the archive endpoint, which is what the UI's
// own delete does, so it is recoverable for 90 days rather than being an unrecoverable wipe.
export async function archiveContact(contactId) {
    if (!token()) return { ok: false, reason: 'no_token' };
    if (!contactId) return { ok: false, reason: 'no_contact' };
    const r = await hs(`/crm/v3/objects/contacts/${contactId}`, { method: 'DELETE' });
    return { ok: r.ok || r.status === 204, status: r.status, detail: r.raw };
}

// True only when exactly one rep on the roster goes by this first name. With no roster to check, the
// answer is no: a missing alias costs one extra lookup, a wrong one costs somebody their commission.
async function firstNameIsUnique(first, deps = {}) {
    if (typeof deps.listReps !== 'function') return false;
    try {
        const reps = (await deps.listReps()) || [];
        const matches = reps.filter(r => String(r.name || '').trim().toLowerCase().split(/\s+/)[0] === first);
        return matches.length === 1;
    } catch (e) { return false; }
}

// Which HubSpot owner is this rep? An ownerless deal pays no commission, so this tries three things in
// order: the saved name map, the rep's first name, then HubSpot's own owner list matched on email. The
// email match is what stops a newly added rep from quietly producing unattributed deals until somebody
// remembers to run /api/crm-owners/ {auto:true}; the result is written back to the map so it happens once.
export async function repOwnerId(rep, repEmail, deps = {}) {
    const redis = deps.redis;
    const key = String(rep || '').trim().toLowerCase();
    const first = key.split(/\s+/)[0];

    if (key && redis) {
        try {
            const direct = await redis.hget(OWNER_KEY, key);
            if (direct) return String(direct);
            if (first && first !== key) {
                const byFirst = await redis.hget(OWNER_KEY, first);
                if (byFirst) return String(byFirst);
            }
        } catch (e) { /* fall through to the email match */ }
    }
    if (!token()) return '';

    // The signed-in rep's own email is the reliable one. A name posted in a request body carries no
    // email, so fall back to the hub's roster to find it.
    let email = String(repEmail || '').trim().toLowerCase();
    if (!email && key && typeof deps.listReps === 'function') {
        try {
            const reps = (await deps.listReps()) || [];
            const hit = reps.find(r => String(r.name || '').trim().toLowerCase() === key);
            email = hit ? String(hit.email || '').trim().toLowerCase() : '';
        } catch (e) { /* no roster, no email match */ }
    }
    if (!email || email === 'guest' || email === 'admin') return '';

    // Exact match only. A fuzzy match here would credit one rep's work to another.
    const r = await hs('/crm/v3/owners?limit=200', { method: 'GET' });
    const owner = r.ok && r.body && (r.body.results || []).find(
        o => String(o.email || '').trim().toLowerCase() === email);
    if (!owner) return '';

    const id = String(owner.id);
    if (redis && key) {
        try {
            await redis.hset(OWNER_KEY, { [key]: id });
            // Only alias the bare first name when it is unambiguous. Two reps named "Chris" sharing one
            // alias would credit whichever of them happened to be resolved first, and commission would
            // land on the wrong person.
            if (first && first !== key && (await firstNameIsUnique(first, deps))) {
                await redis.hset(OWNER_KEY, { [first]: id });
            }
        } catch (e) { /* the id is still good even if caching it failed */ }
    }
    return id;
}

export function configured() { return !!token(); }
