// GET /api/stats
// Aggregate-only counts of the email + subscriber system. No PII.
// Useful for quick "how are we doing" checks without exposing the list.
//
// Returns: total subscribers, soft-yes drip distribution, source breakdown,
// signups by day (last 14d), graduation counts, and Resend 7-day delivery
// counts if RESEND_API_KEY is set.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

const DAY = 86400 * 1000;

function bucketStage(s) {
    if (!s || !s.enrolled_at) return 'never_enrolled';
    if (s.graduated_at) return `graduated_${s.graduated_reason || 'unknown'}`;
    if (s.day45_sent_at) return 'completed_day45';
    if (s.day21_sent_at) return 'sent_day21';
    if (s.day12_sent_at) return 'sent_day12';
    if (s.day6_sent_at)  return 'sent_day6';
    if (s.day2_sent_at)  return 'sent_day2';
    return 'enrolled_waiting_day2';
}

async function fetchResendCount() {
    const key = process.env.RESEND_API_KEY;
    if (!key) return null;
    try {
        // Resend doesn't expose a great "count emails sent" endpoint on free tier;
        // we list the first page of emails (~25 most recent) and report timing.
        const r = await fetch('https://api.resend.com/emails?limit=100', {
            headers: { 'Authorization': `Bearer ${key}` },
        });
        if (!r.ok) return { error: `resend ${r.status}` };
        const json = await r.json();
        const data = json.data || [];
        const now = Date.now();
        let last24h = 0, last7d = 0;
        for (const e of data) {
            const t = e.created_at ? new Date(e.created_at).getTime() : 0;
            if (now - t < 1 * DAY) last24h++;
            if (now - t < 7 * DAY) last7d++;
        }
        return { recent_total: data.length, last24h, last7d, oldest_in_window: data[data.length - 1]?.created_at };
    } catch (err) {
        return { error: String(err.message || err) };
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

    try {
        const [
            totalSubscribers,
            softyesActive,
            nurtureActive,
            dispositionPending,
            allEmails,
        ] = await Promise.all([
            redis.zcard('subscribers:by_date'),
            redis.zcard('softyes:active'),
            redis.zcard('nurture:active'),
            redis.zcard('disposition:pending'),
            redis.zrange('subscribers:by_date', 0, -1, { withScores: true }),
        ]);

        // allEmails comes back as [email, score, email, score, ...] OR [{member, score}]
        // Normalize to list of {email, ts}
        let entries = [];
        if (Array.isArray(allEmails) && allEmails.length && typeof allEmails[0] === 'string') {
            for (let i = 0; i < allEmails.length; i += 2) {
                entries.push({ email: allEmails[i], ts: Number(allEmails[i + 1]) });
            }
        } else if (Array.isArray(allEmails)) {
            entries = allEmails.map(e => ({ email: e.member, ts: Number(e.score) }));
        }

        // Source + stage breakdown — fetch each subscriber + softyes record
        const bySource = {};
        const byStage = {};
        const byDecision = { client: 0, nope: 0, none: 0 };
        let bookingsTotal = 0;
        const now = Date.now();
        const signupsByDay = {};

        // Cap at 500 to keep response fast
        const sample = entries.slice(-500);
        await Promise.all(sample.map(async ({ email, ts }) => {
            // signups by day
            const dayKey = new Date(ts).toISOString().slice(0, 10);
            signupsByDay[dayKey] = (signupsByDay[dayKey] || 0) + 1;

            const [sub, softyes] = await Promise.all([
                redis.hgetall(`subscriber:${email}`),
                redis.hgetall(`softyes:${email}`),
            ]);
            const source = (sub?.source || 'unknown').toString();
            bySource[source] = (bySource[source] || 0) + 1;

            const stage = bucketStage(softyes);
            byStage[stage] = (byStage[stage] || 0) + 1;

            const decision = (sub?.decision || '').toString().toLowerCase();
            if (decision === 'client') byDecision.client++;
            else if (decision === 'nope') byDecision.nope++;
            else byDecision.none++;

            if (sub?.last_booking_at) bookingsTotal++;
        }));

        // Recent: trim signupsByDay to last 14 days, sorted desc
        const last14 = {};
        for (let i = 0; i < 14; i++) {
            const d = new Date(now - i * DAY).toISOString().slice(0, 10);
            last14[d] = signupsByDay[d] || 0;
        }

        const resend = await fetchResendCount();

        const decisionRate = (byDecision.client + byDecision.nope) > 0
            ? Math.round((byDecision.client / (byDecision.client + byDecision.nope)) * 100)
            : null;
        const conversionRate = totalSubscribers > 0
            ? Math.round((byDecision.client / totalSubscribers) * 1000) / 10
            : null;

        return res.status(200).json({
            generated_at: new Date().toISOString(),
            sample_size: sample.length,
            sample_note: sample.length < entries.length ? `Showing last ${sample.length} of ${entries.length} subscribers` : 'Full population',

            queues: {
                subscribers_total: totalSubscribers,
                softyes_active: softyesActive,
                post_call_nurture_active: nurtureActive,
                disposition_pending_paul_review: dispositionPending,
            },

            soft_yes_drip_stage: byStage,

            by_source_page: bySource,

            decisions: {
                ...byDecision,
                close_rate_pct_of_decided: decisionRate,
                overall_subscriber_to_client_pct: conversionRate,
            },

            bookings: {
                total_subscribers_who_booked: bookingsTotal,
                signup_to_booking_pct: totalSubscribers > 0 ? Math.round((bookingsTotal / totalSubscribers) * 1000) / 10 : null,
            },

            signups_last_14_days: last14,
            signups_last_14d_total: Object.values(last14).reduce((a, b) => a + b, 0),

            resend_recent_sends: resend,
        });
    } catch (err) {
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
