// GET /api/sales-pipeline?token=ADMIN_TOKEN
// Live Calendly bookings for the sales pipeline: last 30 days + upcoming 45 days.
// Env: CALENDLY_API_TOKEN, plus ADMIN_TOKEN or CRON_SECRET for auth.

const USER_URI = 'https://api.calendly.com/users/7b9e76a9-050c-436f-b226-719606dc462c';

async function cget(url, token) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Calendly ${res.status}`);
    return res.json();
}

export default async function handler(req, res) {
    // open-share: live Calendly bookings, no login required
    const token = process.env.CALENDLY_API_TOKEN;
    if (!token) return res.status(500).json({ error: 'calendly_not_configured' });
    try {
        const now = Date.now();
        const min = new Date(now - 30 * 864e5).toISOString();
        const max = new Date(now + 45 * 864e5).toISOString();
        let url = `https://api.calendly.com/scheduled_events?user=${USER_URI}&status=active&min_start_time=${min}&max_start_time=${max}&sort=start_time:asc&count=100`;
        const events = [];
        while (url) {
            const data = await cget(url, token);
            events.push(...(data.collection || []));
            url = data.pagination && data.pagination.next_page ? data.pagination.next_page : null;
        }
        const discEvents = events.filter(ev => /discovery/i.test(ev.name || ''));
        const invLists = await Promise.all(
            discEvents.map(ev => cget(`${ev.uri}/invitees`, token).catch(() => ({ collection: [] })))
        );
        const rows = [];
        discEvents.forEach((ev, idx) => {
            (invLists[idx].collection || []).forEach(i => {
                rows.push({
                    start: ev.start_time,
                    name: i.name || '',
                    email: i.email || '',
                    type: ev.name || '',
                    status: ev.status,
                    join: (ev.location && (ev.location.join_url || ev.location.location)) || '',
                    when: new Date(ev.start_time).getTime() < now ? 'past' : 'upcoming',
                });
            });
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ count: rows.length, window: { min, max }, bookings: rows });
    } catch (e) {
        return res.status(502).json({ error: 'calendly_error', detail: String(e.message || e) });
    }
}
