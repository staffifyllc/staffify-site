// Paul, 2026-10-30: "I need to create an agent who will go and get lists like maddie has all day every day".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToken, agentAuthorized, knownIndex, knownWhy, leadProblem, capLookup, remember, agentProfile, phoneCheck, rememberLines, lineProof, provenCell, provenPhone, carrierLookup } from '../api/_lead-agent.js';
import { qualifyLead, tollFree } from '../api/_hiring-intent.js';

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
    const RR = { by: 'rocketreach', type: 'mobile', grade: 'A', person: 'Dana Reyes' };
    const why = (l, proof = RR) => leadProblem(l, { idx, qualify: qualifyLead, tollFree, proof, now });
    assert.equal(why(lead()), null);
    // The agent's word is not proof (Paul, 2026-10-30: never a main line, and not always RocketReach).
    assert.match(why(lead(), null), /not proven a cell/);
    assert.match(why(lead({ phone_type: 'mobile' }), { by: 'carrier', type: 'landline', carrier: 'AT&T' }), /the carrier says this number is landline \(AT&T\), not a cell/);
    assert.match(why(lead(), { by: 'carrier', type: 'nonfixedvoip', carrier: 'Twilio' }), /not a cell/);
    assert.match(why(lead(), { by: 'carrier', type: 'mobile', carrier: '' }), /not a cell/, 'a carrier that does not name itself proves nothing');
    assert.match(why(lead(), { by: 'rocketreach', type: 'professional' }), /did not list this number as a mobile/);
    assert.match(why(lead(), { by: 'carrier', type: 'mobile', carrier: 'Verizon Wireless' }), /phone_source_url is required/);
    assert.equal(why(lead({ phone_source_url: 'https://newplumbing.com/about' }), { by: 'carrier', type: 'mobile', carrier: 'Verizon Wireless' }), null);
    assert.match(why(lead({ phone: '888-555-0100' })), /toll-free/);
    assert.match(why(lead({ owner_email: null })), /owner_email/);
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
    return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v) { m.set(k, v); return 'OK'; }, async incr(k) { m.set(k, (m.get(k) || 0) + 1); return m.get(k); }, async decr(k) { m.set(k, (m.get(k) || 0) - 1); return m.get(k); }, async expire() { return 1; } };
}

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
    assert.deepEqual(provenPhone({ owner_first: 'Dana', owner_last: 'Reyes' }, { by: 'carrier', type: 'mobile', carrier: 'Verizon' }), { phone_type: 'mobile', phone_source: 'carrier-checked public listing', phone_person: 'Dana Reyes', phone_grade: null });
    assert.deepEqual(provenPhone({ owner_first: 'Dana' }, { by: 'rocketreach', type: 'mobile', grade: 'A', person: 'Dana Reyes' }), { phone_type: 'mobile', phone_source: 'RocketReach', phone_person: 'Dana Reyes', phone_grade: 'A' });
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
