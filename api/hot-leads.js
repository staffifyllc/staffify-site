// Hot queue for the dialer. Merges, live, every time:
//   1) the lead-gen engine's warm leads (GET {ENGINE}/api/hub) -> id "engine:{phone}"
//   2) any hot leads pushed to us directly (Bland webhook / manual) -> id "hot:..."
// Deduped by phone, minus anything a rep has already worked (set hot:handled).
//
// GET  /api/hot-leads            -> { count, leads:[...] }  (rep session or admin)
// POST /api/hot-leads {id, outcome, motion, company}  -> won|callback|not_interested|no_answer|bad_number
//   For engine leads: marks the phone handled locally and best-effort logs it back to the engine.

import { openIdentity, redis, readBody } from './_auth.js';
import { slackNotify } from './_slack.js';

const OUTCOMES = ['won', 'callback', 'not_interested', 'no_answer', 'bad_number'];
const PORTAL_BASE = process.env.SALES_PORTAL_BASE || '';
const PORTAL_TOKEN = process.env.SALES_PORTAL_TOKEN || '';
const HUB_URL = PORTAL_BASE ? PORTAL_BASE.replace('/sales-portal', '/hub') : '';
const BRAND_MOTION = { Foundry: 'websites', Staffify: 'staffing' };

// engine log outcomes: interested|callback|not_interested|gatekeeper|no_answer|voicemail
function toEngineOutcome(o) {
    if (o === 'won') return 'interested';
    if (o === 'bad_number') return 'not_interested';
    if (OUTCOMES.indexOf(o) >= 0 && o !== 'won' && o !== 'bad_number') return o;
    return 'not_interested';
}

async function fetchEngineWarm() {
    if (!HUB_URL || !PORTAL_TOKEN) return [];
    try {
        const r = await fetch(HUB_URL + '?t=' + encodeURIComponent(PORTAL_TOKEN));
        if (!r.ok) return [];
        const j = await r.json();
        const out = [];
        (j.motions || []).forEach(m => {
            const motion = BRAND_MOTION[m.brand] || 'websites';
            (m.warm || []).forEach(w => {
                if (!w.phone) return;
                const summary = w.summary || (w.grade === 'replied'
                    ? 'Replied to our outreach, warm. Call to qualify and set the hook.'
                    : 'Warm lead from the engine. Call to move it forward.');
                out.push({ id: 'engine:' + w.phone, name: w.name || '', company: w.company || '', phone: w.phone, email: '', motion, grade: w.grade || '', summary, source: w.source || 'engine', recordingUrl: (w.recording_url || w.recordingUrl || ''), transcript: (w.transcript || w.concatenated_transcript || '') });
            });
        });
        return out;
    } catch (e) { return []; }
}

export default async function handler(req, res) {
    const who = await openIdentity(req); // open-share: identify by name if given, else Guest
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
        const b = readBody(req);
        const id = (b.id || '').toString();
        if (OUTCOMES.indexOf(b.outcome) < 0) return res.status(400).json({ error: 'bad_outcome', outcomes: OUTCOMES });

        if (id.indexOf('engine:') === 0) {
            const phone = id.slice(7);
            await redis.sadd('hot:handled', phone);
            try {
                await fetch(PORTAL_BASE + '?action=log&t=' + encodeURIComponent(PORTAL_TOKEN), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rep: who.name || who.email, motion: b.motion || '', company: b.company || '', phone, outcome: toEngineOutcome(b.outcome) }),
                });
            } catch (e) { /* best effort */ }
            if (b.outcome === 'won') slackNotify(':tada: *' + (who.name || who.email) + '* CLOSED a warm lead: *' + (b.company || phone) + '*');
            return res.status(200).json({ ok: true });
        }

        if (id.indexOf('hot:') !== 0) return res.status(400).json({ error: 'bad_id' });
        const h = await redis.hgetall(id);
        if (!h || !h.phone) return res.status(404).json({ error: 'no_such_lead' });
        await redis.hset(id, { status: 'done', outcome: b.outcome, closedBy: who.name || who.email, closedAt: String(Date.now()) });
        await redis.zrem('hotleads', id);
        await redis.sadd('hot:handled', h.phone);
        if (b.outcome === 'won') slackNotify(':tada: *' + (who.name || who.email) + '* CLOSED a hot lead: *' + (h.company || h.name || h.phone) + '*');
        return res.status(200).json({ ok: true });
    }

    const handled = new Set((await redis.smembers('hot:handled')) || []);
    const seen = new Set();
    const leads = [];

    const engine = await fetchEngineWarm();
    engine.sort((a, b) => (b.grade === 'interested' ? 1 : 0) - (a.grade === 'interested' ? 1 : 0));
    engine.forEach(l => { if (handled.has(l.phone) || seen.has(l.phone)) return; seen.add(l.phone); leads.push(l); });

    const ids = (await redis.zrange('hotleads', 0, 99, { rev: true })) || [];
    for (const id of ids) {
        const h = await redis.hgetall(id);
        if (!h || !h.phone || h.status === 'done') continue;
        if (handled.has(h.phone) || seen.has(h.phone)) continue;
        seen.add(h.phone);
        leads.push({ id, name: h.name || '', company: h.company || '', phone: h.phone, email: h.email || '', motion: h.motion || 'websites', grade: '', summary: h.summary || '', source: h.source || '', recordingUrl: (h.recordingUrl || ''), transcript: (h.transcript || '') });
    }

    return res.status(200).json({ count: leads.length, leads });
}
