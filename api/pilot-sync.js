// POST/GET /api/pilot-sync/ — work the inbound-to-CRM queue.
//
// Two callers: the cron in vercel.json, and the hub when Paul presses retry on a failed sync. Both
// go through the same drain, so there is one code path and one set of rules.
//
//   GET  ?token=CRON_SECRET            drain what is due
//   POST { id }                        signed-in: push one request to the front and work it now
import { requireAccess, adminAuthorized, redis, readBody, listReps } from './_auth.js';
import { drainSync, enqueueSync, syncRequest, syncHealth } from './_pilot-sync.js';
import { lookupContact, findOrCreateContact, fillBlankContactProps, logNote, upsertDeal, createTask, linkToContact, repOwnerId, portalId } from './_hubspot.js';
import { clientCheck, guardHealth, refreshClients } from './_client-guard.js';
import { isOptedOut } from './_optout.js';

const PAUL = process.env.PILOT_OWNER_NAME || 'Paul Chareth';

function deps() {
    return {
        redis,
        hubspot: { lookupContact, findOrCreateContact, fillBlankContactProps, logNote, upsertDeal, createTask, linkToContact },
        guard: (who) => clientCheck(who),
        optout: (who) => isOptedOut(who),
        // The HubSpot owners endpoint answers 403 for this token (no crm.objects.owners.read), so the
        // roster lookup cannot resolve an id on its own. PILOT_OWNER_ID short-circuits that with the
        // id straight from the portal. Without either, createTask refuses rather than making a task
        // nobody owns and calling it Paul's.
        ownerId: async () => {
            const want = process.env.PILOT_OWNER_ID || '';
            if (want) {
                // An owner id belongs to one portal. If it was set for a different account, it is not
                // an owner here, and a task filed against it would be assigned to nobody real.
                const expect = process.env.PILOT_OWNER_PORTAL || '';
                if (expect) {
                    const p = await portalId().catch(() => ({ ok: false }));
                    if (p.ok && p.portalId !== expect) return '';
                }
                return want;
            }
            return repOwnerId(PAUL, process.env.PILOT_OWNER_EMAIL || '', { redis, listReps });
        },
        now: Date.now,
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
        const who = await requireAccess(req).catch(() => null);
        if (!who) return res.status(401).json({ ok: false, error: 'Sign in to run a sync' });
        const b = readBody(req) || {};
        const id = String(b.id || '');
        if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
        await enqueueSync(redis, id, { at: Date.now() });
        const out = await syncRequest(id, deps());
        return res.status(200).json({ ok: out.status === 'ok' || out.status === 'partial' || out.status === 'skipped', ...out });
    }

    if (!adminAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // Keep the live customer list warm. Without it the guard answers unknown and every inbound
    // request sits pending, which is a config gap dressed up as caution. This runs on the schedule
    // that already exists, with the credentials that already exist, and sends nothing.
    let clients = await guardHealth();
    if (!clients.hubspot || clients.hubspot.ageHours >= 12) {
        const r = await refreshClients();
        clients = await guardHealth();
        clients.refreshed = r.ok ? { emails: r.emails, companies: r.companies, at: r.at } : { failed: r.why };
    }

    const out = await drainSync(deps(), { limit: Number(req.query.limit) || 10 });
    const health = await syncHealth(redis);
    return res.status(200).json({ ok: true, ...out, health, clientGuard: clients });
}
