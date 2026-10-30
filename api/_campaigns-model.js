// The one model behind the Campaigns area: overview, an industry, a campaign.
// ------------------------------------------------------------------
// Paul, 2026-10-22, after choosing Option B and then seeing the first cut: "it doesn't feel
// implemented." He was right, and the worst of it was arithmetic. The page reported "1,222 of
// 1,271 replied, 96.1%" because it counted replyId, which is a threading id present on every sent
// message, as a reply. So this file exists to answer three screens from ONE set of definitions,
// every one of them traceable to a field the worker actually writes.
//
// What counts, and the evidence for it:
//   contacted      at least one email the worker verified as sent (verifiedSentTouches, else sentTouches)
//   replied        a RECEIVED message on the thread, or a status the worker only sets on a reply
//   needs a human  the worker held the thread for a person (human_reply_hold / held_reply)
//   connected      a caller logged the call as connected
//   callback due   a caller promised a time and it has passed
//   ready to call  the queue's own callReady, after the phone ladder
//   won            NOT recorded on the queue. Reported as unknown, never as zero.
//
// Rates carry their denominator and are withheld below 30 contacted, because 2 of 24 is 8.3% and
// would outrank 38 of 779 on any page that printed both.
import { classify, rate, spansIndustries, offTarget } from './_campaign-industry.js';
import { CAMPAIGN_ID } from './_outreach-campaign.js';
import { TOBIT_ID } from './_tobit-campaign.js';
import { TALENT_ID } from './_talent-network-campaign.js';
import { HIRING_ID } from './_hiring-intent.js';
import { HIRING_DRIP_ID } from './_hiring-drip-campaign.js';

export const NAMES = {
    [CAMPAIGN_ID]: { name: 'Staffify agency outreach', motion: 'email_call', motionLabel: 'Email, then call', summary: 'Four emails, 48 hours apart, then a call to anyone who has not replied.' },
    [TOBIT_ID]: { name: 'CEO B2B outreach', motion: 'email_call', motionLabel: 'Email, then call', badge: 'Spearhead', summary: 'Chief executives worked by name, one at a time. Four emails each, then a call.' },
    // Buyers, not candidates. The 99 rows are businesses that may need remote talent (the PM's review of
    // 2026-10-27 read every one); the old "candidates" flag hid them from every rate and mislabelled the page.
    [TALENT_ID]: { name: 'Talent network outreach', motion: 'email_call', motionLabel: 'Email, then call', summary: 'Businesses that may need remote talent. Four emails, then a call to anyone who has not replied.' },
    // Called on the owner's line; since 2026-10-30 the owners with a verified email also get the Hiring now emails below.
    [HIRING_ID]: { name: 'Hiring now', motion: 'call', motionLabel: 'Call first', summary: 'Businesses hiring right now for a customer service, sales or admin seat a remote person can fill. Called first, on the number their business lists.' },
    // Paul, 2026-10-29: "there needs to be constant contact again" (api/_hiring-drip-campaign.js).
    [HIRING_DRIP_ID]: { name: 'Hiring now emails', motion: 'email_call', motionLabel: 'Email and call', summary: 'The owners on Hiring now cards: four emails, 48 hours apart, while the callers keep calling.' },
};
export const MOTIONS = [
    { key: 'email_call', label: 'Email, then call' },
    { key: 'email', label: 'Email only' },
    { key: 'call', label: 'Call first' },
];
export const PLANNED = [
    { key: 'hvac', label: 'HVAC' },
    { key: 'realestate', label: 'Real estate' },
];

const REPLY_STATUSES = new Set(['human_reply_hold', 'held_reply', 'auto_reply_hold']);
const HUMAN_STATUSES = new Set(['human_reply_hold', 'held_reply']);

