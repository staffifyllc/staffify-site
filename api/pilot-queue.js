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
import { createHash } from 'node:crypto';
import { requireAccess, redis, readBody } from './_auth.js';
import { REQUEST_STATES, ANSWER_KINDS, validateTransition } from './_pilotstate.js';
import { notifyState, retryAlert } from './_rolemap.js';
import { expectedEventTypes, PILOT_EVENT } from './_booking-match.js';
import { syncHealth, enqueueSync } from './_pilot-sync.js';
import { guardHealth } from './_client-guard.js';
import { DRAFTS, mailto } from './_pilot-drafts.js';
import { findPaymentCandidates, verifyLinkedPayment, isVerifiedPaid } from './_pilot-payment.js';
import { qboConnected, qboQuery, getRealmId } from './_qbo.js';
import { configured as hubspotConfigured, portalId } from './_hubspot.js';
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
                // The CRM link, and whether it actually happened.
                crm: { state: r.syncState || 'pending', error: r.syncError || '', attempts: Number(r.syncAttempts || 0),
                    contactId: r.crmContactId || '', dealId: r.crmDealId || '', taskId: r.crmTaskId || '',
                    dueAt: r.crmTaskDueAt || null, dealSkipped: r.crmDealSkipped || '',
                    isClient: r.isExistingClient === 'true', clientReason: r.clientReason || '',
                    needsReview: r.needsReview === 'true', reason: r.syncReason || '' },
                booking: { ref: r.bookingRef || '', agreedFor: r.agreedFor || '', proposedFor: r.bookingProposedFor || '',
                    canceledAt: r.bookingCanceledAt || null, canceledReason: r.bookingCanceledReason || '',
                    reviewReason: r.bookingReviewReason || '', eventName: r.bookingEventName || '',
                    rescheduledFrom: r.bookingRescheduledFrom || '' },
                payment: { reference: r.paymentReference || '', status: r.paymentStatus || '', why: r.paymentWhy || '',
                    realm: r.paymentRealm || '', customerId: r.paymentCustomerId || '',
                    checkedAt: r.paymentCheckedAt || null, verifiedAt: r.paymentVerifiedAt || null,
                    formerReference: r.paymentFormerReference || '', formerClearedWhy: r.paymentFormerClearedWhy || '',
                    invoiceId: r.paymentInvoiceId || '', linkedBy: r.paymentLinkedBy || '' },
                origin: { kind: r.origin || 'inbound', cohortId: r.originCohortId || '', evidence: r.originEvidence || '',
                    submittedForm: r.submittedForm !== 'false' },
                // Saved drafts, so an edit survives a refresh and the mail client gets what was typed.
                draft: { subject: r.draftSubject || '', body: r.draftBody || '', kind: r.draftKind || '',
                    savedAt: r.draftSavedAt || null, savedBy: r.draftSavedBy || '',
                    role: r.draft_role || '', hours: r.draft_hours || '', level: r.draft_level || '',
                    tasks: r.draft_tasks || '', assumption: r.draft_assumption || '',
                    successMeasure: r.draft_successMeasure || '', nextStep: r.draft_nextStep || '' },
                attribution: [r.utmSource, r.utmMedium, r.utmCampaign, r.utmContent].filter(Boolean).join(' / '),
                // A promoted cohort record is not an inbound request and must not be labelled as one.
                arm: r.arm || 'inbound',
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
        if (scope === 'draft') {
            // Renders an artifact. Changes nothing, marks nothing sent.
            const id = STR(b.id, 200);
            const kind = STR(b.kind, 20);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            if (!DRAFTS[kind]) return res.status(400).json({ ok: false, error: 'draft must be reply, roleMap or proposal' });
            let rec = null;
            try { rec = await redis.hgetall(id); } catch (e) { return res.status(503).json({ ok: false, error: 'could not read that request' }); }
            if (!rec || !rec.email) return res.status(404).json({ ok: false, error: 'no such request' });
            // Saved structured fields first, then anything the operator just typed on top.
            const saved = {};
            for (const f of ['role', 'hours', 'level', 'tasks', 'assumption', 'successMeasure', 'nextStep']) {
                if (rec['draft_' + f]) saved[f] = rec['draft_' + f];
            }
            const draft = DRAFTS[kind]({ ...rec }, { ...saved, ...(b.options || {}) });
            return res.status(200).json({ ok: true, draft, mailto: mailto(rec.email, draft),
                note: 'This is a draft. Nothing has been sent and nothing was marked sent.' });
        }

        if (scope === 'save-draft') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            let rec = null;
            try { rec = await redis.hgetall(id); } catch (e) { return res.status(503).json({ ok: false, error: 'could not read that request, so nothing was saved' }); }
            if (!rec || !rec.email) return res.status(404).json({ ok: false, error: 'no such request' });
            const patch = { draftSavedAt: new Date().toISOString(), draftSavedBy: STR((who && who.name) || 'operator', 60) };
            if (b.subject !== undefined) patch.draftSubject = STR(b.subject, 250);
            if (b.body !== undefined) patch.draftBody = STR(b.body, 12000);
            if (b.kind !== undefined) patch.draftKind = STR(b.kind, 20);
            // The structured pieces a role map and a proposal cannot be written without. Saved on the
            // record so the next render starts from them instead of from brackets.
            for (const f of ['role', 'hours', 'level', 'tasks', 'assumption', 'successMeasure', 'nextStep']) {
                if (b[f] !== undefined) patch['draft_' + f] = STR(b[f], 2000);
            }
            try { await redis.hset(id, patch); }
            catch (e) { return res.status(503).json({ ok: false, error: 'that draft did not save, so it is still only on your screen' }); }
            return res.status(200).json({ ok: true, savedAt: patch.draftSavedAt,
                note: 'Saved as a draft. Nothing has been sent and nothing is marked sent.' });
        }

        if (scope === 'sync') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            // The worker itself runs in api/pilot-sync.js, which owns every guard. This only queues it,
            // and only reports queued if the queue actually took it.
            const q = await enqueueSync(redis, id, { at: Date.now() });
            if (!q.ok) return res.status(503).json({ ok: false, error: q.error || 'the sync could not be queued' });
            return res.status(200).json({ ok: true, queued: true, note: 'queued; the sync worker will pick it up' });
        }

        // A cohort owner who replies or books directly deserves the same linked journey. This opens
        // one from a cohort record WITHOUT pretending they filled in the form: the origin is recorded
        // as the cohort, with the cohort's own evidence, and the arm stays cohort rather than inbound.
        if (scope === 'start-opportunity') {
            const cohortId = STR(b.cohortId, 64);
            const email = STR(b.email, 160).toLowerCase();
            if (!cohortId) return res.status(400).json({ ok: false, error: 'which cohort record?' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return res.status(400).json({ ok: false, error: 'that email does not look right' });
            const id = 'pilot:req:' + createHash('sha256').update(email).digest('hex').slice(0, 24);
            const at = new Date().toISOString();
            const how = STR(b.how, 200);
            if (!how) return res.status(400).json({ ok: false, error: 'say what actually happened, in one line. This is the evidence.' });
            const first = {
                id, email, createdAt: at, arm: 'cohort', origin: 'cohort', originCohortId: cohortId,
                originEvidence: how, name: STR(b.name, 80), company: STR(b.company, 120),
                pain: STR(b.pain, 1200), state: 'ANSWERED', answeredAt: at,
                source: 'founder-outreach', path: 'cohort/' + cohortId,
                syncState: 'pending', owner: 'Paul', isTest: 'false',
                // Explicitly not a form submission, so nothing downstream can read it as one.
                submittedForm: 'false',
            };
            try {
                for (const [k, v] of Object.entries(first)) await redis.hsetnx(id, k, v);
                await redis.hset(id, { lastTouchAt: at, originEvidence: how });
                await redis.zadd('pilot:requests', { score: Date.now(), member: id });
            } catch (e) { return res.status(503).json({ ok: false, error: 'the opportunity could not be recorded' }); }
            const q = await enqueueSync(redis, id, { at: Date.now() });
            return res.status(200).json({ ok: true, id, queued: !!q.ok,
                queueError: q.ok ? '' : (q.error || 'not queued'),
                note: 'Opened from the cohort, not from the form. The CRM sync will link it.' });
        }

        // Two steps on purpose. Finding candidates never concludes anything; verifying checks only
        // the invoice a person explicitly linked.
        if (scope === 'payment-candidates') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            let rec = null;
            try { rec = await redis.hgetall(id); } catch (e) { return res.status(503).json({ ok: false, error: 'could not read that request' }); }
            if (!rec || !rec.email) return res.status(404).json({ ok: false, error: 'no such request' });
            const v = await findPaymentCandidates({ email: rec.email, company: rec.company, since: rec.createdAt },
                { qboConnected, qboQuery, getRealmId });
            return res.status(200).json({ ok: true, candidates: v,
                note: 'These are candidates. Nothing is paid until you link one and it verifies.' });
        }

        if (scope === 'payment-link') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            const link = { realm: STR(b.realm, 40), customerId: STR(b.customerId, 40), invoiceId: STR(b.invoiceId, 40) };
            const unlink = b.unlink === true;
            if (!unlink && (!link.customerId || !link.invoiceId)) {
                return res.status(400).json({ ok: false, error: 'a link needs a customer and an invoice' });
            }
            // Read before writing. hset on an id that does not exist would create an empty hash that
            // looks like a request and is not one.
            let existing = null;
            try { existing = await redis.hgetall(id); }
            catch (e) { return res.status(503).json({ ok: false, error: 'could not read that request, so nothing was written' }); }
            if (!existing || !existing.email) return res.status(404).json({ ok: false, error: 'no such request' });
            const v = unlink
                ? { status: 'needs-link', why: 'the link was removed, so nothing is recorded as paid' }
                : await verifyLinkedPayment(link, { qboConnected, qboQuery, getRealmId });
            const patch = {
                paymentStatus: v.status, paymentWhy: v.why || '', paymentCheckedAt: new Date().toISOString(),
                paymentCustomerId: unlink ? '' : link.customerId, paymentInvoiceId: unlink ? '' : link.invoiceId,
                paymentRealm: unlink ? '' : (link.realm || ''),
                paymentLinkedBy: STR((who && who.name) || 'operator', 60),
            };
            // Only a verified paid verdict may ever write a reference. A later non-paid refresh
            // clears the live one and keeps the old one visible as history, so a payment that was
            // verified and then voided does not vanish without trace.
            const had = existing.paymentReference;
            if (isVerifiedPaid(v)) {
                patch.paymentReference = v.reference;
                patch.paymentVerifiedAt = new Date().toISOString();
            } else {
                patch.paymentReference = '';
                if (had) {
                    patch.paymentFormerReference = had;
                    patch.paymentFormerClearedAt = new Date().toISOString();
                    patch.paymentFormerClearedWhy = v.why || v.status;
                }
            }
            try { await redis.hset(id, patch); }
            catch (e) { return res.status(503).json({ ok: false, error: 'the verdict could not be recorded, so nothing was changed', verdict: v }); }
            return res.status(200).json({ ok: true, verdict: v, recordedReference: isVerifiedPaid(v),
                clearedPrevious: !isVerifiedPaid(v) && !!had });
        }

        if (scope === 'retry-alert') {
            const id = STR(b.id, 200);
            if (!/^pilot:req:[A-Za-z0-9]+$/.test(id)) return res.status(400).json({ ok: false, error: 'not a request id' });
            // Only the channels that never got through are tried again, so a delivery cannot be doubled.
            const out = await retryAlert(id, { redis, notifyEmail, notifySlack, now: Date.now });
            return res.status(out.ok ? 200 : 502).json(out);
        }
        return res.status(400).json({ ok: false, error: 'scope must be cohort, request, draft, save-draft, sync, start-opportunity, payment-candidates, payment-link or retry-alert' });
    }

    const [cohort, requests, sync, guard, qbo] = await Promise.all([
        engine(''), loadRequests(), syncHealth(redis), guardHealth(),
        qboConnected().then((ok) => ({ ok })).catch(() => ({ ok: false })),
    ]);
    const portal = await portalId().catch(() => ({ ok: false, why: 'the portal could not be read' }));
    const cb = cohort.body || {};
    // Integration health, stated as configured or not rather than implied by silence.
    const health = {
        hubspot: { configured: hubspotConfigured(), label: 'CRM sync' },
        clientGuard: guard,
        crmSync: sync,
        quickbooks: { configured: !!qbo.ok, label: 'payment evidence',
            note: qbo.ok ? '' : 'not connected, so no request can be shown as paid from here' },
        // Health has to ask the same question the matcher asks. Reading the environment variable
        // directly said "not set" while the matcher was happily counting bookings against the
        // shipped default, so the panel was reporting a problem that did not exist.
        calendly: (() => {
            const types = expectedEventTypes();
            const fromEnv = !!String(process.env.PILOT_EVENT_TYPES || '').trim();
            const signed = !!process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
            return {
                configured: signed && types.length > 0,
                eventTypes: types.length,
                eventName: PILOT_EVENT.name, eventUrl: PILOT_EVENT.url, eventMinutes: PILOT_EVENT.minutes,
                source: fromEnv ? 'PILOT_EVENT_TYPES' : 'shipped with the code',
                note: !signed
                    ? 'no signing key, so booking events are rejected'
                    : !types.length
                        ? 'no event type is recognised, so every booking is held for review rather than counted'
                        : `counting bookings on ${PILOT_EVENT.name}, ${PILOT_EVENT.minutes} minutes`
                          + (fromEnv ? ', from PILOT_EVENT_TYPES' : ''),
            };
        })(),
        hubspotPortal: { configured: !!portal.ok, portalId: portal.portalId || '',
            label: 'HubSpot account this site writes to',
            note: portal.ok
                ? (process.env.PILOT_OWNER_PORTAL && process.env.PILOT_OWNER_PORTAL !== portal.portalId
                    ? `PILOT_OWNER_ID was set for portal ${process.env.PILOT_OWNER_PORTAL}, which is not this one. An owner id from another account is meaningless here.`
                    : '')
                : (portal.why || '') },
        owner: { configured: !!process.env.PILOT_OWNER_ID,
            label: 'pilot task owner',
            note: process.env.PILOT_OWNER_ID ? '' :
                'PILOT_OWNER_ID is not set and the HubSpot token cannot read owners, so no task can be assigned. '
                + 'Until it is set, every sync reports partial with the task missing rather than creating an unowned one.' },
        email: { configured: !!process.env.RESEND_API_KEY, label: 'request alerts' },
        slack: { configured: !!(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL), label: 'request alerts' },
    };
    return res.status(200).json({
        ok: true,
        cohort: cb.ok ? cb : { ok: false, status: 'UNKNOWN', why: cb.error || 'the engine did not answer', records: [], report: null },
        requests,
        health,
        requestStates: REQUEST_STATES,
        answerKinds: ANSWER_KINDS,
        you: { name: who.name || '', email: who.email || '' },
    });
}
