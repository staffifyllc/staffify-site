// The opener is chosen by what has replied, and a rate is never claimed early.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attribute, chooseVariant, openerFor, variantsFor, MIN_SENDS, EXPLORE_SHARE } from '../api/_copy-variants.js';
import { copyIssue, INTRO_VERSION } from '../api/_outreach-copy.js';
import { CAMPAIGN_ID } from '../api/_outreach-campaign.js';

const B = 'handoff-list-2026-10-23';
const rec = (i, copyVersion, { replied = false, hold = false, subject = 'x' } = {}) => ({ id: 'r' + i, campaignId: CAMPAIGN_ID, recipient: `p${i}@x.com`, copyVersion, status: hold ? 'human_reply_hold' : 'sent',
    events: [{ kind: 'sent', at: '2026-10-0' + (1 + (i % 9)) + 'T12:00:00Z', subject }, ...(replied ? [{ kind: 'received', at: '2026-10-10T12:00:00Z' }] : [])] });

test('every new opener is complete, in the house voice, and passes the copy checks', () => {
    for (const v of variantsFor(CAMPAIGN_ID)) for (const owner of ['Paul', 'Madison']) {
        const body = v.body(owner, 'Tom');
        assert.ok(!/—/.test(body) && !/—/.test(v.subject), v.id + ': no em dashes');
        assert.ok(!/\b(guarantee[ds]? (results|placement)|dozens|hundreds of|thousands of|best in|risk[- ]free|\d+\s?%)/i.test(body), v.id + ': no claim we cannot back');
        assert.ok(/kick rocks|prefer no more emails/.test(body), v.id + ': an opt-out line');
        assert.ok(/Flylisted/.test(body), v.id + ': Flylisted is named');
        assert.ok(!/30-day/.test(body), 'lifetime, never 30-day');
        assert.equal(copyIssue({ owner, bodyText: body, subject: v.subject }), null, v.id + ' passes copyIssue for ' + owner);
        assert.match(body, /^(Hey|Hi) Tom,/);
        if (owner === 'Madison') assert.ok(!/\bI built Flylisted\b/.test(body), 'Madison attributes Flylisted to Paul');
    }
    const o = openerFor(variantsFor(CAMPAIGN_ID).find(v => v.id === B), 'Paul', null);
    assert.equal(o.copyVersion, B); assert.match(o.bodyText, /^Hey there,/); assert.equal(o.subject, '15 tasks to hand off after the shoot');
});

test('attribution: by copy version, with the subject as the fallback for older rows, and no rate below the minimum', () => {
    const records = [
        ...Array.from({ length: 50 }, (_, i) => rec(i, INTRO_VERSION, { replied: i < 3 })),                 // 6%
        ...Array.from({ length: 10 }, (_, i) => rec(100 + i, B, { replied: i < 2 })),                      // too few
        ...Array.from({ length: 5 }, (_, i) => rec(200 + i, null, { subject: 'Re: same feedback, every video?', replied: i === 0 })),
        { id: 'other', campaignId: 'staffify-tobit-outreach', copyVersion: 'ceo', events: [{ kind: 'sent', at: '2026-10-01T12:00:00Z' }] },
        { id: 'unsent', campaignId: CAMPAIGN_ID, copyVersion: INTRO_VERSION, events: [] },
    ];
    const s = attribute(records, { campaignId: CAMPAIGN_ID, meetingsByEmail: new Set(['p0@x.com', 'p100@x.com']) });
    const a = s.variants.find(v => v.id === INTRO_VERSION), b = s.variants.find(v => v.id === B), old = s.variants.find(v => v.id.startsWith('subject:'));
    assert.equal(a.sends, 50); assert.equal(a.replies, 3); assert.equal(a.replyRate, 6); assert.equal(a.meetings, 1); assert.equal(a.meetingRate, 2); assert.equal(a.enough, true);
    assert.equal(b.sends, 10); assert.equal(b.replyRate, null); assert.match(b.note, /needs 40/); assert.equal(b.meetings, 1);
    assert.equal(old.sends, 5); assert.equal(old.label, 'Earlier copy'); assert.equal(old.active, false); assert.equal(old.subject, 'Same feedback, every video?', 'normalised: no Re:, first letter up');
    assert.equal(s.leader, INTRO_VERSION, 'the only version with enough sends leads');
    assert.ok(!s.variants.some(v => v.id === 'ceo'), 'another campaign is not counted');
    assert.equal(s.minSends, MIN_SENDS);
    // Nothing sent at all: both offered variants still appear, nobody leads.
    const none = attribute([], { campaignId: CAMPAIGN_ID });
    assert.deepEqual(none.variants.map(v => v.id).sort(), [INTRO_VERSION, B, 'conversational-2026-10-04', 'practical-handoff-2026-10-23'].sort()); assert.equal(none.leader, null); assert.equal(none.variants[0].note, 'Not sent yet');
});

