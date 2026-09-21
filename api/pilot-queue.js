// THE FOUNDER PILOT WORK QUEUE, for /pilot/ on the hub.
//
//   GET  /api/pilot-queue            -> { ok, cohort, report, records, requests, drafts, vocabulary }
//   POST /api/pilot-queue            -> { ok, ... }
//        { scope:'cohort', id, update:{...} }   forwarded to the engine
//        { scope:'request', id, set:{...} }     an inbound role-map request, updated here
//
// Two sources, deliberately kept apart:
//   * the COHORT is Paul's own batch of owners (warm and cold), held by the engine;
//   * REQUESTS are people who asked from /real-estate-media/ themselves. They are inbound. They are
//     never counted as warm or cold, because they came to us.
//
// Behind the same gate as /hub/ and Sales Live: a signed-in rep or an admin token. These records hold
// owners' own words about their businesses and must never be public.
import { requireAccess, redis, readBody } from './_auth.js';
import { REQUEST_STATES, ANSWER_KINDS, validateTransition } from './_pilotstate.js';
import { notifyState, retryAlert } from './_rolemap.js';
import { notifyEmail, notifySlack } from './_notify-request.js';

const ENGINE = 'https://campaign-dashboard-green.vercel.app/api/pilot-cohort';

const STR = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);

async function engine(path, init) {
    const token = process.env.SALES_PORTAL_TOKEN || '';
    if (!token) return { status: 500, body: { ok: false, error: 'the pilot queue is not connected to the engine (SALES_PORTAL_TOKEN missing)' } };
    try {
        const r = await fetch(`${ENGINE}?t=${encodeURIComponent(token)}${path || ''}`, {
            ...(init || {}), signal: AbortSignal.timeout(30000),
        });
        const j = await r.json().catch(() => null);
        if (!j) return { status: 502, body: { ok: false, error: `the engine answered ${r.status} with nothing readable` } };
        // The engine's own status is carried through, so a 409 stays a 409 and the UI keeps the edit.
        return { status: r.status, body: j };
    } catch (e) {
        return { status: 502, body: { ok: false, error: 'the engine did not answer', keepEdit: true } };
    }
}

/** Inbound requests, newest first. A read that fails is reported as unknown, never as none. */
async function loadRequests(limit = 60) {
    try {
        const ids = (await redis.zrange('pilot:requests', 0, limit - 1, { rev: true })) || [];
        if (!ids.length) return { status: 'EMPTY', items: [] };
        const rows = await Promise.all(ids.map((id) => redis.hgetall(id).catch(() => undefined)));
        // undefined means the read failed. null/empty means the row is genuinely gone. Only the first
        // is a hole in the answer, and it has to be visible rather than quietly filtered away.
        const unreadable = rows.filter((h) => h === undefined).length;
        const items = rows.map((h, i) => (h ? { ...h, id: ids[i] } : null)).filter(Boolean)
            .filter((r) => r.isTest !== true && r.isTest !== 'true')
            .map((r) => ({
                id: r.id, name: r.name || '', email: r.email || '', company: r.company || '',
                pain: r.pain || '', times: r.times || '', wants: r.wants || 'role_map',
                state: REQUEST_STATES[r.state] ? r.state : 'REQUESTED',
                stateLabel: (REQUEST_STATES[r.state] || REQUEST_STATES.REQUESTED).label,
                answeredAt: r.answeredAt || null, roleMapSentAt: r.roleMapSentAt || null,
                roleMapArtifact: r.roleMapArtifact || '', agreedFor: r.agreedFor || null,
                bookingRef: r.bookingRef || '', heldAt: r.heldAt || null,
                answerKind: r.answerKind || '', answerWords: r.answerWords || '',
                owner: r.owner || 'Paul', notes: r.notes || '',
                submissions: Number(r.submissions || 1),
                createdAt: r.createdAt || null, updatedAt: r.updatedAt || null,
                lastSubmissionAt: r.lastSubmissionAt || null,
                newSubmissionAfterClose: r.newSubmissionAfterClose || null,
                // Each channel on its own. "Nobody was alerted" is only true when neither got through.
                notify: { email: r.notifyEmail || '', slack: r.notifySlack || '',
                    emailAt: r.notifyEmailAt || null, slackAt: r.notifySlackAt || null,
                    state: notifyState(r), reopenAlert: r.reopenAlert || '' },
                arm: 'inbound',
            }));
        return unreadable
            ? { status: 'PARTIAL', items, unreadable, why: `${unreadable} request(s) in the index could not be read` }
            : { status: 'DATA', items };
    } catch (e) {
        return { status: 'UNKNOWN', why: 'the request store did not answer', items: [] };
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const who = await requireAccess(req).catch(() => null);
    if (!who) return res.status(401).json({ ok: false, error: 'Sign in to open the pilot queue' });

    if (req.method === 'POST') {
        const b = readBody(req) || {};
        const scope = STR(b.scope, 20);

        if (scope === 'cohort') {
            const out = await engine('', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: b.id, update: b.update, seed: b.seed, rev: b.rev }) });
            return res.status(out.status).json(out.body);
        }

        if (scope === 'request') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            const set = b.set || {};
            let existing = null;
            try { existing = await redis.hgetall(id); } catch (e) {
                return res.status(503).json({ ok: false, error: 'could not read that request, so nothing was written', keepEdit: true });
            }
            if (!existing || !existing.email) return res.status(404).json({ ok: false, error: 'no such request' });
            // The gate. You cannot claim a state whose evidence is not in front of you, and you cannot
            // record why someone said no unless they said it.
            const check = validateTransition(existing, STR(set.state, 30), set);
            if (!check.ok) return res.status(400).json({ ...check, ok: false, keepEdit: true });
            try { await redis.hset(id, check.patch); } catch (e) {
                return res.status(503).json({ ok: false, error: 'that did not save. Your entry is still here.', keepEdit: true });
            }
            return res.status(200).json({ ok: true, id, state: check.patch.state, label: REQUEST_STATES[check.patch.state].label });
        }
        if (scope === 'retry-alert') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            // Only the channels that never got through are tried again, so a delivery cannot be doubled.
            const out = await retryAlert(id, { redis, notifyEmail, notifySlack, now: Date.now });
            return res.status(out.ok ? 200 : 502).json(out);
        }
        return res.status(400).json({ ok: false, error: 'scope must be cohort, request or retry-alert' });
    }

    const [cohort, requests] = await Promise.all([engine(''), loadRequests()]);
    const cb = cohort.body || {};
    return res.status(200).json({
        ok: true,
        cohort: cb.ok ? cb : { ok: false, status: 'UNKNOWN', why: cb.error || 'the engine did not answer', records: [], report: null },
        requests,
        requestStates: REQUEST_STATES,
        answerKinds: ANSWER_KINDS,
        you: { name: who.name || '', email: who.email || '' },
    });
}
