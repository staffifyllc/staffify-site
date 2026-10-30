// Hiring now drip: the owners on Hiring now cards get four emails, 48 hours apart, while the Hub callers keep calling.
// ------------------------------------------------------------------
// Paul, 2026-10-29: "we need to be emailing and dripping emails to the folks sitting in our queue, there needs to be
// constant contact again, wire that up". 2026-10-30, the copy: "asking if the job is still available, don't try to
// sell the outcome, sell the value and the appointment 'i see you have this listed for $22 an hour' we can fill this
// role with someone amazing for $14 an hour".
//
// The campaign id and its follow-up reader live in api/_hiring-drip-campaign.js, which the engine imports.
// The hosted Gmail worker (api/_outreach-worker-core.js) sends these like every other campaign: one queue, the same
// history, opt-out, client, CRM and Findymail checks, the same send window. This file only says who qualifies, what
// they read, and when a card's own state stops the sequence (a caller reached them, a booking, a closed posting).
import { spokenRole, DISCOVERY_LINK } from './_call-scripts.js';
import { HIRING_DRIP_ID } from './_hiring-drip-campaign.js';
import { sequenceLine } from './_kick-rocks.js';
import { kickLink } from '../lib/unsubscribe-token.js';
import { leadStatedDate, sectorOf } from './_hiring-intent.js';

export { HIRING_DRIP_ID };
export const OUR_RATE = 14;
// A posted rate this far above ours is worth quoting back; closer than that, the comparison is no argument.
const QUOTE_FROM = 16;

// Card states the drip may email. A held card waits on a phone number, not on doubt about the person or the job.
const LIVE = ['ready', 'research', 'number_research'];
const PHONE_HOLDS = ['main_line_only', 'toll_free_only', 'owner_cell_unconfirmed', 'number_unconfirmed'];
// Someone spoke to them (or asked not to be called): from here a person follows up, not the drip.
const SPOKE = ['connected', 'callback', 'timing', 'suppress'];
const EMAIL_OK = ['verified', 'named'];
const FRONT_DESK = /\b(front[\s-]*desk|receptionist)\b/i;

/** Why a card must not get (or keep getting) drip email, or null when it may. */
export function hiringDripStop(card) {
    if (!card) return 'The card is gone';
    if (card.booking || card.status === 'booked') return 'They booked a call';
    if (!LIVE.includes(card.status)) return 'The card is ' + card.status;
    if (card.status === 'research' && !PHONE_HOLDS.includes(card.hold && card.hold.reason)) return 'The card is held: ' + ((card.hold && card.hold.reason) || 'under review');
    if (/^(closed|stale)$/.test(String(card.job && card.job.state || ''))) return 'The posting is ' + card.job.state;
    // 18 of the 59 "this is not a remote job" stops were front desks, and a post that asks for US-based people has said
    // no to ours before we write (research, 2026-10-30). The callers can still try them; the emails don't.
    const j = card.job || {};
    if (FRONT_DESK.test(j.title || '') && !/\b(virtual|remote)\b/i.test(j.title || '') && j.workplace !== 'remote') return 'A front desk seat: the callers work it, not email';
    if (((j.restrictions || {}).soft || []).some(x => /US-based/.test(x))) return 'The post asks for US-based applicants';
    if (SPOKE.includes(card.callOutcome) || (card.callHistory || []).some(h => h && SPOKE.includes(h.outcome))) return 'A caller already spoke with them';
    const c = card.contact || {};
    if (!c.email || !c.firstName || !EMAIL_OK.includes(c.status)) return 'No verified owner email';
    return null;
}

