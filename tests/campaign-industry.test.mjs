// Industry as a stored, sourced fact, and the honesty rules Option B rests on.
// ------------------------------------------------------------------
// Paul chose Option B, which groups campaigns by target industry. Of 1,630 live records, ZERO
// store an industry today: the agency cohort reads as real estate media because its campaign id
// says so, not because anything was checked. Rendering that prettier would not make it true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, rate, spansIndustries, SAMPLE_FLOOR, CONFIDENCE } from '../api/_campaign-industry.js';

const row = (over = {}) => ({ campaignId: 'staffify-tobit-outreach', company: 'Example Co', source: {}, ...over });

test('a person who set it outranks everything, and the record says who', () => {
    const v = classify(row({ company: 'Totally Ambiguous LLC' }), { stated: { key: 'hvac', label: 'HVAC', by: 'Paul', at: '2026-10-22T10:00:00Z' } });
    assert.equal(v.key, 'hvac');
    assert.equal(v.source, 'stated');
    assert.match(v.why, /Set by Paul/);
});

test('their own website copy beats the name, and the name beats nothing', () => {
    const fromCopy = classify(row({ company: 'Boot Civil', source: { excerpt: 'We are a civil engineering firm handling site work across central Texas.' } }));
    assert.equal(fromCopy.key, 'construction');
    assert.equal(fromCopy.source, 'read');
    assert.match(fromCopy.why, /website copy/);

    const fromName = classify(row({ company: 'Jefferson Bank', source: {} }));
    assert.equal(fromName.key, 'finance');
    assert.match(fromName.why, /company name/);
});

test('the campaign assumption is kept, but LABELLED as an assumption', () => {
    // This is the 1,508-record case. It is true of the cohort and unverified per business, and the
    // difference has to survive into the data rather than being flattened into a fact.
    const v = classify({ campaignId: 'staffify-agency-outreach', company: '', source: {} });
    assert.equal(v.key, 're-media');
    assert.equal(v.source, 'campaign');
    assert.equal(v.confidence, 'campaign');
    assert.match(v.why, /Not verified for this business/);
    assert.match(CONFIDENCE.campaign, /unverified per business/i);
});

test('a record we cannot read stays unclassified rather than joining its campaign', () => {
    const v = classify(row({ company: '', source: {}, campaignId: 'staffify-tobit-outreach' }));
    assert.equal(v.key, null);
    assert.equal(v.source, 'none');
    assert.match(v.why, /We do not know what they do/);
});

test('a small sample never prints a rate that would outrank a real one', () => {
    const strong = rate(38, 779);
    const weak = rate(2, 24);
    assert.equal(strong.label, '4.9%');
    assert.equal(strong.note, '38 of 779');
    // 2 of 24 is 8.3% and would sort above 4.9% on any page that printed it.
    assert.equal(weak.label, '—');
    assert.equal(weak.value, null);
    assert.match(weak.note, new RegExp('below ' + SAMPLE_FLOOR));
    assert.equal(rate(1, SAMPLE_FLOOR).small, false, 'exactly 30 qualifies');
});

test('unknown and zero are different things', () => {
    const noData = rate(0, null);
    const nothingSent = rate(0, 0);
    const lookedAndZero = rate(0, 500);
    assert.equal(noData.unknown, true);
    assert.equal(noData.label, '—');
    assert.equal(nothingSent.unknown, true);
    assert.match(nothingSent.note, /nothing sent/);
    assert.equal(lookedAndZero.unknown, false);
    assert.equal(lookedAndZero.label, '0%', 'we checked 500 and it is genuinely zero');
});

test('spanning is read from the prospects, not declared', () => {
    assert.equal(spansIndustries({ software: 6, construction: 4, finance: 1 }), true);
    assert.equal(spansIndustries({ 're-media': 779 }), false);
    assert.equal(spansIndustries({}), false);
    assert.equal(spansIndustries({ 're-media': 779, null: 12 }), false, 'unclassified rows do not make it span');
});
