// Quo's API, for reading who actually made which calls.
// ------------------------------------------------------------------
// Quo is OpenPhone. The product was renamed in 2025 and the API moved to api.quo.com, which is why
// the onboarding page lists both names in one stack line. The existing OPENPHONE_API_KEY is a Quo
// key and is reused here; no new credential is needed.
//
// This talks to the 2026-03-30 version of the API, NOT the legacy /v1 routes the rest of the
// codebase uses. The reason matters: legacy GET /v1/calls REQUIRES phoneNumberId AND participants,
// one conversation at a time, so it structurally cannot answer "how many calls did this rep make
// today". The 2026-03-30 GET /calls has no required parameters and takes actorId plus a createdAt
// range, which is exactly that question.
//
// Docs: https://www.quo.com/docs/2026-03-30/calls/list-calls
//       https://www.quo.com/docs/2026-03-30/users/list-users
const BASE = 'https://api.quo.com';
const VERSION = '2026-03-30';

export const quoKey = () => process.env.QUO_API_KEY || process.env.OPENPHONE_API_KEY || '';
export const quoConfigured = () => !!quoKey();

/**
 * One request. THROWS on any failure, and the error carries the status.
 *
 * This is deliberate. The existing /api/openphone-calls swallows a failed list and returns
 * `connected: true, total: 0`, so a broken request and a genuinely quiet day look identical on the
 * dashboard. A rep's call count is exactly the figure where that is unacceptable: zero is an
 * accusation. An error has to surface as an error.
 */
export async function quoFetch(path, params = {}) {
    const key = quoKey();
    if (!key) {
        const e = new Error('No Quo API key is set (QUO_API_KEY or OPENPHONE_API_KEY)');
        e.status = 0;
        throw e;
    }
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
        headers: { Authorization: key, 'Quo-Api-Version': VERSION, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        let detail = body.slice(0, 300);
        try { const j = JSON.parse(body); detail = j.message || j.title || detail; } catch { /* keep the text */ }
        const e = new Error(`Quo ${res.status}: ${detail}`);
        e.status = res.status;
        throw e;
    }
    return res.json();
}

/** Every page of a cursor-paginated list, bounded so a bad cursor cannot loop for ever. */
async function pages(path, params, { maxPages = 40 } = {}) {
    const out = [];
    let after = null;
    for (let i = 0; i < maxPages; i++) {
        const j = await quoFetch(path, { ...params, limit: 50, after });
        const batch = Array.isArray(j?.data) ? j.data : [];
        out.push(...batch);
        after = j?.nextCursor || null;
        if (!after || !batch.length) return { items: out, complete: true };
    }
    // Hit the page ceiling. Say so rather than presenting a truncated count as the total.
    return { items: out, complete: false };
}

/** Everyone with a Quo seat. id is the actorId the call list filters on. */
export async function listUsers() {
    const { items } = await pages('/users', {});
    return items.map(u => ({
        actorId: u.id,
        email: String(u.email || '').toLowerCase(),
        name: [u.firstName, u.lastName].filter(Boolean).join(' ') || String(u.email || ''),
        role: u.role || null,
    }));
}

/**
 * A rep's Quo seat, by any address they might be signed in as. Returns null rather than guessing:
 * attributing one person's calls to another is worse than reporting that the seat was not found.
 */
// A Hub login whose Quo seat is registered under another address. Quo matching only: this never signs anyone in as
// anyone (that is api/_login-aliases.js, kept for provisioning mistakes). Paul, 2026-10-28: "I do want my metrics to
// also track on my end too". Madison dials from the seat registered as Molly Smith (the 561 line).
export const QUO_SEAT_EMAILS = Object.freeze({ 'madison@gostaffify.com': 'molly@gostaffify.com' });
export function findSeat(users, emails = []) {
    const base = emails.map(e => String(e || '').trim().toLowerCase()).filter(Boolean);
    const want = [...base, ...base.map(e => QUO_SEAT_EMAILS[e]).filter(Boolean)];
    for (const e of want) {
        const hit = users.find(u => u.email === e);
        if (hit) return { ...hit, matchedOn: e };
    }
    return null;
}

/**
 * Inbound texts in a window. This is what the STOP sweep reads.
 *
 * The legacy route it used before (/v1/messages) demands a phoneNumberId AND a single participant,
 * so the sweep had to walk every conversation one at a time and ask about each person separately.
 * On 2026-10-22 that returned 0 incoming messages across 81 threads on an inbox that visibly held
 * an inbound "Stop", and reported it as "nothing found" rather than as a failure. This route takes
 * direction=incoming directly and needs no participant, so there is nothing to walk and nothing to
 * miss.
 */
export async function listMessages({ direction = 'incoming', from, to, phoneNumberId, after: since, until, maxPages = 40 } = {}) {
    const params = { direction, from, to, phoneNumberId };
    if (since) params['createdAt[gt]'] = since;
    if (until) params['createdAt[lt]'] = until;
    return pages('/messages', params, { maxPages });
}

/** Calls in a window, newest first, optionally for one actor and direction. */
export async function listCalls({ actorId, direction, from, to, maxPages = 40 } = {}) {
    const params = { actorId, direction };
    if (from) params['createdAt[gte]'] = from;
    if (to) params['createdAt[lte]'] = to;
    return pages('/calls', params, { maxPages });
}