// Mad River and AlestaCare got a call, a text and the first email inside two hours (2026-10-30), and both said no. The
// first email waits a day after the last call. It only holds a row whose draft does not exist yet, so the worker's
// recheck puts it back in the queue once the day has passed.
const CALL_GAP = 24 * 3600e3;
/** Why the first email must wait (a call in the last day), or null. */
export function dripWait(card, row, now = Date.now()) {
    if (!card || !row || Number(row.sentTouches) || row.draftId) return null;
    const last = Math.max(0, ...(card.callHistory || []).map(h => Date.parse(h && h.at) || 0));
    return now - last < CALL_GAP ? 'Called in the last day: the first email waits' : null;
}

// "$22/hr", "$23 - $27 an hour", "$2.0K-$2.2K/wk", "$50–60K Base", "from $60k": the first stated amount or range.
const AMOUNT = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b)?(?:\s*(?:-|–|—|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k\b)?)?/i;
const num = s => Number(String(s).replace(/,/g, ''));
/** The pay a posting states, read from its title: { low, high, unit, from } or null. Only dollar amounts count. */
export function postedPay(title) {
    const t = String(title || '');
    const m = t.match(AMOUNT);
    if (!m) return null;
    const k = !!(m[2] || m[4]);
    // "$50–60K": the K on the top of the range covers the bottom too.
    let low = num(m[1]) * (m[2] || (m[4] && num(m[1]) < 1000) ? 1000 : 1);
    let high = m[3] ? num(m[3]) * (m[4] ? 1000 : 1) : null;
    if (!(high > low)) high = null;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30).toLowerCase();
    const unit = /^[^$]*?(\/\s?hr|\bhour|\bhourly|\/\s?h\b)/.test(after) ? 'hour'
        : /^[^$]*?(\/\s?day|\bdaily|\ba day|\bper day)/.test(after) ? 'day'
        : /^[^$]*?(\/\s?wk|\bweek|\bweekly)/.test(after) ? 'week'
        : /^[^$]*?(\/\s?mo|\bmonth|\bmonthly)/.test(after) ? 'month'
        : /^[^$]*?(\/\s?yr|\byear|\bannual|\bsalary|\bbase)/.test(after) || k || low >= 1000 ? 'year' : 'hour';
    return { low, high, unit, from: /\bfrom\s*$/i.test(t.slice(0, m.index)) };
}
const PER_HOUR = { hour: 1, day: 1 / 8, week: 1 / 40, month: 12 / 2080, year: 1 / 2080 };
export const hourlyOf = pay => (pay ? pay.low * PER_HOUR[pay.unit] : null);

const money = (n, unit) => {
    if (unit === 'year') return '$' + Math.round(n / 1000) + 'K';
    return '$' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2).replace(/\.00$/, ''));
};
const UNIT = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month', year: 'a year' };
/** "$20 to $25 an hour", "$60K to $65K a year", "$25 an hour and up". */
export function payPhrase(pay) {
    if (!pay) return null;
    const range = money(pay.low, pay.unit) + (pay.high ? ' to ' + money(pay.high, pay.unit) : '');
    return range + ' ' + UNIT[pay.unit] + (pay.from && !pay.high ? ' and up' : '');
}

