// A wrong number condemns the number, never the lead.
// ------------------------------------------------------------------
// Codex's reliability brief, 2026-10-22: wrong-party numbers go to background research, not a dead
// end. The day it shipped, Milton logged Zenoti as a wrong number, the lead stopped being offered
// for good, and nothing sent it back. The number was the main line taken off Zenoti's own homepage,
// so the source that found it would have offered it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markBad, loadBad, isBad, digits10, BAD_KEY } from '../api/_bad-numbers.js';
import { withCallPhones } from '../api/_outreach-call-phones.js';

const store = (seed = {}) => ({ _: seed, async get(k) { return seed[k] ?? null; }, async set(k, v) { seed[k] = v; return 'OK'; } });
const crmDown = async () => { throw new Error('offline'); };
const OLD = '2026-10-01T12:00:00Z';
const lead = (over = {}) => ({ id: 'z', recipient: 'sudheer@zenoti.com', company: 'Zenoti', campaignId: 'staffify-tobit-outreach',
    status: 'sent', sentTouches: 4, verifiedSentTouches: 4, lastSentAt: OLD, source: { url: 'https://zenoti.com/' }, ...over });
const view = rows => ({ revision: 1, records: rows });

test('a number can only be marked bad if it was really on file for that person', async () => {
    const redis = store();
    assert.equal((await markBad(redis, { email: 'a@x.com', phone: '+14253005833', known: ['(425) 300-5833'] })).ok, true);
    const planted = await markBad(redis, { email: 'a@x.com', phone: '+15555550123', known: ['+14253005833'] });
    assert.equal(planted.ok, false, 'a request cannot plant an arbitrary number against somebody');
    assert.match(planted.reason, /not on file/);
    assert.equal((await markBad(redis, { email: 'a@x.com', phone: '12', known: ['12'] })).ok, false);
    const bad = await loadBad(redis, 'a@x.com');
    assert.ok(isBad(bad, '425.300.5833'), 'matched however it is written');
    assert.equal(digits10('+1 (425) 300-5833'), '4253005833');
});

test('a wrong-number lead comes back only with a DIFFERENT number', async () => {
    const redis = store({
        [BAD_KEY('sudheer@zenoti.com')]: { numbers: ['4253005833'] },
        'staffify:call-site-phone:sudheer@zenoti.com': { phone: '+14253005833', sourceUrl: 'https://zenoti.com/', alternates: [], checkedAt: new Date().toISOString() },
    });
    const d = await withCallPhones(view([lead({ callOutcome: 'wrong_number', callReady: false })]), { redis, crm: crmDown });
    const r = d.records[0];
    assert.equal(r.callReady, false, 'the same wrong line is not offered again');
    assert.equal(r.callContact.phoneStatus, 'wrong_number');
    assert.equal(r.numberResearch.state, 'researching', 'it goes back to research rather than a dead end');

    // Research then finds a different number, and the lead is callable again through the normal rules.
    redis._['staffify:call-phone-vendor:sudheer@zenoti.com'] = { phone: '+12065550199', source: 'RocketReach', checkedAt: new Date().toISOString() };
    const d2 = await withCallPhones(view([lead({ callOutcome: 'wrong_number', callReady: false })]), { redis, crm: crmDown });
    assert.equal(d2.records[0].callReady, true);
    assert.equal(d2.records[0].callContact.phone, '+12065550199');
});

test('a wrong number logged before we recorded WHICH one is never re-offered with a guess', async () => {
    // Zenoti, exactly: wrong_number on the record, no bad-number entry, the homepage number still cached.
    const redis = store({ 'staffify:call-site-phone:sudheer@zenoti.com': { phone: '+14253005833', sourceUrl: 'https://zenoti.com/', alternates: [], checkedAt: new Date().toISOString() } });
    const d = await withCallPhones(view([lead({ callOutcome: 'wrong_number', callReady: false })]), { redis, crm: crmDown });
    assert.equal(d.records[0].callReady, false, 'the caller is not sent back to the same wrong line');
    assert.match(d.records[0].callContact.phoneDetail, /no number on file can be trusted/);
});

test('the retry never skips a rule: an ineligible lead stays out even after a wrong number', async () => {
    const redis = store();
    // Only two emails sent, so it was never eligible in the first place.
    const d = await withCallPhones(view([lead({ callOutcome: 'wrong_number', callReady: false, sentTouches: 2, verifiedSentTouches: 2 })]), { redis, crm: crmDown });
    assert.equal(d.records[0].callReady, false);
    assert.equal(d.records[0].wrongNumberRetry, undefined);
});

test('what is OFFERED follows the final decision, so a held lead is not handed out', async () => {
    // The shared view sets unclaimed / dueForMe before the phone ladder runs. A blocked lead used
    // to stay offered until the card itself refused it.
    const redis = store({ 'staffify:call-block:z': { error: 'Do not call: CRM opt-out', lastSentAt: OLD },
        'staffify:call-site-phone:sudheer@zenoti.com': { phone: '+12065550199', alternates: [], checkedAt: new Date().toISOString() } });
    const d = await withCallPhones(view([lead({ callReady: true, unclaimed: true, dueForMe: false })]), { redis, crm: crmDown });
    assert.equal(d.records[0].callReady, false);
    assert.equal(d.records[0].unclaimed, false, 'no longer handed out');
});
