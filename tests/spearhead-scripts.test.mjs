// A script per Spearhead account, and the lines it must never cross.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "I need to get scripts that pertain to these different companies for each and
// every single one for spearhead accounts."
//
// The hard part is not writing 21 scripts. It is writing 21 scripts without inventing anything.
// None of the 21 records carries a researched excerpt, so the temptation is to fill the gap from
// outside knowledge of the company. On a CEO call that is the fastest way to be caught out, and
// the caller truth rules forbid it outright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spearheadScript, sectorFor } from '../api/_spearhead-scripts.js';

// The real cohort.
const COHORT = [
    ['Diebold Nixdorf', 'https://www.dieboldnixdorf.com/en-us/', 'Octavio', 'manufacturing'],
    ['Drako Motors', 'https://www.drakomotors.com/', 'Dean', 'manufacturing'],
    ['Securiti', 'https://securiti.ai/about/', 'Rehan', 'software'],
    ['Zenoti', 'https://www.zenoti.com/', 'Sudheer', 'software'],
    ['Frontline Education', 'https://www.frontlineeducation.com/', 'Matthew', 'education'],
    ['Forcepoint', 'https://www.forcepoint.com/', 'Ryan', 'software'],
    ['nCino', 'https://investor.ncino.com/', 'Sean', 'software'],
    ['Rubrik, Inc.', 'https://www.rubrik.com/', 'Bipul', 'software'],
    ['HighRadius', 'https://www.highradius.com/', 'Sashi', 'software'],
    ['Arch-Con Corporation', 'https://www.arch-con.com/who-we-are/', 'Matt', 'construction'],
    ['McKinstry', 'https://www.mckinstry.com/who-we-are/', '', 'construction'],
    ['Boot Civil', 'https://www.bootcivil.com/', '', 'construction'],
    ['Jefferson Bank', 'https://www.jeffersonbank.com/about', 'Kyle', 'finance'],
    ['Wickfire', 'https://www.wickfire.com/about-us/', 'Katy', 'marketing'],
    ['AOG Living', 'https://www.aogliving.com/', 'Kristin', 'property'],
    ['Vivent Health', 'https://viventhealth.org/our-approach/', 'Joseph', 'health'],
    ['HeartGift', 'https://heartgift.org/about-us/', '', 'nonprofit'],
    ['Ardmore Roderick', 'https://www.ardmoreroderick.com/markets/energy-utilities/', 'Kelly', 'construction'],
    ['CPM Texas', 'https://www.cpmtx.com/', '', null],
    ['HPI', 'https://www.hpitx.com/', 'Jordan', null],
    ['T. Kerr Group', 'https://www.tkerrgroup.com/', '', null],
];

test('every account in the cohort gets a complete, usable script', () => {
    for (const [company, website, firstName] of COHORT) {
        const s = spearheadScript({ company, website, firstName, caller: 'Milton', sentTouches: 4, subject: 'A quick hello' });
        assert.ok(s.opener.includes('Staffify'), company);
        assert.ok(s.opener.includes('Milton'), company);
        assert.equal(s.questions.length, 5, company + ' gets four questions and a close');
        assert.ok(s.questions.every(q => typeof q === 'string' && q.length > 30), company);
        assert.equal(s.stages.length, 5, company);
        assert.ok(s.voicemail.includes(company), company);
        assert.ok(s.bookingUrl.startsWith('https://'), company);
        assert.ok(s.reason.includes('seven figures'), company);
    }
});

test('the sector drives the questions, so a bank and a builder are not asked the same thing', () => {
    for (const [company, website, firstName, expected] of COHORT) {
        if (!expected) continue;
        assert.equal(sectorFor({ company, website }).key, expected, company);
    }
    const bank = spearheadScript({ company: 'Jefferson Bank', website: 'https://www.jeffersonbank.com/about', caller: 'Milton' });
    const builder = spearheadScript({ company: 'Boot Civil', website: 'https://www.bootcivil.com/', caller: 'Milton' });
    const charity = spearheadScript({ company: 'HeartGift', website: 'https://heartgift.org/about-us/', caller: 'Milton' });
    assert.match(bank.questions[0], /reconciliation|onboarding files/);
    assert.match(builder.questions[0], /submittals|RFIs|takeoffs/);
    assert.match(charity.questions[0], /donor|grant/);
    assert.notEqual(bank.questions[0], builder.questions[0]);
    assert.notEqual(builder.questions[0], charity.questions[0]);
});