/** The seat as it reads in a sentence: "Paralegal", "Executive Assistant", "Customer Service Rep". */
export function dripRole(title) {
    let r = spokenRole(title).replace(/\s+(to|for)\s+(the\s+)?\S.*$/i, '');
    r = r.replace(/\b(fully\s+remote|100%\s+remote|remote|hybrid|part[- ]time|full[- ]time|weekend)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    r = r.replace(/^(experienced|entry[- ]level)\s+/i, '').replace(/^(and|&)\s+|\s+(and|&)$/gi, '').trim();
    return calm(r) || 'open';
}
// A word typed in capitals ("RECEPTIONIST", "INNOVATE PHYSICAL THERAPY") reads as shouting; short acronyms (CSR, HVAC) stay.
const calm = s => String(s || '').replace(/\b[A-Z]{5,}\b/g, w => w[0] + w.slice(1).toLowerCase());
// "Farmers Insurance - Alan Bradshaw" is Alan's agency, not Farmers: a carrier name before the dash gives way to the agent's.
const CARRIER = /^(state farm|farmers( insurance)?|allstate|nationwide|american family|liberty mutual|country financial)\b/i;
/** The company as people say it: no "LLC", no "(Farmers Insurance)", no " - State Farm Agent" descriptor. */
export function dripCompany(name) {
    let n = String(name || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = n.split(/\s+[-–|]\s+/);
    if (parts.length > 1) n = CARRIER.test(parts[0]) ? parts.slice(1).join(' ') : parts[0];
    for (let i = 0; i < 2; i++) n = n.replace(/,?\s+(llc\.?|l\.l\.c\.|inc\.?|pllc\.?|p\.?a\.?|p\.?c\.?|llp\.?|ltd\.?|corp\.?|co\.)$/i, '').trim();
    return calm(n);
}

// Paul, 2026-10-30, on the first version: "these dont really get me to get excited to take any sort of action, theres
// very little value in this message". The rewrite rests on what owners told us (59 of the 66 caller stops were "this is
// not a remote job", and 165 of the first 176 emails never said remote), on what owners fear in a remote hire (a bad
// pick, then ending up as its manager), and only on claims the site already makes. Email 1 says remote next to the price,
// names the work the hire takes over and asks for a one-word answer; email 2 answers the bad pick (how we screen),
// email 3 the managing (and the replacement guarantee), email 4 is a short close.

// The work a hire takes over, by the card's role family. Law firms get the law page's own list.
const VALUE = {
    support: 'your customer calls and emails and every follow-up',
    sales: 'the calls to prospects you approve and the appointment booking, while the closing stays with you',
    admin: 'your inbox and calendar, the data entry and the invoice follow-ups',
    scheduling: 'new inquiries, appointment booking and confirmation calls, with each booking logged in your CRM',
    account: "the day-to-day calls and emails with your clients and keeping each account's records current",
    video: 'your short-form and YouTube edits and the revision rounds, kept on your brand',
};
const LAW_VALUE = 'intake calls on your script, court dates and deadlines on your calendar, and time entry for billing';
// The site says we do no paralegal work: these seats hear that first.
const LEGAL_SEAT = /\b(paralegal|legal\s+assistant)\b/i;

/** The day the post went up, only when the post itself states it (a provided lead's own date, a careers page's): "Oct 26". */
export function postedDay(card) {
    const j = (card && card.job) || {};
    const t = Date.parse((j.source === 'provided' ? leadStatedDate(card.lead) : j.source === 'ats' ? j.postedAt : null) || '');
    return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : null;
}

/** The four emails for one card. Nothing promises an outcome, a timeline or a number the site does not publish. */
export function hiringDripCopy(card, { link = DISCOVERY_LINK, signer = 'Paul', unsubscribe = kickLink } = {}) {
    const SIGN = signer + '\nStaffify';
    // Each email's own way out, and the one-click link to /kick-rocks/ under it (Paul: "should it be a link, but make it funny?").
    let kick = '';
    try { kick = unsubscribe((card.contact || {}).email) || ''; } catch { kick = ''; }
    const out = n => sequenceLine(n) + (kick ? '\nOne click works too: ' + kick : '');
    const c = card.contact || {}, first = c.firstName, j = card.job || {};
    const title = j.title || (card.lead && card.lead.role_posted) || '';
    const role = dripRole(title);
    const job = role === 'open' ? 'the job you posted' : `the ${role} job`;
    const pay = postedPay(title), hourly = hourlyOf(pay);
    const offshore = !!(j.restrictions && j.restrictions.offshore);
    // The remote tag is wrong in both directions (Mad River), so a remote post the researcher doubted reads as in-office.
    const remote = j.workplace === 'remote' && !/not\s+confirmed\s+remote/i.test(String(card.lead && card.lead.notes || ''));
    const legalSeat = LEGAL_SEAT.test(title);
    const ctx = [card.lead && card.lead.industry, card.lead && card.lead.vertical, card.company && card.company.identity && card.company.identity.listingType].filter(Boolean).join(' ');
    const law = legalSeat || sectorOf(card.company && card.company.name, ctx) === 'law';
    const value = law && card.family !== 'video' ? LAW_VALUE : VALUE[card.family] || null;
    // Our price only where it is lower than theirs: never to an offshore post or one paying our rate or less. Their own
    // number goes next to it only when the gap is worth reading (QUOTE_FROM), and never on a video seat (copy rule 7).
    const priced = !offshore && !(hourly != null && hourly <= OUR_RATE);
    const quote = priced && hourly != null && hourly >= QUOTE_FROM && card.family !== 'video';
    const price = priced ? ` for $${OUR_RATE} an hour` + (pay && pay.unit === 'year' ? `, about $${Math.round(OUR_RATE * 2080 / 1000)}K a year` : '') : '';
    const day = postedDay(card), city = j.city;
    const seen = `I saw ${role === 'open' ? 'the job' : job} you posted${city ? ' in ' + city : ''}${day ? ' on ' + day : ''}${quote ? ', listed at ' + payPhrase(pay) : ''}. Is it still open?`;
    const work = value ? `They'd work only for you, on your hours, and take over ${value}.` : "They'd work only for you, on your hours.";
    let offer = legalSeat
        ? `One thing up front: we place legal admins, not paralegals, and they work remotely from Latin America or the Philippines. If the admin side of this seat can be done remotely, we can put a full-time person on it${price}. ${work}`
        : offshore
        ? `Your post is open to someone outside the US, and that's who we place: full-time remote hires from Latin America or the Philippines. ${work}`
        : !remote
        ? `One thing up front: our hires work remotely from Latin America or the Philippines. If the work can be done remotely, we can put a full-time person on it${price}. ${work}`
        : `If so, we can fill it with a full-time remote hire from Latin America or the Philippines${price}. ${work}`;
    // A part-time post is told plainly that ours are full-time (AlestaCare said no to a pitch that hid it).
    if (/\bpart[\s-]*time\b/i.test(title)) offer += " You listed it as part-time, and our hires are full-time, so this fits if there's a full week of work to give them.";
    const subject = role === 'open' ? 'Your open role' : `Your ${role} hire`;
    const bodyText = [`Hi ${first},`, seen, offer,
        'You skip the applicant pile. We find and screen candidates, you interview the finalists and pick one, and we run their payroll and HR.',
        `Reply "open" or "filled." If it's open, grab a time and I'll show you ${remote ? "who we'd look for" : 'which parts could go remote'}:\n${link}`,
        SIGN, out(1)].join('\n\n');
    const followupBodies = {
        2: [`Hi ${first},`, "The risk with any hire is someone who interviews well and then can't do the job. Here's how we screen remote candidates.",
            'Every candidate does a written screen, a live video interview and a paid skills test, and we call their references. For seats that talk to customers or clients, we test their spoken and written English. We check their computer and internet speed too.'
                + (law ? ' They sign a confidentiality agreement, work under your data policies and see only the systems you give them access to.' : ''),
            'The finalists then do a test task modeled on your work, so you see what they can do before anyone starts.',
            `Is ${job} still open? "Open" or "filled" is all I need.`, SIGN, out(2)].join('\n\n'),
        3: [`Hi ${first},`, 'If the worry with a remote hire is ending up as their manager, that part is ours.',
            "You direct the work. We run their payroll, HR and time tracking, and our managers handle the check-ins and corrections, so you aren't chasing anyone. They're never shared with another business.",
            "If they leave or it isn't working, we find and place someone new at no additional cost, for as long as you're with us. That's our lifetime replacement guarantee. It's month to month, with no long-term contract.",
            `If ${job} is still open, pick a time and I'll walk you through it. If we're not a fit, I'll say so.\n${link}`, SIGN, out(3)].join('\n\n'),
        4: [`Hi ${first},`, `Did ${role === 'open' ? 'the job you posted' : `your ${role} job`} get filled? If it did, congrats.`,
            `If it's still open, or another seat opens up later, we'll run the search for a full-time remote ${legalSeat ? 'legal admin' : 'hire'} and you'll pick from the finalists.`,
            'Either way, one word back is plenty: "filled" or "open."', SIGN, out(4)].join('\n\n'),
    };
    return { subject, bodyText, followupBodies, role, payText: payPhrase(pay), quoted: quote };
}

const key = s => String(s || '').trim().toLowerCase();
const domainOf = card => key(card.company && card.company.domain).replace(/^www\./, '') || null;
/**
 * The cards to enrol now, best first: callable cards, then cards waiting on a cell, newest first. One per address and
 * one per company, never someone the queue already tracks, suppressed, or assigned to another owner.
 */
export function dripCandidates(cards, state, { limit = 25 } = {}) {
    const tracked = new Set((state.records || []).map(r => key(r.recipient)).filter(Boolean));
    const cardsDone = new Set((state.records || []).map(r => r.hiringId).filter(Boolean));
    const domains = new Set((state.records || []).filter(r => r.campaignId === HIRING_DRIP_ID && r.agencyKey).map(r => key(r.agencyKey)));
    const suppressed = new Set((state.suppressions || []).map(key));
    const taken = new Set((state.assignments || []).filter(a => !SENDERS.includes(a.owner)).map(a => key(a.email)));
    const out = [], skipped = {};
    const skip = (why, card) => { (skipped[why] ||= []).push(card.company && card.company.name || card.id); };
    const order = c => (c.status === 'ready' ? 0 : 1);
    for (const card of [...cards].sort((a, b) => order(a) - order(b) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')))) {
        const stop = hiringDripStop(card);
        if (stop) { skip(stop, card); continue; }
        const email = key(card.contact.email), dom = domainOf(card);
        if (cardsDone.has(card.id) || tracked.has(email)) { skip('Already in the email queue', card); continue; }
        if (suppressed.has(email)) { skip('Suppressed', card); continue; }
        if (taken.has(email)) { skip('Owned by another sender', card); continue; }
        if (dom && domains.has(dom)) { skip('Company already enrolled', card); continue; }
        tracked.add(email); if (dom) domains.add(dom);
        out.push(card);
        if (out.length >= limit) break;
    }
    return { cards: out, skipped };
}

// Paul, 2026-10-30: "can we send from every account please? we have more than 2 inboxes". Every Staffify inbox the
// worker drafts from sends, each email signed by that inbox's owner.
export const SENDERS = ['Paul', 'Madison'];
const DONE = ['sequence_complete_hold', 'suppressed', 'bounce_hold', 'sender_retired_hold'];
/**
 * The Staffify inbox with the least drip work (only the assigned owner's, when someone owns this person). Load is this
 * campaign's live rows plus any introduction still waiting in another campaign: those share the inbox's daily cap of new
 * introductions. An inbox's years of finished agency history is not load.
 */
export function dripSender(accounts, records, { owner = null } = {}) {
    const choices = (accounts || []).filter(a => a.brand === 'Staffify' && a.draftEnabled && SENDERS.includes(a.owner) && (!owner || a.owner === owner));
    if (!choices.length) throw Error(owner ? 'No ' + owner + ' outreach inbox available' : 'No Staffify outreach inbox available');
    const load = email => records.filter(r => r.sender === email && r.recipient && (r.campaignId === HIRING_DRIP_ID ? !DONE.includes(r.status) : r.status === 'prepared')).length;
    return choices.sort((a, b) => load(a.email) - load(b.email) || a.email.localeCompare(b.email))[0];
}

// Rows written with an older version take this one through refreshDripCopy: the whole sequence before email 1 is
// drafted, the follow-ups not yet drafted after it.
export const COPY_VERSION = 'hiring-now-2026-10-31-remote-value';

/** The queue row for one card: prepared, approved, and carrying its own follow-ups. */
export function dripRow(card, { account, now = Date.now() }) {
    const copy = hiringDripCopy(card, { signer: account.owner });
    const at = new Date(now).toISOString();
    return {
        id: 'hiring-drip-' + String(card.id).replace(/^hire:/, ''), campaignId: HIRING_DRIP_ID, lane: 'hiring_now', owner: account.owner, sender: account.email,
        recipient: key(card.contact.email), company: (card.company && card.company.name) || '', agencyKey: domainOf(card), website: (card.company && card.company.website) || null,
        verifiedFirstName: card.contact.firstName, hiringId: card.id, roleName: copy.role,
        subject: copy.subject, bodyText: copy.bodyText, followupBodies: copy.followupBodies, copyVersion: COPY_VERSION,
        source: { label: 'Hiring now card', id: card.id, job: (card.job && card.job.title) || null, url: (card.job && card.job.url) || null },
        status: 'prepared', sentTouches: 0, verifiedSentTouches: 0, qualificationApproved: true, createdAt: at, enrichedAt: at,
    };
}

/**
 * Spread the introductions nobody has started yet across every inbox again (new inboxes, or a batch that landed on a
 * few). Only prepared rows with no draft, thread or send move; the copy is rebuilt so the signature matches the inbox.
 * The caller holds the worker's lock. Returns how many rows changed inbox.
 */
export function rebalanceDripRows(state, cardsById, accounts, now = Date.now()) {
    const movable = new Set(state.records.filter(r => r.campaignId === HIRING_DRIP_ID && r.status === 'prepared' && !r.sentTouches && !r.draftId && !r.threadId && cardsById.has(r.hiringId)).map(r => r.id));
    const placed = state.records.filter(r => !movable.has(r.id));
    const next = new Map();
    let moved = 0;
    for (const r of state.records.filter(x => movable.has(x.id))) {
        const owner = ((state.assignments || []).find(a => a.email === r.recipient) || {}).owner || null;
        let account;
        try { account = dripSender(accounts, placed, { owner: SENDERS.includes(owner) ? owner : null }); } catch { placed.push(r); continue; }
        const row = account.email === r.sender ? r : { ...dripRow(cardsById.get(r.hiringId), { account, now }), id: r.id, createdAt: r.createdAt, enrichedAt: r.enrichedAt };
        if (row !== r) { moved++; next.set(r.id, row); }
        placed.push(row);
    }
    state.records = state.records.map(r => next.get(r.id) || r);
    return moved;
}

/**
 * Rows written with older copy take the current copy for every email not yet written: all of it before the first
 * draft, otherwise only the follow-ups after the one already drafted (a saved Gmail draft is never rewritten here, and
 * the send checks the draft against its stored text). The caller holds the worker's lock. Returns rows changed.
 */
export function refreshDripCopy(state, cardsById) {
    let changed = 0;
    for (const r of state.records) {
        if (r.campaignId !== HIRING_DRIP_ID || r.copyVersion === COPY_VERSION || !cardsById.has(r.hiringId)) continue;
        const copy = hiringDripCopy(cardsById.get(r.hiringId), { signer: r.owner });
        const sent = Number(r.sentTouches) || 0;
        if (r.status === 'prepared' && !sent && !r.draftId && !r.threadId) Object.assign(r, { subject: copy.subject, bodyText: copy.bodyText, followupBodies: copy.followupBodies });
        else {
            const firstFree = sent + (r.draftId ? 2 : 1);
            r.followupBodies = { ...(r.followupBodies || {}), ...Object.fromEntries(Object.entries(copy.followupBodies).filter(([k]) => Number(k) >= firstFree)) };
        }
        r.copyVersion = COPY_VERSION;
        changed++;
    }
    return changed;
}
