// The Instagram question, and everything that must stop it.
// ------------------------------------------------------------------
// Paul's angle is good: if a marketing agency's own marketing is slipping, what else is? But this
// is the easiest line in the script to be wrong about, and being wrong ends the call. Telling an
// agency owner they have stopped marketing themselves, when they posted yesterday on an account we
// never found, earns a hang-up. So most of this file is about the refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramBranch, evidenceVerdict, MIN_POST_AGE_DAYS } from '../api/_instagram-branch.js';
import { handlesOnPage, researchInstagram, instagramPanel } from '../api/_instagram-research.js';

const NOW = Date.parse('2026-10-22T16:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

const good = (over = {}) => ({
    handle: 'wickfire',
    profileUrl: 'https://www.instagram.com/wickfire/',
    profileConfirmed: true,
    profileConfirmedBy: 'linked from their own website, https://wickfire.com/about-us/',
    latestPostAt: daysAgo(34),
    latestPostUrl: 'https://www.instagram.com/p/abc123/',
    checkedAt: daysAgo(1),
    scanned: { feed: true, reels: true },
    pinnedExcluded: true,
    ...over,
});

test('a verified 34-day gap at a marketing agency produces the question', () => {
    const b = instagramBranch({ sector: 'marketing', company: 'Wickfire', evidence: good(), now: NOW });
    assert.ok(b, 'the branch is offered');
    assert.match(b.say, /I noticed your last Instagram post was September 18/);
    assert.match(b.say, /What else gets pushed back when client work gets busy\?/);
    // Paul's own line is kept, with the cue that makes it a joke rather than an accusation.
    assert.match(b.variant.say, /Aren't you guys a marketing agency and you're not even marketing yourselves\?/);
    assert.match(b.variant.delivery, /smiling/);
    assert.equal(b.evidence.ageDays, 34);
    assert.equal(b.evidence.profileUrl, 'https://www.instagram.com/wickfire/');
    assert.equal(b.evidence.postUrl, 'https://www.instagram.com/p/abc123/');
});

test('the claim is about Instagram posting, never about their marketing in general', () => {
    const b = instagramBranch({ sector: 'marketing', company: 'Wickfire', evidence: good(), now: NOW });
    assert.match(b.claim, /Their Instagram specifically/);
    assert.match(b.claim, /does NOT say they have stopped marketing/);
    // The spoken line must not assert a conclusion about the business.
    assert.ok(!/you(r)? (business|company) is/i.test(b.say));
    assert.ok(!/not marketing (anywhere|at all)/i.test(b.say));
});

test('a deliberate channel choice is an answer the caller can take', () => {
    const b = instagramBranch({ sector: 'marketing', company: 'Wickfire', evidence: good(), now: NOW });
    assert.match(b.ifCorrected.say, /plenty of agencies have decided Instagram is not where their clients are/);
    assert.match(b.ifCorrected.note, /Do not argue/);
});

test('it never fires for anyone who is not a marketing agency', () => {
    for (const sector of ['re-media', 'construction', 'finance', null, undefined, 'business'])
        assert.equal(instagramBranch({ sector, company: 'X', evidence: good(), now: NOW }), null, String(sector));
});

test('a recent post means no question at all', () => {
    for (const age of [0, 1, 9]) {
        const v = evidenceVerdict(good({ latestPostAt: daysAgo(age) }), NOW);
        assert.equal(v.ok, false, age + ' days');
        assert.equal(v.postAgeDays, age);
    }
    assert.ok(evidenceVerdict(good({ latestPostAt: daysAgo(MIN_POST_AGE_DAYS) }), NOW).ok, 'exactly 10 days qualifies');
});

test('ABSENCE IS NEVER EVIDENCE: every way of not seeing the account is unknown, not inactive', () => {
    const cases = [
        ['nothing on file', null],
        ['private account', good({ private: true })],
        ['login wall', good({ loginBlocked: true })],
        ['fetch failed', good({ fetchFailed: true })],
        ['no date read', good({ latestPostAt: null })],
        ['unparseable date', good({ latestPostAt: 'sometime last spring' })],
    ];
    for (const [label, ev] of cases) {
        assert.equal(instagramBranch({ sector: 'marketing', company: 'X', evidence: ev, now: NOW }), null, label);
    }
});

test('an unconfirmed profile is refused, because it may be somebody else entirely', () => {
    assert.equal(instagramBranch({ sector: 'marketing', evidence: good({ profileConfirmed: false }), now: NOW }), null);
    assert.equal(instagramBranch({ sector: 'marketing', evidence: good({ profileConfirmedBy: null }), now: NOW }), null);
    assert.match(evidenceVerdict(good({ profileConfirmed: false }), NOW).reason, /may be somebody else/);
});

test('pinned posts and reels: a partial look cannot support the claim', () => {
    // The classic failure: a pinned 2023 post sits at the top of the grid and reads as the latest.
    assert.equal(instagramBranch({ sector: 'marketing', evidence: good({ pinnedExcluded: false }), now: NOW }), null);
    assert.match(evidenceVerdict(good({ pinnedExcluded: false }), NOW).reason, /Pinned posts were not excluded/);
    // And a newer reel that was never looked at.
    assert.equal(instagramBranch({ sector: 'marketing', evidence: good({ scanned: { feed: true, reels: false } }), now: NOW }), null);
    assert.match(evidenceVerdict(good({ scanned: { feed: true, reels: false } }), NOW).reason, /Reels or the grid/);
});

test('evidence we gathered six weeks ago cannot be quoted as fact today', () => {
    const v = evidenceVerdict(good({ checkedAt: daysAgo(40) }), NOW);
    assert.equal(v.ok, false);
    assert.match(v.reason, /too stale to quote/);
    assert.equal(instagramBranch({ sector: 'marketing', evidence: good({ checkedAt: daysAgo(40) }), now: NOW }), null);
});

// ---------- what the caller sees ----------

test('the card shows the state of the research, never a blank the rep has to interpret', () => {
    const verified = instagramPanel({ sector: 'marketing', company: 'Wickfire', evidence: good(), now: NOW });
    assert.equal(verified.status, 'verified_stale_posting');
    assert.match(verified.label, /last post 34 days ago/);
    assert.equal(verified.profileUrl, 'https://www.instagram.com/wickfire/');
    assert.equal(verified.postUrl, 'https://www.instagram.com/p/abc123/');
    assert.equal(verified.checkedAgeDays, 1);
    assert.ok(verified.branch, 'and the question comes with it');

    const recent = instagramPanel({ sector: 'marketing', evidence: good({ latestPostAt: daysAgo(3) }), now: NOW });
    assert.equal(recent.status, 'verified_recent');
    assert.equal(recent.branch, null);
    assert.match(recent.detail, /Do not raise it/);

    const unknown = instagramPanel({ sector: 'marketing', evidence: good({ loginBlocked: true }), now: NOW });
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.branch, null);
    assert.match(unknown.warning, /Not seeing posts is not the same as there being none/);

    const stale = instagramPanel({ sector: 'marketing', evidence: good({ checkedAt: daysAgo(40) }), now: NOW });
    assert.equal(stale.status, 'stale');
    assert.match(stale.detail, /being rechecked/);

    assert.equal(instagramPanel({ sector: 'marketing', evidence: null, now: NOW }).status, 'unknown');
    assert.equal(instagramPanel({ sector: 'construction', evidence: good(), now: NOW }), null, 'not shown to a builder');
});