test('it never invents a fact about the company', () => {
    const s = spearheadScript({ company: 'Rubrik, Inc.', website: 'https://www.rubrik.com/', firstName: 'Bipul', caller: 'Milton', sentTouches: 4 });
    assert.equal(s.sourcedFact, null, 'no excerpt on file means no claim');
    assert.match(s.sourcedFactNote, /Do not invent one/);
    const whole = JSON.stringify(s).toLowerCase();
    // The shape of a fabricated claim: telling the prospect what they do or what they just did.
    for (const tell of ['i saw that you', 'i noticed you', 'i read that', 'congratulations on', 'i see you just'])
        assert.ok(!whole.includes(tell), 'no fabricated observation: ' + tell);
});

test('a real sourced sentence is offered, and marked as safe to reference', () => {
    const s = spearheadScript({ company: 'Boot Civil', website: 'https://www.bootcivil.com/', excerpt: 'We are a civil engineering firm serving central Texas.', caller: 'Milton' });
    assert.equal(s.sourcedFact, 'We are a civil engineering firm serving central Texas.');
    assert.match(s.sourcedFactNote, /their own website/);
});

test('the opener states only what is checkable, and says it is a cold call', () => {
    const s = spearheadScript({ company: 'Zenoti', firstName: 'Sudheer', caller: 'Milton', sentTouches: 4, subject: 'A quick hello, Sudheer' });
    assert.match(s.opener, /this is a cold call/i, 'he says what it is');
    assert.match(s.opener, /4 emails/, 'the count is the real one');
    assert.match(s.opener, /A quick hello, Sudheer/, 'the subject they would recognise');
    assert.match(s.opener, /Have I caught you in the middle of something\?/);

    // With nothing sent, it must not claim we emailed them.
    const cold = spearheadScript({ company: 'Zenoti', firstName: 'Sudheer', caller: 'Milton', sentTouches: 0 });
    assert.ok(!/emails/.test(cold.opener), 'no invented email history');
    assert.match(cold.opener, /We have not spoken before/);
});

test('an inferred sector is flagged as an assumption, never as something to assert', () => {
    const named = spearheadScript({ company: 'Jefferson Bank', caller: 'Milton' });
    assert.equal(named.sector.source, 'named');
    assert.match(named.sectorNote, /starting point, not something to assert/);

    const unknown = spearheadScript({ company: 'T. Kerr Group', website: 'https://www.tkerrgroup.com/', caller: 'Milton' });
    assert.equal(unknown.sector.key, null);
    assert.match(unknown.sectorNote, /Ask, do not assume/);
    assert.equal(unknown.questions.length, 5, 'and still gets a full script');
});

test('a company whose name does not say what it does is NOT guessed at', () => {
    // Four wrong questions is a dead call, so these three get the general script that asks rather
    // than one that assumes. Being honestly generic beats being confidently wrong.
    for (const company of ['CPM Texas', 'HPI', 'T. Kerr Group']) {
        const s = spearheadScript({ company, caller: 'Milton' });
        assert.equal(s.sector.key, null, company);
        assert.match(s.sectorNote, /Ask, do not assume/, company);
        assert.equal(s.questions.length, 5, company + ' still gets a full script');
    }
});

test('a missing first name degrades politely rather than printing a blank', () => {
    const s = spearheadScript({ company: 'McKinstry', firstName: '', caller: 'Milton', sentTouches: 4 });
    assert.match(s.opener, /Hi there, this is Milton/);
    assert.ok(!s.opener.includes('Hi , '));
    assert.ok(!s.voicemail.includes('Hi , '));
});
