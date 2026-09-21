// POST /api/client-snapshot/  — refresh the shared client list without a deploy.
//
// The union of HubSpot customers, the talent console roster and the active-clients CSV is computed by
// ~/Claude Code/staffify-client-guard.js, which can reach all three. A hashed copy ships with the code
// so the guard is never blind on a cold start; this route replaces it with a fresher one.
//
//   ADMIN_TOKEN=... node scripts/push-client-snapshot.mjs
//
// Values arrive already hashed. An empty snapshot is refused, because an empty client list would open
// every cold path at once.
import { adminAuthorized, readBody } from './_auth.js';
import { putSnapshot, guardHealth } from './_client-guard.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    if (req.method === 'GET') return res.status(200).json({ ok: true, health: await guardHealth() });
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    const b = readBody(req) || {};
    if (!Array.isArray(b.emails) || !b.emails.length) {
        return res.status(400).json({ ok: false, error: 'an empty snapshot would open every cold path at once' });
    }
    if (b.algo !== 'sha256-32') {
        return res.status(400).json({ ok: false, error: 'send hashed values (algo sha256-32), never plaintext client addresses' });
    }
    const out = await putSnapshot({ emails: b.emails, companies: b.companies || [], sources: b.sources || [] });
    if (!out.ok) return res.status(503).json({ ok: false, error: out.why });
    return res.status(200).json({ ok: true, ...out, health: await guardHealth() });
}
