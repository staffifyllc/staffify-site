// Paul, 2026-10-30: "I need to create an agent who will go and get lists like maddie has all day every day".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToken, agentAuthorized, knownIndex, knownWhy, leadProblem, capLookup, remember, agentProfile, phoneCheck, rememberLines, lineProof, provenCell, provenPhone, carrierLookup } from '../api/_lead-agent.js';
import { qualifyLead, tollFree } from '../api/_hiring-intent.js';
import { cellMatch } from '../api/_hiring-run.js';

test('the agent\'s key: its own setting, else derived from the cron secret; anything else is refused', () => {
    const env = { CRON_SECRET: 'cron' };
    const key = agentToken(env);
    assert.equal(key.length, 48); assert.notEqual(key, 'cron');
    assert.equal(agentAuthorized({ headers: { authorization: 'Bearer ' + key } }, env), true);
    assert.equal(agentAuthorized({ headers: { authorization: 'Bearer cron' } }, env), false, 'the cron secret itself does not open this door');
    assert.equal(agentAuthorized({ headers: {} }, env), false);
    assert.equal(agentToken({ LEAD_AGENT_TOKEN: 'set', CRON_SECRET: 'cron' }), 'set');
    assert.equal(agentAuthorized({ headers: { authorization: 'Bearer x' } }, {}), false, 'no secret configured: closed');
});

const deps = {
    cards: async () => [{ status: 'ready', company: { name: 'Rowland Pest Management, Inc.', domain: 'rowlandpest.com' }, phone: { number: '+14077597335', alternates: ['+15613633227'] }, contact: { email: 'chris@rowlandpest.com' } }],
    pending: async () => [{ lead: { business: 'Shugarman\'s Bath', website: 'https://shugarmansbath.com', phone: '419-779-5529', owner_email: 'chase@shugarmansbath.com' } }],
    queue: async () => ({ records: [{ recipient: 'ravi@roverpass.com', company: 'RoverPass' }, { recipient: 'someone@gmail.com', company: 'Gmail Person LLC' }] }),
    stops: async () => ({ emails: new Set(['jjohnson10@farmersagent.com']), numbers: new Set(['5072873276']) }),
};

test('known: a card, a waiting lead, the email queue and the stop list, by name, domain, number or address', async () => {
    const idx = await knownIndex(deps);
    assert.match(knownWhy(idx, { company: 'Rowland Pest Management' }), /Hiring now card/);
    assert.match(knownWhy(idx, { website: 'https://www.rowlandpest.com/contact' }), /Hiring now card/);
    assert.match(knownWhy(idx, { phone: '(561) 363-3227' }), /Hiring now card/, 'a backup number counts');
    assert.match(knownWhy(idx, { company: "Shugarman's Bath" }), /waiting/);
    assert.match(knownWhy(idx, { domain: 'roverpass.com' }), /email campaign/);
    assert.equal(knownWhy(idx, { domain: 'gmail.com' }), null, 'a free mail domain is nobody\'s company');
    assert.match(knownWhy(idx, { email: 'JJohnson10@farmersagent.com' }), /do-not-contact/);
    assert.match(knownWhy(idx, { phone: '507-287-3276' }), /do-not-contact/);
    assert.equal(knownWhy(idx, { company: 'Brand New Plumbing', website: 'https://newplumbing.com', phone: '6155550100', email: 'owner@newplumbing.com' }), null);
});

const lead = over => ({ owner_first: 'Dana', owner_last: 'Reyes', owner_title: 'Owner', business: 'Brand New Plumbing', city: 'Nashville', state: 'TN', website: 'https://newplumbing.com', owner_email: 'dana@newplumbing.com',
    phone: '+16155550100', phone_type: "mobile (the owner's own cell, RocketReach grade A)", role_posted: 'Customer Service Representative (Remote) - $18-$22/hr', posting_url: 'https://www.ziprecruiter.com/job/abc', posting_date: 'Posted 2026-10-29', notes: 'Family owned.', vertical: 'lead agent: ziprecruiter', ...over });

