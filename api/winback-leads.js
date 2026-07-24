// Staffify WIN-BACK queue: former clients who dropped off. This is a damage-control / "earn your
// business back" call. The hook: they already paid onboarding, so they can reactivate with NO new
// onboarding fee. Source: Redis `winback:by_date`.
//
// GET  /api/winback-leads                 -> { leads:[...] } (rep session or admin)
// POST /api/winback-leads  {name,company,email,phone,leftReason}  -> add one (admin only, for loading the list)

import { requireAccess, adminAuthorized, redis, readBody, newToken } from './_auth.js';

const OPENER = [
    'Hi [first name], this is [you] with Staffify. I saw [company] worked with us before and stepped away, and I wanted to personally reach out to make it right.',
    'Two quick things. First, honestly, what did not work last time? I want to fix it.',
    'And second, the good news: because you already paid your onboarding with us, you do not pay it again. You can come right back and put that to use with the right person this time.'
];

function domainWebsite(email) {
    const free = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','live.com','me.com'];
    const at = (email || '').split('@')[1];
    if (!at || free.indexOf(at.toLowerCase()) !== -1) return '';
    return 'https://' + at.toLowerCase();
}

export default async function handler(req, res) {
    const who = await requireAccess(req);
    if (!who) return res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
        if (!adminAuthorized(req)) return res.status(403).json({ error: 'admin_only' });
        const b = readBody(req);
        if (!b.phone && !b.email) return res.status(400).json({ error: 'phone_or_email_required' });
        const id = 'winback:' + Date.now() + ':' + newToken(3);
        await redis.hset(id, {
            name: b.name || '', company: b.company || b.business || '', email: b.email || '',
            phone: b.phone || '', leftReason: b.leftReason || b.note || '', created_at: String(Date.now()),
        });
        await redis.zadd('winback:by_date', { score: Date.now(), member: id });
        return res.status(200).json({ ok: true, id });
    }

    const ids = (await redis.zrange('winback:by_date', 0, 199, { rev: true })) || [];
    const leads = [];
    for (const id of ids) {
        const h = await redis.hgetall(id);
        if (!h || (!h.phone && !h.email) || h.status === 'done') continue;
        const note = 'FORMER CLIENT, dropped off. They already paid onboarding, so no onboarding fee to come back. This is a make-it-right, win-back call.' + (h.leftReason ? ' Left because: ' + h.leftReason : '');
        leads.push({
            id, motion: 'staffing',
            name: h.name || '', company: h.company || '', email: h.email || '', phone: h.phone || '',
            city: '', website: h.website || domainWebsite(h.email),
            brief: note, opener: OPENER,
        });
    }
    return res.status(200).json({ count: leads.length, leads });
}
