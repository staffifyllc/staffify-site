// Do-not-contact management.
//   GET  /api/optout/                 -> { count, numbers, emails, recent }
//   GET  /api/optout/?check=+1555...  -> { optedOut: true|false }
//   GET  /api/optout/?scan=1          -> sweep OpenPhone for replies that say STOP and suppress them
//   POST /api/optout/ {phone,email,reason}       -> suppress by hand
//   POST /api/optout/ {phone, restore:true}      -> undo, if someone was suppressed in error
//
// The scan exists because opt-outs arrive as ordinary inbound texts. Carriers stop the SMS at their
// end, but nothing stops us CALLING them tomorrow, which is the part that gets a company in trouble.

import { adminAuthorized, currentRep, readBody } from './_auth.js';
import { optOut, isOptedOut, optOutList, looksLikeOptOut, last10 } from './_optout.js';
import { redis } from './_auth.js';

const OP = 'https://api.openphone.com/v1';

async function scanOpenPhone(limit, debug) {
    const key = process.env.OPENPHONE_API_KEY;
    if (!key) return { ok: false, reason: 'openphone_not_configured' };
    const headers = { Authorization: key, 'Content-Type': 'application/json' };
    try {
        const nr = await fetch(`${OP}/phone-numbers`, { headers });
        if (!nr.ok) return { ok: false, reason: 'phone_numbers_' + nr.status };
        const numJson = await nr.json();
        const numbers = ((numJson.data || [])).map(n => n.id).filter(Boolean);
        const diag = { numbers: numbers.length, numberLabels: (numJson.data || []).map(n => n.number || n.name || n.id), convos: 0, incoming: 0, samples: [] };
        if (!numbers.length) return { ok: false, reason: 'no_numbers', diag };

        const found = [];
        for (const pn of numbers) {
            // Conversations first, then the recent messages in each, so one sweep sees every thread.
            const cr = await fetch(`${OP}/conversations?phoneNumberId=${encodeURIComponent(pn)}&maxResults=100`, { headers });
            if (!cr.ok) continue;
            const convos = (await cr.json()).data || [];
            diag.convos += convos.length;
            for (const c of convos) {
                const participant = (c.participants || []).find(p => p && p !== c.phoneNumber) || (c.participants || [])[0];
                if (!participant) continue;
                const mr = await fetch(`${OP}/messages?phoneNumberId=${encodeURIComponent(pn)}&participants[]=${encodeURIComponent(participant)}&maxResults=20`, { headers });
                if (!mr.ok) continue;
                const msgs = (await mr.json()).data || [];
                for (const m of msgs) {
                    const dir = (m.direction || '').toLowerCase();
                    if (dir === 'incoming') {
                        diag.incoming++;
                        if (diag.samples.length < 8) diag.samples.push({ dir, text: String(m.text || m.body || '').slice(0, 40), from: m.from || '' });
                    }
                    if (dir !== 'incoming') continue;
                    if (!looksLikeOptOut(m.text || m.body || '')) continue;
                    found.push({ phone: m.from || participant, text: (m.text || m.body || '').slice(0, 120), at: m.createdAt || '' });
                    break;
                }
                if (limit && found.length >= limit) break;
            }
            if (limit && found.length >= limit) break;
        }

        const added = [];
        for (const f of found) {
            const already = await isOptedOut({ phone: f.phone });
            const r = await optOut({ phone: f.phone, reason: 'replied stop', source: 'openphone scan', text: f.text });
            if (r.ok && !already) added.push({ phone: r.phone, text: f.text });
        }
        return { ok: true, scanned: found.length, newlySuppressed: added.length, added, ...(debug ? { diag } : {}) };
    } catch (e) {
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