export const sentCount = r => Number(r.verifiedSentTouches ?? r.sentTouches ?? 0) || 0;
export const replied = r => (r.events || []).some(e => e && e.kind === 'received') || REPLY_STATUSES.has(r.status);
export const needsHuman = r => HUMAN_STATUSES.has(r.status);
// An out-of-office or ticket acknowledgement is a reply arriving, not a person answering. Rates use this.
export const humanReplied = r => replied(r) && r.status !== 'auto_reply_hold';
export const connected = r => r.callOutcome === 'connected';
const isCallback = r => r.callOutcome === 'callback' || r.callOutcome === 'gatekeeper';   // a gatekeeper callback is a callback
export const callbackDue = (r, now = Date.now()) => isCallback(r) && !!r.nextCallAt && Date.parse(r.nextCallAt) <= now;
export const callbackSet = (r, now = Date.now()) => isCallback(r) && !!r.nextCallAt && Date.parse(r.nextCallAt) > now;

/** The state a prospect is in, in words a rep uses. One state per record, first match wins. */
export function prospectState(r, now = Date.now()) {
    if (r.status === 'suppressed' || r.callOutcome === 'suppress') return { key: 'stopped', label: 'Asked us to stop' };
    if (r.booking) return { key: 'booked', label: 'Booked a call' };
    // Hiring now cards taken off the list by the admission rules or held for research are not "not yet contacted".
    if (r.kind === 'hiring' && r.status === 'excluded') return { key: 'held', label: 'Excluded: ' + String((r.exclusion && r.exclusion.reason) || 'rules').replace(/_/g, ' ') };
    if (r.kind === 'hiring' && r.status === 'research') return { key: 'held', label: 'Held for research: ' + String((r.hold && r.hold.reason) || 'proof').replace(/_/g, ' ') };
    if (needsHuman(r)) return { key: 'reply', label: 'Replied, needs a human' };
    if (replied(r)) return { key: 'replied', label: 'Replied' };
    if (connected(r)) return { key: 'connected', label: 'Connected on a call' };
    if (callbackDue(r, now)) return { key: 'callback_due', label: 'Callback due' };
    if (callbackSet(r, now)) return { key: 'callback', label: 'Callback booked' };
    if (r.callOutcome === 'wrong_number') return { key: 'wrong_number', label: 'Wrong number, finding another' };
    if (r.numberResearch) return { key: 'finding', label: r.numberResearch.state === 'exhausted' ? 'No number found' : 'Finding a number' };
    if (r.callReady) return { key: 'ready', label: 'Ready to call' };
    if (r.callOutcome === 'voicemail' || r.callOutcome === 'no_answer') return { key: 'retry', label: 'Called, retry scheduled' };
    if (r.callOutcome === 'timing') return { key: 'timing', label: 'Not now, in nurture' };
    if (sentCount(r) >= 4) return { key: 'four_sent', label: 'Four emails sent, waiting' };
    if (sentCount(r) > 0) return { key: 'sequence', label: `Email ${sentCount(r)} of 4 sent` };
    // A bounce hold on a row with no address and nothing sent is the worker's empty-recipient bug
    // (api/_outreach-worker-core.js, fixed 2026-10-27), not a bounce: nothing was ever sent to bounce.
    if (r.status === 'bounce_hold' && !sentCount(r) && !r.recipient) return { key: 'unsent', label: 'Held before sending: no address yet' };
    if (String(r.status || '').endsWith('_hold')) return { key: 'held', label: 'Held: ' + String(r.status).replace(/_hold$/, '').replace(/_/g, ' ') };
    return { key: 'queued', label: 'Not yet contacted' };
}