test('submit refuses what the agent was told never to send: no cell, a main line, toll-free, no email, a seat we do not fill, a stale post, a known company', async () => {
    const idx = await knownIndex(deps);
    const now = Date.parse('2026-10-30T18:00:00Z');
    const RR = { by: 'rocketreach', type: 'mobile', grade: 'A', valid: true, person: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN' };
    const ownerMatch = (l, p) => cellMatch({ company: { name: l.business, domain: 'newplumbing.com' }, contact: { name: [l.owner_first, l.owner_last].join(' ') }, job: { usState: l.state } }, { name: p.person, employer: p.employer, employerDomain: p.employerDomain, title: p.title, region: p.region, location: p.location });
    const why = (l, proof = RR, freeCells = true) => leadProblem(l, { idx, qualify: qualifyLead, tollFree, proof, match: ownerMatch, freeCells, now });
    const CAR = { by: 'carrier', type: 'mobile', carrier: 'Verizon Wireless', at: '2026-10-30T17:00:00Z' };
    const site = { phone_source_url: 'https://newplumbing.com/about', phone_evidence: 'Call or text Dana Reyes, owner: (615) 555-0100' };
    assert.equal(why(lead()), null);
    // The agent's word is not proof, and its own main-line label always stands (Paul: never a main line).
    assert.match(why(lead(), null), /not proven a cell/);
    // Paul, 2026-10-30: the business's own published line is called ("Yes, use RocketReach on fails"): no lookup, no
    // proof, but the business's own website so the Hub can check the number against it.
    for (const t of ['business line', 'main business line', 'Main line', 'office number', 'company phone']) assert.equal(why(lead({ phone_type: t }), null), null, t);
    assert.match(why(lead({ phone_type: 'business line', website: null }), null), /needs the business's own website/);
    assert.match(why(lead({ phone_type: 'business line', phone: '888-555-0100' }), null), /toll-free/);
    assert.match(why(lead({ phone_type: 'work' })), /must say "business line"/);
    assert.equal(why(lead({ phone_type: "mobile (owner's own cell, not the main line)" })), null, 'a cell label that mentions the main line only to deny it');
    assert.equal(why(lead({ phone_type: 'cellphone' })), null);
    // The free path stays off until switched on: a carrier's answer alone proves nothing at the door.
    assert.match(why(lead({ phone_source_url: 'https://newplumbing.com/about', phone_evidence: 'Call or text Dana Reyes, owner: (615) 555-0100' }), { by: 'carrier', type: 'mobile', carrier: 'Verizon Wireless', at: '2026-10-30T17:00:00Z' }, false), /free path is off/);
    assert.match(why(lead({ phone: '615-555-0100 (front desk)' })), /main line/);
    assert.match(why(lead({ ...site, phone_evidence: 'Office line: 615-555-0100 (Dana Reyes)' }), CAR), /main line/);
    assert.match(why(lead({ phone_type: 'mobile' }), { by: 'carrier', type: 'landline', carrier: 'AT&T', at: CAR.at }), /the carrier says this number is landline \(AT&T\), not a proven cell/);
    assert.match(why(lead(), { by: 'carrier', type: 'nonfixedvoip', carrier: 'Twilio', at: CAR.at }), /not a proven cell/);
    assert.match(why(lead(), { by: 'carrier', type: 'mobile', carrier: '', at: CAR.at }), /did not name itself/, 'a carrier that does not name itself proves nothing');
    assert.match(why(lead(), { ...RR, type: 'professional' }), /did not list this number as a mobile/);
    assert.match(why(lead(), { ...RR, valid: false }), /invalid/);
    assert.match(why(lead(), { ...RR, carrierType: 'landline' }), /the carrier says this number is landline/);
    // A carrier proves the line is a cell, never whose it is: the page must put it beside the owner's name.
    assert.match(why(lead(), CAR), /phone_source_url is required/);
    assert.match(why(lead({ phone_source_url: site.phone_source_url }), CAR), /phone_evidence is required/);
    assert.match(why(lead({ ...site, phone_evidence: 'Call us: (615) 555-0100' }), CAR), /phone_evidence is required/, 'the business line with no owner beside it');
    assert.match(why(lead({ ...site, phone_evidence: 'Dana Reyes, owner. Call 615-555-0199' }), CAR), /phone_evidence is required/, 'another number');
    assert.equal(why(lead(site), CAR), null);
    assert.match(why(lead(site), { ...CAR, at: '2026-09-01T00:00:00Z' }), /over 30 days ago/);
    // A lookup's number is the person RocketReach found: this owner, at this business.
    assert.match(why(lead(), { ...RR, person: 'Zed Other', employer: 'Other Co', employerDomain: 'other.com', region: 'CA' }), /not this owner's: RocketReach found Zed Other, not Dana Reyes/);
    assert.match(why(lead(), { ...RR, employer: 'Acme Roofing', employerDomain: 'acmeroof.com' }), /not this owner's: Dana Reyes works at Acme Roofing/);
    assert.match(why(lead({ phone: '888-555-0100' })), /toll-free/);
    assert.equal(why(lead({ owner_email: null })), null, 'an email is welcome, not required');
    assert.match(why(lead({ owner_email: 'not-an-address' })), /not a valid address/);
    assert.match(why(lead({ owner_first: null })), /named owner/);
    assert.match(why(lead({ posting_url: 'ziprecruiter.com/job/abc' })), /https/);
    assert.match(why(lead({ role_posted: 'Marketing Coordinator - $20/hr' })), /refused by the Hub rules: role_not_fillable/);
    assert.match(why(lead({ posting_date: 'Posted 2026-09-20' })), /stale_post/);
    assert.match(why(lead({ business: 'Rowland Pest Management' })), /already known/);
    remember(idx, lead());
    assert.match(why(lead({ owner_email: 'other@x.com', phone: '6155550199', business: 'Brand New Plumbing LLC' })), /submitted earlier in this batch/);
});

function lineKv() {
    const m = new Map();
    return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; }, async del(k) { m.delete(k); return 1; }, async incr(k) { m.set(k, (m.get(k) || 0) + 1); return m.get(k); }, async decr(k) { m.set(k, (m.get(k) || 0) - 1); return m.get(k); }, async expire() { return 1; } };
}

test('third check: whole names, the very number, plain office wording, the Hub\'s own owner test, and RocketReach and carrier together', async () => {
    const { ownerMatch } = await import('../api/lead-agent.js');
    const idx = await knownIndex(deps);
    const now = Date.parse('2026-10-30T18:00:00Z');
    const CAR = { by: 'carrier', type: 'mobile', carrier: 'Verizon Wireless', at: '2026-10-30T17:00:00Z' };
    const why = (l, proof) => leadProblem(l, { idx, qualify: qualifyLead, tollFree, proof, match: (x, p) => ownerMatch(x, p, now), freeCells: true, now });
    const page = (over) => lead({ phone_source_url: 'https://newplumbing.com/about', ...over });
    // The owner's name as a whole word, the last name when there is one.
    assert.match(why(page({ owner_first: 'Pat', owner_last: 'Quinlan', phone_evidence: 'New patients: text Sarah at (615) 555-0100' }), CAR), /phone_evidence/);
    assert.match(why(page({ owner_first: 'Will', owner_last: 'Jones', phone_evidence: 'Text Sarah at 615-555-0100 and she will get back to you' }), CAR), /phone_evidence/);
    assert.match(why(page({ phone_evidence: 'Dana (office manager) 615-555-0100' }), CAR), /main line|phone_evidence/);
    // The number itself, never digits strung across a year or an address.
    assert.match(why(page({ phone: '+16155552026', phone_evidence: 'Dana Reyes, owner. Text 615-555-0100. (c) 2026' }), CAR), /phone_evidence/);
    assert.match(why(page({ phone: '+16155550012', phone_evidence: 'Dana Reyes, 100 Elm Ave Suite 12, cell 615-555-0199' }), CAR), /phone_evidence/);
    assert.equal(why(page({ phone_evidence: 'Dana Reyes, 210 Main St. Cell: (615) 555-0100' }), CAR), null, 'a street called Main is not a main line');
    // Plain office wording, and a label that is not a cell.
    assert.match(why(page({ phone_evidence: 'Dana Reyes, Owner | Office: (615) 555-0100' }), CAR), /main line/);
    assert.match(why(page({ phone_type: 'work', phone_evidence: 'Cell: Dana Reyes (615) 555-0100' }), CAR), /must say "business line"/);
    // RocketReach: the Hub's own owner test, with the state and the Hub's domain rules.
    const kv = lineKv();
    const lookup = async (profile) => capLookup({ kv, rr: { account: acct(500), lookupPerson: async () => ({ found: true, profile }) }, day: 'd' }, { id: 1 });
    await lookup({ id: 1, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TX', location: 'Greater Houston Area', phones: [{ number: '+16155550100', type: 'mobile', grade: 'A', valid: true }] });
    assert.match(why(lead(), await lineProof(kv, '6155550100')), /Dana Reyes is in TX, the job is in TN/);
    await lookup({ id: 2, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: null, location: null, phones: [{ number: '+16155550101', type: 'mobile', grade: 'A', valid: true }] });
    assert.match(why(lead({ phone: '+16155550101' }), await lineProof(kv, '6155550101')), /no state/);
    await lookup({ id: 3, name: 'John Smith', title: 'Claims Adjuster', employer: 'State Farm', employerDomain: 'statefarm.com', region: 'TX', phones: [{ number: '+15125550100', type: 'mobile', grade: 'A', valid: true }] });
    const sf = lead({ owner_first: 'John', owner_last: 'Smith', business: 'John Smith - State Farm Insurance Agent', website: 'https://www.statefarm.com/agent/us/tx/austin/john-smith-abc123', state: 'TX', city: 'Austin', phone: '+15125550100', owner_email: 'john@jsmithagency.com' });
    assert.match(why(sf, await lineProof(kv, '5125550100')), /not this owner's/);
    // A later "invalid" takes back an earlier lookup's proof.
    await lookup({ id: 4, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN', phones: [{ number: '+16155550102', type: 'mobile', grade: 'A', valid: null }] });
    assert.ok(await lineProof(kv, '6155550102'));
    await lookup({ id: 4, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN', phones: [{ number: '+16155550102', type: 'mobile', grade: 'A', valid: false }] });
    assert.equal(await lineProof(kv, '6155550102'), null);
    // Carrier first, then a lookup: the lookup proves it, with the carrier's answer kept.
    kv.m.set('staffify:lead-agent:line:6155550103', { ...CAR });
    await lookup({ id: 5, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN', phones: [{ number: '+16155550103', type: 'mobile', grade: 'A', valid: true }] });
    const both = await lineProof(kv, '6155550103');
    assert.equal(both.by, 'rocketreach'); assert.equal(both.carrier, 'Verizon Wireless');
    assert.equal(why(lead({ phone: '+16155550103' }), both), null);
    // RocketReach says "professional", the carrier names itself and says mobile: the carrier decides the line type.
    await lookup({ id: 6, name: 'Dana Reyes', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN', phones: [{ number: '+16155550104', type: 'professional', grade: 'A', valid: true }] });
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = '10';
    const [r] = await phoneCheck({ kv, day: 'd', tollFree, lookup: async () => ({ type: 'mobile', carrier: 'Verizon Wireless' }) }, ['6155550104'], now);
    assert.equal(r.mobile, true);
    assert.equal(why(lead({ phone: '+16155550104' }), await lineProof(kv, '6155550104')), null);
    delete process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY;
});

test('fourth check: the card\'s own state, shared hosts, brand-only ties, accents and suffixes, stale carrier answers', async () => {
    const { ownerMatch } = await import('../api/lead-agent.js');
    const { stateOf } = await import('../api/_hiring-intent.js');
    const now = Date.parse('2026-10-30T18:00:00Z');
    assert.equal(stateOf('Charleston, West Virginia, United States'), 'WV');
    assert.equal(stateOf('Kansas City, Missouri, United States'), 'MO');
    assert.equal(stateOf('Richmond, Virginia'), 'VA');
    const P = over => ({ by: 'rocketreach', type: 'mobile', valid: true, person: 'Dana Reyes', title: 'Owner', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', region: 'TN', location: 'Nashville, Tennessee', ...over });
    const m = (l, p) => ownerMatch(lead(l), P(p), now);
    assert.equal(m({}, {}).ok, true);
    // The state the Hub files the card under, even when the lead wrote it only in the city.
    assert.match(m({ state: null, city: 'Nashville, TN' }, { region: 'CA', location: 'Fresno, California' }).why, /is in CA/);
    assert.equal(m({ state: 'tn' }, {}).ok, true);
    // Accents, curly apostrophes and suffixes on either side.
    assert.equal(m({ owner_first: 'Ana', owner_last: 'García' }, { person: 'Ana Garcia' }).ok, true);
    assert.equal(m({ owner_first: 'Sean', owner_last: "O'Brien" }, { person: 'Sean O’Brien' }).ok, true);
    // A shared host ties nobody, and a brand-only tie needs an owner's title and the business's city.
    const sf = { owner_first: 'John', owner_last: 'Smith', business: 'John Smith - State Farm Insurance Agent', website: 'https://www.statefarm.com/agent/us/tx/austin/john-smith-abc123', state: 'TX', city: 'Austin' };
    assert.equal(ownerMatch(lead(sf), P({ person: 'John Smith', title: 'Claims Adjuster', employer: 'State Farm', employerDomain: 'statefarm.com', region: 'TX', location: 'Houston, Texas' }), now).ok, false);
    assert.match(ownerMatch(lead(sf), P({ person: 'John Smith', title: 'Agent', employer: 'State Farm', employerDomain: 'statefarm.com', region: 'TX', location: 'Houston, Texas' }), now).why, /is in Houston, Texas, the business is in Austin/);
    assert.equal(ownerMatch(lead(sf), P({ person: 'John Smith', title: 'Agent', employer: 'State Farm', employerDomain: 'statefarm.com', region: 'TX', location: 'Austin, Texas Metropolitan Area' }), now).ok, true);
    const am = { owner_first: 'John', owner_last: 'Smith', business: 'John Smith Agency - American Family Insurance', website: 'https://www.amfam.com/agents/texas/austin/john-smith', state: 'TX', city: 'Austin' };
    assert.equal(ownerMatch(lead(am), P({ person: 'John Smith', title: 'Claims Adjuster', employer: 'American Family Insurance', employerDomain: 'amfam.com', region: 'TX', location: 'Houston, Texas' }), now).ok, false);
    // RocketReach's own label is not mobile: only a recent carrier answer proves it.
    const idx = await knownIndex(deps);
    const why = (l, proof) => leadProblem(l, { idx, qualify: qualifyLead, tollFree, proof, match: (x, p) => ownerMatch(x, p, now), now });
    assert.match(why(lead(), P({ type: 'professional', carrierType: 'mobile', carrier: 'Verizon', carrierAt: '2026-09-20T12:00:00Z' })), /over 30 days ago/);
    assert.equal(why(lead(), P({ type: 'professional', carrierType: 'mobile', carrier: 'Verizon', carrierAt: '2026-10-30T12:00:00Z' })), null);
});

test('the carrier check: cached per number, inside the day\'s cap, refunded when the carrier does not answer', async () => {
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = '2';
    const kv = lineKv(); const asked = [];
    const answers = { '6155550100': { type: 'mobile', carrier: 'Verizon Wireless' }, '6155550101': { type: 'landline', carrier: 'AT&T' }, '6155550102': { type: 'mobile', carrier: 'T-Mobile' } };
    const lookup = async d => { asked.push(d); if (d === '6155550199') throw Error('timeout'); return answers[d] || { type: 'unknown', carrier: '' }; };
    const deps = { kv, day: '2026-10-30', lookup, tollFree };
    const [a, b, c, t] = await phoneCheck(deps, ['(615) 555-0100', '+1 615-555-0101', '12', '888-555-0100']);
    assert.deepEqual(a, { number: '6155550100', type: 'mobile', carrier: 'Verizon Wireless', mobile: true });
    assert.equal(b.mobile, false); assert.equal(b.type, 'landline');
    assert.match(c.error, /10-digit/); assert.equal(t.type, 'tollfree');
    assert.equal(kv.m.get('staffify:lead-agent:phone-checks:2026-10-30'), 2);
    const [again] = await phoneCheck(deps, ['615-555-0100']);
    assert.equal(again.cached, true); assert.equal(asked.filter(x => x === '6155550100').length, 1, 'asked once, remembered after');
    const [over] = await phoneCheck(deps, ['6155550102']);
    assert.match(over.error, /day's 2 carrier checks/); assert.equal(kv.m.get('staffify:lead-agent:phone-checks:2026-10-30'), 2, 'refunded');
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = '5';
    const [down] = await phoneCheck(deps, ['6155550199']);
    assert.match(down.error, /could not be asked/); assert.equal(kv.m.get('staffify:lead-agent:phone-checks:2026-10-30'), 2, 'a failed ask costs nothing');
    assert.deepEqual(await lineProof(kv, '615.555.0100'), kv.m.get('staffify:lead-agent:line:6155550100'));
    delete process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY;
});

test('RocketReach numbers are remembered as proof, never over a carrier\'s answer; the Hub writes the phone fields itself', async () => {
    const kv = lineKv();
    kv.m.set('staffify:lead-agent:line:6155550101', { by: 'carrier', type: 'landline', carrier: 'AT&T' });
    await rememberLines(kv, { name: 'Dana Reyes', phones: [{ number: '+16155550100', type: 'mobile', grade: 'A' }, { number: '+16155550101', type: 'mobile', grade: 'B' }] });
    assert.equal(provenCell(await lineProof(kv, '6155550100')), true);
    assert.equal((await lineProof(kv, '6155550101')).by, 'carrier', 'the carrier outranks the vendor');
    assert.equal(provenCell(await lineProof(kv, '6155550101')), false);
    assert.deepEqual(provenPhone({ owner_first: 'Dana', owner_last: 'Reyes' }, { by: 'carrier', type: 'mobile', carrier: 'Verizon', at: 'T1' }), { phone_type: 'mobile', phone_source: 'carrier-checked public listing', phone_person: 'Dana Reyes', phone_grade: null, phone_checked_at: 'T1' });
    assert.deepEqual(provenPhone({ owner_first: 'Dana' }, { by: 'rocketreach', type: 'mobile', grade: 'A', person: 'Dana Reyes', at: 'T0', carrierAt: 'T2' }), { phone_type: 'mobile', phone_source: 'RocketReach', phone_person: 'Dana Reyes', phone_grade: 'A', phone_checked_at: 'T2' });
    // RocketReach's own "invalid" is never remembered as proof; a carrier that also says mobile keeps the lookup's owner.
    await rememberLines(kv, { name: 'Dana Reyes', phones: [{ number: '+16155550177', type: 'mobile', grade: 'F', valid: false }] });
    assert.equal(await lineProof(kv, '6155550177'), null);
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = '10';
    const [merged] = await phoneCheck({ kv, day: 'd', tollFree, lookup: async () => ({ type: 'mobile', carrier: 'Verizon' }) }, ['6155550100'], Date.parse('2026-10-30T18:00:00Z'));
    assert.equal(merged.mobile, true); assert.equal(merged.looked_up, true);
    const p = await lineProof(kv, '6155550100');
    assert.equal(p.by, 'rocketreach'); assert.equal(p.person, 'Dana Reyes'); assert.equal(p.carrier, 'Verizon');
    const [unnamed] = await phoneCheck({ kv, day: 'd', tollFree, lookup: async () => ({ type: 'mobile', carrier: '' }) }, ['6155550188'], Date.parse('2026-10-30T18:00:00Z'));
    assert.equal(unnamed.mobile, false); assert.match(unnamed.note, /did not name itself/); assert.equal(await lineProof(kv, '6155550188'), null, 'not remembered, so a later answer can prove it');
    kv.m.set('staffify:lead-agent:line:6155550166', { by: 'carrier', type: 'mobile', carrier: 'AT&T', at: '2026-08-01T00:00:00Z' });
    let asked = 0;
    await phoneCheck({ kv, day: 'd', tollFree, lookup: async () => { asked++; return { type: 'landline', carrier: 'AT&T' }; } }, ['6155550166'], Date.parse('2026-10-30T18:00:00Z'));
    assert.equal(asked, 1, 'an answer older than 30 days is asked again'); assert.equal((await lineProof(kv, '6155550166')).type, 'landline');
    for (const v of ['1,000', '150/day', 'abc', '']) { process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = v; const { CHECKS_PER_DAY } = await import('../api/_lead-agent.js'); assert.ok(Number.isFinite(CHECKS_PER_DAY()), v); }
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = '1,000'; assert.equal((await import('../api/_lead-agent.js')).CHECKS_PER_DAY(), 1000);
    process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY = 'abc'; assert.equal((await import('../api/_lead-agent.js')).CHECKS_PER_DAY(), 150, 'never no cap');
    delete process.env.LEAD_AGENT_PHONE_CHECKS_PER_DAY;
    const r = await carrierLookup('6155550100', { env: { TWILIO_SID: 'AC1', TWILIO_AUTH: 'tok' }, fetcher: async (url, o) => { assert.match(url, /lookups\.twilio\.com\/v2\/PhoneNumbers\/%2B16155550100\?Fields=line_type_intelligence/); assert.equal(o.headers.Authorization, 'Basic ' + Buffer.from('AC1:tok').toString('base64')); return { ok: true, json: async () => ({ line_type_intelligence: { type: 'mobile', carrier_name: 'Verizon Wireless' } }) }; } });
    assert.deepEqual(r, { type: 'mobile', carrier: 'Verizon Wireless' });
    await assert.rejects(carrierLookup('6155550100', { env: { TWILIO_SID: 'a', TWILIO_AUTH: 'b' }, fetcher: async () => ({ ok: false, status: 401 }) }), /401/);
});

function capKv() {
    const m = new Map();
    return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; }, async incr(k) { m.set(k, (m.get(k) || 0) + 1); return m.get(k); }, async decr(k) { m.set(k, (m.get(k) || 0) - 1); return m.get(k); }, async expire() { return 1; } };
}
const acct = remaining => async () => ({ creditUsage: [{ credit_type: 'premium_lookup', remaining }] });

test('lookups: inside the day\'s cap and above the month\'s reserve; one that finds nobody costs nothing', async () => {
    process.env.LEAD_AGENT_LOOKUPS_PER_DAY = '2';
    const kv = capKv();
    const profile = { id: 7, name: 'Dana Reyes', title: 'Owner', employer: 'Brand New Plumbing', employerDomain: 'newplumbing.com', phones: [{ number: '+16155550100', type: 'mobile', grade: 'A', valid: true }], emails: [{ email: 'dana@newplumbing.com', grade: 'A', smtp: 'valid' }] };
    const rr = { account: acct(500), lookupPerson: async q => (q.name === 'Nobody' ? { found: false, reason: 'not in RocketReach' } : { found: true, profile }) };
    const d = { kv, rr, day: '2026-10-30' };
    assert.equal((await capLookup(d, {})).status, 400);
    const miss = await capLookup(d, { name: 'Nobody', company: 'X' });
    assert.equal(miss.found, false); assert.equal(kv.m.get('staffify:lead-agent:lookups:2026-10-30'), 0, 'refunded');
    const a = await capLookup(d, { name: 'Dana Reyes', company: 'Brand New Plumbing' });
    assert.deepEqual(a.profile, agentProfile(profile)); assert.equal(a.lookups_left, 1);
    assert.deepEqual(kv.m.get('staffify:lead-agent:line:6155550100').by, 'rocketreach', 'a looked-up number is proof for the submit');
    await capLookup(d, { id: 7 });
    const over = await capLookup(d, { id: 8 });
    assert.equal(over.ok, false); assert.equal(over.status, 429); assert.match(over.error, /day's 2 lookups/);
    const low = await capLookup({ kv: capKv(), rr: { ...rr, account: acct(100) }, day: 'd' }, { id: 1 });
    assert.equal(low.status, 429); assert.match(low.error, /kept for the Hub/);
    const blind = await capLookup({ kv: capKv(), rr: { ...rr, account: async () => { throw Error('down'); } }, day: 'd' }, { id: 1 });
    assert.equal(blind.status, 503);
    delete process.env.LEAD_AGENT_LOOKUPS_PER_DAY;
});
