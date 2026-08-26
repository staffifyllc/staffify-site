// Turn a call into a follow-up task on the right person's plate, in HubSpot.
// ------------------------------------------------------------------
// Paul, 2026-08-25: "set a follow up task reminder, wondering what may be the easier way to do this
// but this should go in hubspot, can you reference the recording and set the task for madison?"
//
// The easier way is not to do it by hand each time. This takes a phone number, finds that call in
// OpenPhone across every line (the dashboard endpoint only watches one), pulls the recording, finds
// or creates the HubSpot contact, and puts a dated task on the rep's queue with the recording link
// in the body.
//
//   POST /api/call-followup/
//     { phone:"+13044625634", rep:"Madison Sterling", inDays:2, note:"...", subject:"..." }
//   GET  /api/call-followup/?phone=+13044625634        -> what it WOULD do, changes nothing
//
// Auth: signed-in rep or admin token.
import { requireAccess, redis } from './_auth.js';
import { findOrCreateContact, configured } from './_hubspot.js';
import { repOwnerId } from './_hubspot.js';

const OP = 'https://api.openphone.com/v1';
const HS = 'https://api.hubapi.com';
const ten = (p) => String(p || '').replace(/[^0-9]/g, '').slice(-10);

// OpenPhone calls live per phone-number line, and a rep's line is not necessarily the one the
// dashboard watches, which is why the dashboard showed zero calls for a call that plainly happened.
async function findCall(phone) {
    const key = process.env.OPENPHONE_API_KEY;
    if (!key) return { error: 'openphone_not_configured' };
    const headers = { Authorization: key, 'Content-Type': 'application/json' };
    const want = ten(phone);

    const nr = await fetch(`${OP}/phone-numbers`, { headers });
    if (!nr.ok) return { error: `phone_numbers_${nr.status}` };
    const lines = ((await nr.json()).data || []).map((n) => ({ id: n.id, number: n.number, name: n.name }));

    const found = [];
    for (const line of lines) {
        // OpenPhone is inconsistent about how it wants a repeated query parameter: /messages accepts
        // participants= and rejects participants[], and the two have swapped before. Try each and
        // use whichever the API accepts, rather than hardcoding a guess that silently returns nothing.
        let data = null;
        for (const enc of ['participants[]', 'participants', 'participants[0]']) {
            const u = `${OP}/calls?phoneNumberId=${encodeURIComponent(line.id)}&${enc}=${encodeURIComponent('+1' + want)}&maxResults=20`;
            const r = await fetch(u, { headers });
            if (!r.ok) continue;
            const j = await r.json().catch(() => null);
            if (j && Array.isArray(j.data)) { data = j.data; break; }
        }
        if (!data) continue;
        for (const c of data) {
            found.push({
                id: c.id, line: line.name || line.number, at: c.createdAt || c.completedAt,
                direction: c.direction, durationSec: c.duration ?? null, status: c.status,
                by: (c.user && (c.user.name || c.user.email)) || c.userId || '',
            });
        }
    }
    if (!found.length) {
        // Which lines exist and what the API actually returns for them, because "no call found"
        // and "wrong query parameter" look identical from here.
        const diag = [];
        for (const line of lines) {
            const r = await fetch(`${OP}/calls?phoneNumberId=${encodeURIComponent(line.id)}&participants[]=${encodeURIComponent('+1' + want)}&maxResults=5`, { headers });
            const txt = await r.text();
            let parsed = null; try { parsed = JSON.parse(txt); } catch (e) { /* keep the raw */ }
            diag.push({
                line: line.name || line.number, id: line.id, status: r.status,
                returned: parsed && Array.isArray(parsed.data) ? parsed.data.length : null,
                sample: parsed && parsed.data && parsed.data[0]
                    ? { id: parsed.data[0].id, at: parsed.data[0].createdAt, participants: parsed.data[0].participants, direction: parsed.data[0].direction }
                    : undefined,
                error: !r.ok ? txt.slice(0, 200) : undefined,
            });
        }
        return { error: 'no_call_found', linesChecked: lines.length, lines: lines.map((l) => l.name || l.number), diag };
    }
    found.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const call = found[0];

    // The recording is a separate call in OpenPhone's API, not a field on the call.
    try {
        const rr = await fetch(`${OP}/call-recordings/${encodeURIComponent(call.id)}`, { headers });
        if (rr.ok) {
            const rj = await rr.json();
            const rec = (rj.data || [])[0] || rj.data || {};
            call.recordingUrl = rec.url || rec.mediaUrl || '';
            call.recordingDuration = rec.duration ?? null;
        }
    } catch (e) { /* a call without a recording is still worth a task */ }
    return { call, alsoFound: found.length - 1 };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!(await requireAccess(req))) return res.status(401).json({ error: 'unauthorized' });
    if (!configured()) return res.status(200).json({ error: 'hubspot_not_configured' });

    const b = req.method === 'POST' ? (req.body || {}) : {};
    const phone = String(b.phone || req.query.phone || '').trim();
    if (!ten(phone)) return res.status(400).json({ error: 'pass a US phone number' });

    const found = await findCall(phone);
    if (found.error && req.method !== 'POST') return res.status(200).json(found);
    const call = found.call || null;

    // A dry run so the caller can see what it found before anything is written.
    if (req.method !== 'POST') {
        return res.status(200).json({ wouldUse: call, alsoFound: found.alsoFound || 0 });
    }

    const rep = String(b.rep || 'Madison Sterling');
    const ownerId = await repOwnerId(rep, '', { redis });
    if (!ownerId) return res.status(200).json({ error: 'no_owner_for_rep', rep, note: 'map this rep in /api/crm-owners/ first' });

    const contact = await findOrCreateContact({ phone: '+1' + ten(phone), company: b.company || '' });
    if (!contact || !contact.id) return res.status(200).json({ error: 'contact_failed', detail: contact });

    // Due date. Default is tomorrow morning rather than "now", because a task that is already
    // overdue the moment it is created is one a rep learns to ignore.
    const days = Number.isFinite(Number(b.inDays)) ? Number(b.inDays) : 1;
    const due = new Date();
    due.setDate(due.getDate() + days);
    due.setHours(9, 0, 0, 0);

    const when = call && call.at ? new Date(call.at) : null;
    const mins = call && call.durationSec ? Math.floor(call.durationSec / 60) + ':' + String(call.durationSec % 60).padStart(2, '0') : '';
    const bodyLines = [
        b.note || 'Follow up on this call.',
        '',
        call ? `Call: ${when ? when.toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'time unknown'}${mins ? ' · ' + mins : ''}${call.direction ? ' · ' + call.direction : ''}` : 'No matching call found in OpenPhone.',
        call && call.by ? `Made by: ${call.by}` : '',
        call && call.recordingUrl ? `Recording: ${call.recordingUrl}` : (call ? 'Recording: not available on this call' : ''),
        `Number: ${'+1' + ten(phone)}`,
    ].filter(Boolean);

    const props = {
        hs_task_subject: String(b.subject || `Follow up: call with ${'+1' + ten(phone)}`).slice(0, 250),
        hs_task_body: bodyLines.join('\n'),
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: b.priority === 'HIGH' ? 'HIGH' : 'MEDIUM',
        hs_task_type: 'CALL',
        hs_timestamp: String(due.getTime()),
        hubspot_owner_id: String(ownerId),
    };
    const token = process.env.HUBSPOT_TOKEN;
    const r = await fetch(`${HS}/crm/v3/objects/tasks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            properties: props,
            associations: [{ to: { id: contact.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
        }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return res.status(200).json({ error: `hubspot_${r.status}`, detail: JSON.stringify(j).slice(0, 300) });

    return res.status(200).json({
        ok: true, taskId: j.id, contactId: contact.id, assignedTo: rep, ownerId,
        dueAt: due.toISOString(), recording: (call && call.recordingUrl) || null, call,
    });
}
