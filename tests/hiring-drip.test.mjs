// Paul, 2026-10-29/30: "we need to be emailing and dripping emails to the folks sitting in our queue", "asking if the
// job is still available ... 'i see you have this listed for $22 an hour' we can fill this role with someone amazing for
// $14 an hour", and "never put in data for Main Line".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HIRING_DRIP_ID, hiringDripStop, postedPay, payPhrase, hourlyOf, dripRole, dripCompany, hiringDripCopy, dripCandidates, dripSender, dripRow, rebalanceDripRows } from '../api/_hiring-drip-copy.js';
import { hiringDripFollowup } from '../api/_hiring-drip-campaign.js';
import { prepareDripRows, addDripRows, enrollHiringDrip, hiringSupply, contactProps, dripAllowed } from '../api/_hiring-drip.js';
import { inCampaign, tagCampaign } from '../api/_outreach-campaign.js';
import { followup, eligible, callReady } from '../api/_outreach-policy.js';
import { roleFamily } from '../api/_hiring-intent.js';

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

test('email 1 asks if the role is open, quotes their posted rate back, offers $14 an hour and asks for the appointment', () => {
    const c = hiringDripCopy(card('a'));
    assert.equal(c.subject, 'Is the Legal Assistant role still open?');
    assert.match(c.bodyText, /^Hi Denise,\n\nIs the Legal Assistant role at MDM Legal still open\? I see you have it listed at \$22 an hour\.\n\n/);
    assert.match(c.bodyText, /someone amazing for \$14 an hour\. They work only for you, and we handle the recruiting and vetting\./);
    assert.match(c.bodyText, /Do you have 15 minutes this week\? I'll show you how it works\. Grab a time here:\nhttps:\/\/calendly\.com\/go-staffify\/discovery-call/);
    for (const text of [c.subject, c.bodyText, ...Object.values(c.followupBodies)]) {
        assert.doesNotMatch(text, /—|–|[“”’]/, 'no em or en dashes, straight quotes only');
        assert.doesNotMatch(text, /\bi\b/, 'I is always capitalised');
        assert.doesNotMatch(text, /30-day|mint/i);
        if (/guarantee/i.test(text)) assert.match(text, /lifetime replacement guarantee/, 'only the lifetime replacement guarantee');
    }
    assert.match(c.followupBodies[2], /lifetime replacement guarantee/);
    assert.match(c.followupBodies[4], /close the loop/);
    assert.equal(hiringDripFollowup({ followupBodies: c.followupBodies, sentTouches: 1 }), c.followupBodies[2]);
    assert.throws(() => hiringDripFollowup({ followupBodies: {}, sentTouches: 1 }), /follow-up missing/);
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
    const near = hiringDripCopy(card('b', { job: { title: 'Intake Coordinator - $15/hr' } }));
    assert.doesNotMatch(near.bodyText, /I see you have it listed/, 'no comparison when theirs is close to ours');
    assert.match(near.bodyText, /someone amazing for \$14 an hour/);
    const yearly = hiringDripCopy(card('c', { job: { title: 'Customer Service Representative - $50k-$65k' } }));
    assert.match(yearly.bodyText, /listed at \$50K to \$65K a year\.\n\nWe can fill it with someone amazing for \$14 an hour \(about \$29K a year, full time\)/);
    const offshore = hiringDripCopy(card('d', { job: { title: 'Virtual Executive Assistant - $4-$9/hr (PH-based)' } }));
    assert.doesNotMatch(offshore.bodyText + offshore.followupBodies[3], /\$14/, 'an offshore post at or under our rate never hears a higher number');
    assert.match(hiringDripCopy(card('f', { job: { title: 'Office Assistant (Immigration Law) - From $25 an hour' } })).bodyText, /I see you have it listed at \$25 an hour and up\./);
    const none = hiringDripCopy(card('e', { job: { title: 'Dispatcher- (OVERTIME)' } }));
    assert.match(none.bodyText, /Is the Dispatcher role at MDM Legal still open\?\n\nWe can fill it/);
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
    const own = hiringDripCopy(card('g', { company: { name: 'Law Office of Denise M. Mutamba', domain: 'g.com' } }));
    assert.match(own.bodyText, /Is the Legal Assistant role still open\?/, 'their own name is not read back to them as the company');
});

test('the card stops the drip: a conversation, a booking, a closed card or posting, a hold that doubts the person', () => {
    assert.equal(hiringDripStop(card('a')), null);
    assert.equal(hiringDripStop(card('a', { callOutcome: 'no_answer' })), null, 'a missed call keeps the emails going');
    assert.equal(hiringDripStop(card('a', { callOutcome: 'gatekeeper' })), null);
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
    const records = [{ sender: 'paul@hirestaffify.com', recipient: 'a@a.com', status: 'prepared' }, { sender: 'paul@hirestaffify.com', recipient: 'b@b.com', status: 'sent' }, { sender: 'paul@staffifyhq.com', recipient: 'c@c.com', status: 'suppressed' }, { sender: 'madison@staffifyhq.com', recipient: 'd@d.com', status: 'prepared' }];
    assert.equal(dripSender(CFG.accounts, records).email, 'paul@staffifyhq.com');
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
    const state = { ...emptyState(), records: [{ id: 'talent', recipient: 'x@x.com', sender: 'paul@staffifyhq.com', status: 'prepared' }, drafted, ...rows], assignments: [{ email: 'denise@r6.com', owner: 'Paul' }] };
    const moved = rebalanceDripRows(state, cards, accounts, Date.parse('2026-10-30T17:00:00Z'));
    const by = state.records.reduce((m, r) => (m[r.sender] = (m[r.sender] || 0) + 1, m), {});
    assert.deepEqual(Object.keys(by).sort(), ['madison@staffifyhq.com', 'paul@hirestaffify.com', 'paul@staffifyhq.com']);
    assert.ok(Math.max(...Object.values(by)) - Math.min(...Object.values(by)) <= 1, 'within one of each other: ' + JSON.stringify(by));
    assert.ok(moved >= 3);
    assert.equal(state.records.find(r => r.id === drafted.id).sender, 'paul@hirestaffify.com', 'a drafted row never moves');
    assert.equal(state.records.find(r => r.recipient === 'denise@r6.com').owner, 'Paul', 'someone assigned to Paul stays with Paul');
    for (const r of state.records.filter(r => r.sender === 'madison@staffifyhq.com')) { assert.equal(r.owner, 'Madison'); assert.match(r.bodyText, /Madison\nStaffify/); assert.ok(r.id.startsWith('hiring-drip-')); assert.equal(r.createdAt, '2026-10-30T16:00:00.000Z'); }
    assert.deepEqual(state.records.map(r => r.id), ['talent', drafted.id, ...rows.map(r => r.id)], 'order kept');
});
