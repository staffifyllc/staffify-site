// Pre-call emails for Discovery call bookers (api/_precall.js), the Mac's staffify-precall-emails job.
// ------------------------------------------------------------------
//   GET  (cron, Bearer CRON_SECRET)         one run. Sends nothing unless PRECALL_SEND is 'on'; otherwise a
//                                           dry run that is kept three days and returned. ?dry=1 forces a
//                                           dry run; ?html=1 adds each email's HTML to the answer; ?notify=1
//                                           posts the run notice from a dry run too (a live run always does).
//   GET  ?view=pending (owner)              the latest dry runs and live runs, and what stops live mode
//   POST ?action=import (Bearer token)      the desktop's sent log as hashed ledger entries
//                                           (scripts/seed-precall-ledger.mjs); marks precall:seeded
// Vercel runs it at 13:10 and 23:10 UTC: 8:10 and 18:10 Eastern from Nov 1, 2026, the desktop's slots.
// From Mar 14, 2027 (Eastern back on UTC-4) the same runs fall at 9:10 and 19:10 Eastern.
import { redis, requireAccess, adminAuthorized, readBody } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { runPrecall, pendingView, importLedger } from './_precall.js';

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const machine = adminAuthorized(req);
        if (req.method === 'GET' && req.query?.view === 'pending') {
            if (!machine) { const rep = await requireAccess(req); if (!ownerFor(rep)) return res.status(403).json({ error: 'Owners only' }); }
            return res.status(200).json(await pendingView(redis));
        }
        if (req.method === 'POST' && req.query?.action === 'import') {
            if (!machine) return res.status(401).json({ error: 'Unauthorized' });
            const body = readBody(req);
            const out = await importLedger(redis, body.entries);
            return res.status(out.ok ? 200 : 400).json(out);
        }
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        if (!machine) return res.status(401).json({ error: 'Unauthorized' });
        const out = await runPrecall({ kv: redis, force: req.query?.dry ? 'dry-run' : null, includeHtml: req.query?.html === '1', notify: req.query?.notify === '1' });
        if (out.mode === 'live' && (out.errors.length || out.held.length)) console.warn('cron-precall', JSON.stringify({ errors: out.errors.length, held: out.held.map(h => h.reason) }));
        if (out.notice && !out.notice.posted) console.warn('cron-precall notice not posted', JSON.stringify({ error: out.notice.error || null }));
        return res.status(out.ok ? 200 : 503).json(out);
    } catch (e) {
        console.error('cron-precall', e);
        return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
    }
}
