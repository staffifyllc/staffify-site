// The Caller review: who answered, number problems, local time, repeats, pace and logging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answeredFrom, noteHint, numberIssue, cleanNote, bucketOf, leadSupply, buildReview } from '../api/_performance-review.js';
import { source, GENERATED, USER } from './fixtures/caller-review.mjs';

// Three review rounds showed no keyword rule reads "who answered" from free-text notes reliably, so
// the count comes from the outcome chosen and notes only feed a list a person checks.
test('a person answered when the outcome chosen says so; the stop button counts only on a call Quo confirms', () => {
    const a = (outcome, verified = false) => answeredFrom({ outcome, notes: 'anything at all' }, { verified });
    assert.deepEqual(['connected', 'callback', 'timing'].map(o => a(o).how), ['Conversation', 'Callback agreed', 'Not now']);
    assert.equal(a('suppress', true).how, 'Not interested');
    assert.equal(a('suppress', false), null, 'the stop button is also used for closed businesses');
    for (const o of ['no_answer', 'voicemail', 'wrong_number', undefined]) assert.equal(a(o, true), null, String(o));
    // The note never changes the count, whatever it says.
    assert.equal(answeredFrom({ outcome: 'no_answer', notes: 'Spoke to the owner, he hung up' }, { verified: true }), null);
    assert.equal(answeredFrom({ outcome: 'connected', notes: 'LVM' }).how, 'Conversation');
});

test('notes to check: Milton\'s real mislogs are listed, plain voicemail and no-answer notes are not', () => {
    const h = (outcome, notes) => noteHint({ outcome, notes });
    // Real notes from Oct 21 to 26 whose outcome may be wrong.
    for (const [o, n] of [['no_answer', 'She hung up'], ['no_answer', 'Hang up'], ['voicemail', "Kaya, Nima's assistant, stated that she's not in,"], ['no_answer', 'Leave message with GK'], ['no_answer', 'HU on me'], ['no_answer', 'Mike answered, asked me to email'], ['no_answer', 'Spoke w/ GK, owner at a shoot til 4']])
        assert.match(h(o, n), /may describe a person answering/, n);
    assert.match(h('connected', 'He hang up'), /mentions a hang-up/);
    assert.match(h('connected', 'Left a message with the assistant'), /may describe staff/);
    // Plain notes and agreed outcomes are left alone.
    for (const [o, n] of [['no_answer', 'LVM'], ['voicemail', 'Left VM'], ['no_answer', 'NA'], ['no_answer', 'Rang out'], ['voicemail', 'NVMLA'], ['no_answer', 'Texted them after the call.'], ['voicemail', 'They never answer'], ['voicemail', 'Too late to call'], ['no_answer', 'The VM is not set up'], ['no_answer', 'Nobody picked up'], ['no_answer', ''], ['callback', "Carla stated that he's in Asia"], ['timing', 'He hang up when I told him the intro'], ['connected', 'Good convo, wants pricing'], ['no_answer', '[Interested] LVM']])
        assert.equal(h(o, n), null, o + ': ' + n);
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
    for (const n of ['Good convo but we got disconnected, will email', 'Call dropped/disconnected mid convo, he said call back in 10']) assert.equal(i('connected', n), null, n);
    assert.equal(i('no_answer', 'Number is disconnected'), 'Wrong or dead number');
});

