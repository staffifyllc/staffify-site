// Industry as a stored, sourced fact, and the honesty rules Option B rests on.
// ------------------------------------------------------------------
// Paul chose Option B, which groups campaigns by target industry. Of 1,630 live records, ZERO
// store an industry today: the agency cohort reads as real estate media because its campaign id
// says so, not because anything was checked. Rendering that prettier would not make it true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, rate, spansIndustries, offTarget, SAMPLE_FLOOR, CONFIDENCE } from '../api/_campaign-industry.js';

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

test('a few strays do not turn a single-industry campaign into a cross-industry one', () => {
    // The real numbers from the first persisted classification. Under the old "more than one key"
    // rule this moved the main real estate media campaign into the band beside CEO outreach.
    const agency = { 're-media': 1447, 'media-other': 44, property: 8, education: 3, legal: 2, marketing: 1, nonprofit: 1, health: 1, construction: 1 };
    assert.equal(spansIndustries(agency), false, '96% one industry is that industry');
    const off = offTarget(agency);
    assert.equal(off.dominant, 're-media');
    assert.equal(off.strays, 61, 'the strays are reported, not hidden and not promoted');
    // CEO outreach genuinely spans: no sector comes close to a majority.
    assert.equal(spansIndustries({ software: 6, construction: 4, manufacturing: 2, finance: 1, marketing: 1, property: 1, health: 1, nonprofit: 1, education: 1 }), true);
});

// ------------------------------------------------------------------
// The first live preview over the 1,508 filed listing photographers under their CLIENTS'
// industries: "Rancho Photos" as construction, "Bella Photography" as healthcare, "Framed
// Listings" as hospitality, "Realty Pix Media" as property. Their copy says they shoot new-build
// homes, or hotels, or properties, and a keyword classifier read the client as the business.
// Persisting that would have put false industries on Paul's Option B page. These are the real
// cases, as they appeared.
const A = 'staffify-agency-outreach';
const read = (company, excerpt) => classify({ campaignId: A, company, source: { excerpt } });

test('a listing photographer is real estate media, not the industry of the homes it shoots', () => {
    assert.equal(read('Rancho Photos', 'We shoot new construction homes and model homes for builders across the valley.').key, 're-media');
    assert.equal(read('Framed Listings', 'Hotels, rentals and listings photographed with care.').key, 're-media');
    assert.equal(read('Realty Pix Media', 'Property photography for agents who want to win more listings.').key, 're-media');
    assert.equal(read('AK Media', 'Whether you are a realtor looking to sell more properties and win more listings').key, 're-media');
    // A mixed studio that does real estate among other things is still a real estate media business.
    assert.equal(read('Wallace + Sage Photo', 'Wedding, Family, Portrait and Real Estate Photography.').key, 're-media');
});

test('off target only on POSITIVE evidence of another focus', () => {
    const wellness = read('Bella Photography', 'Helping health and wellness brands look their best with lifestyle portraits.');
    assert.equal(wellness.key, 'media-other', 'a genuine finding: possibly not on target');
    assert.match(wellness.why, /Possibly off target/);
    assert.equal(read('Love Story Weddings Photo', 'Capturing your wedding day and engagement sessions across Texas.').key, 'media-other');
});

test('silence is not evidence: a short excerpt that never says real estate stays on the cohort assumption', () => {
    // The mistake the fix nearly made. 120 characters about years of experience prove nothing about
    // what a studio shoots, so it is NOT reported as off target and NOT filed under a client industry.
    for (const [c, ex] of [
        ['Front Door Media', 'Each of our photographers has over 7 years of experience, setting us apart from competitors.'],
        ['Jordan Licon Photography', 'Photography in El Paso: images that make your brand easier to trust.'],
    ]) {
        const v = read(c, ex);
        assert.equal(v.key, 're-media', c);
        assert.equal(v.source, 'campaign', c + ' is labelled as an assumption, not a reading');
        assert.match(v.why, /does not say either way/);
    }
});

test('a non-media business is still read normally', () => {
    // The media rule must not swallow a real non-media business that ended up on the list.
    const v = read('Summit Roofing', 'Residential and commercial roofing contractor serving Denver since 1998.');
    assert.notEqual(v.key, 're-media');
    assert.notEqual(v.key, 'media-other');
});