test('the chooser rotates evenly with no leader, then gives the leader its share and the rest to the others', () => {
    const noLeader = attribute([], { campaignId: CAMPAIGN_ID });
    const picks = Array.from({ length: 100 }, (_, i) => chooseVariant(noLeader, { campaignId: CAMPAIGN_ID, roll: i / 100 }).id);
    for (const id of [INTRO_VERSION, B, 'conversational-2026-10-04', 'practical-handoff-2026-10-23']) assert.equal(picks.filter(p => p === id).length, 25, id + ' gets a quarter with no leader');
    const records = Array.from({ length: 60 }, (_, i) => rec(i, B, { replied: i < 6 }));
    const led = attribute(records, { campaignId: CAMPAIGN_ID });
    assert.equal(led.leader, B);
    const picks2 = Array.from({ length: 100 }, (_, i) => chooseVariant(led, { campaignId: CAMPAIGN_ID, roll: i / 100 }).id);
    assert.equal(picks2.filter(p => p === B).length, 100 - EXPLORE_SHARE * 100); for (const id of [INTRO_VERSION, 'conversational-2026-10-04', 'practical-handoff-2026-10-23']) assert.ok(Math.abs(picks2.filter(p => p === id).length - EXPLORE_SHARE * 100 / 3) <= 1, id + ' shares the exploring slice');
    assert.equal(chooseVariant(led, { campaignId: 'no-such-campaign' }), null);
    // A leader that stops winning stops leading: the other overtakes once it has the sends.
    const flipped = attribute([...records, ...Array.from({ length: 60 }, (_, i) => rec(500 + i, INTRO_VERSION, { replied: i < 12 }))], { campaignId: CAMPAIGN_ID });
    assert.equal(flipped.leader, INTRO_VERSION);
});

test('a personalised subject is one opener, not one bucket per company, and the one-off tail folds into a single line', async () => {
    const { subjectKey } = await import('../api/_copy-variants.js');
    assert.equal(subjectKey('A practical handoff for Sky Visuals', 'Sky Visuals'), 'subject:a practical handoff for {company}');
    assert.equal(subjectKey('Re: A practical handoff for Estate Media', 'Estate Media'), 'subject:a practical handoff for {company}');
    assert.equal(subjectKey('A practical handoff for Joas Souza - Architectural', 'Different Name'), 'subject:a practical handoff for {company}', 'the "for X" tail is collapsed even when the company field differs');
    assert.equal(subjectKey('The work between shoots', 'Sky Visuals'), 'subject:the work between shoots');
    const recs = [
        ...Array.from({ length: 40 }, (_, i) => ({ id: 'h' + i, campaignId: CAMPAIGN_ID, recipient: `h${i}@x.com`, company: 'Co ' + i, events: [{ kind: 'sent', at: '2026-09-29T12:00:00Z', subject: 'A practical handoff for Co ' + i }, ...(i < 2 ? [{ kind: 'received', at: '2026-09-30T12:00:00Z' }] : [])] })),
        ...['same feedback, every video?', 'who edits when it gets busy?', 'real estate media staffing'].flatMap((subj, k) => Array.from({ length: 2 }, (_, i) => ({ id: 's' + k + i, campaignId: CAMPAIGN_ID, recipient: `s${k}${i}@x.com`, company: 'Z', events: [{ kind: 'sent', at: '2026-09-17T12:00:00Z', subject: subj }] }))),
    ];
    const s = attribute(recs, { campaignId: CAMPAIGN_ID });
    const handoff = s.variants.find(v => v.id === 'subject:a practical handoff for {company}');
    assert.equal(handoff.sends, 40); assert.equal(handoff.replies, 2); assert.equal(handoff.replyRate, 5);
    assert.equal(handoff.subject, 'A practical handoff for {company}', 'the template, not the first company it was sent to');
    const other = s.variants.find(v => v.id === 'subject:other');
    assert.equal(other.sends, 6); assert.equal(other.label, 'Other earlier subjects'); assert.match(other.subject, /3 subjects/);
    assert.ok(!s.variants.some(v => v.id === 'subject:same feedback, every video?'), 'the tiny buckets are folded, not listed');
    assert.equal(s.leader, null, 'a retired opener never leads');
});

test('a personalised subject renders with the company and falls back when there is none', () => {
    const v = variantsFor(CAMPAIGN_ID).find(x => x.id === 'practical-handoff-2026-10-23');
    assert.equal(openerFor(v, 'Paul', 'Tom', 'Sky Visuals').subject, 'A practical handoff for Sky Visuals');
    assert.equal(openerFor(v, 'Paul', 'Tom', '').subject, 'A practical handoff for your team');
    assert.match(openerFor(v, 'Madison', null, 'X').bodyText, /^Hi there,\n\nI'm Madison with Staffify/);
    assert.equal(attribute([], { campaignId: CAMPAIGN_ID }).variants.find(x => x.id === v.id).subject, 'A practical handoff for {company}');
});