// A call connected when the far end picked up. `status` alone is not enough: `completed` is also
// what a call that rang out and went to voicemail ends as, so answeredAt is the honest signal.
// answeredAt means SOMETHING picked up the line. A person, a gatekeeper, or an answering machine
// all set it, so a high connect rate on short calls is not evidence of conversations. The tally
// reports the average and the longest alongside it so the number cannot be read as more than it is.
export const connected = c => !!c?.answeredAt;
/** A call still going: no completedAt yet, in a live status. */
export const callLive = c => !c?.completedAt && ['queued', 'initiated', 'ringing', 'in-progress', 'answered'].includes(String(c?.status || ''));
/** When a call ended: completedAt, or its start plus its duration (at least a minute); null while live. */
export const callEnd = c => (callLive(c) ? null : c?.completedAt || (c?.createdAt ? new Date(Date.parse(c.createdAt) + Math.max(60, Number(c.duration) || 0) * 1000).toISOString() : null));
export const talkSeconds = c => (connected(c) ? Math.max(0, Number(c?.duration) || 0) : 0);

/** The outside number on a call, for telling eight prospects apart from one number dialled eight times. */
export const counterparty = c => {
    const parts = Array.isArray(c?.participants) ? c.participants : [];
    const outside = parts.find(p => p && !p.actorId && p.phoneNumber) || parts.find(p => p && p.phoneNumber);
    return outside ? String(outside.phoneNumber) : null;
};

/** Counts for one set of calls, with every definition stated in the output. */
export function tally(calls, { actorId } = {}) {
    const outgoing = calls.filter(c => c.direction === 'outgoing');
    const incoming = calls.filter(c => c.direction === 'incoming');
    const placed = actorId ? outgoing.filter(c => !c.initiatedBy || c.initiatedBy === actorId) : outgoing;
    const answered = placed.filter(connected);
    const onPhone = [...placed, ...(actorId ? incoming.filter(c => c.answeredBy === actorId) : [])];
    const seconds = placed.reduce((n, c) => n + talkSeconds(c), 0);
    const byDay = {};
    for (const c of placed) {
        const day = etDay(c.createdAt);
        if (!day) continue;
        byDay[day] = byDay[day] || { dials: 0, connected: 0, talkSeconds: 0 };
        byDay[day].dials++;
        if (connected(c)) byDay[day].connected++;
        byDay[day].talkSeconds += talkSeconds(c);
    }
    const numbers = new Set(placed.map(counterparty).filter(Boolean));
    // Paul, 2026-10-22: "new calls, follow up calls made etc". The first dial to a number in the
    // window is a new call; any later dial to the same number is a follow-up. Judged within the
    // window being reported, which the definitions say, so a 7-day view and a 30-day view can
    // disagree about the same call and both be right.
    let newCalls = 0, followUpCalls = 0;
    const seen = new Set();
    for (const c of placed.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
        const who = counterparty(c);
        if (!who) continue;
        if (seen.has(who)) followUpCalls++; else { seen.add(who); newCalls++; }
    }
    return {
        newCalls, followUpCalls,
        dials: placed.length,
        connected: answered.length,
        noAnswer: placed.length - answered.length,
        connectRate: placed.length ? Math.round((answered.length / placed.length) * 1000) / 10 : null,
        talkSeconds: seconds,
        talkMinutes: Math.round(seconds / 6) / 10,
        longestSeconds: placed.reduce((n, c) => Math.max(n, talkSeconds(c)), 0),
        // Eight dials to eight people is prospecting. Eight dials to one number is a test or a
        // chase, and the dial count alone cannot tell them apart.
        uniqueNumbers: numbers.size,
        repeatDials: placed.length - numbers.size,
        avgAnsweredSeconds: answered.length ? Math.round(seconds / answered.length) : null,
        // For the Hub's idle prompt and live status: this person's calls in either direction (dials,
        // and inbound calls they answered), when the last one started and ended, and whether one is
        // still going. A long call, or a prospect calling back, never reads as idle.
        lastCallAt: onPhone.reduce((m, c) => (c.createdAt && (!m || c.createdAt > m) ? c.createdAt : m), null),
        lastCallEndAt: onPhone.reduce((m, c) => { const e = callEnd(c); return e && (!m || e > m) ? e : m; }, null),
        callInProgress: onPhone.some(callLive),
        inboundReturned: incoming.length,
        byDay,
        definitions: {
            dials: 'Outgoing calls this person placed, counted once each, including ones nobody picked up.',
            connected: 'Dials where the line was picked up (answeredAt is set). An answering machine or a gatekeeper picking up also counts, so read this with avgAnsweredSeconds: short answered calls are not conversations.',
            talkSeconds: 'Time on answered dials only. Ringing time is not counted.',
            uniqueNumbers: 'Distinct outside numbers dialled. Compare with dials to see repeat attempts or test calls.',
            newCalls: 'First dial to a number within this window.',
            followUpCalls: 'A later dial to a number already called within this window.',
        },
    };
}

/** The calendar day in Eastern time, which is the day a rep thinks in. */
export function etDay(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** An ET calendar day as the UTC instants that bound it, for createdAt[gte]/[lte]. */
export function etDayBounds(day) {
    // ET is UTC-4 or UTC-5. Taking a generous bound and filtering by etDay afterwards is correct in
    // both, and never drops a call that sits near midnight.
    return { from: new Date(Date.parse(day + 'T00:00:00Z') - 6 * 3600e3).toISOString(),
             to: new Date(Date.parse(day + 'T23:59:59Z') + 6 * 3600e3).toISOString() };
}
