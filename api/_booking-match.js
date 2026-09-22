// A BOOKING IS ONLY A BOOKING WHEN CALENDLY SAYS SO, FOR THE RIGHT EVENT, FOR THE RIGHT PERSON.
//
// Calendly's webhook verifies its own signature. What it did not do was connect a booking to the
// inbound request that produced it, handle a cancellation, or survive events arriving out of order.
// A reschedule is TWO events, the old invitee canceled and a new one created, and they do not
// reliably arrive in that order.
//
// The rules, each from a way this breaks:
//
//  * THE CLAIM AND THE WRITE ARE THE SAME WRITE. An earlier cut claimed a separate "seen" key first,
//    so a failed persist left the claim behind and every retry was swallowed as a duplicate while
//    the booking was never recorded. The applied-event marker now lives IN the record and is written
//    in the same HSET as the change it marks.
//  * ONE WRITER AT A TIME. Read, compare and write happen under a short lease on the record, so two
//    events arriving together cannot interleave. The lease is token-released.
//  * IMMUTABLE IDENTITY. Every decision keys on the invitee URI, never on an email or a time.
//  * A CANCEL ONLY CANCELS WHAT IT NAMES. A late cancel for a superseded invitee is recorded and
//    ignored, because that is the reschedule case and getting it wrong wipes a live meeting.
//  * A CANCELLATION IS A CANCELLATION. The state becomes CANCELED and the old time is cleared. It
//    does not fall back to "time agreed" with a time nobody is holding.
//  * THE WRONG EVENT TYPE DOES NOT COUNT AS A CONVERSION. An unexpected or unconfigured event type
//    is held for review rather than recorded as a booked pilot meeting.
//  * LATE EVENTS DO NOT REOPEN WHAT IS FINISHED. A suppressed, closed or paid record is left alone.
//  * AN EMAIL MATCH IS A LINK, NOT A RELATIONSHIP, AND NEVER PAYMENT EVIDENCE.
import { createHash } from 'node:crypto';
import { bookingAttribution } from '../assets/js/pilot-attribution.js';

export const hashEmail = (s) => createHash('sha256').update(String(s).toLowerCase()).digest('hex').slice(0, 24);
export const requestIdFor = (email) => `pilot:req:${hashEmail(email)}`;

// THE ONE EVENT THIS PILOT BOOKS.
//
// Created in Calendly on 2026-09-21 and verified through the API: 15 minutes, active, public,
// instant booking, Google Meet, a single optional question, no prep and no video gate. It exists
// because every other event on the account belongs to a different offer, and pointing media owners
// at an agency lead-generation questionnaire or a 30-minute qualification form was the mismatch this
// whole piece of work set out to remove.
//
// The URI ships in the code rather than only in an environment variable, because a booking arriving
// against an unrecognised event type is held for review, and a config gap would quietly hold every
// one of them. PILOT_EVENT_TYPES still overrides if the event is ever rebuilt.
export const PILOT_EVENT = Object.freeze({
    uri: 'https://api.calendly.com/event_types/39fabd35-909a-46aa-996c-abb025e5192f',
    url: 'https://calendly.com/go-staffify/media-owner-workflow-chat',
    name: 'Media Owner Workflow Chat',
    minutes: 15,
});

/** Event types a media-owner booking may come from. */
export const expectedEventTypes = () => {
    const configured = String(process.env.PILOT_EVENT_TYPES || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
    return configured.length ? configured : [PILOT_EVENT.uri, PILOT_EVENT.name];
};

/** Records that a late booking event must never disturb. */
export const FINISHED_STATES = new Set(['CLOSED', 'HELD']);

// bookingEventAt is stored as epoch milliseconds in a string field, and `new Date("1758708000000")`
// is NaN, not that instant. Reading it back as a date silently disabled the whole ordering check.
/** The one optional question on the media-owner event, in their words, if they answered it. */
function firstAnswer(p) {
    const qa = (p && (p.questions_and_answers || p.questionsAndAnswers)) || [];
    for (const x of qa) {
        const a = String((x && (x.answer || x.value)) || '').trim();
        if (a) return a.slice(0, 1200);
    }
    return '';
}

const num = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const s = String(v);
    if (/^\d+$/.test(s)) return Number(s);
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : 0;
};
const LEASE_SECONDS = 20;
const RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const eventKey = (inviteeUri, kind) => `${kind}:${hashEmail(inviteeUri)}`;
const appliedList = (r) => String(r.bookingApplied || '').split(',').filter(Boolean);

