// Paul, 2026-10-29/30: "we need to be emailing and dripping emails to the folks sitting in our queue", "asking if the
// job is still available ... 'i see you have this listed for $22 an hour' we can fill this role with someone amazing for
// $14 an hour", and "never put in data for Main Line". Then, of that copy: "theres very little value in this message".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HIRING_DRIP_ID, hiringDripStop, dripWait, sendWait, refreshDripCopy, COPY_VERSION, postedPay, payPhrase, hourlyOf, dripRole, dripCompany, postedDay, hiringDripCopy, dripCandidates, dripSender, dripRow, rebalanceDripRows } from '../api/_hiring-drip-copy.js';
import { hiringDripFollowup } from '../api/_hiring-drip-campaign.js';
import { prepareDripRows, addDripRows, enrollHiringDrip, hiringSupply, contactProps, dripAllowed } from '../api/_hiring-drip.js';
import { inCampaign, tagCampaign } from '../api/_outreach-campaign.js';
import { followup, eligible, callReady } from '../api/_outreach-policy.js';
import { roleFamily } from '../api/_hiring-intent.js';
import { kickLine } from '../api/_kick-rocks.js';

const card = (id, over = {}) => ({
    id: 'hire:' + id.padEnd(16, '0'), status: 'ready', createdAt: '2026-10-29T12:00:00Z',
    company: { name: 'MDM Legal, PLLC', domain: id + '.com', website: 'https://' + id + '.com' },
    job: { title: 'Legal Assistant - $22/hr', city: 'Tampa', usState: 'FL', url: 'https://jobs.example/' + id },
    contact: { name: 'Denise Mutamba', firstName: 'Denise', role: 'Founder', email: 'denise@' + id + '.com', status: 'verified' },
    phone: { number: '+15615550100', source: 'provided' }, callOutcome: null, callHistory: [], ...over,
});
const acct = (email, owner = 'Paul') => ({ email, owner, brand: 'Staffify', draftEnabled: true });
const CFG = { allowedCampaignIds: ['staffify-talent-network-outreach'], accounts: [acct('paul@staffifyhq.com'), acct('paul@hirestaffify.com'), acct('madison@staffifyhq.com', 'Madison')] };
const emptyState = () => ({ revision: 3, records: [], suppressions: [], assignments: [], pausedOwners: [] });
const lines = s => s.split('\n');

