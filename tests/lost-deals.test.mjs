// Calling back somebody we already met and did not close.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "see if they filled the role, we met previously about (xxx take info from
// call)". The danger in a re-engagement script is the opposite of a cold one. On a cold call you
// know nothing and say so. Here you claim a shared history, and getting that claim wrong, telling
// somebody you discussed editors when they asked about bookkeeping, is worse than admitting you do
// not have the notes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lostDealScript, topicFrom, spokenDate, monthsSince } from '../api/_lost-deal-script.js';
import { eventUuid } from '../api/_calendly.js';

const MET = '2026-08-14T15:00:00Z';

test('it opens on the one question worth calling for', () => {
    const s = lostDealScript({ firstName: 'Dana', caller: 'Milton', metAt: MET,
        answers: [{ question: 'What do you need help with?', answer: 'hiring a video editor' }] });
    assert.match(s.opener, /this is Milton from Staffify/);
    assert.match(s.opener, /We spoke back in August/);
    assert.match(s.opener, /about hiring a video editor/);
    assert.match(s.opener, /did you end up getting that filled\?/);
    assert.match(s.opener, /not calling to pitch/);
});

test('it never invents what the call was about', () => {
    const blind = lostDealScript({ firstName: 'Dana', caller: 'Milton', metAt: MET });
    assert.equal(blind.verified.topic, null);
    assert.match(blind.verified.note, /Do NOT guess at a topic/);
    // The opener must not assert a subject it does not have.
    assert.ok(!/ about /.test(blind.opener), 'no topic is claimed when none is on file');
    assert.match(blind.opener, /did you end up getting that filled\?/, 'it still asks the question');
});

test('the topic comes from their own words first, then a host note', () => {
    const written = topicFrom({ answers: [{ question: 'Anything else?', answer: 'ok' }, { question: 'What do you need?', answer: 'two editors and a scheduler' }] });
    assert.equal(written.text, 'two editors and a scheduler', 'the substantive answer, not the one-word one');
    assert.match(written.source, /what they wrote when booking/);

    const noted = topicFrom({ answers: [], notes: 'They were drowning in revisions.' });
    assert.equal(noted.text, 'They were drowning in revisions.');
    assert.match(noted.source, /note from the call/);

    assert.equal(topicFrom({ answers: [{ question: 'x', answer: '' }, { question: 'y', answer: 'no' }] }), null,
        'a two-character answer is not a topic');
    assert.equal(topicFrom({}), null);
});

test('a no-show gets a different opening, because we did not actually meet', () => {
    const s = lostDealScript({ firstName: 'Dana', caller: 'Milton', metAt: MET, noShow: true,
        answers: [{ question: 'q', answer: 'hiring an editor' }] });
    assert.equal(s.kind, 'booked_but_no_show');
    assert.equal(s.verified.weMet, false);
    assert.ok(!/We spoke/.test(s.opener), 'we did not speak, so we must not say we did');
    assert.match(s.opener, /it did not end up happening/);
    assert.match(s.opener, /not calling to chase that/);
});

test('every answer they can give has a branch, including not remembering us', () => {
    const s = lostDealScript({ firstName: 'Dana', caller: 'Milton', metAt: MET,
        answers: [{ question: 'q', answer: 'a part time bookkeeper' }] });
    const labels = s.branches.map(b => b.label);
    for (const need of ['They filled it', 'Still not filled', 'They went another way', 'They do not remember us', 'Bad time'])
        assert.ok(labels.includes(need), 'missing branch: ' + need);
    assert.ok(s.branches.every(b => b.say && b.note), 'every branch says something and explains itself');
    // The reminder branch uses the real topic rather than a vague gesture.
    assert.match(s.branches.find(b => b.label === 'They do not remember us').say, /about a part time bookkeeper/);
});

test('how cold this is gets said out loud', () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    assert.match(lostDealScript({ metAt: '2026-10-01T12:00:00Z', now, caller: 'M' }).staleness, /Recent/);
    assert.match(lostDealScript({ metAt: '2026-07-01T12:00:00Z', now, caller: 'M' }).staleness, /remind them who you are/);
    assert.match(lostDealScript({ metAt: '2025-11-01T12:00:00Z', now, caller: 'M' }).staleness, /close to a cold call/);
    assert.equal(monthsSince('2026-08-22T12:00:00Z', now), 2);
    assert.equal(monthsSince('not a date'), null);
});

test('the date is the one both people would say, in Eastern time', () => {
    // 00:30 UTC on the 15th is still the evening of the 14th in New York.
    assert.equal(spokenDate('2026-08-15T00:30:00Z').label, 'August 14');
    assert.equal(spokenDate('2026-08-14T15:00:00Z').label, 'August 14');
    assert.equal(spokenDate('nope'), null);
});

test('a missing first name does not print a blank', () => {
    const s = lostDealScript({ caller: 'Milton', metAt: MET });
    assert.match(s.opener, /Hi there, this is Milton/);
    assert.ok(!s.opener.includes('Hi , '));
    assert.ok(!s.voicemail.includes('Hi , '));
});

test('the close hands them to Paul rather than letting the caller pitch', () => {
    const s = lostDealScript({ caller: 'Milton', metAt: MET });
    assert.match(s.close, /twenty minutes in with Paul/);
    assert.match(s.close, /No pitch/);
});

test('an event uri reduces to the uuid the invitees route needs', () => {
    assert.equal(eventUuid('https://api.calendly.com/scheduled_events/abc-123'), 'abc-123');
    assert.equal(eventUuid('https://api.calendly.com/scheduled_events/abc-123/'), 'abc-123');
    assert.equal(eventUuid(''), '');
    assert.equal(eventUuid(null), '');
});

// Paul, 2026-10-22: "I would only put people in there after 2 weeks since their sales call, I see
// some recent ones like from today." A meeting this week is a live deal, not a lost one.
test('meetings from the last two weeks are never read into the list', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../api/lost-deals.js', import.meta.url), 'utf8');
    const { COOLING_DAYS } = await import('../api/lost-deals.js');
    assert.equal(COOLING_DAYS, 14);
    // The cut is applied at the source, on the Calendly query, not filtered afterwards.
    assert.match(src, /const until = new Date\(Date\.now\(\) - COOLING_DAYS \* 86400000\)/);
    assert.match(src, /since, until, organization/);
    // And the cache key moved, so a list built before the rule cannot be served after it.
    assert.match(src, /staffify:lost-deals:v2/);
});
