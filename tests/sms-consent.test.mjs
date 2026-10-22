// Who we are allowed to text, and the proof required.
// ------------------------------------------------------------------
// Paul, 2026-10-22: one-click texting from the Hub. The same feature was switched off on
// 2026-09-15 for texting people after a no-answer: "Proceed with consent-based OpenPhone texting.
// Do not build or enable cold SMS." Quo prohibits it and the account loses the number.
//
// The click is back. The gate is what makes that safe, so this tests the refusals hardest.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.KV_REST_API_URL = 'https://example.invalid';
process.env.KV_REST_API_TOKEN = 'test';
process.env.QUO_API_KEY = 'test-key';

const { mayText, recordSpokenConsent, CONSENT_KEY } = await import('../api/_sms-consent.js');

const store = (seed = {}) => ({
    _: seed,
    async get(k) { return seed[k] ?? null; },
    async set(k, v) { seed[k] = v; return 'OK'; },
});
function quo({ inbound = [], fail = false } = {}) {
    globalThis.fetch = async (url) => {
        const u = new URL(String(url));
        if (u.host !== 'api.quo.com') return { ok: true, status: 200, headers: { get: () => null }, text: async () => '[]', json: async () => [] };
        if (fail) return { ok: false, status: 503, text: async () => '{"message":"down"}' };
        const from = u.searchParams.get('from');
        return { ok: true, status: 200, json: async () => ({ data: inbound.filter(m => m.from === from), nextCursor: null }) };
    };
}
const NO_OPTOUT = { isOptedOut: async () => false };
const msg = (from, text, at = '2026-10-20T14:00:00Z') => ({ from, text, direction: 'incoming', createdAt: at });

test('somebody who texted us first may be texted back', async () => {
    quo({ inbound: [msg('+15615551234', 'who is this?')] });
    const out = await mayText({ deps: NO_OPTOUT, redis: store(), email: 'dana@example.com', phone: '+15615551234' });
    assert.equal(out.allowed, true);
    assert.equal(out.basis, 'they_texted_us');
    assert.match(out.evidence.text, /who is this/);
});

test('a no-answer is NOT consent, which is the whole reason this was switched off', async () => {
    quo({ inbound: [] });
    const out = await mayText({ deps: NO_OPTOUT, redis: store(), email: 'dana@example.com', phone: '+15615551234' });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /A no-answer is not consent/);
    assert.equal(out.basis, null);
});

test('asking on a call counts, and the record says who heard it', async () => {
    quo({ inbound: [] });
    const redis = store();
    const rec = await recordSpokenConsent({ redis, email: 'dana@example.com', phone: '+15615551234', by: 'Milton', heardOn: 'the call on 22 October', note: 'asked for pricing by text' });
    assert.equal(rec.ok, true);
    assert.ok(redis._[CONSENT_KEY('dana@example.com')], 'it is stored against the person');

    const out = await mayText({ deps: NO_OPTOUT, redis, email: 'dana@example.com', phone: '+15615551234' });
    assert.equal(out.allowed, true);
    assert.equal(out.basis, 'asked_on_a_call');
    assert.match(out.reason, /Milton recorded/);
    assert.equal(out.evidence.by, 'Milton');
});

test('a do-not-contact beats consent they gave earlier', async () => {
    quo({ inbound: [msg('+15615551234', 'yes send it')] });
    const redis = store();
    await recordSpokenConsent({ redis, email: 'dana@example.com', phone: '+15615551234', by: 'Milton' });
    // isOptedOut reads the same store; put the number on the list.
    const { optOut } = await import('../api/_optout.js');
    // optOut writes through the real client, which is not wired here, so assert the gate's own
    // ordering instead: the opt-out check runs before either consent path.
    assert.equal(typeof optOut, 'function');
    const src = (await import('node:fs')).readFileSync(new URL('../api/_sms-consent.js', import.meta.url), 'utf8');
    assert.ok(src.indexOf('isOptedOut') < src.indexOf('they_texted_us'), 'opt-out is checked first');
});

test('an unreadable Quo means no send, never an assumed yes', async () => {
    quo({ fail: true });
    const out = await mayText({ deps: NO_OPTOUT, redis: store(), email: 'dana@example.com', phone: '+15615551234' });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /consent cannot be confirmed/);
});

test('no number means no send', async () => {
    quo({ inbound: [msg('+15615551234', 'hi')] });
    const out = await mayText({ deps: NO_OPTOUT, redis: store(), email: 'dana@example.com', phone: '' });
    assert.equal(out.allowed, false);
    assert.match(out.reason, /No phone number/);
});

test('consent is per person, not a blanket switch', async () => {
    quo({ inbound: [msg('+15615551234', 'hi')] });
    const redis = store();
    const yes = await mayText({ deps: NO_OPTOUT, redis, email: 'dana@example.com', phone: '+15615551234' });
    const no = await mayText({ deps: NO_OPTOUT, redis, email: 'someone@example.com', phone: '+15615559999' });
    assert.equal(yes.allowed, true);
    assert.equal(no.allowed, false, 'a different number gets no benefit from theirs');
});

// Paul, 2026-10-22: "can you just wire up what I tell you to?" The consent check no longer blocks
// a send. It still runs and is recorded, and the suppression list still blocks outright, because
// that one is his own rule rather than a judgement of mine.
test('the send is not blocked by consent, but every send carries what it found', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../api/send-text.js', import.meta.url), 'utf8');
    assert.match(src, /const consent = await mayText\(/, 'it is still checked');
    assert.ok(!/if \(!consent\.allowed\)[\s\S]{0,120}return/.test(src), 'and no longer blocks');
    assert.match(src, /consentBasis: consent\.basis/, 'the basis is written into the audit record');
    assert.match(src, /consent: \{ basis: consent\.basis/, 'and returned to whoever sent it');
});

test('the guards that are Paul\'s own rules still block', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../api/send-text.js', import.meta.url), 'utf8');
    // A do-not-contact stops the send outright. He asked for that today.
    assert.match(src, /if \(await isOptedOut\(\{ phone: to \}\)\)/);
    // And the rest of the original guards survived the rewiring.
    for (const guard of ['UNSUPPORTABLE', 'too_long', 'SENT_KEY'])
        assert.ok(src.includes(guard), 'still guarded by ' + guard);
});

test('the outreach text is true of everyone it can be sent to', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../api/send-text.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('function outreachMessage'), src.indexOf('function monthOf'));
    // No role is claimed, because nobody in this cohort posted one. That exact claim got
    // "where for you see the role posted" back within a minute on 2026-08-12.
    assert.ok(!/role/.test(fn), 'it never mentions a role');
    assert.ok(!/you posted/.test(fn), 'and never claims they posted anything');
    assert.match(fn, /Just tried you/, 'the call just happened, which is true');
    assert.match(fn, /emails/, 'the email count comes from the record');
});
