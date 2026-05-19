// POST /api/historical-enroll/  (TEMPORARY — will be deleted after one-shot run)
// Headers: Authorization: Bearer <ADMIN_TOKEN>
// Body:    { "calendly_pat": "eyJ...", "execute": false }
//
// Pulls every Calendly invitee, diffs against the client roster baked in below,
// returns a dry-run summary. With execute=true, enrolls non-clients in the
// nurture drip.

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

// ─── Client roster (from staffify-clients-export.csv, normalized) ───────
const CLIENT_EMAILS = new Set([
    'adam@386productions.com',
    'alex@mosaicstudio.us',
    'brydenupshaw@gmail.com',
    'clcaron@oceansedgere.com',
    'chris@coralcovemedia.com',
    'davidgriffingershman@gmail.com',
    'dave@verticalbird.com',
    'adam@adamdc.ca',
    'brandon@definitivehdr.com',
    'matt@dynamiccinemaproductions.com',
    'samantha@eastendsocialco.com',
    'info@flylisted.com',
    'karly@foothillsphotography.ca',
    'earl.endrich@foxroach.com',
    'patrick@hephaestusinnovation.com',
    'michael@homehearthproductions.com',
    'media@homepagerealty.com',
    'cjhowellco@gmail.com',
    'edwing@incustudio.com',
    'service@driverealestatemedia.com',
    'joel@realpropertyphotography.com.au',
    'jonathan@fluxmediausa.com',
    'andy@keeneyemarketing.com',
    'corey.dostal@gmail.com',
    'info@missoularealestatephotography.com',
    'lisa.franklin.bmt@gmail.com',
    'kam@luxpointmedia.com',
    'media631li@gmail.com',
    'info@mosaicstudio.us',
    'nate@moveitmedia.ca',
    'damian@northbaycreate.com',
    'darryl@getonelook.com',
    'james@pending-media.com',
    'pete@morneaustudios.com',
    'peter.morneau@me.com',
    'james@photografikstudios.com',
    'mark@propertypix.ie',
    'info@focusedmediacollective.com',
    'info@realtourpilot.com',
    'stetson@rootedelementsmedia.com',
    'sara@barclaymedia.co',
    'hello@sojourner-media.com',
    'joe@symmetrysauna.com',
    'mollysmith0195@gmail.com',
    'tevincolon@lightreelmedia.com',
    'josh@themidlandsgroup.com',
    'ben@thevideostrategist.com',
    'hello@architecturalstorytelling.com',
    'vic.devore@devoredesign.com',
    'vincent@virtualviewtours.com',
    'visualadvantagescott@gmail.com',
    'steven.geiger@raveis.com',
]);

function isClient(email) {
    return CLIENT_EMAILS.has(String(email || '').toLowerCase().trim());
}

// ─── Calendly API helpers ───────────────────────────────────────────────
async function calFetch(url, pat) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${pat}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Calendly ${r.status}: ${j.message || JSON.stringify(j)}`);
    return j;
}

async function fetchAllInvitees(pat) {
    // Get current user's org
    const me = await calFetch('https://api.calendly.com/users/me', pat);
    const orgUri = me.resource && me.resource.current_organization;
    if (!orgUri) throw new Error('no organization on PAT');

    const inviteesByEmail = new Map();
    // Page through ALL scheduled events (status=active|canceled both — we count interest)
    let url = `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(orgUri)}&count=100`;
    let pages = 0;
    while (url && pages < 100) {
        pages++;
        const page = await calFetch(url, pat);
        for (const ev of (page.collection || [])) {
            // Fetch invitees for this event (typically 1, occasionally more for group events)
            try {
                const invPage = await calFetch(`${ev.uri}/invitees?count=100`, pat);
                for (const inv of (invPage.collection || [])) {
                    const email = String(inv.email || '').toLowerCase().trim();
                    if (!email) continue;
                    const rec = {
                        email,
                        name: inv.name || '',
                        first_name: inv.first_name || (inv.name || '').split(' ')[0] || '',
                        last_call_at: ev.start_time || '',
                        event_name: ev.name || '',
                        status: inv.status || ev.status,
                    };
                    const existing = inviteesByEmail.get(email);
                    if (!existing || (rec.last_call_at && rec.last_call_at > (existing.last_call_at || ''))) {
                        inviteesByEmail.set(email, rec);
                    }
                }
            } catch (err) {
                console.warn('invitee fetch failed for', ev.uri, err.message);
            }
        }
        url = page.pagination && page.pagination.next_page;
    }
    return [...inviteesByEmail.values()];
}

// ─── Handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const authHeader = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    const provided = m ? m[1] : '';
    if (provided !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });

    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const pat = String(body.calendly_pat || '').trim();
    const execute = body.execute === true;
    if (!pat) return res.status(400).json({ error: 'calendly_pat required' });

    try {
        const allInvitees = await fetchAllInvitees(pat);
        const clients = allInvitees.filter(i => isClient(i.email));
        const toEnroll = allInvitees.filter(i => !isClient(i.email));

        if (!execute) {
            return res.status(200).json({
                ok: true,
                dry_run: true,
                summary: {
                    total_unique_invitees: allInvitees.length,
                    matched_clients: clients.length,
                    would_enroll_in_nurture: toEnroll.length,
                },
                clients_matched: clients.map(c => c.email).sort(),
                would_enroll: toEnroll.map(t => ({
                    email: t.email,
                    name: t.name,
                    last_call_at: t.last_call_at,
                    status: t.status,
                })).sort((a, b) => (a.last_call_at < b.last_call_at ? 1 : -1)),
            });
        }

        // Execute: enroll each non-client
        const now = Date.now();
        const result = { enrolled: 0, already_in_nurture: 0, errors: 0 };

        for (const inv of toEnroll) {
            try {
                const alreadyEnrolled = await redis.hget(`nurture:${inv.email}`, 'enrolled_at');
                if (alreadyEnrolled) { result.already_in_nurture++; continue; }

                const existingSub = await redis.hgetall(`subscriber:${inv.email}`);
                if (!existingSub || !existingSub.email) {
                    await redis.hset(`subscriber:${inv.email}`, {
                        email: inv.email,
                        source: 'discovery-call-booked-historical',
                        role: 'default',
                        signed_up_at: now,
                        last_seen_at: now,
                        first_name: inv.first_name || inv.email.split('@')[0],
                        last_booking_at: inv.last_call_at ? new Date(inv.last_call_at).getTime() : now,
                        event_name: inv.event_name,
                        decision: 'nope',
                        decision_at: now,
                    });
                    await redis.zadd('subscribers:by_date', { score: now, member: inv.email });
                } else {
                    await redis.hset(`subscriber:${inv.email}`, {
                        decision: 'nope',
                        decision_at: now,
                    });
                }

                await redis.hset(`nurture:${inv.email}`, {
                    email: inv.email,
                    enrolled_at: now,
                    day3_sent_at: '',
                    day14_sent_at: '',
                    day45_sent_at: '',
                });
                await redis.zadd('nurture:active', { score: now, member: inv.email });

                result.enrolled++;
            } catch (err) {
                console.error(`enroll error for ${inv.email}`, err);
                result.errors++;
            }
        }

        return res.status(200).json({
            ok: true,
            executed: true,
            summary: {
                total_unique_invitees: allInvitees.length,
                matched_clients_skipped: clients.length,
                ...result,
            },
        });
    } catch (err) {
        console.error('historical-enroll fatal', err);
        return res.status(500).json({ error: 'server_error', detail: String(err.message || err) });
    }
}
