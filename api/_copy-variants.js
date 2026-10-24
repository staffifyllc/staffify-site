// The email that earns the reply, chosen by what has actually replied.
// ------------------------------------------------------------------
// Paul, 2026-10-23: "sending the most bad ass emails every time we load up a new campaign that is
// proven to give us conversions."
//
// "Proven" can only mean measured, so this is a measurement first and a chooser second. Every
// prospect carries the copy version it was opened with (copyVersion, set at enrolment) and the
// queue carries what happened next: a reply received, a human conversation, a meeting on the
// calendar, a deal stage. That is attributed back to the opener here, per campaign, and the
// chooser hands the next enrolment the version with the best reply rate once there is enough
// evidence to tell, while still giving every other version a share so a new one can prove itself.
//
// Nothing is claimed early: below MIN_SENDS a version's rate is withheld and enrolments rotate
// evenly. A version that wins keeps winning only while it keeps winning.
import { INTRO_SUBJECT, INTRO_VERSION, introduction } from './_outreach-copy.js';
import { CAMPAIGN_ID } from './_outreach-campaign.js';

export const MIN_SENDS = 40;       // below this a rate is noise, and the chooser rotates
export const EXPLORE_SHARE = 0.2;  // the share every non-leading version keeps, so it can prove itself

/**
 * The openers on offer, per campaign. Each is a complete first email; follow-ups are shared.
 * Add a variant here and it starts receiving its exploration share on the next enrolment.
 */
export const VARIANTS = Object.freeze({
    [CAMPAIGN_ID]: [
        { id: INTRO_VERSION, label: 'Client service', subject: INTRO_SUBJECT, body: introduction, since: '2026-10-13' },
        {
            id: 'handoff-list-2026-10-23', label: 'Fifteen tasks', subject: '15 tasks to hand off after the shoot', since: '2026-10-23',
            body: (owner, firstName) => {
                const built = owner === 'Madison'
                    ? 'Paul, our founder, built Flylisted into a seven-figure real estate media agency, and the turning point was handing that list to one person whose whole job is the back end.'
                    : 'I built Flylisted into a seven-figure real estate media agency, and the turning point was handing that list to one person whose whole job is the back end.';
                return ['Hey ' + (firstName || 'there') + ',',
                    'The shoot is the easy part. The next three hours are the problem: culling, uploading, chasing the agent for tomorrow’s lockbox code, answering “can you brighten the kitchen?”, sending the invoice, following up on the one from last week.',
                    built + ' We wrote down the fifteen tasks our owners hand off first.',
                    'That is what we do at Staffify: we recruit, train and support that person for real estate media agencies, with a lifetime replacement guarantee if it is not the right fit.',
                    'Want the list? Reply “list” and I’ll send it over, no call required.',
                    owner + '\nStaffify',
                    'If you’d like me to kick rocks and leave you alone, just say so :)'].join('\n\n');
            },
        },
    ],
});

export const variantsFor = campaignId => VARIANTS[campaignId] || [];
export const variantById = (campaignId, id) => variantsFor(campaignId).find(v => v.id === id) || null;

const first = r => [...(r.events || [])].filter(e => e && e.kind === 'sent' && e.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
const lower = s => String(s || '').toLowerCase().trim();
const WON = /closed ?won|customer|signed/i;

/**
 * What each opener produced, per campaign, from the queue records.
 * A prospect belongs to the version it was opened with (copyVersion), or, for rows enrolled
 * before versions were stamped, to the subject of its first sent email.
 * @param meetingsByEmail  Set of invitee emails with a meeting on the calendar (optional)
 */
export function attribute(records, { campaignId = CAMPAIGN_ID, meetingsByEmail = null, now = Date.now() } = {}) {
    const by = new Map();
    for (const r of records || []) {
        if ((r.campaignId || CAMPAIGN_ID) !== campaignId) continue;
        const f = first(r);
        if (!f) continue;
        const id = r.copyVersion || ('subject:' + lower(f.subject).replace(/^re:\s*/, ''));
        if (!by.has(id)) by.set(id, { id, label: null, subject: (variantById(campaignId, id) || {}).subject || f.subject || null, sends: 0, replies: 0, conversations: 0, meetings: 0, won: 0, firstSent: f.at, lastSent: f.at });
        const b = by.get(id);
        b.sends++;
        if ((r.events || []).some(e => e && e.kind === 'received')) b.replies++;
        if (r.status === 'human_reply_hold' || r.callOutcome === 'connected') b.conversations++;
        if (meetingsByEmail && meetingsByEmail.has(lower(r.recipient))) b.meetings++;
        if (WON.test(r.dealStage || '')) b.won++;
        if (f.at < b.firstSent) b.firstSent = f.at;
        if (f.at > b.lastSent) b.lastSent = f.at;
    }
    const out = [...by.values()].map(b => {
        const v = variantById(campaignId, b.id);
        const enough = b.sends >= MIN_SENDS;
        return { ...b, label: v ? v.label : (b.id.startsWith('subject:') ? 'Earlier copy' : b.id), active: !!v, enough,
            replyRate: enough ? Math.round(1000 * b.replies / b.sends) / 10 : null,
            meetingRate: enough && meetingsByEmail ? Math.round(1000 * b.meetings / b.sends) / 10 : null,
            note: enough ? `${b.replies} of ${b.sends} replied` : `${b.sends} sent; a rate needs ${MIN_SENDS}` };
    });
    // Every variant on offer appears even before its first send, so the page shows it is in rotation.
    for (const v of variantsFor(campaignId)) if (!out.some(o => o.id === v.id)) out.push({ id: v.id, label: v.label, subject: v.subject, sends: 0, replies: 0, conversations: 0, meetings: 0, won: 0, firstSent: null, lastSent: null, active: true, enough: false, replyRate: null, meetingRate: null, note: 'Not sent yet' });
    out.sort((a, b) => (b.replyRate ?? -1) - (a.replyRate ?? -1) || b.sends - a.sends);
    const leader = out.find(o => o.active && o.enough) || null;
    return { campaignId, variants: out, leader: leader ? leader.id : null, minSends: MIN_SENDS, exploreShare: EXPLORE_SHARE, computedAt: new Date(now).toISOString() };
}

/**
 * Which opener the next enrolment gets. Deterministic given the stats and a roll in [0,1):
 * with a leader, it takes 1 - EXPLORE_SHARE of enrolments and the rest rotate among the others;
 * with no leader yet, everyone rotates evenly. Only variants on offer are ever chosen.
 */
export function chooseVariant(stats, { campaignId = CAMPAIGN_ID, roll = Math.random() } = {}) {
    const offered = variantsFor(campaignId);
    if (!offered.length) return null;
    if (offered.length === 1) return offered[0];
    const leader = stats && stats.leader ? offered.find(v => v.id === stats.leader) : null;
    if (leader && roll >= EXPLORE_SHARE) return leader;
    const pool = leader ? offered.filter(v => v.id !== leader.id) : offered;
    const r = leader ? roll / EXPLORE_SHARE : roll;            // rescale the exploring slice to [0,1)
    return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
}

/** The opener fields a new row gets. */
export function openerFor(variant, owner, firstName) {
    return { copyVersion: variant.id, subject: variant.subject, bodyText: variant.body(owner, firstName) };
}