/** The same stats for a set of records, however the set was chosen. */
export function stats(records, { now = Date.now(), candidates = false, motion = null } = {}) {
    const n = records.length;
    const contacted = records.filter(r => sentCount(r) > 0).length;
    const fourDone = records.filter(r => sentCount(r) >= 4).length;
    const replies = records.filter(replied).length;
    const humanReplies = records.filter(humanReplied).length;
    const human = records.filter(needsHuman).length;
    const conn = records.filter(connected).length;
    const due = records.filter(r => callbackDue(r, now)).length;
    const ready = records.filter(r => r.callReady).length;
    const finding = records.filter(r => r.numberResearch && r.numberResearch.state !== 'exhausted').length;
    const noNumber = records.filter(r => r.numberResearch && r.numberResearch.state === 'exhausted').length;
    const base = { total: n, contacted, fourDone, replies, humanReplies, autoReplies: replies - humanReplies, repliesWaiting: human, connected: conn, callbacksDue: due, ready, findingNumber: finding, noNumberPossible: noNumber,
        // Not recorded on the queue. Unknown is not zero.
        won: null,
        // Calls logged, for a call-first campaign where nothing is emailed first.
        called: records.filter(r => (r.callHistory || []).some(c => c && c.at)).length };
    if (candidates) return { ...base, replyRate: rate(null, null), connectRate: rate(null, null), note: 'Candidates, not buyers. No sales rate is claimed.' };
    if (motion === 'call') return { ...base, replyRate: rate(null, null), connectRate: rate(conn, base.called), note: 'Call first: no email goes out before the call, so the connect rate is over calls logged.' };
    return { ...base, replyRate: rate(humanReplies, contacted), connectRate: rate(conn, fourDone) };
}

