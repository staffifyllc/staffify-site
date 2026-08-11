// Staffify proxy to the lead-gen engine's outreach log. Keeps SALES_PORTAL_TOKEN server-side
// so the browser never sees it. Powers the internal Outreach Proof view.
//
// GET /api/outreach-log/                                  -> full log { counts, leads:[{touches:[...]}] }
//   ?motion=websites|vas   ?limit=N   ?withTranscripts=0
// GET /api/outreach-log/?action=recording&call_id=<id>    -> { recording_url, transcript }  (lazy transcript)
// GET /api/outreach-log/?action=audio&call_id=<id>        -> streams audio/mpeg bytes for playback
//     (relies on the engine exposing ?action=audio; until then this returns the upstream status)

const ENGINE = 'https://campaign-dashboard-green.vercel.app/api/outreach-log';
const TOKEN = process.env.SALES_PORTAL_TOKEN || '';

function engineUrl(params) {
    const p = new URLSearchParams(params);
    p.set('t', TOKEN);
    return ENGINE + '?' + p.toString();
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!TOKEN) return res.status(500).json({ error: 'SALES_PORTAL_TOKEN not set' });
    const action = (req.query.action || '').toString();

    // ---- stream recording audio (engine holds the Bland key) ----
    if (action === 'audio') {
        const callId = (req.query.call_id || '').toString();
        if (!callId) return res.status(400).json({ error: 'no_call_id' });
        try {
            const r = await fetch(engineUrl({ action: 'audio', call_id: callId }));
            if (!r.ok) return res.status(r.status).json({ error: 'audio_upstream_' + r.status });
            const ct = r.headers.get('content-type') || 'audio/mpeg';
            const buf = Buffer.from(await r.arrayBuffer());
            res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'private, max-age=86400');
            return res.status(200).send(buf);
        } catch (e) {
            return res.status(502).json({ error: 'audio_proxy_failed' });
        }
    }

    // ---- lazy transcript / recording url for one call ----
    if (action === 'recording') {
        const callId = (req.query.call_id || '').toString();
        if (!callId) return res.status(400).json({ error: 'no_call_id' });
        try {
            const r = await fetch(engineUrl({ action: 'recording', call_id: callId }));
            const j = await r.json().catch(() => ({}));
            return res.status(r.ok ? 200 : 502).json(j);
        } catch (e) {
            return res.status(502).json({ error: 'recording_proxy_failed' });
        }
    }

    // ---- the full log ----
    const params = {};
    if (req.query.motion) params.motion = req.query.motion.toString();
    if (req.query.limit) params.limit = req.query.limit.toString();
    if (req.query.withTranscripts != null) params.withTranscripts = req.query.withTranscripts.toString();
    if (req.query.all != null) params.all = req.query.all.toString();
    try {
        const r = await fetch(engineUrl(params));
        const j = await r.json().catch(() => null);
        if (!r.ok || !j) return res.status(502).json({ error: 'engine_' + r.status });
        return res.status(200).json(j);
    } catch (e) {
        return res.status(502).json({ error: 'engine_unreachable' });
    }
}