test('a rep can flag it wrong and the question stops immediately', () => {
    const p = instagramPanel({ sector: 'marketing', company: 'Wickfire', evidence: good(),
        flagged: { wrong: true, by: 'Milton', note: 'that is their founder, not the agency' }, now: NOW });
    assert.equal(p.status, 'flagged');
    assert.equal(p.branch, null, 'suppressed pending correction');
    assert.match(p.detail, /Milton flagged this/);
    assert.match(p.detail, /their founder, not the agency/);
});

// ---------- finding the handle ----------

test('the handle comes from their own website, which is the business telling us', async () => {
    const page = { url: 'https://wickfire.com/', html: '<a href="https://www.instagram.com/wickfire/">Follow us</a>' };
    const ev = await researchInstagram({ website: 'https://wickfire.com/', fetchSite: async () => page, now: NOW });
    assert.equal(ev.handle, 'wickfire');
    assert.equal(ev.profileConfirmed, true);
    assert.match(ev.profileConfirmedBy, /linked from their own website/);
    // But the date is still unknown, and it says why rather than leaving an empty field.
    assert.equal(ev.latestPostAt, null);
    assert.match(ev.unknownReason, /no post dates to a logged-out request/);
    assert.equal(instagramBranch({ sector: 'marketing', evidence: ev, now: NOW }), null);
});

test('post and reel URLs are not mistaken for the profile', () => {
    const found = handlesOnPage({ html: `
        <a href="https://www.instagram.com/p/Cabc123/">a post</a>
        <a href="https://www.instagram.com/reel/Cxyz/">a reel</a>
        <a href="https://www.instagram.com/explore/tags/design/">tag</a>
        <a href="https://www.instagram.com/accounts/login/">login</a>
        <a href="https://www.instagram.com/wickfire/">the agency</a>` });
    assert.deepEqual(found, ['wickfire']);
});

test('two linked accounts is ambiguous, so nothing is claimed', async () => {
    const page = { url: 'https://x.com/', html: '<a href="https://www.instagram.com/agency/">a</a><a href="https://www.instagram.com/founder/">b</a>' };
    const ev = await researchInstagram({ website: 'https://x.com/', fetchSite: async () => page, now: NOW });
    assert.equal(ev.profileConfirmed, false);
    assert.equal(ev.candidates.length, 2);
    assert.match(ev.unknownReason, /which one is the business is not settled/);
});

test('a dead website is recorded as a failed look, not as an absent account', async () => {
    const ev = await researchInstagram({ website: 'https://x.com/', fetchSite: async () => { throw new Error('ETIMEDOUT'); }, now: NOW });
    assert.equal(ev.fetchFailed, true);
    assert.equal(ev.profileConfirmed, false);
    assert.match(ev.unknownReason, /could not be read/);
    assert.equal(instagramPanel({ sector: 'marketing', evidence: ev, now: NOW }).status, 'unknown');
});