/** Classify every record once, with a human's answer winning. */
export function classified(records, stated = {}) {
    return records.map(r => {
        let s = null;
        try { const raw = stated[r.recipient]; s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { s = null; }
        return { r, v: classify(r, { stated: s }) };
    });
}

function campaignShape(id, rows, labelOf, now) {
    const meta = NAMES[id] || { name: id, motion: 'email', motionLabel: 'Unknown' };
    const byIndustry = {};
    let unclassified = 0;
    const bySource = {};
    for (const { v } of rows) {
        bySource[v.source] = (bySource[v.source] || 0) + 1;
        if (v.key) byIndustry[v.key] = (byIndustry[v.key] || 0) + 1; else unclassified++;
    }
    const industries = Object.entries(byIndustry).map(([key, n]) => ({ key, label: labelOf[key] || key, n })).sort((a, b) => b.n - a.n);
    const off = offTarget(byIndustry);
    return {
        id, name: meta.name, motion: meta.motion, motionLabel: meta.motionLabel, badge: meta.badge || null, candidates: !!meta.candidates, summary: meta.summary || null,
        ...stats(rows.map(x => x.r), { now, candidates: !!meta.candidates, motion: meta.motion }),
        industries, unclassified, spans: spansIndustries(byIndustry),
        dominant: off.dominant, strays: off.strays,
        evidenceNote: bySource.campaign ? `${bySource.campaign} of ${rows.length} are classified from the campaign the list was built as, not from evidence about the business.` : null,
        offTargetNote: off.strays && !spansIndustries(byIndustry) ? `${off.strays} of ${rows.length} look like something other than ${labelOf[off.dominant] || off.dominant}. Worth a look before they are called.` : null,
    };
}

/** Screen 1. */
export function overview(records, stated = {}, now = Date.now()) {
    const rows = classified(records, stated);
    const labelOf = {};
    for (const { v } of rows) if (v.key && !labelOf[v.key]) labelOf[v.key] = v.label;
    const byCampaign = new Map();
    for (const x of rows) { const id = x.r.campaignId || '(none)'; if (!byCampaign.has(id)) byCampaign.set(id, []); byCampaign.get(id).push(x); }

    const campaigns = [...byCampaign.entries()].map(([id, list]) => campaignShape(id, list, labelOf, now));
    const spanning = campaigns.filter(c => c.spans);
    const grouped = {};
    for (const c of campaigns.filter(c => !c.spans)) {
        const key = c.industries[0] ? c.industries[0].key : 'unclassified';
        (grouped[key] = grouped[key] || []).push(c);
    }
    const industries = Object.entries(grouped).map(([key, list]) => ({
        key, label: labelOf[key] || key, started: true, campaigns: list,
        prospects: list.reduce((n, c) => n + c.total, 0),
        ready: list.reduce((n, c) => n + c.ready, 0),
        repliesWaiting: list.reduce((n, c) => n + c.repliesWaiting, 0),
    })).sort((a, b) => b.prospects - a.prospects);
    for (const p of PLANNED) if (!industries.some(i => i.key === p.key)) industries.push({ key: p.key, label: p.label, started: false, campaigns: [], prospects: 0, ready: 0, repliesWaiting: 0, note: 'No campaign yet. Nothing has been sent, so every figure is unknown rather than zero.' });

    // Filter rails. Industry counts come from the records themselves, so the chips are true.
    const indCounts = {};
    for (const { v } of rows) { const k = v.key || 'unclassified'; indCounts[k] = (indCounts[k] || 0) + 1; }
    const filters = {
        industries: Object.entries(indCounts).map(([key, n]) => ({ key, label: key === 'unclassified' ? 'Unclassified' : (labelOf[key] || key), n })).sort((a, b) => b.n - a.n),
        motions: MOTIONS.map(m => ({ ...m, n: campaigns.filter(c => c.motion === m.key).reduce((s, c) => s + c.total, 0) })),
    };
    return {
        totals: { records: records.length, campaigns: campaigns.length, ready: campaigns.reduce((n, c) => n + c.ready, 0), repliesWaiting: campaigns.reduce((n, c) => n + c.repliesWaiting, 0), callbacksDue: campaigns.reduce((n, c) => n + c.callbacksDue, 0) },
        spanning, industries, filters,
        unclassified: rows.filter(x => !x.v.key).length,
    };
}

/** Screen 2. */
export function industryView(records, industryKey, stated = {}, now = Date.now()) {
    const rows = classified(records, stated);
    const labelOf = {};
    for (const { v } of rows) if (v.key && !labelOf[v.key]) labelOf[v.key] = v.label;
    const mine = rows.filter(x => (x.v.key || 'unclassified') === industryKey);
    const planned = PLANNED.find(p => p.key === industryKey);
    const label = labelOf[industryKey] || (planned && planned.label) || (industryKey === 'unclassified' ? 'Unclassified' : industryKey);

    // Campaigns BUILT for this industry: those where it is the dominant classification.
    const byCampaign = new Map();
    for (const x of rows) { const id = x.r.campaignId || '(none)'; if (!byCampaign.has(id)) byCampaign.set(id, []); byCampaign.get(id).push(x); }
    const all = [...byCampaign.entries()].map(([id, list]) => campaignShape(id, list, labelOf, now));
    const own = all.filter(c => !c.spans && c.dominant === industryKey);
    // Campaigns that merely REACH it, shown apart, with the people counted once in their own campaign.
    const alsoReaching = all.filter(c => !own.includes(c) && c.industries.some(i => i.key === industryKey))
        .map(c => ({ id: c.id, name: c.name, badge: c.badge, here: c.industries.find(i => i.key === industryKey).n, total: c.total }));

    const people = mine.map(x => x.r);
    return {
        industry: { key: industryKey, label, started: own.length > 0 || people.length > 0 },
        funnel: stats(people, { now }),
        campaigns: own,
        alsoReaching,
        queue: { ready: people.filter(r => r.callReady).length, callbacksDue: people.filter(r => callbackDue(r, now)).length, repliesWaiting: people.filter(needsHuman).length },
        note: planned && !people.length ? 'No campaign yet. Nothing has been sent, so every figure is unknown rather than zero.' : null,
    };
}

/** Screen 3. */
export function campaignView(records, campaignId, stated = {}, now = Date.now()) {
    const rows = classified(records.filter(r => r.campaignId === campaignId), stated);
    const labelOf = {};
    for (const { v } of rows) if (v.key && !labelOf[v.key]) labelOf[v.key] = v.label;
    const shape = campaignShape(campaignId, rows, labelOf, now);
    const list = rows.map(x => x.r);

    const prospects = list.map(r => {
        const st = prospectState(r, now);
        return {
            id: r.id, company: r.company || null, name: r.verifiedFirstName || null, email: r.recipient,
            emails: sentCount(r), lastTouch: r.lastSentAt || null,
            state: st.key, stateLabel: st.label,
            nextCallAt: r.nextCallAt || null, callOwner: r.callOwner || null,
            phone: r.callContact && r.callContact.phone ? { number: r.callContact.phone, status: r.callContact.phoneStatus } : null,
        };
    }).sort((a, b) => {
        const order = { booked: 0, reply: 0, callback_due: 1, connected: 2, ready: 3, callback: 4, finding: 5, wrong_number: 5, retry: 6, four_sent: 7, sequence: 8, timing: 9, held: 10, queued: 11, stopped: 12 };
        return (order[a.state] ?? 20) - (order[b.state] ?? 20) || String(b.lastTouch || '').localeCompare(String(a.lastTouch || ''));
    });

    // What they received: the first email and the follow-ups, taken from one representative record
    // that has them, since the copy is the same across the campaign except for the name.
    // Openers rotate now, so email 1 is one entry per opener actually on the campaign, most-sent first.
    const withCopy = list.find(r => r.bodyText && r.followupBodies && typeof r.followupBodies === 'object') || list.find(r => r.bodyText);
    const sequence = [];
    const openers = new Map();
    for (const r of list) { if (!r.bodyText) continue; const k = r.copyVersion || String(r.subject || '').toLowerCase(); const o = openers.get(k) || { subject: r.subject || null, body: r.bodyText, copyVersion: r.copyVersion || null, prospects: 0 }; o.prospects++; openers.set(k, o); }
    const ranked = [...openers.values()].sort((a, b) => b.prospects - a.prospects).slice(0, 4);
    if (withCopy) {
        if (ranked.length) for (const o of ranked) sequence.push({ n: 1, subject: o.subject, body: o.body, copyVersion: o.copyVersion, prospects: o.prospects, variant: ranked.length > 1 });
        else sequence.push({ n: 1, subject: withCopy.subject || null, body: withCopy.bodyText });
        const follow = withCopy.followupBodies && typeof withCopy.followupBodies === 'object'
            ? Object.entries(withCopy.followupBodies).sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })) : [];
        follow.forEach(([, body], i) => sequence.push({ n: i + 2, subject: null, body }));
    }

    const replies = list.filter(replied).map(r => {
        const got = (r.events || []).filter(e => e && e.kind === 'received').sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
        return { id: r.id, company: r.company || null, name: r.verifiedFirstName || null, email: r.recipient,
            at: got ? got.at : null, subject: got ? got.subject : null, excerpt: got ? String(got.body || '').replace(/\s+/g, ' ').slice(0, 220) : null,
            needsHuman: needsHuman(r) };
    }).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

    const callbacks = list.filter(r => r.callOutcome === 'callback' && r.nextCallAt).map(r => ({ id: r.id, company: r.company, name: r.verifiedFirstName, at: r.nextCallAt, owner: r.callOwner || null, due: Date.parse(r.nextCallAt) <= now }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));

    return {
        campaign: shape,
        prospects,
        sequence,
        replies,
        calls: { placed: list.filter(r => (r.callHistory || []).length).length, attempts: list.reduce((n, r) => n + (r.callHistory || []).length, 0), connected: shape.connected, callbacks },
        next: { ready: shape.ready, callbacksDue: shape.callbacksDue, repliesWaiting: shape.repliesWaiting, findingNumber: shape.findingNumber, noNumberPossible: shape.noNumberPossible },
    };
}