test('email 1: their post and pay, our remote hire at $12 to $14 an hour, the work it takes over, a one-word answer and the link', () => {
    const c = hiringDripCopy(card('a', { family: 'support', company: { name: 'Bayside HVAC', domain: 'a.com' }, job: { title: 'Customer Service Rep - $22/hr', city: 'Tampa', workplace: 'remote', source: 'provided' }, lead: { posting_date: 'Posted 2026-10-26' } }));
    assert.equal(c.subject, 'Your Customer Service Rep hire');
    assert.equal(c.bodyText, [
        'Hi Denise,',
        'I saw the Customer Service Rep job you posted in Tampa on Oct 26, listed at $22 an hour. Is it still open?',
        "If so, we can fill it with a full-time remote hire from Latin America or the Philippines for $12 to $14 an hour. They'd work only for you, on your hours, and take over your customer calls and emails and every follow-up.",
        'You skip the applicant pile. We find and screen candidates, you interview the finalists and pick one, and we run their payroll and HR.',
        'Reply "open" or "filled." If it\'s open, grab a time and I\'ll show you who we\'d look for:\nhttps://calendly.com/go-staffify/discovery-call',
        'Paul\nStaffify',
        kickLine('denise@a.com', 0),
    ].join('\n\n'));
    for (const text of [c.subject, c.bodyText, ...Object.values(c.followupBodies)]) {
        assert.doesNotMatch(text, /—|–|[“”’]/, 'no em or en dashes, straight quotes only');
        assert.doesNotMatch(text, /\bi\b/, 'I is always capitalised');
        assert.doesNotMatch(text, /30-day|mint|amazing|\d+ ?%|\b\d+ (days|weeks)\b/i, 'no hype, no percentages, no placement timeline');
        if (/guarantee/i.test(text)) assert.match(text, /lifetime replacement guarantee/, 'only the lifetime replacement guarantee');
    }
    assert.match(c.followupBodies[2], /written screen, a live video interview and a paid skills test/);
    assert.match(c.followupBodies[2], /If the Customer Service Rep job is still open, would you mind if I sent you a few profiles of recent hires we've made\? You'd see the caliber of people we're hiring\./);
    assert.doesNotMatch(c.followupBodies[2], /confidentiality/, 'the law line is for law firms');
    assert.match(c.followupBodies[3], /lifetime replacement guarantee\. It's month to month, with no long-term contract\./);
    assert.match(c.followupBodies[3], /calendly\.com/);
    assert.match(c.followupBodies[4], /^Hi Denise,\n\nDid your Customer Service Rep job get filled\? If it did, congrats\./);
    assert.doesNotMatch(c.followupBodies[4], /\$/, 'the close quotes no price');
    assert.match(c.followupBodies[4], /This is my last note, so one word back is plenty: "filled" or "open\."/);
    for (const text of [c.bodyText, ...Object.values(c.followupBodies)]) assert.doesNotMatch(text, /https:\/\/(?!calendly)|One click/, 'no link but the booking link');
    assert.equal(Object.values(c.followupBodies).filter(t => /\$1[24]/.test(t)).length, 0, 'the price is in email 1 only');
    assert.equal(hiringDripFollowup({ followupBodies: c.followupBodies, sentTouches: 1 }), c.followupBodies[2]);
    assert.throws(() => hiringDripFollowup({ followupBodies: {}, sentTouches: 1 }), /follow-up missing/);
});

test('email 1 says remote up front to an in-office post, and tells a legal seat we place admins, not paralegals', () => {
    const office = hiringDripCopy(card('o', { family: 'support', job: { title: 'Customer Retention Specialist - $46K-$52K a year', city: 'Boise', workplace: 'onsite' } }));
    assert.match(office.bodyText, /I saw the Customer Retention Specialist job you posted in Boise, listed at \$46K to \$52K a year\. Is it still open\?/);
    assert.match(office.bodyText, /One thing up front: our hires work remotely from Latin America or the Philippines\. If the work can be done remotely, we can put a full-time person on it for \$12 to \$14 an hour, about \$25K to \$29K a year\./);
    assert.match(office.bodyText, /I'll show you which parts could go remote:/);
    const doubted = hiringDripCopy(card('d', { family: 'support', job: { title: 'CSR', workplace: 'remote' }, lead: { notes: 'Role not confirmed remote' } }));
    assert.match(doubted.bodyText, /One thing up front/, 'a remote tag the researcher doubted reads as in-office');
    const legal = hiringDripCopy(card('l', { family: 'admin', company: { name: 'Hunt & Co', domain: 'l.com' }, job: { title: 'Paralegal - $28/hr', workplace: 'onsite' } }));
    assert.match(legal.bodyText, /One thing up front: we place legal admins, not paralegals, and they work remotely from Latin America or the Philippines\. If the admin side of this seat can be done remotely, we can put a full-time person on it for \$12 to \$14 an hour\./);
    assert.match(legal.bodyText, /take over intake calls on your script, court dates and deadlines on your calendar, and time entry for billing\./);
    assert.match(legal.followupBodies[2], /They sign a confidentiality agreement, work under your data policies and see only the systems you give them access to\./);
    assert.match(legal.followupBodies[4], /full-time remote legal admin/);
    const firm = hiringDripCopy(card('f', { family: 'support', company: { name: 'Henkels & Baker Law', domain: 'f.com' }, job: { title: 'Receptionist (remote)', workplace: 'remote' } }));
    assert.match(firm.bodyText, /take over intake calls on your script/, 'a law firm hears the law page tasks whatever the seat');
    const part = hiringDripCopy(card('p', { family: 'scheduling', job: { title: 'Part-Time Scheduling Coordinator', workplace: 'remote' } }));
    assert.match(part.bodyText, /You listed it as part-time, and our hires are full-time, so this fits if there's a full week of work to give them\./);
});

test('the price: never to an offshore post or one paying our rate or less, their number only when the gap is worth reading', () => {
    const offshore = hiringDripCopy(card('d', { job: { title: 'Virtual Executive Assistant - $4-$9/hr (PH-based)', workplace: 'remote', restrictions: { offshore: 'Philippines' } } }));
    assert.doesNotMatch(offshore.bodyText + Object.values(offshore.followupBodies).join(''), /\$1[24]|listed at/, 'an offshore post never hears a higher number');
    assert.match(offshore.bodyText, /Your post is open to someone outside the US, and that's who we place: full-time remote hires from Latin America or the Philippines\./);
    const low = hiringDripCopy(card('w', { job: { title: 'Admin Assistant - $12/hr', workplace: 'remote' } }));
    assert.doesNotMatch(low.bodyText, /\$1[24]|listed at/);
    assert.match(low.bodyText, /from Latin America or the Philippines\. They'd work only for you/);
    const near = hiringDripCopy(card('b', { job: { title: 'Intake Coordinator - $15/hr', workplace: 'remote' } }));
    assert.doesNotMatch(near.bodyText, /listed at/, 'no comparison when theirs is close to ours');
    assert.match(near.bodyText, /for \$12 to \$14 an hour\./);
    const none = hiringDripCopy(card('e', { job: { title: 'Dispatcher- (OVERTIME)', workplace: 'remote' } }));
    assert.match(none.bodyText, /^Hi Denise,\n\nI saw the Dispatcher job you posted\. Is it still open\?\n\nIf so, we can fill it with a full-time remote hire from Latin America or the Philippines for \$12 to \$14 an hour\./);
    const video = hiringDripCopy(card('v', { family: 'video', company: { name: 'Reel Co', domain: 'v.com' }, job: { title: 'Video Editor - $30/hr', workplace: 'remote' } }));
    assert.doesNotMatch(video.bodyText, /listed at/, 'a video seat is never compared to a US wage (copy rule 7)');
    assert.match(video.bodyText, /take over your short-form and YouTube edits/);
    assert.match(hiringDripCopy(card('y', { job: { title: 'Office Assistant (Immigration Law) - From $25 an hour' } })).bodyText, /listed at \$25 an hour and up\./);
    const unknown = hiringDripCopy(card('u', { company: { name: 'Bayside HVAC', domain: 'u.com' }, job: { title: '' }, family: 'nope' }));
    assert.equal(unknown.subject, 'Your open role');
    assert.match(unknown.bodyText, /I saw the job you posted\. Is it still open\?/);
    assert.match(unknown.bodyText, /They'd work only for you, on your hours\.\n\n/);
});

test('the posting date only when the post itself states it', () => {
    assert.equal(postedDay(card('a', { job: { source: 'provided', postedAt: '2026-10-30T15:00:00Z' }, lead: { posting_date: 'Posted 2026-10-26' } })), 'Oct 26');
    assert.equal(postedDay(card('a', { job: { source: 'provided', postedAt: '2026-10-30T15:00:00Z' }, lead: { posting_date: '46266.0' } })), 'Sep 1', 'an Excel serial is the date it stands for');
    assert.equal(postedDay(card('a', { job: { source: 'provided', postedAt: '2026-10-30T15:00:00Z' }, lead: { posting_date: 'within the last week' } })), null, 'never the import time');
    assert.equal(postedDay(card('a', { job: { source: 'google_jobs', postedAt: '2026-10-27T15:00:00Z' } })), null, 'a Google age label is not a date');
    assert.equal(postedDay(card('a', { job: { source: 'ats', postedAt: '2026-10-20T15:00:00Z' } })), 'Oct 20');
});

test('posted pay: only dollar amounts, in the unit the post states; quoted back only when well above our rate', () => {
    const cases = [
        ['Experienced Remote Paralegal ($2.0K-$2.2K/wk)', '$2,000 to $2,200 a week', 50],
        ['Scheduler - $23 - $27 an hour', '$23 to $27 an hour', 23],
        ['Corporate Paralegal - Fully Remote, from $60k', '$60K a year and up', 60000 / 2080],
        ['Inside Sales Representative – New Business | $50–60K Base + Uncapped Commission', '$50K to $60K a year', 50000 / 2080],
        ['Office Assistant (Immigration Law) - From $25 an hour', '$25 an hour and up', 25],
        ['Executive / Personal Assistant to the agency owner (HYBRID, $35K-$40K)', '$35K to $40K a year', 35000 / 2080],
        ['Appointment Setter (Automotive AI) - $75-$150/day', '$75 to $150 a day', 75 / 8],
        ['Client Intake Specialist (Remote in Pennsylvania, $37,440-$43,000/yr)', '$37K to $43K a year', 37440 / 2080],
        ['Telemarketer - State Farm Agent Team Member - $31,000 - $55,000 a year', '$31K to $55K a year', 31000 / 2080],
        ['Bilingual Registered Paralegal (remote, part-time 20-30 hrs/wk, $30-$40/hr)', '$30 to $40 an hour', 30],
        ['Intake Coordinator - $15.00/hr - $20.00/hr', '$15 an hour', 15],
        ['Appointment Setter - $5K-$7K/mo', '$5,000 to $7,000 a month', 5000 * 12 / 2080],
        ['Executive Assistant - PHP 35K-45K/mo', null, null],
    ];
    for (const [t, phrase, hourly] of cases) {
        const p = postedPay(t);
        assert.equal(payPhrase(p), phrase, t);
        if (hourly == null) assert.equal(hourlyOf(p), null); else assert.ok(Math.abs(hourlyOf(p) - hourly) < 0.01, t);
    }
});

test('role and company read as people say them', () => {
    assert.equal(dripRole('Experienced Remote Paralegal ($2.0K-$2.2K/wk)'), 'Paralegal');
    assert.equal(dripRole('Executive Assistant to President (QuickBooks) - $54.1k-$80k/yr'), 'Executive Assistant');
    assert.equal(dripRole('Telemarketer - State Farm Agent Team Member - $31,000 - $55,000 a year'), 'Telemarketer');
    assert.equal(dripRole('Part-Time Weekend Remote CSR - $18-$23/hr'), 'CSR');
    assert.equal(dripCompany('Aaron Services (Aaron Plumbing Inc)'), 'Aaron Services');
    assert.equal(dripCompany('Rowland Pest Management, Inc.'), 'Rowland Pest Management');
    assert.equal(dripCompany('Henkels & Baker, PC'), 'Henkels & Baker');
    assert.equal(dripCompany('Reynolds Insurance Agency LLC (Farmers Insurance)'), 'Reynolds Insurance Agency');
    assert.equal(dripCompany('Farmers Insurance - Alan Bradshaw'), 'Alan Bradshaw');
    assert.equal(dripCompany('Allstate - D & W Agency'), 'D & W Agency');
    assert.equal(dripCompany('CTIconnect, LLC.'), 'CTIconnect');
    assert.equal(dripCompany("Fann's Air Conditioning and Heating Co., LLC"), "Fann's Air Conditioning and Heating");
    assert.equal(dripCompany('Kimberly Shurtleff - State Farm Agent'), 'Kimberly Shurtleff');
    assert.equal(dripCompany('INNOVATE PHYSICAL & OCCUPATIONAL THERAPY'), 'Innovate Physical & Occupational Therapy');
    assert.equal(dripRole('Part Time and Weekend Paralegal (remote, US; Florida preferred; $25-$37/hr)'), 'Paralegal');
    assert.equal(dripRole('Patient Coordinator / RECEPTIONIST'), 'Patient Coordinator and Receptionist');
    assert.equal(dripRole('HVAC CSR'), 'HVAC CSR');
});

test('the card stops the drip: a conversation, a booking, a closed card or posting, a hold that doubts the person', () => {
    assert.equal(hiringDripStop(card('a')), null);
    assert.equal(hiringDripStop(card('a', { callOutcome: 'no_answer' })), null, 'a missed call keeps the emails going');
    assert.equal(hiringDripStop(card('a', { callOutcome: 'gatekeeper' })), null);
    assert.match(hiringDripStop(card('a', { job: { title: 'Front Desk Medical Receptionist', workplace: 'onsite' } })), /front desk/);
    assert.match(hiringDripStop(card('a', { job: { title: 'Dental Receptionist' } })), /front desk/);
    assert.equal(hiringDripStop(card('a', { job: { title: 'Virtual Receptionist' } })), null, 'a remote front desk is ours');
    assert.equal(hiringDripStop(card('a', { job: { title: 'Receptionist', workplace: 'remote' } })), null);
    assert.match(hiringDripStop(card('a', { job: { title: 'Account Manager - Fully Remote - US', restrictions: { soft: ['asks for US-based applicants'] } } })), /US-based/);
    assert.equal(hiringDripStop(card('a', { status: 'research', hold: { reason: 'main_line_only' } })), null, 'a card waiting on a cell can still be emailed');
    assert.match(hiringDripStop(card('a', { status: 'research', hold: { reason: 'owner_unconfirmed' } })), /held/);
    assert.match(hiringDripStop(card('a', { status: 'conversation', callOutcome: 'connected' })), /conversation/);
    assert.match(hiringDripStop(card('a', { callOutcome: 'no_answer', callHistory: [{ outcome: 'callback' }, { outcome: 'no_answer' }] })), /spoke/);
    assert.match(hiringDripStop(card('a', { booking: { at: 'x' } })), /booked/);
    assert.match(hiringDripStop(card('a', { status: 'suppressed' })), /suppressed/);
    assert.match(hiringDripStop(card('a', { status: 'excluded' })), /excluded/);
    assert.match(hiringDripStop(card('a', { job: { title: 'X', state: 'closed' } })), /closed/);
    assert.match(hiringDripStop(card('a', { contact: { firstName: 'Denise', status: 'not_found' } })), /No verified owner email/);
    assert.match(hiringDripStop(card('a', { contact: { firstName: 'Denise', email: 'd@x.com', status: 'unconfirmed' } })), /No verified owner email/);
    assert.match(hiringDripStop(null), /gone/);
});

test('the first email waits a day after a call; follow-ups and drafted emails do not', () => {
    const now = Date.parse('2026-10-30T18:00:00Z');
    const called = card('a', { callHistory: [{ outcome: 'no_answer', at: '2026-10-30T14:51:00Z' }] });
    assert.match(dripWait(called, { sentTouches: 0 }, now), /waits/);
    assert.equal(dripWait(called, { sentTouches: 0 }, now + 21 * 3600e3), null, 'a day later it goes');
    assert.equal(dripWait(called, { sentTouches: 1 }, now), null, 'a follow-up is not held');
    assert.equal(dripWait(called, { sentTouches: 0, draftId: 'd' }, now), null, 'a saved draft is never stranded in a hold');
    assert.equal(dripWait(card('b'), { sentTouches: 0 }, now), null, 'never called');
});

test('review fixes, 2026-10-30: dates, cities, offshore, part-time, legal seats, bonuses, role names, US-only posts', () => {
    const at = (posting_date, source = 'provided') => postedDay(card('a', { job: { source, postedAt: '2026-10-30T15:00:00Z' }, lead: { posting_date } }));
    assert.equal(at('Posted 2026-10-26'), 'Oct 26');
    for (const seen of ['Active on Indeed as of 2026-10-26', 'No post date shown on IdealTraits; live/accepting applications 2026-10-27', 'Posted within 3 days (Indeed, pulled 2026-10-28)', "~2026-10-24 (Remote Rocketship: '2 days ago')", 'Not displayed (live on Indeed search 2026-10-26)'])
        assert.equal(at(seen), null, 'a date our researcher saw it live is not the date they posted it: ' + seen);
    const body = over => hiringDripCopy(card('z', { company: { name: 'Bayside HVAC', domain: 'z.com' }, family: 'support', ...over })).bodyText;
    assert.match(body({ job: { title: 'CSR', city: 'Calabasas (role based in Fresno)', workplace: 'remote' } }), /I saw the CSR job you posted in Calabasas\. Is it still open\?/);
    assert.match(body({ job: { title: 'CSR', city: 'Austin/Dallas', workplace: 'remote' } }), /you posted in Austin\. /);
    assert.match(body({ job: { title: 'CSR', city: 'Remote (US)', workplace: 'remote' } }), /I saw the CSR job you posted\. /);
    for (const t of ['Legal Executive Assistant, Mandarin/English - fully remote (Asia)', 'Intake Specialist, Bilingual English-Arabic - remote (Egypt/Lebanon)'])
        assert.doesNotMatch(body({ job: { title: t, workplace: 'remote' } }), /\$1[24]/, 'an offshore post never hears our price: ' + t);
    assert.match(body({ job: { title: 'Office Manager - Albuquerque, New Mexico', workplace: 'remote' } }), /\$12 to \$14/, 'New Mexico is in the US');
    const PART = /You listed it as part-time/;
    assert.match(body({ job: { title: 'Customer Service Rep (PT)', workplace: 'remote' } }), PART);
    for (const t of ['Customer Service Rep (FT/PT)', 'Customer Service Rep (full or part time)', 'Part-Time to Full-Time CSR']) assert.doesNotMatch(body({ job: { title: t, workplace: 'remote' } }), PART, t);
    const legal = hiringDripCopy(card('l', { job: { title: 'Paralegal - $28/hr', workplace: 'onsite' } }));
    assert.match(legal.followupBodies[2], /We place legal admins, not paralegals, and here's how we screen them\./, 'a thread moved from the older copy still hears it');
    assert.match(legal.followupBodies[2], /If you're still filling the Paralegal job, would you mind/);
    assert.match(legal.followupBodies[3], /If you're still filling the Paralegal job, pick a time and I'll walk you through what a legal admin could take off it\./);
    assert.equal(postedPay('Executive Assistant - $500 sign-on bonus'), null);
    assert.equal(payPhrase(postedPay('CSR - $18/hr + $500 bonus')), '$18 an hour');
    assert.doesNotMatch(body({ job: { title: 'Executive Assistant - $500 sign-on bonus', workplace: 'remote' } }), /listed at/);
    for (const [t, r] of [['Customer Support Representative- Mandarin Speaking', 'Customer Support Representative'], ['Telemarketer w/career growth opportunities! - $40,000 a year', 'Telemarketer'], ['Bilingual Telemarketer: English-Spanish - $15 - $16 an hour', 'Bilingual Telemarketer'], ['Work from Home Customer Service Coordinator-Card Account Servicing', 'Customer Service Coordinator'], ['Medical College of Wisconsin is hiring: Senior Administrative Assistant', 'Senior Administrative Assistant'], ['Home Care Case Coordinator / Scheduler Portuguese Speaking', 'Home Care Case Coordinator and Scheduler'], ['Front-Desk Receptionist', 'Front-Desk Receptionist'], ['Remote Legal Assistant / Entry-Level Paralegal - Remote in Florida, $20-$30/hr', 'Legal Assistant and Entry-Level Paralegal']])
        assert.equal(dripRole(t), r, t);
    for (const t of ['Foreclosure Litigation Paralegal (100% remote, FL/IL residents, part-time 20 hrs/wk, $24-$32/hr)', 'Social Security Disability Case Manager Paralegal - fully remote (anywhere US), $44k-$46k', 'Part-Time Intake Specialist (remote in Texas, $25-$30/hr)', 'Paralegal (Remote in Pennsylvania)', 'Legal Assistant (remote, Texas)', 'CSR - US only'])
        assert.match(hiringDripStop(card('u', { job: { title: t } })), /US-based/, t);
    for (const t of ['Customer Service Rep (Remote)', 'Executive Assistant - remote, $25/hr', 'Virtual Receptionist']) assert.equal(hiringDripStop(card('u', { job: { title: t } })), null, t);
    assert.match(hiringDripStop(card('k', { job: { title: 'Front Desk - $37k-$55k/yr', workplace: 'remote' }, lead: { notes: 'Role not confirmed remote (Remote Type: No)' } })), /front desk/, 'the doubted remote tag is doubted here too');
});

test('the call gap: a call in progress counts, and a first email drafted before a call waits at the send', () => {
    const now = Date.parse('2026-11-02T14:00:00Z');
    const fresh = card('a');
    assert.equal(dripWait(fresh, { sentTouches: 0 }, now), null);
    assert.match(dripWait(fresh, { sentTouches: 0 }, now, { heldAt: now - 2 * 60000 }), /waits/, 'Call now tapped two minutes ago');
    const called = card('b', { callHistory: [{ outcome: 'voicemail', at: '2026-11-02T13:02:00Z' }] });
    assert.match(sendWait(called, { sentTouches: 0, draftId: 'd' }, now), /waits/, 'drafted overnight, called at 9:02');
    assert.equal(sendWait(called, { sentTouches: 1, draftId: 'd' }, now), null, 'follow-ups are not held');
    assert.equal(sendWait(called, { sentTouches: 0, draftId: 'd' }, now + 24 * 3600e3), null, 'a day later it goes');
});

test('older copy is never drafted: a held row with nothing written gets the whole new sequence', () => {
    const c = card('h', { company: { name: 'Bayside HVAC', domain: 'h.com' }, family: 'support', job: { title: 'CSR - $20/hr', workplace: 'remote' } });
    const old = { campaignId: HIRING_DRIP_ID, hiringId: c.id, owner: 'Paul', copyVersion: 'hiring-now-2026-10-30-kick-rocks-link', subject: 'Is the CSR role still open?', bodyText: 'someone amazing for $14 an hour\nOne click works too: https://www.gostaffify.com/kick-rocks/?t=x', followupBodies: { 2: 'o2', 3: 'o3', 4: 'o4' } };
    const state = { records: [{ ...old, id: 'held', status: 'crm_hold', sentTouches: 0 }, { ...old, id: 'creating', status: 'draft_creation_pending', sentTouches: 0 }, { ...old, id: 'uncertain', status: 'draft_creation_uncertain_hold', sentTouches: 0 }] };
    assert.equal(refreshDripCopy(state, new Map([[c.id, c]])), 3);
    const by = id => state.records.find(r => r.id === id);
    assert.equal(by('held').subject, 'Your CSR hire'); assert.match(by('held').bodyText, /\$12 to \$14 an hour/); assert.doesNotMatch(by('held').bodyText, /One click|kick-rocks\//);
    for (const id of ['creating', 'uncertain']) assert.equal(by(id).bodyText, old.bodyText, 'a Gmail draft may already exist: ' + id);
    for (const r of state.records) assert.equal(r.copyVersion, COPY_VERSION);
});

test('candidates: callable first, one per person and per company, never someone the queue already tracks', () => {
    const state = { ...emptyState(), records: [{ id: 'x', recipient: 'denise@tracked.com', campaignId: 'staffify-talent-network-outreach' }, { id: 'y', hiringId: 'hire:done000000000000', recipient: 'z@z.com' }], suppressions: ['denise@stop.com'], assignments: [{ email: 'denise@mad.com', owner: 'Trey' }] };
    const cards = [
        card('held', { status: 'research', hold: { reason: 'toll_free_only' }, createdAt: '2026-10-30T00:00:00Z' }), card('ok'), card('tracked'), card('stop'), card('mad'), card('done'),
        card('dupe', { company: { name: 'Same', domain: 'ok.com' } }), card('call', { callOutcome: 'connected', status: 'conversation' }),
    ];
    const { cards: picks, skipped } = dripCandidates(cards, state);
    assert.deepEqual(picks.map(c => c.id.slice(5, 9)), ['ok00', 'held']);
    assert.deepEqual(skipped['Already in the email queue'].length, 2);
    assert.ok(skipped.Suppressed && skipped['Owned by another sender'] && skipped['Company already enrolled']);
    assert.equal(dripCandidates(cards, state, { limit: 1 }).cards.length, 1);
});

test('the queue row: the least-loaded Staffify inbox, Paul’s or Madison’s, prepared and approved, its own campaign', () => {
    const drip = (sender, status, n) => ({ campaignId: HIRING_DRIP_ID, sender, recipient: n + '@x.com', status });
    const records = [drip('paul@hirestaffify.com', 'prepared', 'a'), drip('paul@hirestaffify.com', 'sent', 'b'), drip('paul@staffifyhq.com', 'suppressed', 'c'), { sender: 'madison@staffifyhq.com', recipient: 'd@d.com', status: 'prepared' },
        ...Array.from({ length: 30 }, (_, i) => ({ sender: 'paul@staffifyhq.com', recipient: i + '@old.com', status: 'sent', sentTouches: 2 }))];
    assert.equal(dripSender(CFG.accounts, records).email, 'paul@staffifyhq.com', 'another campaign’s sequences under way are not load; its waiting introductions are');
    assert.equal(dripSender(CFG.accounts, []).email, 'madison@staffifyhq.com', 'ties go alphabetically');
    assert.equal(dripSender(CFG.accounts, [], { owner: 'Paul' }).email, 'paul@hirestaffify.com');
    assert.throws(() => dripSender([acct('madison@staffifyhq.com', 'Madison')], [], { owner: 'Paul' }), /No Paul outreach inbox/);
    assert.throws(() => dripSender([{ ...acct('paul@tryfoundryhq.com'), brand: 'Foundry' }], []), /No Staffify outreach inbox/);
    const mad = dripRow(card('m'), { account: acct('madison@staffifyhq.com', 'Madison') });
    assert.equal(mad.owner, 'Madison'); assert.equal(mad.sender, 'madison@staffifyhq.com');
    for (const t of [mad.bodyText, mad.followupBodies[2], mad.followupBodies[3], mad.followupBodies[4]]) { assert.match(t, /\n\nMadison\nStaffify/); assert.doesNotMatch(t, /\bPaul\b/); }
    const row = dripRow(card('a'), { account: acct('paul@staffifyhq.com'), now: Date.parse('2026-10-30T15:00:00Z') });
    assert.equal(row.campaignId, HIRING_DRIP_ID); assert.equal(row.id, 'hiring-drip-a000000000000000'); assert.equal(row.hiringId, 'hire:a000000000000000');
    assert.equal(row.recipient, 'denise@a.com'); assert.equal(row.agencyKey, 'a.com'); assert.equal(row.owner, 'Paul'); assert.equal(row.status, 'prepared');
    assert.ok(inCampaign(row));
    assert.equal(eligible(row, emptyState(), Date.parse('2026-10-30T15:00:00Z')), true);
    assert.equal(followup({ ...row, sentTouches: 2 }), row.followupBodies[3]);
    assert.deepEqual(tagCampaign({ records: [row] }).campaigns.map(c => c.id), ['staffify-agency-outreach', HIRING_DRIP_ID]);
    const done = { ...row, status: 'sent', sentTouches: 4, verifiedSentTouches: 4, lastSentAt: '2026-10-01T00:00:00Z' };
    assert.equal(callReady(done, Date.parse('2026-10-30T00:00:00Z')), false, 'called from its card on the cell, never from the email queue’s phone ladder');
    assert.equal(callReady({ ...done, campaignId: 'staffify-talent-network-outreach' }, Date.parse('2026-10-30T00:00:00Z')), true);
});

test('CRM contact: the owner, verified, and a phone only when it is their own looked-up mobile', () => {
    const p = contactProps(card('a'));
    assert.deepEqual(p, { email: 'denise@a.com', firstname: 'Denise', lastname: 'Mutamba', company: 'MDM Legal, PLLC', website: 'https://a.com', jobtitle: 'Founder', city: 'Tampa', state: 'FL', country: 'United States', lifecyclestage: 'lead', rep_email_verified: 'verified' });
    assert.equal(contactProps(card('a', { phone: { number: '+15615550199', source: 'vendor', lineType: 'mobile', person: 'Denise Mutamba' } })).mobilephone, '+15615550199');
    assert.equal(contactProps(card('a', { phone: { number: '+15615550199', source: 'provided', lineType: 'main business line' } })).mobilephone, undefined);
});

const fakeCrm = (existing = {}) => {
    const calls = [];
    return { calls, find: async e => (calls.push(['find', e]), existing[e] || []), create: async p => (calls.push(['create', p.email]), { id: 'n' }), patch: async (id, p) => (calls.push(['patch', id, p]), {}) };
};

test('prepare: dry writes nothing; write makes the contact, then checks the stops; CRM conflicts are skipped', async () => {
    const crm = fakeCrm({ 'denise@bad.com': [{ id: '9', properties: { rep_email_verified: 'invalid' } }], 'denise@two.com': [{ id: '1' }, { id: '2' }], 'denise@old.com': [{ id: '7', properties: {} }] });
    const blocks = [];
    const block = async (row, o) => (blocks.push([row.recipient, o.created]), row.recipient === 'denise@client.com' ? 'Client check: client' : null);
    const cards = ['new', 'bad', 'two', 'old', 'client'].map(id => card(id));
    const dry = await prepareDripRows({ state: emptyState(), cfg: CFG, cards, crm, block, write: false });
    assert.equal(dry.rows.length, 0);
    assert.deepEqual(crm.calls.filter(c => c[0] !== 'find'), [], 'a dry run only reads');
    assert.ok(dry.results[0].preview && dry.results[0].preview.subject);
    blocks.length = 0;
    const wet = await prepareDripRows({ state: emptyState(), cfg: CFG, cards, crm, block, write: true });
    assert.deepEqual(wet.rows.map(r => r.recipient), ['denise@new.com', 'denise@old.com']);
    assert.deepEqual(wet.results.map(r => r.result), ['enroll', 'skipped', 'skipped', 'enroll', 'skipped']);
    assert.match(wet.results[1].why, /invalid/); assert.match(wet.results[2].why, /Two CRM contacts/); assert.match(wet.results[4].why, /Client check/);
    assert.deepEqual(crm.calls.filter(c => c[0] === 'create').map(c => c[1]), ['denise@new.com', 'denise@client.com']);
    assert.deepEqual(crm.calls.find(c => c[0] === 'patch'), ['patch', '7', { rep_email_verified: 'verified' }]);
    assert.deepEqual(blocks.filter(b => ['denise@new.com', 'denise@old.com'].includes(b[0])), [['denise@new.com', true], ['denise@old.com', false]], 'a new contact gets the checks that do not need it; an existing one the full CRM check');
    assert.deepEqual(new Set(wet.rows.map(r => r.sender)).size, 2, 'spread across the inboxes');
});

function fakeRedis(state, stored) {
    const db = new Map([['q', JSON.parse(JSON.stringify(state))], ['cfg', stored]]);
    return { db,
        get: async k => db.get(k) ?? null,
        set: async (k, v, o = {}) => { if (o.nx && db.has(k)) return null; db.set(k, v); return 'OK'; },
        eval: async (script, keys, args) => {
            if (/cjson/.test(script)) { const cur = db.get(keys[0]); if (!cur || cur.revision !== Number(args[0])) return 0; db.set(keys[0], JSON.parse(args[1])); return 1; }
            if (db.get(keys[0]) === args[0]) { db.delete(keys[0]); return 1; } return 0;
        } };
}

test('enrol: under the worker lock, appended with a new revision, and allow adds the campaign to the allowlist once', async () => {
    const redis = fakeRedis(emptyState(), { ...CFG });
    const deps = { redis, queueKey: 'q', config: async () => CFG, stored: async () => redis.db.get('cfg'), saveConfig: async c => redis.db.set('cfg', c), records: async () => [card('one'), card('two')], crm: fakeCrm(), block: async () => null, sleep: async () => {}, now: Date.parse('2026-10-30T15:00:00Z') };
    const dry = await enrollHiringDrip(deps, { write: false });
    assert.equal(redis.db.get('q').records.length, 0); assert.equal(dry.summary.candidates, 2);
    const out = await enrollHiringDrip(deps, { write: true, allow: true });
    assert.equal(out.summary.enrolled, 2); assert.equal(out.summary.allowed, 'added');
    assert.equal(redis.db.get('q').revision, 4); assert.equal(redis.db.get('q').records.length, 2);
    assert.deepEqual(redis.db.get('cfg').allowedCampaignIds, ['staffify-talent-network-outreach', HIRING_DRIP_ID]);
    assert.equal(redis.db.has('outreach:cloud:lock'), false, 'the lock is released');
    const again = await enrollHiringDrip(deps, { write: true, allow: true });
    assert.equal(again.summary.enrolled, 0); assert.equal(again.summary.allowed, 'already');
    redis.db.set('outreach:cloud:lock', 'worker');
    const busy = await enrollHiringDrip({ ...deps, records: async () => [card('three')] }, { write: true });
    assert.match(busy.summary.error, /stayed busy/); assert.equal(redis.db.get('q').records.length, 2);
});

test('addDripRows drops anyone tracked or suppressed since the rows were prepared', () => {
    const state = { ...emptyState(), records: [{ recipient: 'denise@one.com' }], suppressions: ['denise@two.com'] };
    const rows = ['one', 'two', 'three'].map(id => dripRow(card(id), { account: acct('paul@staffifyhq.com') }));
    assert.deepEqual(addDripRows(state, rows).map(r => r.recipient), ['denise@three.com']);
    assert.equal(state.records.length, 2);
});

test('the worker tops itself up only when switched on, a few at a time, every ten minutes at most', async () => {
    const redis = fakeRedis(emptyState(), {});
    const base = { redis, records: async () => [card('one'), card('two')], crm: fakeCrm(), block: async () => null };
    assert.deepEqual(await hiringSupply({ ...base, state: emptyState(), cfg: CFG }), { skipped: 'not allowed' });
    const on = { ...CFG, allowedCampaignIds: [...CFG.allowedCampaignIds, HIRING_DRIP_ID] };
    assert.ok(dripAllowed(on)); assert.ok(dripAllowed({})); assert.equal(dripAllowed(CFG), false);
    const state = emptyState();
    const r = await hiringSupply({ ...base, state, cfg: on, limit: 1 });
    assert.equal(r.added, 1); assert.equal(state.records.length, 1);
    assert.equal((await hiringSupply({ ...base, state, cfg: on })).rested, true, 'rests ten minutes');
    const full = { ...emptyState(), records: Array.from({ length: 10 }, (_, i) => ({ campaignId: HIRING_DRIP_ID, status: 'prepared', recipient: i + '@x.com' })) };
    assert.equal((await hiringSupply({ ...base, redis: fakeRedis(emptyState(), {}), state: full, cfg: on })).waiting, 10);
});

test('a contractor’s remote Emergency CSR / Job Dispatcher is a seat; public-safety dispatch is not', () => {
    assert.equal(roleFamily('Emergency CSR / Job Dispatcher (Remote) - $15-$21/hr'), 'support');
    for (const t of ['Emergency Dispatcher', '911 Dispatcher', 'Emergency Medical Dispatcher']) assert.equal(roleFamily(t), null, t);
});

test('rebalance: unstarted introductions spread over every inbox, signed by its owner; anything started stays put', () => {
    const accounts = [acct('paul@staffifyhq.com'), acct('paul@hirestaffify.com'), acct('madison@staffifyhq.com', 'Madison')];
    const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
    const cards = new Map(ids.concat('dr').map(id => [card(id).id, card(id)]));
    const rows = ids.map(id => dripRow(card(id), { account: acct('paul@hirestaffify.com'), now: Date.parse('2026-10-30T16:00:00Z') }));
    const drafted = { ...dripRow(card('dr'), { account: acct('paul@hirestaffify.com') }), status: 'draft_saved', draftId: 'd1' };
    const state = { ...emptyState(), records: [{ id: 'talent', recipient: 'x@x.com', sender: 'paul@staffifyhq.com', status: 'prepared' }, { id: 'old', recipient: 'o@o.com', sender: 'madison@staffifyhq.com', status: 'sent', sentTouches: 3 }, drafted, ...rows], assignments: [{ email: 'denise@r6.com', owner: 'Paul' }] };
    const moved = rebalanceDripRows(state, cards, accounts, Date.parse('2026-10-30T17:00:00Z'));
    const by = state.records.filter(r => r.id !== 'old').reduce((m, r) => (m[r.sender] = (m[r.sender] || 0) + 1, m), {});
    assert.deepEqual(Object.keys(by).sort(), ['madison@staffifyhq.com', 'paul@hirestaffify.com', 'paul@staffifyhq.com']);
    assert.ok(Math.max(...Object.values(by)) - Math.min(...Object.values(by)) <= 1, 'within one of each other: ' + JSON.stringify(by));
    assert.ok(moved >= 3);
    assert.equal(state.records.find(r => r.id === drafted.id).sender, 'paul@hirestaffify.com', 'a drafted row never moves');
    assert.equal(state.records.find(r => r.recipient === 'denise@r6.com').owner, 'Paul', 'someone assigned to Paul stays with Paul');
    for (const r of state.records.filter(r => r.sender === 'madison@staffifyhq.com' && r.id !== 'old')) { assert.equal(r.owner, 'Madison'); assert.match(r.bodyText, /Madison\nStaffify/); assert.ok(r.id.startsWith('hiring-drip-')); assert.equal(r.createdAt, '2026-10-30T16:00:00.000Z'); }
    assert.deepEqual(state.records.map(r => r.id), ['talent', 'old', drafted.id, ...rows.map(r => r.id)], 'order kept');
});
