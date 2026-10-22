// Calendly, for the meetings that already happened.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "we need a place for folks who HAD sales calls with us but we couldn't convert
// them... look through calendly to see who didn't convert."
//
// Everything here is read-only. It lists past meetings and who was on them, and it never books,
// cancels or reschedules anything.
//
// Docs: https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-scheduled-events
//       https://developer.calendly.com/api-docs/calendly-api/scheduled-events/list-event-invitees
const BASE = 'https://api.calendly.com';

export const calendlyConfigured = () => !!process.env.CALENDLY_API_TOKEN;

/** One request. THROWS on failure, so a broken read can never be mistaken for an empty calendar. */
async function cal(path, params = {}) {
    const token = process.env.CALENDLY_API_TOKEN;
    if (!token) { const e = new Error('CALENDLY_API_TOKEN is not set'); e.status = 0; throw e; }
    const url = path.startsWith('http') ? new URL(path) : new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        let detail = body.slice(0, 300);
        try { const j = JSON.parse(body); detail = j.message || j.title || detail; } catch { /* keep the text */ }
        const e = new Error(`Calendly ${res.status}: ${detail}`);
        e.status = res.status;
        throw e;
    }
    return res.json();
}

/** Pages of a collection, bounded so a bad token cannot loop. */
async function pages(path, params, { maxPages = 20 } = {}) {
    const out = [];
    let token = null;
    for (let i = 0; i < maxPages; i++) {
        const j = await cal(path, { ...params, count: 100, page_token: token });
        out.push(...(j.collection || []));
        token = j.pagination?.next_page_token || null;
        if (!token) return { items: out, complete: true };
    }
    return { items: out, complete: false };
}

/** Who we are, and which organization the events belong to. */
export async function whoAmI() {
    const j = await cal('/users/me');
    const r = j.resource || {};
    return { uri: r.uri, email: r.email, name: r.name, organization: r.current_organization };
}

/**
 * Meetings in a window. `status: 'active'` means not cancelled, which is the only kind that can
 * have actually happened.
 */
export async function pastEvents({ since, until = new Date().toISOString(), organization, user, maxPages = 20 }) {
    const scope = organization ? { organization } : { user };
    return pages('/scheduled_events', {
        ...scope, status: 'active', min_start_time: since, max_start_time: until,
        sort: 'start_time:desc',
    }, { maxPages });
}

export const eventUuid = uri => String(uri || '').split('/').filter(Boolean).pop() || '';

/** Who was on one meeting, including what they wrote on the booking form. */
export async function invitees(eventUri) {
    const { items } = await pages(`/scheduled_events/${encodeURIComponent(eventUuid(eventUri))}/invitees`, {}, { maxPages: 3 });
    return items.map(i => ({
        email: String(i.email || '').toLowerCase(),
        name: i.name || [i.first_name, i.last_name].filter(Boolean).join(' ') || null,
        status: i.status || null,
        // What they typed when booking. This is the most reliable record of what the call was about:
        // it is in their own words, it is structured, and it needs no meeting notes to exist.
        answers: (i.questions_and_answers || [])
            .filter(qa => qa && String(qa.answer || '').trim())
            .sort((a, b) => (a.position || 0) - (b.position || 0))
            .map(qa => ({ question: String(qa.question || '').trim(), answer: String(qa.answer || '').trim() })),
        // A no-show is a different conversation from a meeting that happened and went nowhere, so
        // it is carried through rather than quietly folded into the same list.
        noShow: !!i.no_show,
        timezone: i.timezone || null,
        createdAt: i.created_at || null,
        rescheduled: !!i.rescheduled,
    }));
}

/** The internal note on the event, when a host wrote one. */
export const eventNotes = ev => String(ev?.meeting_notes_plain || '').trim() || null;
