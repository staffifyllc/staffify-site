// The Caller review: who answered, number problems, local time, repeats, pace and logging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reachedFrom, numberIssue, cleanNote, bucketOf, leadSupply, buildReview } from '../api/_performance-review.js';
import { source, GENERATED, USER } from './fixtures/caller-review.mjs';

const r = (outcome, notes = '') => reachedFrom({ outcome, notes });

test('who answered is read from the outcome he chose and the words of his note, never from Quo', () => {
    assert.deepEqual([r('callback', 'She stated that she was busy with her family').who, r('callback', 'She stated that she was busy').how], ['prospect', 'Callback agreed']);
    assert.equal(r('timing', 'He hang up when I told him the intro').how, 'Hung up');
    assert.equal(r('timing', 'He hang up when I told him the intro').mislogged, false, 'Not now after a hang-up is a fair outcome');
    assert.deepEqual([r('no_answer', 'She hung up').who, r('no_answer', 'She hung up').mislogged], ['prospect', true]);
    assert.equal(r('no_answer', 'Hang up').how, 'Hung up');
    assert.deepEqual([r('connected', 'He hang up').how, r('connected', 'He hang up').mislogged], ['Hung up', true]);
    assert.deepEqual([r('voicemail', "Kaya, Nima's assistant, stated that she's not in,").who, r('voicemail', "Kaya, Nima's assistant").mislogged], ['staff', true]);
    assert.deepEqual([r('connected', 'Left a message with the assistant').who, r('connected', 'Left a message with the assistant').mislogged], ['staff', true]);
    assert.deepEqual([r('callback', "Carla  stated that he's in Asia").who, r('callback', "Carla stated that he's in Asia").mislogged], ['staff', false]);
    assert.equal(r('no_answer', 'Leave message with GK').who, 'staff');
    assert.equal(r('suppress').how, 'Not interested'); assert.equal(r('connected').how, 'Conversation');
    for (const [o, n] of [['no_answer', 'His VM is " Hello this is Dakoda, can you hear me?'], ['voicemail', 'Too late to call'], ['voicemail', 'LVM'], ['voicemail', 'They never answer'], ['no_answer', 'Texted them after the call.'], ['no_answer', 'The VM is not set up'], ['no_answer', 'I think that he block us'], ['wrong_number', 'he hung up'], ['voicemail', '']])
        assert.equal(r(o, n), null, o + ': ' + n);
    assert.equal(r('no_answer', 'Spoke to the owner briefly').who, 'someone');
});

test('number problems come from the Wrong number outcome or a note that says so', () => {
    const i = (outcome, notes) => numberIssue({ outcome, notes });
    assert.equal(i('wrong_number', ''), 'Wrong or dead number');
    assert.equal(i('no_answer', 'Number is disconnected'), 'Wrong or dead number');
    assert.equal(i('no_answer', 'No number to call'), 'No number');
    assert.equal(i('no_answer', 'This is a  business number.'), 'General business line');
    assert.equal(i('no_answer', 'GENERAL NUMBER of the business'), 'General business line');
    assert.equal(i('no_answer', 'Wont dial out'), 'Call would not go through');
    for (const n of ['LVM', 'She hung up', 'The VM is not set up', 'Texted them after the call.']) assert.equal(i('voicemail', n), null, n);
});

test('a note never shows a dialable number', () => {
    assert.equal(cleanNote('Call him on 612-555-0199 or (612) 555 0198, ext 12'), 'Call him on [number] or [number], ext 12');
    assert.equal(cleanNote('x'.repeat(400)).length, 240);
});

test('the clock buckets', () => {
    assert.equal(bucketOf(null), 'unknown');
    assert.deepEqual([{ hour: 8, minute: 59 }, { hour: 9, minute: 0 }, { hour: 12, minute: 0 }, { hour: 16, minute: 59 }, { hour: 17, minute: 30 }, { hour: 18, minute: 0 }].map(bucketOf), ['before9', 'morning', 'afternoon', 'afternoon', 'five', 'evening']);
});

