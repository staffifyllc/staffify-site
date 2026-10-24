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
import { SAMPLE_FLOOR } from './_campaign-industry.js';

export const MIN_SENDS = SAMPLE_FLOOR;   // one evidence floor for the whole campaign screen (30)
export const EXPLORE_SHARE = 0.2;  // the share every non-leading version keeps, so it can prove itself

/**
 * The openers on offer, per campaign. Each is a complete first email; follow-ups are shared.
 * Add a variant here and it starts receiving its exploration share on the next enrolment.
 */
export const VARIANTS = Object.freeze({
    [CAMPAIGN_ID]: [
        // Sent 2026-10-04 to 10-14 (commit d58f2e3), retired by 8bde9a5, and the best-measured opener
        // on the live queue when this engine shipped: 9 replies from 367 sends, 2.5%, against 1.6%
        // for the client-service opener that replaced it. Reinstated verbatim: changing a word
        // would make that measurement somebody else's.
        { id: 'conversational-2026-10-04', label: 'The work between shoots', subject: 'The work between shoots', since: '2026-10-04',
          body: (owner, firstName) => {
              const intro = owner === 'Madison'
                  ? "I'm Madison with Staffify. I work with Paul, who runs Flylisted, a real estate media agency. We help owners hand off the work around their shoots."
                  : "I'm Paul. I run Flylisted, a real estate media agency, and Staffify, where we help owners hand off the work around their shoots.";
              return ['Hi ' + (firstName || 'there') + ',', intro,
                  'One small thing you can try: keep photo revision requests in one shared list, with a person and a due date beside each change. It gives the team one place to check before anything comes back to you.',
                  'We put together a few more practical handoffs here, if useful:\nhttps://www.gostaffify.com/blog/real-estate-photography-tasks-to-delegate/',
                  'What tends to pull you away from running the business most: scheduling, revisions, or client follow-ups?',
                  owner + '\nStaffify', "If you'd prefer no more emails, just let me know."].join('\n\n');
          } },
        // The personalised subject "A practical handoff for <Company>" measured 7 of 263, 2.7%, in late
        // September on bodies that are not on file. This pairs that subject with the best-measured body
        // above. It starts on the exploration share and earns more only by replies.
        { id: 'practical-handoff-2026-10-23', label: 'A practical handoff for {company}', since: '2026-10-23',
          subject: company => 'A practical handoff for ' + (String(company || '').trim() || 'your team'),
          body: (owner, firstName) => variantById(CAMPAIGN_ID, 'conversational-2026-10-04').body(owner, firstName) },
        { id: INTRO_VERSION, label: 'Client service', subject: INTRO_SUBJECT, body: introduction, since: '2026-10-13' },
        {
            id: 'handoff-list-2026-10-23', label: 'Fifteen tasks', subject: '15 tasks to hand off after the shoot', since: '2026-10-23',
            body: (owner, firstName) => {
                const built = owner === 'Madison'
                    ? 'Paul, our founder, built Flylisted into a seven-figure real estate media agency, and the turning point was handing that list to one person whose whole job is the back end.'
                    : 'I built Flylisted into a seven-figure real estate media agency, and the turning point was handing that list to one person whose whole job is the back end.';
                return ['Hey ' + (firstName || 'there') + ',',
                    'The shoot is the easy part. Everything after it is the problem: culling, uploading, chasing the agent for tomorrow’s lockbox code, answering “can you brighten the kitchen?”, sending the invoice, following up on the one from last week.',
                    built + ' We wrote down fifteen tasks an agency owner can hand off, starting with the ones that eat the most time.',
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
// The subject a row was opened with, as a bucket key. Live data had a batch of 170 one-off subjects
// ("A practical handoff for <Company>"), one per prospect, which made 170 buckets of one send each.
// The company name is replaced with a placeholder so a personalised subject is one opener.
export function subjectKey(subject, company) {
    let s = lower(subject).replace(/^(re|fw|fwd):\s*/i, '').replace(/\s+/g, ' ');
    const c = lower(company);
    if (c && c.length >= 3 && s.includes(c)) s = s.split(c).join('{company}');
    s = s.replace(/\bfor [^{].*$/, 'for {company}');   // "a practical handoff for sky visuals" -> one bucket
    return 'subject:' + s.trim();
}
const FOLD_BELOW = 5;   // legacy subject buckets with fewer sends than this are shown as one line
// A reply is a human writing back. The worker files bounces, auto-replies and out-of-office
// notices under their own statuses, and those must not raise an opener's rate or crown a leader.
const NOT_HUMAN = new Set(['bounce_hold', 'auto_reply_hold', 'held_out_of_office']);
export const humanReply = r => !!r && !NOT_HUMAN.has(r.status) && ((r.events || []).some(e => e && e.kind === 'received') || r.status === 'human_reply_hold' || r.status === 'held_reply');
// Won is not measured on the queue (dealStage only exists on deal follow-up rows, which are not
// openers), so it is reported as unknown, never as zero.

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
        if (r.lane === 'deal_followup') continue;   // an existing deal's follow-up is not an opener
        const f = first(r);
        if (!f) continue;
        const id = r.copyVersion || subjectKey(f.subject, r.company);
        // A legacy bucket shows its normalised subject ("A practical handoff for {company}"), not the
        // first company's copy of it.
        const legacySubject = k => { const t = k.slice('subject:'.length); return t ? t.charAt(0).toUpperCase() + t.slice(1) : null; };
        if (!by.has(id)) { const vs = (variantById(campaignId, id) || {}).subject; by.set(id, { id, label: null, subject: typeof vs === 'function' ? vs('{company}') : (vs || (id.startsWith('subject:') ? legacySubject(id) : f.subject) || null), sends: 0, replies: 0, conversations: 0, meetings: 0, won: null, firstSent: f.at, lastSent: f.at }); }
        const b = by.get(id);
        b.sends++;
        if (humanReply(r)) b.replies++;
        if (r.status === 'human_reply_hold' || r.callOutcome === 'connected') b.conversations++;
        // A meeting counts for the opener only if it was booked after the opener went out.
        if (meetingsByEmail instanceof Map) { const at = meetingsByEmail.get(lower(r.recipient)); if (at && Date.parse(at) >= Date.parse(f.at)) b.meetings++; }
        else if (meetingsByEmail && typeof meetingsByEmail.has === 'function' && meetingsByEmail.has(lower(r.recipient))) b.meetings++;
        if (f.at < b.firstSent) b.firstSent = f.at;
        if (f.at > b.lastSent) b.lastSent = f.at;
    }
    // Fold the long tail of one-off legacy subjects into a single honest line.
    const small = [...by.values()].filter(b => b.id.startsWith('subject:') && b.sends < FOLD_BELOW);
    if (small.length > 1) {
        const fold = { id: 'subject:other', label: 'Other earlier subjects', subject: `${small.length} subjects, each sent fewer than ${FOLD_BELOW} times`, sends: 0, replies: 0, conversations: 0, meetings: 0, won: null, firstSent: null, lastSent: null };
        for (const b of small) { fold.sends += b.sends; fold.replies += b.replies; fold.conversations += b.conversations; fold.meetings += b.meetings; if (!fold.firstSent || b.firstSent < fold.firstSent) fold.firstSent = b.firstSent; if (!fold.lastSent || b.lastSent > fold.lastSent) fold.lastSent = b.lastSent; by.delete(b.id); }
        by.set(fold.id, fold);
    }
    const out = [...by.values()].map(b => {
        const v = variantById(campaignId, b.id);
        const enough = b.sends >= MIN_SENDS;
        return { ...b, label: v ? v.label : (b.label || (b.id.startsWith('subject:') ? 'Earlier copy' : b.id)), active: !!v, enough,
            replyRate: enough ? Math.round(1000 * b.replies / b.sends) / 10 : null,
            meetingRate: enough && meetingsByEmail ? Math.round(1000 * b.meetings / b.sends) / 10 : null,
            note: enough ? `${b.replies} of ${b.sends} replied` : `${b.sends} sent; a rate needs ${MIN_SENDS}` };
    });
    // Every variant on offer appears even before its first send, so the page shows it is in rotation.
    for (const v of variantsFor(campaignId)) if (!out.some(o => o.id === v.id)) out.push({ id: v.id, label: v.label, subject: typeof v.subject === 'function' ? v.subject('{company}') : v.subject, sends: 0, replies: 0, conversations: 0, meetings: 0, won: null, firstSent: null, lastSent: null, active: true, enough: false, replyRate: null, meetingRate: null, note: 'Not sent yet' });
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

/** The opener fields a new row gets. A subject may be a function of the company. */
export function openerFor(variant, owner, firstName, company = '') {
    const subject = typeof variant.subject === 'function' ? variant.subject(company) : variant.subject;
    return { copyVersion: variant.id, subject, bodyText: variant.body(owner, firstName, company) };
}