test('a note never shows a dialable number', () => {
    assert.equal(cleanNote('Call him on 612-555-0199 or (612) 555 0198, ext 12'), 'Call him on [number] or [number], ext 12');
    for (const n of ['Cell 612  555  0199', '612 - 555 - 0199', '612\u2013555\u20130199', '612. 555. 0199', 'call 555-0199', '+44 20 7946 0958']) assert.ok(!/\d{3}/.test(cleanNote(n).replace('[number]', '')), n + ' -> ' + cleanNote(n));
    assert.equal(cleanNote('Call 10/27/2026 at 2:30, budget $1,500'), 'Call 10/27/2026 at 2:30, budget $1,500', 'dates and money stay readable');
    for (const n of ['212/555/0166', '612 / 555 / 0199', '212\u2011555\u20110155', '612\u2212555\u22120199', '(561) 555/0123', '561-555/0123', '561.555/0123', '561\ufe63555\ufe630123', '561\uff0d555\uff0d0123']) assert.equal(cleanNote('alt ' + n), 'alt [number]', n);
    for (const n of ['cb 10-28-2026', 'budget 1500-2000/mo', 'paid $1500-2000', 'on 10/27/2026']) assert.equal(cleanNote(n), n, n + ' stays readable');
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
    assert.equal(t.reached, 5); assert.deepEqual(t.reachedByHow, [{ how: 'Conversation', n: 2 }, { how: 'Callback agreed', n: 2 }, { how: 'Not now', n: 1 }]);
    assert.deepEqual([t.reachedPerDial.num, t.reachedPerDial.den], [5, 19]); assert.equal(t.reachedWithoutQuoCall, 0);
    assert.equal(t.meetings, 0); assert.equal(t.notesToCheck, 6); assert.equal(t.daysWorked, 5);
    assert.equal(t.dialsWithoutOutcome, 2, 'the two dials on Oct 26 with nothing logged'); assert.equal(t.outcomesWithoutQuoCall, 0);
    assert.equal(t.clockedMinutes, 240); assert.equal(t.activeMinutes, 123);
    const oct26 = v.days.find(d => d.day === '2026-10-26');
    assert.deepEqual([oct26.dials, oct26.outcomes, oct26.reached, oct26.notesToCheck], [10, 8, 3, 5]);
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

    assert.equal(v.reached.list.length, 5); assert.ok(v.reached.list.every(x => !/\d{3}\D?\d{3}\D?\d{4}/.test(x.note)), 'no number in a note');
    assert.deepEqual(v.notesToCheck.map(x => x.company), ['Lilac Studio', 'Visual Estate Co', 'Helio Homes', 'Elevate Travel', 'Lakeshore Photo', 'Spacecraft Photo']);
    assert.ok(!/\d{10}/.test(JSON.stringify(v)), 'no full phone number anywhere in the review');
});

test('a source that could not be read is unknown, never zero', () => {
    const noQuo = buildReview(source({ quoOk: false }), { generatedAt: GENERATED });
    assert.equal(noQuo.totals.dials, null); assert.equal(noQuo.totals.reachedPerDial, null); assert.equal(noQuo.totals.reached, 5, 'who answered comes from the Hub log, so it survives');
    assert.equal(noQuo.sources.quo, 'unavailable');
    const noCal = buildReview(source({ calendlyOk: false }), { generatedAt: GENERATED });
    assert.equal(noCal.totals.meetings, null); assert.ok(noCal.coverage.some(c => /Meetings are unknown/.test(c)));
    const noHub = buildReview(source({ hubOk: false }), { generatedAt: GENERATED });
    assert.deepEqual([noHub.totals.outcomes, noHub.totals.reached, noHub.numbers.flagged, noHub.totals.notesToCheck, noHub.notesToCheck], [null, null, null, null, null]);
    assert.equal(noHub.totals.daysWorked, 5, 'a kept day with no evidence is not a day worked');
    assert.equal(noHub.timing.buckets, null); assert.equal(noHub.repeats, null); assert.ok(noHub.timing.etHours.length > 0, 'the Eastern hours come from Quo and stay');
    const both = buildReview(source({ quoOk: false, hubOk: false }), { generatedAt: GENERATED });
    assert.equal(both.quietDays.length, 0, 'a day whose sources could not be read is never called quiet');
    const cut = source(); cut.quo.complete = false;
    const truncated = buildReview(cut, { generatedAt: GENERATED });
    assert.equal(truncated.totals.dials, null, 'a Quo read that stopped early is unknown, never a low count'); assert.ok(truncated.coverage.some(c => /more calls in these dates than could be read/.test(c)));
});

