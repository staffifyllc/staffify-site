// Nobody reaches a caller without a number, and nothing about that can take the queue down.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "There needs to never be someone in there without a number, it shouldn't crash
// the entire system if it can't find it it should just do what it needs to in order to get the
// number."
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, researchStatus, nextTryAt, ATTEMPTS, websiteOf } from '../api/_number-research.js';
import { withCallPhones } from '../api/_outreach-call-phones.js';

const row = (over = {}) => ({
    id: 'r1', recipient: 'owner@example.com', company: 'Example Co', campaignId: 'staffify-agency-outreach',
    callReady: true, lastSentAt: '2026-10-01T12:00:00Z', source: { url: 'https://example.com/' }, ...over,
});
const store = (seed = {}) => ({ _: seed, async get(k) { return seed[k] ?? null; }, async set(k, v) { seed[k] = v; return 'OK'; } });
const crmDown = async () => { throw new Error('offline'); };
const state = rows => ({ revision: 1, records: rows, suppressions: [], pausedOwners: [] });

// ---------- the decision, without a network ----------

test('the free source is always exhausted before the metered one', () => {
    assert.equal(decide(row(), null).source, 'website');
    assert.equal(decide(row(), { tried: ['website'], attempts: 1 }).source, 'vendor');
    assert.equal(decide(row(), { tried: ['website', 'vendor'], attempts: 2 }).action, 'exhausted');
});

test('a record with no website skips straight to the vendor rather than stalling', () => {
    const r = row({ source: null, website: null });
    assert.equal(websiteOf(r), null);
    assert.equal(decide(r, null).source, 'vendor');
});

test('a failed attempt backs off, and the delay grows', () => {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    assert.equal(decide(row(), { tried: [], attempts: 1, nextTryAt: now + 3600000 }, now).action, 'wait');
    assert.ok(nextTryAt(1, now) < nextTryAt(2, now), 'the second failure waits longer');
    assert.ok(nextTryAt(4, now) < nextTryAt(5, now));
    assert.equal(nextTryAt(9, now), nextTryAt(5, now), 'and it stops growing rather than never retrying');
});

test('exhausted says why, and never becomes callable or deleted', () => {
    const s = researchStatus(row(), { tried: ['website', 'vendor'], attempts: 2 });
    assert.equal(s.state, 'exhausted');
    assert.equal(s.callable, false);
    assert.match(s.detail, /after 2 attempts/);
    assert.match(s.label, /No number could be found/);
});

// ---------- the queue, which is where it has to hold ----------

test('MISSING NUMBER: the record leaves Ready to call instead of becoming a dead card', async () => {
    const d = await withCallPhones(state([row()]), { redis: store(), crm: crmDown });
    const r = d.records[0];
    assert.equal(r.callReady, false, 'not offered to a caller');
    assert.equal(r.numberResearch.state, 'researching');
    assert.match(r.numberResearch.label, /Finding a number/);
    assert.equal(d.numberWork.findingNumber, 1);
    assert.equal(d.numberWork.callable, 0);
    // Kept. Not deleted, and no number invented.
    assert.equal(r.callContact.phone, null);
    assert.ok(d.records.length === 1);
});

test('SUCCESSFUL ENRICHMENT: a found number promotes the record on the next read, once', async () => {
    const redis = store({
        'staffify:call-site-phone:owner@example.com': { phone: '+15125550100', sourceUrl: 'https://example.com/contact', alternates: [], checkedAt: new Date().toISOString() },
    });
    const d = await withCallPhones(state([row()]), { redis, crm: crmDown });
    const r = d.records[0];
    assert.equal(r.callReady, true, 'back in the queue');
    assert.equal(r.numberResearch, null, 'and no longer in research');
    assert.equal(r.callContact.phone, '+15125550100');
    assert.equal(r.callContact.phoneStatus, 'site_main', 'labelled as a main line, not a direct dial');
    assert.equal(d.numberWork.callable, 1);
    assert.equal(d.numberWork.findingNumber, 0);
    // Once. The record appears a single time, in its own campaign.
    assert.equal(d.records.filter(x => x.id === 'r1').length, 1);
    assert.equal(r.campaignId, 'staffify-agency-outreach');
});

test('PROVIDER FAILURE: an unreadable research record degrades that row only', async () => {
    const redis = {
        async get(k) {
            if (String(k).startsWith('staffify:number-research:')) throw new Error('store down');
            if (k === 'staffify:call-site-phone:fine@example.com') return { phone: '+15125550111', sourceUrl: 'https://ok.com/', alternates: [], checkedAt: new Date().toISOString() };
            return null;
        },
        async set() { return 'OK'; },
    };
    const d = await withCallPhones(state([row(), row({ id: 'r2', recipient: 'fine@example.com' })]), { redis, crm: crmDown });
    const broken = d.records.find(r => r.id === 'r1');
    const fine = d.records.find(r => r.id === 'r2');
    assert.equal(broken.callReady, false, 'the row we cannot assess is held, not guessed at');
    assert.equal(broken.numberResearch.state, 'researching');
    // THE POINT: the other card is untouched and still workable.
    assert.equal(fine.callReady, true);
    assert.equal(fine.callContact.phone, '+15125550111');
});

test('a whole CRM outage still leaves the queue standing', async () => {
    const d = await withCallPhones(state([row(), row({ id: 'r2', recipient: 'b@example.com' })]), { redis: store(), crm: crmDown });
    assert.equal(d.records.length, 2, 'nothing was dropped');
    assert.ok(d.records.every(r => r.callReady === false), 'and nothing was offered without a number');
    assert.equal(d.numberWork.findingNumber, 2);
});

test('WRONG PARTY: a number is only ever as good as its provenance says', async () => {
    const redis = store({
        'staffify:call-phone-evidence:owner@example.com': { phone: '3055551234', status: 'needs_confirmation' },
    });
    const d = await withCallPhones(state([row()]), { redis, crm: crmDown });
    const c = d.records[0].callContact;
    assert.equal(c.phone, '3055551234', 'it is given to the caller');
    assert.equal(c.phoneStatus, 'crm_unconfirmed');
    assert.notEqual(c.phoneStatus, 'business_listed', 'and never passed off as corroborated');
    assert.match(c.phoneDetail, /main line or a front desk/, 'the caller is told who is likely to answer');
});

test('a record already held for another reason is not double counted as a number problem', async () => {
    const redis = store({ 'staffify:call-block:r1': { error: 'Do not call: CRM opt-out', lastSentAt: '2026-10-01T12:00:00Z' } });
    const d = await withCallPhones(state([row()]), { redis, crm: crmDown });
    assert.equal(d.numberWork.blocked, 1);
    assert.equal(d.numberWork.findingNumber, 0, 'a blocked lead is not waiting on a number');
    assert.equal(d.records[0].callReady, false);
});

test('the attempt key is per person', () => {
    assert.equal(ATTEMPTS('A@Example.com'), 'staffify:number-research:a@example.com');
    assert.notEqual(ATTEMPTS('a@example.com'), ATTEMPTS('b@example.com'));
});
