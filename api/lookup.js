// Who is calling? One answer, fast, for a rep with a ringing phone.
//
// Leads call back and the rep has seconds to work out who they are. Everything needed to answer
// that already existed, scattered: the live queue knows the pitch and the angle, HubSpot knows the
// history, the opt-out list knows whether we are even allowed to talk to them, and the worked
// markers know whether a colleague already spoke to them today. This joins them.
//
// GET /api/lookup/?q=9512198719          phone, full or partial
// GET /api/lookup/?q=chalela             name, company or email
//
// Open like the other read endpoints, and it never throws: a rep mid-call gets a partial answer
// rather than an error.

import { openIdentity, redis } from './_auth.js';
import { configured as hsReady, findContact } from './_hubspot.js';
import { isOptedOut } from './_optout.js';

const digits = (s) => String(s == null ? '' : s).replace(/[^0-9]/g, '');
const last10 = (s) => digits(s).slice(-10);
const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

const BASE = process.env.SALES_PORTAL_BASE;
const TOKEN = process.env.SALES_PORTAL_TOKEN;

// What a rep should actually do, given who this turns out to be.
function advise({ optedOut, worked, inQueue, hubspot }) {
    if (optedOut) return 'They asked us to stop. Do not pitch. Take the call politely, answer what they ask, and do not offer anything.';
    if (worked) return `Already worked${worked.rep ? ' by ' + worked.rep : ''}${worked.action ? ' (' + worked.action + ')' : ''}. Check with them before re-pitching.`;
    if (inQueue) return 'In the live queue and not yet worked. The script and angle for them are on the card below.';
    if (hubspot) return 'In HubSpot but not in a current campaign. Greet them by name, find out what it is about, and do not assume a pitch.';
    return 'Not in any campaign or the CRM. Get their name, company and number, and what it is regarding.';
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    await openIdentity(req).catch(() => null);

    const q = String((req.query.q || '')).trim();
    if (!q) return res.status(400).json({ error: 'add ?q=<phone, name, company or email>' });

    const qDigits = digits(q);
    const byPhone = qDigits.length >= 7;          // enough of a number to be meaningful
    const key = byPhone ? qDigits.slice(-10) : '';
    const text = norm(q);

    const out = { query: q, matchedOn: byPhone ? 'phone' : 'text', found: [] };

    // 1. The live queue. This is the richest source: it carries the opener, the angle and the price.
    try {
        if (BASE && TOKEN) {
            const r = await fetch(`${BASE}?action=list&n=1000&t=${encodeURIComponent(TOKEN)}`);
            if (r.ok) {
                const j = await r.json();
                for (const motion of ['websites', 'staffing']) {
                    for (const l of (j[motion] || [])) {
                        const hit = byPhone
                            ? last10(l.phone).includes(key) || key.includes(last10(l.phone))
                            : [l.company, l.name, l.lastName, l.email].some(v => norm(v).includes(text));
                        if (!hit) continue;
                        out.found.push({
                            source: 'live queue',
                            motion, company: l.company || '', name: [l.name, l.lastName].filter(Boolean).join(' '),
                            phone: l.phone || '', email: l.email || '',
                            role: l.role || '', industry: l.industry || '', city: l.city || '',
                            website: l.website || '', carrier: l.carrier || '',
                            sayThis: l.sayIndustry || '', hook: l.hook || '', brief: l.brief || '',
                            priorCall: !!l.priorCall, lastCall: l.lastCall || '',
                        });
                    }
                }
            }
        }
    } catch (e) { out.queueError = 'queue unreachable'; }

    // 2. Hot leads: someone who already showed interest.
    try {
        const ids = (await redis.zrange('hotleads', 0, 99, { rev: true })) || [];
        for (const id of ids) {
            const h = await redis.hgetall(id);
            if (!h || !h.phone) continue;
            const hit = byPhone
                ? last10(h.phone).includes(key)
                : [h.company, h.name, h.email].some(v => norm(v).includes(text));
            if (hit) out.found.push({
                source: 'hot lead', motion: h.motion || '', company: h.company || '', name: h.name || '',
                phone: h.phone, email: h.email || '', summary: h.summary || '',
            });
        }
    } catch (e) { /* non-fatal */ }

    // 3. HubSpot, for anyone who is a real contact rather than a current target.
    if (hsReady()) {
        try {
            const c = await findContact(byPhone ? { phone: '+1' + key } : { email: q.includes('@') ? q : '' });
            if (c && c.ok && c.id) {
                const p = c.properties || {};
                out.hubspot = {
                    id: c.id,
                    name: [p.firstname, p.lastname].filter(Boolean).join(' '),
                    company: p.company || '', email: p.email || '', phone: p.phone || '',
                    lifecycle: p.lifecyclestage || '', status: p.hs_lead_status || '',
                };
            }
        } catch (e) { /* non-fatal */ }
    }

    // 4. The two things that change what a rep is allowed to say.
    const phoneForChecks = byPhone ? '+1' + key : (out.found[0] && out.found[0].phone) || '';
    try {
        out.optedOut = await isOptedOut({ phone: phoneForChecks, email: q.includes('@') ? q : '' });
    } catch (e) { out.optedOut = null; }

    try {
        const d = last10(phoneForChecks);
        if (d) {
            const handled = await redis.sismember('hot:handled', d);
            const texted = await redis.hget('text:sent', phoneForChecks);
            if (handled || texted) {
                out.alreadyWorked = { handled: !!handled, texted: texted ? JSON.parse(texted) : null };
            }
        }
    } catch (e) { /* non-fatal */ }

    out.count = out.found.length;
    out.advice = advise({
        optedOut: out.optedOut,
        worked: out.alreadyWorked && (out.alreadyWorked.texted || { }),
        inQueue: out.found.some(f => f.source === 'live queue'),
        hubspot: !!out.hubspot,
    });
    return res.status(200).json(out);
}