test('an unreadable shift or activity day keeps its row and makes the total unknown; a booking day is never quiet', () => {
    const s1 = source(); s1.shiftByDay['2026-10-26'] = { unavailable: true }; s1.activityByDay['2026-10-26'] = null;
    const v = buildReview(s1, { generatedAt: GENERATED });
    const d = v.days.find(x => x.day === '2026-10-26');
    assert.deepEqual([d.shiftUnavailable, d.activityUnavailable], [true, true]);
    assert.deepEqual([v.totals.clockedMinutes, v.totals.activeMinutes], [null, null]);
    assert.ok(v.coverage.some(c => /Shift records could not be read on 1 day/.test(c)) && v.coverage.some(c => /Hub activity could not be read on 1 day/.test(c)));
    const s2 = source(); s2.calendly.bookings = [{ email: 'r4@example.com', createdAt: '2026-10-24T15:00:00.000Z', startTime: '2026-10-29T15:00:00.000Z', eventName: 'Discovery call' }];
    const v2 = buildReview(s2, { generatedAt: GENERATED });
    assert.ok(v2.days.some(x => x.day === '2026-10-24' && x.meetings === 1), 'Saturday keeps its row because a meeting was booked');
    assert.equal(v2.totals.meetings, 1);
});

test('leads still to call: callable, never dialled, unclaimed; and his own follow-ups that are due', () => {
    const ready = (id, status, extra = {}) => ({ id, campaignId: 'staffify-agency-outreach', callReady: true, callContact: { phone: '+12125550100', phoneStatus: status }, callHistory: [], ...extra });
    const s = leadSupply([
        ready('a', 'business_listed'), ready('b', 'crm_unconfirmed'), ready('c', 'crm_unconfirmed', { campaignId: 'staffify-tobit-outreach' }),
        ready('d', 'business_listed', { callHistory: [{ at: '2026-10-26T20:00:00Z', outcome: 'voicemail', caller: 'paul' }] }),
        ready('e', 'business_listed', { callOwner: 'milton@trystaffify.com' }),
        ready('f', 'wrong_number'), { id: 'g', callReady: false, callContact: { phone: '+1', phoneStatus: 'business_listed' } },
    ], ['miltion@trystaffify.com', 'milton@trystaffify.com']);
    // The agency (real estate media) list is paused since 2026-10-27: its unworked cards are not supply.
    assert.equal(s.neverDialled, 1, 'only the live (tobit) card is a lead still to call');
    assert.equal(s.pausedNotOffered, 2, 'the paused agency cards are counted apart, not offered');
    assert.deepEqual(s.byCampaign.map(x => [x.name, x.n]), [['CEO B2B outreach', 1]]);
    assert.equal(s.hisFollowUpsDue, 0, 'an owned follow-up on the paused list is not due work');
    assert.equal(s.hisPausedFollowUps, 1, 'it is counted in the Paused area instead');
});

test('quiet stretches on shift, by day: Hub minutes and Quo calls fill the shift, the rest of 10 minutes or more is listed', () => {
    const v = buildReview(source(), { generatedAt: GENERATED, emails: [USER.email] });
    const d = v.days.find(x => x.day === '2026-10-26');
    // Shift 3:55 to 7:55 PM. Hub 3:55 to 4:31 and 5:00 to 5:51. Quo calls (a minute each) at 5:02, 5:20,
    // 5:30, 5:44, 6:39, and two with nothing logged at 6:55 (70 s) and 7:10.
    assert.equal(d.onShiftMinutes, 240);
    assert.deepEqual(d.quietStretches.map(x => [x.from, x.to, x.minutes, x.prompted, x.answer]), [
        ['2026-10-26T20:31:00.000Z', '2026-10-26T21:00:00.000Z', 29, true, 'Said they were on a call'],
        ['2026-10-26T21:51:00.000Z', '2026-10-26T22:39:00.000Z', 48, false, null],
        ['2026-10-26T22:40:00.000Z', '2026-10-26T22:55:00.000Z', 15, false, null],
        ['2026-10-26T22:56:10.000Z', '2026-10-26T23:10:00.000Z', 13, false, null],     // the 6:55 dial ran 70 seconds
        ['2026-10-26T23:11:00.000Z', '2026-10-26T23:55:00.000Z', 44, false, null],
    ]);
    assert.equal(d.quietMinutes, 149);
    assert.equal(v.days.find(x => x.day === '2026-10-23').quietStretches, null, 'no declared shift before Oct 24: not measured');
    assert.deepEqual([v.quiet.quietMinutes, v.quiet.onShiftMinutes, v.quiet.list.length], [149, 240, 5]);
    assert.equal(buildReview(source({ quoOk: false }), { generatedAt: GENERATED }).days.find(x => x.day === '2026-10-26').quietStretches, null, 'Quo unread: calls unknown, so quiet is unknown');
});
