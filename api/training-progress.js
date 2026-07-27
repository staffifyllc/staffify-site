// Per-rep training progress + quiz scores, and the team board.
// POST /api/training-progress {module, correct, total}  -> record for the logged-in rep (session required)
// GET  /api/training-progress                           -> { me, team:[...sorted], isAdmin }
// Storage: hash training:{email} (fields m0..m7 = "correct/total", m{n}_p = "1", name, updated); set training:reps

import { openIdentity, redis, readBody } from './_auth.js';

const NMOD = 8;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'POST') {
        const rep = await openIdentity(req); // open-share: record under the name the visitor set (else Guest)
        const b = readBody(req);
        const m = Number(b.module);
        if (!(m >= 0 && m < NMOD)) return res.status(400).json({ error: 'bad_module' });
        const key = 'training:' + rep.email;
        const fields = { name: rep.name || rep.email, updated: String(Date.now()), ['m' + m + '_p']: '1' };
        if (b.correct != null && b.total != null) fields['m' + m] = Number(b.correct) + '/' + Number(b.total);
        await redis.hset(key, fields);
        await redis.sadd('training:reps', rep.email);
        return res.status(200).json({ ok: true });
    }

    const who = await openIdentity(req); // open-share: anyone can see the team board

    const emails = (await redis.smembers('training:reps')) || [];
    const team = [];
    for (const e of emails) {
        const h = (await redis.hgetall('training:' + e)) || {};
        let doneCount = 0, sSum = 0, sN = 0;
        for (let i = 0; i < NMOD; i++) {
            if (String(h['m' + i + '_p']) === '1') doneCount++;
            const s = h['m' + i];
            if (s && String(s).indexOf('/') >= 0) { const p = String(s).split('/').map(Number); if (p[1]) { sSum += p[0] / p[1]; sN++; } }
        }
        team.push({ email: e, name: h.name || e, done: doneCount, total: NMOD, avg: sN ? Math.round((100 * sSum) / sN) : null, updated: Number(h.updated || 0) });
    }
    team.sort((a, b) => b.done - a.done || (b.avg || 0) - (a.avg || 0) || b.updated - a.updated);

    const mine = {};
    if (who.email && who.email !== 'admin') {
        const h = (await redis.hgetall('training:' + who.email)) || {};
        for (let i = 0; i < NMOD; i++) mine[i] = String(h['m' + i + '_p']) === '1';
    }
    return res.status(200).json({ me: { email: who.email, done: mine }, team, isAdmin: who.role === 'admin' });
}
