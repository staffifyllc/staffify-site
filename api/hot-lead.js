// POST /api/hot-lead?s=HOT_WEBHOOK_SECRET
// Intake for HOT (interested) leads, e.g. from Bland when a prospect says yes.
// Stores the full lead so a human closer can call it back immediately.
// Tolerant of Bland / Zapier / manual payload shapes. Auth: ?s=secret or admin token.

import { redis, adminAuthorized, readBody, newToken } from './_auth.js';
import { slackNotify } from './_slack.js';

function pick(obj, keys) {
    for (const k of keys) {
        const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), obj);
        if (v != null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const authed = (req.query.s && req.query.s === process.env.HOT_WEBHOOK_SECRET) || adminAuthorized(req);
    if (!authed) return res.status(401).json({ error: 'unauthorized' });

    const b = readBody(req);
    const phone = pick(b, ['phone', 'to', 'number', 'customer_phone', 'customer.phone', 'call.to', 'lead.phone']);
    if (!phone) return res.status(400).json({ error: 'phone_required' });

    const lead = {
        id: 'hot:' + Date.now() + ':' + newToken(4),
        name: pick(b, ['name', 'customer_name', 'customer.name', 'first_name', 'lead.name']),
        phone,
        company: pick(b, ['company', 'business', 'company_name', 'metadata.company', 'lead.company']),
        email: pick(b, ['email', 'customer.email', 'lead.email']),
        motion: pick(b, ['motion', 'metadata.motion']) || 'websites',
        summary: pick(b, ['summary', 'analysis', 'disposition', 'note', 'notes', 'ai_summary', 'call.summary']),
        transcript: pick(b, ['transcript', 'concatenated_transcript', 'call.transcript', 'call.concatenated_transcript']).slice(0, 6000),
        recordingUrl: pick(b, ['recording_url', 'recordingUrl', 'recording', 'call.recording_url', 'call.recording', 'audio_url', 'concatenated_recording_url', 'recording.url']),
        callId: pick(b, ['call_id', 'callId', 'c_id', 'call.id', 'callID']),
        source: pick(b, ['source']) || 'bland',
        portalId: pick(b, ['portal_id', 'lead_id', 'id']),
        status: 'new',
        created_at: String(Date.now()),
    };

    // A summary must be backed by the other person actually speaking (Paul, 2026-08-14: "you
    // said he agreed, but there's no call whatsoever"). Bland hands back a transcript the moment
    // our assistant talks, so a call nobody answered still arrives with a confident-sounding
    // summary attached. Refuse it here too, not just upstream, because this endpoint accepts
    // whatever the webhook sends.
    const humanTurns = (String(lead.transcript || '').match(/^\s*(user|human|customer|prospect)\s*:/gim) || []).length;
    if (!humanTurns && lead.summary) {
        lead.summary = 'No conversation. The line opened but the other side never spoke, so there is no outcome to report.';
        lead.noConversation = 'true';
    }

    await redis.hset(lead.id, lead);
    await redis.zadd('hotleads', { score: Date.now(), member: lead.id });

    const slackText =
        `:fire: *New Bland lead* — *${lead.company || lead.name || lead.phone}*` + (lead.motion ? ` · _${lead.motion}_` : '')
        + `\n:telephone_receiver: ${lead.phone}`
        + (lead.summary ? `\n> ${lead.summary.slice(0, 400)}` : '')
        + (lead.recordingUrl ? `\n:headphones: Recording: ${lead.recordingUrl}` : '')
        + `\n:mag: Review & listen in the hub: https://www.gostaffify.com/campaigns/  (Calls tab)`;
    slackNotify(slackText);

    return res.status(200).json({ ok: true, id: lead.id });
}