test('the review adds up: days, who answered, numbers, local time, repeats, pace and logging', () => {
    const v = buildReview(source(), { generatedAt: GENERATED, emails: [USER.email, 'milton@trystaffify.com'] });
    assert.deepEqual(v.days.map(d => d.day), ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27']);
    assert.deepEqual(v.quietDays, ['2026-10-20', '2026-10-24', '2026-10-25'], 'quiet days are listed, not drawn as rows of zeros');
    assert.equal(v.partial, true);
    const t = v.totals;
    assert.equal(t.dials, 19); assert.equal(t.outcomes, 17); assert.equal(t.prospects, 13);
    assert.deepEqual([t.reached, t.prospectsReached, t.staffReached, t.someoneReached], [9, 5, 4, 0]);
    assert.deepEqual([t.reachedPerDial.num, t.reachedPerDial.den], [9, 19]);
    assert.equal(t.meetings, 0); assert.equal(t.mislogged, 6);
    assert.equal(t.dialsWithoutOutcome, 2, 'the two dials on Oct 26 with nothing logged'); assert.equal(t.outcomesWithoutQuoCall, 0);
    assert.equal(t.clockedMinutes, 240); assert.equal(t.activeMinutes, 123);
    const oct26 = v.days.find(d => d.day === '2026-10-26');
    assert.deepEqual([oct26.dials, oct26.outcomes, oct26.reached, oct26.prospectsReached, oct26.staffReached], [10, 8, 6, 2, 4]);
    assert.equal(oct26.dialsPerClockedHour, 2.5); assert.equal(oct26.dialSpanMinutes, 193, "3:57 PM to 7:10 PM");
    assert.equal(v.days.find(d => d.day === '2026-10-21').dialsPerClockedHour, null, 'no declared shift that day: no rate');

    assert.equal(v.numbers.prospects, 13); assert.equal(v.numbers.flagged, 4);
    assert.deepEqual(Object.fromEntries(v.numbers.byIssue.map(x => [x.issue, x.n])), { 'Wrong or dead number': 1, 'No number': 1, 'General business line': 1, 'Call would not go through': 1 });
    const seg = Object.fromEntries(v.segments.map(s => [s.name, s]));
    assert.deepEqual([seg['Staffify agency outreach'].prospects, seg['CEO B2B outreach'].prospects, seg['CEO B2B outreach'].flagged], [11, 2, 1]);

    const b = Object.fromEntries(v.timing.buckets.map(x => [x.key, x]));
    assert.equal(b.unknown.outcomes, 1, '605 is a split area code'); assert.equal(v.timing.knownZone, 16);
    assert.equal(b.evening.outcomes + b.five.outcomes + b.afternoon.outcomes + b.morning.outcomes + b.before9.outcomes + b.unknown.outcomes, 17);
    assert.ok(v.timing.etHours.every(h => /Eastern$/.test(h.label)));

    assert.deepEqual(v.repeats.distribution.map(d => d.prospects), [10, 2, 1, 0]);
    assert.deepEqual([v.repeats.nextDay.num, v.repeats.nextDay.den], [10, 11]);
    assert.equal(v.repeats.mostCalled[0].company, 'Lakeshore Photo');

    assert.equal(v.reached.list.length, 9); assert.ok(v.reached.list.every(x => !/\d{3}\D?\d{3}\D?\d{4}/.test(x.note)), 'no number in a note');
    assert.equal(v.logging.list.length, 6);
    assert.ok(!/\d{10}/.test(JSON.stringify(v)), 'no full phone number anywhere in the review');
});

test('a source that could not be read is unknown, never zero', () => {
    const noQuo = buildReview(source({ quoOk: false }), { generatedAt: GENERATED });
    assert.equal(noQuo.totals.dials, null); assert.equal(noQuo.totals.reachedPerDial, null); assert.equal(noQuo.totals.reached, 9, 'who answered comes from the Hub log, so it survives');
    assert.equal(noQuo.sources.quo, 'unavailable');
    const noCal = buildReview(source({ calendlyOk: false }), { generatedAt: GENERATED });
    assert.equal(noCal.totals.meetings, null); assert.ok(noCal.coverage.some(c => /Meetings are unknown/.test(c)));
    const noHub = buildReview(source({ hubOk: false }), { generatedAt: GENERATED });
    assert.deepEqual([noHub.totals.outcomes, noHub.totals.reached, noHub.numbers.flagged, noHub.totals.mislogged], [null, null, null, null]);
});

test('leads still to call: callable, never dialled, unclaimed; and his own follow-ups that are due', () => {
    const ready = (id, status, extra = {}) => ({ id, campaignId: 'staffify-agency-outreach', callReady: true, callContact: { phone: '+12125550100', phoneStatus: status }, callHistory: [], ...extra });
    const s = leadSupply([
        ready('a', 'business_listed'), ready('b', 'crm_unconfirmed'), ready('c', 'crm_unconfirmed', { campaignId: 'staffify-tobit-outreach' }),
        ready('d', 'business_listed', { callHistory: [{ at: '2026-10-26T20:00:00Z', outcome: 'voicemail', caller: 'paul' }] }),
        ready('e', 'business_listed', { callOwner: 'milton@trystaffify.com' }),
        ready('f', 'wrong_number'), { id: 'g', callReady: false, callContact: { phone: '+1', phoneStatus: 'business_listed' } },
    ], ['miltion@trystaffify.com', 'milton@trystaffify.com']);
    assert.equal(s.neverDialled, 3);
    assert.deepEqual(s.bySource.map(x => [x.label, x.n]), [['CRM number, not found on their website', 2], ['Published on their own website', 1]]);
    assert.deepEqual(s.byCampaign.map(x => [x.name, x.n]), [['Staffify agency outreach', 2], ['CEO B2B outreach', 1]]);
    assert.equal(s.hisFollowUpsDue, 1, 'claimed through his login alias');
});
