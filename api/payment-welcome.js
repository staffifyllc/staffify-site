// Payment welcome: a client's first QuickBooks payment gets the approved strategy-call email.
// ------------------------------------------------------------------
// The cloud copy of the Mac job staffify-payment-welcome (logic in api/_payment-welcome.js).
//
//   GET  (cron, Bearer CRON_SECRET)    one run, hourly at :17 from 8 AM to 8 PM Eastern.
//                                      Sends nothing unless PAYMENT_WELCOME_SEND is 'on'.
//   GET  ?view=pending   (owner)       the last dry run: who would get the email, and its links
//   GET  ?view=backfill  (owner)       first-time payers in the last 21 days with no welcome on record
//   GET  ?view=status    (owner)       mode, missing secrets by name, go-live time, last run
//   GET  ?view=preview   (owner)       the email itself, for a sample first name (&firstName=)
//   POST {action:'import', keys:[{kind,hash,at}], suppressed:[hash], substrings:[text]}   (owner)
//        the Mac's dedupe keys, from scripts/seed-payment-welcome-ledger.mjs
//   POST {action:'send-backfill', customerIds:['372']}   (owner)
//        welcome exactly these backfill customers; live mode only, otherwise it shows what it would send
//
// Owner: a machine token (ADMIN_TOKEN, CRON_SECRET, HUB_TOKEN) or a signed-in admin or finance owner.
// A browser POST must come from the site itself.
import { redis, adminAuthorized, currentRep, readBody, SITE } from './_auth.js';
import { financeAccess } from './_finance-access.js';
import { qboQuery } from './_qbo.js';
import { isOptedOut } from './_optout.js';
import { scheduledRun, backfillView, sendBackfill, importKeys, statusView, previewHtml, resendSend, KEYS } from './_payment-welcome.js';

const isOwner = rep => !!rep && (rep.role === 'admin' || financeAccess(rep));

function deps() {
    return {
        kv: redis,
        query: qboQuery,
        send: ({ payload, idempotencyKey }) => resendSend({ payload, idempotencyKey, apiKey: process.env.RESEND_API_KEY }),
        optedOut: email => isOptedOut({ email }),
        env: process.env,
        now: Date.now(),
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
        const machine = adminAuthorized(req);
        const rep = machine ? null : await currentRep(req).catch(() => null);
        const owner = machine || isOwner(rep);
        const q = req.query || {};

        if (req.method === 'POST') {
            if (!owner) return res.status(rep ? 403 : 401).json({ error: 'Owners only' });
            if (!machine && req.headers.origin !== SITE) return res.status(403).json({ error: 'Invalid request' });
            const b = readBody(req);
            if (b.action === 'import') {
                const out = await importKeys(redis, b);
                return res.status(out.status === 'invalid' ? 400 : 200).json(out);
            }
            if (b.action === 'send-backfill') {
                const out = await sendBackfill(deps(), b.customerIds);
                return res.status(out.status === 'invalid' ? 400 : 200).json(out);
            }
            return res.status(400).json({ error: 'Unknown action' });
        }
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        if (q.view) {
            if (!owner) return res.status(rep ? 403 : 401).json({ error: 'Owners only' });
            if (q.view === 'pending') {
                const saved = await redis.get(KEYS.pending);
                return res.status(200).json(saved ? (typeof saved === 'string' ? JSON.parse(saved) : saved) : { pending: [], message: 'No dry run in the last 36 hours' });
            }
            if (q.view === 'backfill') return res.status(200).json(await backfillView(deps()));
            if (q.view === 'status') return res.status(200).json(await statusView(deps()));
            if (q.view === 'preview') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.status(200).send(previewHtml({ firstName: q.firstName || 'there' }));
            }
            return res.status(400).json({ error: 'Unknown view' });
        }

        if (!machine) return res.status(401).json({ error: 'Unauthorized' });
        return res.status(200).json(await scheduledRun(deps()));
    } catch (e) {
        const m = String((e && e.message) || e).slice(0, 200);
        return res.status(/qb_/.test(m) ? 503 : 500).json({ error: m });
    }
}