/**
 * Apply one Calendly event to the pilot request it belongs to, if any.
 * deps: { redis, now, expected }
 */
export async function applyBookingEvent(event, deps) {
    const { redis, now = () => Date.now(), expected = expectedEventTypes } = deps;
    const kind = String((event && event.event) || '');
    const p = (event && event.payload) || {};
    const inviteeUri = String(p.uri || '');
    const email = String(p.email || '').toLowerCase().trim();
    const at = new Date(now()).toISOString();

    if (kind !== 'invitee.created' && kind !== 'invitee.canceled') return { applied: false, reason: `ignored event ${kind}` };
    if (!email) return { applied: false, reason: 'no email on the payload' };
    if (!inviteeUri) return { applied: false, reason: 'no invitee uri, so there is no identity to key on' };

    const id = requestIdFor(email);
    const lease = `${id}:booking:lease`;
    const tk = `${now()}-${Math.random().toString(36).slice(2, 8)}`;
    let holding = false;
    try { holding = (await redis.set(lease, tk, { nx: true, ex: LEASE_SECONDS })) !== null; }
    catch (e) { return { applied: false, retryable: true, reason: 'the booking lease could not be taken' }; }
    // Retryable on purpose: Calendly will send it again, and a 5xx is how we ask it to.
    if (!holding) return { applied: false, retryable: true, reason: 'another booking event for this person is being applied' };

    try {
        let r;
        try { r = await redis.hgetall(id); }
        catch (e) { return { applied: false, retryable: true, reason: 'the request store did not answer' }; }
        // NOBODY WHO BOOKS FALLS ON THE FLOOR, AND A HALF MADE RECORD IS NOT A MADE ONE.
        //
        // The owner page offers the fifteen minutes directly, so somebody can book without ever
        // filling in the form. Before this they matched nothing and the booking existed only in
        // Calendly.
        //
        // Creation is three things and all three have to happen: the fields, the indexes the hub and
        // the lead queue read, and the enqueue that gets it to the CRM. A first draft wrote the
        // fields one at a time and treated an email as proof of a finished record, so a failure right
        // after the email left something orphaned that every retry skipped. It also shrugged off a
        // failed enqueue on the theory that the cron would find it, and the cron reads the due queue
        // and nothing else, so it never would.
        //
        // So origin and a pending marker go down FIRST, before the email, because a record with an
        // email and nothing else is exactly what that failure leaves and it has to be recognisable.
        // originComplete is written last, only once the indexes and the enqueue are both down.
        let created = false;
        let healed = false;
        const incomplete = !!(r && r.email && r.originComplete !== 'true'
            && (r.origin === 'direct_booking' || r.originPending));
        if (!r || !r.email || incomplete) {
            if (kind !== 'invitee.created') {
                return { applied: false, matched: false, reason: 'a cancellation for an address we hold nothing for' };
            }
            const ev0 = p.scheduled_event || {};
            const type0 = String(ev0.event_type || p.event_type || '');
            const name0 = String(ev0.name || '');
            const allowed0 = expected();
            // Only the event we verified for this audience. A booking on somebody else's event type
            // belongs to somebody else's funnel, and inventing a media-owner opportunity from it is
            // the same mistake as repurposing the event in the first place.
            if (!allowed0.length || !(allowed0.includes(type0) || allowed0.includes(name0))) {
                return { applied: false, matched: false,
                    reason: `a booking on "${name0 || type0 || 'an unrecognised event type'}", which is not the media-owner event, and there is no request to attach it to` };
            }
            const first = {
                origin: 'direct_booking', originPending: at,
                id, email, createdAt: at, arm: 'inbound',
                name: String(p.name || '').slice(0, 80), company: '', state: 'REQUESTED',
                originEvidence: `booked "${name0}" directly on ${at} without filling in the form`,
                originInvitee: inviteeUri, originEventType: type0, originEventName: name0,
                source: 'calendly-direct', path: PILOT_EVENT.url,
                // Never a form submission, and never a cold nurture candidate.
                submittedForm: 'false', nurtureSuppressed: 'true',
                nurtureSuppressedReason: 'they booked the media-owner call directly',
                pain: firstAnswer(p),
                syncState: 'pending', owner: 'Paul', isTest: 'false',
                ...bookingAttribution(p.tracking),
            };
            try {
                for (const [k, v] of Object.entries(first)) await redis.hsetnx(id, k, v);
            } catch (e) {
                return { applied: false, retryable: true, reason: 'the direct booking could not be written' };
            }
            try {
                await redis.zadd('pilot:requests', { score: now(), member: id });
                await redis.zadd('leads:by_date', { score: now(), member: id });
            } catch (e) {
                return { applied: false, retryable: true, reason: 'the direct booking was written but could not be indexed' };
            }
            if (!deps.enqueueSync) {
                return { applied: false, retryable: true,
                    reason: 'no sync queue is wired, and nothing else would ever pick this booking up' };
            }
            let q;
            try { q = await deps.enqueueSync(redis, id, { at: now() }); }
            catch (e) { q = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
            if (!q || !q.ok) {
                return { applied: false, retryable: true,
                    reason: `the direct booking was recorded but could not be queued for the CRM (${(q && q.error) || 'unknown'}), so it was not acknowledged` };
            }
            try { await redis.hset(id, { originComplete: 'true', originCompletedAt: at, originPending: '' }); }
            catch (e) { return { applied: false, retryable: true, reason: 'the direct booking could not be marked complete' }; }

            try { r = await redis.hgetall(id); } catch (e) { r = null; }
            if (!r || !r.email) return { applied: false, retryable: true, reason: 'the direct booking was written but could not be read back' };
            created = !incomplete;
            healed = incomplete;
            // Deliberately NOT an early return. Returning here answered 200, so Calendly considered
            // the event delivered and never sent it again, and there is no other delivery to wait
            // for. This same successful call carries on and applies the booking, through the closed
            // and suppressed checks below, which a healed record still has to pass.
        }

        // The marker lives in the record, so it becomes true only when the change beside it does.
        const key = eventKey(inviteeUri, kind);
        const applied = appliedList(r);
        if (applied.includes(key)) return { applied: false, matched: true, duplicate: true, reason: 'this event was already applied' };

        // Finished work is left alone, however late an event turns up.
        if (FINISHED_STATES.has(String(r.state || '')) || String(r.suppressed) === 'true' || r.paymentReference) {
            return { applied: false, matched: true, ignored: true,
                reason: `the record is ${r.paymentReference ? 'already paid' : String(r.suppressed) === 'true' ? 'suppressed' : 'closed'}, so a late booking event was not applied` };
        }

        const ev = p.scheduled_event || {};
        const eventTypeUri = String(ev.event_type || p.event_type || '');
        const eventName = String(ev.name || '');
        const startTime = String(ev.start_time || '');
        // Order by when the EVENT happened, never by when the meeting is. A start time is a future
        // instant and using it here made a cancellation look older than the booking it cancelled.
        const eventAt = num(p.updated_at) || num(p.created_at) || now();
        const appliedAt = num(r.bookingEventAt);
        if (appliedAt && eventAt < appliedAt) {
            await redis.hset(id, { bookingApplied: [...applied, key].join(','), bookingOutOfOrderAt: at,
                bookingOutOfOrderNote: `${kind} for ${inviteeUri} arrived after a newer event and was ignored` });
            return { applied: false, matched: true, stale: true, reason: 'an older event arrived after a newer one and was ignored' };
        }

        const allowed = expected();
        const audienceOk = allowed.length ? (allowed.includes(eventTypeUri) || allowed.includes(eventName)) : null;

        if (kind === 'invitee.created') {
            const base = {
                bookingApplied: [...applied, key].join(','),
                bookingRef: inviteeUri, bookingEventUri: String(ev.uri || ''),
                bookingEventType: eventTypeUri, bookingEventName: eventName,
                bookingEventAt: String(eventAt), bookedAt: at,
                bookingCanceledAt: '', bookingCanceledReason: '',
                // The one thing this must switch off: somebody in a thread with Paul does not belong
                // in a nurture sequence written for a cold visitor.
                nurtureSuppressed: 'true', nurtureSuppressedReason: 'they came from an inbound role-map request',
            };
            // Retain original form attribution; fill gaps for direct bookings and recovered records.
            for (const [field, value] of Object.entries(bookingAttribution(p.tracking))) {
                if (!r[field]) base[field] = value;
            }
            if (p.rescheduled === true || p.old_invitee) {
                base.bookingRescheduledFrom = String(p.old_invitee || '');
                base.bookingRescheduledAt = at;
            }
            // Only a booking on an event type we have verified for this audience counts as booked.
            if (audienceOk === true) {
                Object.assign(base, { state: 'BOOKED', agreedFor: startTime, bookingReviewReason: '' });
            } else {
                Object.assign(base, {
                    state: 'BOOKING_REVIEW',
                    agreedFor: '',
                    bookingProposedFor: startTime,
                    bookingReviewReason: audienceOk === null
                        ? `PILOT_EVENT_TYPES is not configured, so "${eventName || eventTypeUri || 'this event type'}" cannot be confirmed as the right one for media owners`
                        : `booked on "${eventName || eventTypeUri}", which is not one of the event types verified for this audience`,
                });
            }
            try { await redis.hset(id, base); }
            catch (e) { return { applied: false, retryable: true, reason: 'the booking could not be written, so nothing was marked applied' }; }
            return { applied: true, matched: true, created, healed, state: base.state, inviteeUri, startTime,
                rescheduled: !!(p.rescheduled || p.old_invitee), audienceOk, suppressedNurture: true,
                origin: created ? 'direct_booking' : (r.origin || 'inbound'),
                reviewReason: base.bookingReviewReason || '' };
        }

        // invitee.canceled
        if (r.bookingRef && r.bookingRef !== inviteeUri) {
            try {
                await redis.hset(id, { bookingApplied: [...applied, key].join(','), bookingSupersededCancelAt: at,
                    bookingSupersededCancelOf: inviteeUri });
            } catch (e) { return { applied: false, retryable: true, reason: 'the superseded cancellation could not be recorded' }; }
            return { applied: false, matched: true, superseded: true,
                reason: 'this cancellation is for a booking that was already replaced, so the live meeting stands' };
        }
        const patch = {
            bookingApplied: [...applied, key].join(','),
            state: 'CANCELED', bookingRef: '', agreedFor: '', bookingProposedFor: '',
            bookingCanceledAt: at, bookingCanceledInvitee: inviteeUri, bookingEventAt: String(eventAt),
            bookingCanceledReason: String((p.cancellation && p.cancellation.reason) || 'canceled in Calendly').slice(0, 300),
        };
        try { await redis.hset(id, patch); }
        catch (e) { return { applied: false, retryable: true, reason: 'the cancellation could not be written, so nothing was marked applied' }; }
        return { applied: true, matched: true, state: 'CANCELED', canceled: inviteeUri };
    } finally {
        try { if (typeof redis.eval === 'function') await redis.eval(RELEASE, [lease], [tk]); } catch (e) { /* it expires */ }
    }
}
