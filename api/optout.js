// Do-not-contact management.
//   GET  /api/optout/                 -> { count, numbers, emails, recent }
//   GET  /api/optout/?check=+1555...  -> { optedOut: true|false }
//   GET  /api/optout/?scan=1          -> sweep OpenPhone for replies that say STOP and suppress them
//   POST /api/optout/ {phone,email,reason}       -> suppress by hand
//   POST /api/optout/ {phone, restore:true}      -> undo, if someone was suppressed in error
//
// The scan exists because opt-outs arrive as ordinary inbound texts. Carriers stop the SMS at their
// end, but nothing stops us CALLING them tomorrow, which is the part that gets a company in trouble.

import { adminAuthorized, currentRep, readBody, redis } from './_auth.js';
import { optOut, isOptedOut, optOutList, looksLikeOptOut, last10 } from './_optout.js';

const SEEN = 'optout:scan:seen';
const OP = 'https://api.openphone.com/v1';

export async function scanOpenPhone(limit, debug) {
    // Resumable and incremental. A conversation is only re-read when it has new activity, and the
    // sweep remembers where it got to, so a big inbox is worked through across runs instead of
    // restarting on the same first few threads every time and never reaching the rest.
    const started = Date.now();
    const BUDGET_MS = Number(process.env.OPTOUT_SCAN_BUDGET_MS || 20000);
    const key = process.env.OPENPHONE_API_KEY;
    if (!key) return { ok: false, reason: 'openphone_not_configured' };
    const headers = { Authorization: key, 'Content-Type': 'application/json' };

    let seen = {};
    try { seen = (await redis.hgetall(SEEN)) || {}; } catch { seen = {}; }
    const touched = {};

    try {
        const nr = await fetch(`${OP}/phone-numbers`, { headers });
        if (!nr.ok) return { ok: false, reason: 'phone_numbers_' + nr.status };
        const numJson = await nr.json();
        const numbers = ((numJson.data || [])).map(n => n.id).filter(Boolean);
        const diag = { numbers: numbers.length, convos: 0, checked: 0, skipped: 0, incoming: 0, samples: [] };
        if (!numbers.length) return { ok: false, reason: 'no_numbers', diag };

        const found = [];
        let out = false;
        for (const pn of numbers) {
            let pageToken = null;
            do {
                const cu = `${OP}/conversations?phoneNumberId=${encodeURIComponent(pn)}&maxResults=100` +
                           (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
                const cr = await fetch(cu, { headers });
                if (!cr.ok) break;
                const cj = await cr.json();
                const convos = cj.data || [];
                pageToken = cj.nextPageToken || (cj.totalItems && convos.length === 100 ? cj.nextPageToken : null) || null;
                diag.convos += convos.length;

                for (const c of convos) {
                    if (Date.now() - started > BUDGET_MS) { diag.timedOut = out = true; break; }
                    const stamp = String(c.lastActivityAt || c.updatedAt || '');
                    // Nothing has happened in this thread since we last read it, so there is no new reply to find.
                    if (c.id && seen[c.id] && seen[c.id] === stamp) { diag.skipped++; continue; }

                    const participant = (c.participants || []).find(p => p && p !== c.phoneNumber) || (c.participants || [])[0];
                    if (!participant) { if (c.id) touched[c.id] = stamp; continue; }

                    // OpenPhone takes participants as a plain repeated param. Verified against the live
                    // API: participants[] and participants[0] both 400 with "Expected array".
                    const mUrl = `${OP}/messages?phoneNumberId=${encodeURIComponent(pn)}` +
                                 `&participants=${encodeURIComponent(participant)}&maxResults=20`;
                    const mr = await fetch(mUrl, { headers });
                    diag.checked++;
                    if (!mr.ok) {
                        diag.msgFail = (diag.msgFail || 0) + 1;
                        if (!diag.msgError) diag.msgError = mr.status + ' ' + (await mr.text().catch(() => '')).slice(0, 180);
                        continue; // not marked seen, so a failed read is retried next run
                    }
                    const msgs = (await mr.json()).data || [];
                    for (const m of msgs) {
                        if ((m.direction || '').toLowerCase() !== 'incoming') continue;
                        diag.incoming++;
                        const body = m.text || m.body || '';
                        if (diag.samples.length < 8) diag.samples.push({ text: String(body).slice(0, 40), from: m.from || '' });
                        if (!looksLikeOptOut(body)) continue;
                        found.push({ phone: m.from || participant, text: String(body).slice(0, 120), at: m.createdAt || '' });
                        break;
                    }
                    if (c.id) touched[c.id] = stamp;
                    if (limit && found.length >= limit) { out = true; break; }
                }
                if (out) break;
            } while (pageToken);
            if (out) break;
        }

        const added = [];
        for (const f of found) {
            const already = await isOptedOut({ phone: f.phone });
            const r = await optOut({ phone: f.phone, reason: 'replied stop', source: 'openphone scan', text: f.text });
            if (r.ok && !already) added.push({ phone: r.phone, text: f.text });
        }
        // Only recorded once the threads were genuinely read, so a crash mid-sweep re-reads rather than skips.
        if (Object.keys(touched).length) { try { await redis.hset(SEEN, touched); } catch {} }

        return {
            ok: true,
            scanned: found.length,
            newlySuppressed: added.length,
            added,
            threadsRead: diag.checked,
            threadsUnchanged: diag.skipped,
            incomplete: !!diag.timedOut,
            note: diag.timedOut ? 'Time budget reached. Run again to pick up where this left off.' : undefined,
            ...(debug ? { diag } : {}),
        };
    } catch (e) {
        if (Object.keys(touched).length) { try { await redis.hset(SEEN, touched); } catch {} }
        return { ok: false, reason: 'error', detail: String((e && e.message) || e).slice(0, 160) };
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const who = await currentRep(req).catch(() => null);
    const isAdmin = adminAuthorized(req) || (who && who.role === 'admin');

    if (req.method === 'POST') {
        if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
        const b = readBody(req);
        if (b.restore) {
            const d = last10(b.phone);
            if (d) await redis.srem('optout:numbers', d);
            if (b.email) await redis.srem('optout:emails', String(b.email).toLowerCase());
            return res.status(200).json({ ok: true, restored: d || b.email });
        }
        const r = await optOut({ phone: b.phone, email: b.email, reason: b.reason || 'manual', source: 'manual' });
        return res.status(r.ok ? 200 : 400).json(r);
    }

    if (req.query.check) {
        return res.status(200).json({ optedOut: await isOptedOut({ phone: req.query.check, email: req.query.check }) });
    }

    if (req.query.scan) {
        if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
        return res.status(200).json(await scanOpenPhone(Number(req.query.limit) || 0, !!req.query.debug));
    }

    if (!isAdmin) return res.status(401).json({ error: 'unauthorized' });
    const list = await optOutList();
    return res.status(200).json({ count: list.numbers.length + list.emails.length, ...list });
}
