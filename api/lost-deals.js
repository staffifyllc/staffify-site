// People who sat on a call with us and did not become clients.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "we need a place for folks who HAD sales calls with us but we couldn't convert
// them for some reason, under LOST DEALS you should look through calendly to see who didn't
// convert, and do what we can do to call them, see if they filled the role."
//
// The list is built from Calendly, because a booked and attended meeting is the only hard evidence
// that a sales conversation actually happened. A HubSpot stage says what somebody typed into a CRM;
// a Calendly event says a meeting existed, when it was, and what the person wrote to get it.
//
// Who is left out, and why each one:
//   * CANCELLED meetings. Those conversations never happened.
//   * CLIENTS. Checked against the client guard, which reads the live HubSpot customer list and the
//     shared snapshot rather than a hand-maintained sheet. Cold pitching a live client has happened
//     here before and it is the one outcome worth being slow about.
//   * Anyone opted out. A do-not-contact beats a warm history every time.
//
// Who is kept but flagged rather than dropped: a possible or unverifiable client match, and no-shows.
// A no-show is not a lost deal, it is an unheld meeting, and it is a different call. Dropping either
// silently would hide real work.
//
// GET /api/lost-deals/?days=180[&refresh=1]
import { redis, requireAccess } from './_auth.js';
import { ownerFor } from './_outreach-queue.js';
import { calendlyConfigured, whoAmI, pastEvents, invitees, eventNotes } from './_calendly.js';
import { lostDealScript } from './_lost-deal-script.js';
import { clientCheck } from './_client-guard.js';
import { isOptedOut } from './_optout.js';
import { bookingLinkFor } from './_call-scripts.js';
import { callerPlan, designatedCaller } from './_caller-plan.js';

const CACHE = 'staffify:lost-deals:v1';
const TTL_MS = 30 * 60000;
const BUDGET_MS = 45000;

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    try {
        const rep = await requireAccess(req);
        if (!rep || !rep.email) return res.status(401).json({ error: 'Sign in to your Staffify account' });
        if (!calendlyConfigured()) return res.status(503).json({ error: 'CALENDLY_API_TOKEN is not set on this project' });

        const days = Math.max(7, Math.min(730, Number(req.query?.days) || 180));
        const since = new Date(Date.now() - days * 86400000).toISOString();

        // The assembly is N+1 Calendly calls, so it is cached. A caller refreshing the page should
        // not re-walk the whole calendar.
        const cached = await redis.get(CACHE).catch(() => null);
        if (cached && cached.days === days && Date.now() - Date.parse(cached.builtAt) < TTL_MS && !req.query?.refresh) {
            return res.status(200).json({ ...cached, cached: true });
        }

        const me = await whoAmI();
        const { items: events, complete } = await pastEvents({
            since, organization: me.organization, user: me.organization ? undefined : me.uri,
        });

        // Newest meeting per person. Somebody who met us three times is one row, dated by the last
        // conversation, because that is the one the caller has to open on.
        const started = Date.now();
        const byPerson = new Map();
        let eventsRead = 0, truncated = !complete;
        for (const ev of events) {
            if (Date.now() - started > BUDGET_MS) { truncated = true; break; }
            let people = [];
            try { people = await invitees(ev.uri); } catch { continue; }
            eventsRead++;
            for (const p of people) {
                if (!p.email || p.status === 'canceled') continue;
                const prior = byPerson.get(p.email);
                if (prior && Date.parse(prior.metAt) >= Date.parse(ev.start_time)) continue;
                byPerson.set(p.email, {
                    email: p.email, name: p.name, metAt: ev.start_time, eventName: ev.name || null,
                    answers: p.answers, notes: eventNotes(ev), noShow: p.noShow, timezone: p.timezone,
                    meetings: (prior?.meetings || 0) + 1,
                });
            }
        }

        // Whose voice the scripts are in: the assigned caller, not whoever is reading the page.
        const assigned = designatedCaller('staffify-tobit-outreach');
        const callerEmail = assigned || rep.email;
        const callerName = (callerPlan(callerEmail)?.name) || rep.name || 'Staffify';

        const rows = [], clients = [], suppressed = [], noShows = [];
        for (const p of byPerson.values()) {
            const company = (p.email.split('@')[1] || '').replace(/\.(com|org|net|io|ai|co)(\.[a-z]{2})?$/i, '');
            if (await isOptedOut({ email: p.email })) { suppressed.push({ email: p.email, name: p.name }); continue; }
            const guard = await clientCheck({ email: p.email, company }).catch(() => ({ status: 'unknown', why: 'the client guard could not be read' }));
            const entry = {
                ...p, company,
                clientStatus: guard.status,
                clientNote: guard.status === 'client' ? 'Already a client. Do not pitch.'
                    : guard.status === 'possible' ? guard.reason
                    : guard.status === 'unknown' ? 'Could not confirm whether this is a client. ' + (guard.why || '') + ' Check before calling.'
                    : null,
                script: lostDealScript({
                    company: p.name ? null : company, firstName: (p.name || '').split(' ')[0] || null,
                    caller: callerName, callerEmail, metAt: p.metAt, eventName: p.eventName,
                    answers: p.answers, notes: p.notes, noShow: p.noShow,
                    bookingUrl: bookingLinkFor(callerEmail),
                }),
            };
            if (guard.status === 'client') { clients.push(entry); continue; }
            if (p.noShow) { noShows.push(entry); continue; }
            rows.push(entry);
        }
        rows.sort((a, b) => String(b.metAt).localeCompare(String(a.metAt)));
        noShows.sort((a, b) => String(b.metAt).localeCompare(String(a.metAt)));

        const payload = {
            builtAt: new Date().toISOString(), days, since,
            callerIs: { name: callerName, email: callerEmail, assigned: !!assigned },
            meetingsRead: eventsRead, peopleSeen: byPerson.size,
            toCall: rows, noShows,
            // Named, not hidden. Each is a decision somebody may want to overturn.
            excluded: { alreadyClients: clients.map(c => ({ email: c.email, name: c.name, metAt: c.metAt })), optedOut: suppressed },
            truncated,
            note: 'Built from Calendly meetings that were not cancelled. A topic is only shown when we have a record of it; where none exists the script asks rather than guesses.',
        };
        await redis.set(CACHE, payload, { ex: 3600 }).catch(() => {});
        return res.status(200).json({ ...payload, cached: false });
    } catch (e) {
        // Never an empty list. "Nobody to call back" is a claim this must earn.
        return res.status(503).json({
            error: 'The lost deal list could not be built, so this is not a statement that there is nobody to call.',
            detail: String((e && e.message) || e).slice(0, 200),
        });
    }
}
