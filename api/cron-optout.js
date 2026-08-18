// Sweeps OpenPhone for STOP replies and adds them to the do-not-contact list.
//
// This runs on a schedule because consent is withdrawn the moment someone replies, not the next time
// somebody remembers to press a button. Carriers block further SMS on their own, but our calls and
// emails would keep going, so the sweep is what actually stops every channel.
//
// The sweep is incremental and resumable, so a run that hits its time budget is picked up by the next
// one rather than starting over. Runs hourly; a large first backfill just takes a few runs to finish.

import { scanOpenPhone } from './optout.js';
import { adminAuthorized } from './_auth.js';

export default async function handler(req, res) {
    // Vercel cron sends CRON_SECRET as a bearer token; adminAuthorized already accepts it.
    if (!adminAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
    const out = await scanOpenPhone(0, false);
    return res.status(out.ok ? 200 : 500).json({ ...out, ranAt: new Date().toISOString() });
}
