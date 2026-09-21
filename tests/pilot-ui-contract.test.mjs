// THE RENDERER AND THE HANDLER HAVE TO AGREE.
//
// Every one of these exists because a scope shipped on the server with no control in the hub, so
// the feature was real and unreachable. These read both actual files and compare them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const UI = readFileSync(new URL('../assets/js/pilot-queue.js', import.meta.url), 'utf8');
const API = readFileSync(new URL('../api/pilot-queue.js', import.meta.url), 'utf8');

const uiScopes = [...UI.matchAll(/scope:\s*'([a-z-]+)'/g)].map((m) => m[1]);
const apiScopes = [...API.matchAll(/scope === '([a-z-]+)'/g)].map((m) => m[1]);

test('every scope the handler accepts has a control that calls it', () => {
    const missing = [...new Set(apiScopes)].filter((s) => !uiScopes.includes(s));
    assert.deepEqual(missing, [], `scopes with no control in the hub: ${missing.join(', ')}`);
});

test('every scope the hub calls is one the handler accepts', () => {
    const unknown = [...new Set(uiScopes)].filter((s) => !apiScopes.includes(s));
    assert.deepEqual(unknown, [], `the hub calls scopes the handler does not accept: ${unknown.join(', ')}`);
});

test('the handler accepts the scopes this workflow needs', () => {
    for (const s of ['draft', 'save-draft', 'sync', 'start-opportunity', 'payment-candidates', 'payment-link', 'retry-alert', 'request', 'cohort']) {
        assert.ok(apiScopes.includes(s), `handler is missing scope ${s}`);
    }
});

test('the hub has the controls a person actually presses', () => {
    for (const [what, marker] of [
        ['start an opportunity from a cohort record', 'data-startopp'],
        ['open the payment evidence panel', 'data-payopen'],
        ['link a candidate invoice', 'data-link'],
        ['save a draft', 'data-dsave'],
        ['open the draft in a mail client', 'data-dmail'],
        ['rebuild a draft from the structured fields', 'data-drebuild'],
        ['run a sync', 'data-sync'],
    ]) {
        assert.ok(UI.includes(marker), `no control to ${what} (${marker})`);
    }
});

test('the mail action is built from what is on screen, not from a stale server string', () => {
    assert.ok(!/href="'\s*\+\s*esc\(j\.mailto\)/.test(UI), 'the mailto href must not come from the server response');
    assert.ok(/data-dmail/.test(UI) && /window\.location\.href = 'mailto:'/.test(UI),
        'the mail action has to assemble the mailto at click time');
    // The click handler reads the textarea, so an edit cannot be silently dropped.
    const handler = UI.slice(UI.indexOf('data-dmail]'), UI.indexOf('data-dsave]'));
    assert.match(handler, /current\(\)/, 'the mail action must read the current field values');
});

test('a draft that is not ready cannot be opened in a mail client', () => {
    assert.match(UI, /ready\s*\?[\s\S]{0,200}data-dmail[\s\S]{0,200}disabled/,
        'the send action must be disabled while required fields are missing');
});

test('the structured fields a role map and a proposal need are on screen', () => {
    for (const f of ['tasks', 'hours', 'assumption', 'successMeasure', 'nextStep']) {
        assert.ok(UI.includes(`['${f}'`), `roleMap field ${f} is not offered`);
    }
    for (const f of ['role', 'level']) assert.ok(UI.includes(`['${f}'`), `proposal field ${f} is not offered`);
    // And they reach the generator.
    assert.match(UI, /options: options \|\| \{\}/, 'the structured fields must be sent as draft options');
});

test('the request list does not label a promoted cohort record as an inbound request', () => {
    assert.ok(!/arm: 'inbound',\n\s*\}\)\);/.test(API), 'the arm must come from the record');
    assert.match(API, /arm: r\.arm \|\| 'inbound'/);
    assert.match(UI, /opened from the cohort/);
    assert.match(UI, /booked the call directly/, 'a direct booking is labelled as one');
    // Three origins, counted apart: the form, a direct booking, and a promoted cohort record.
    assert.match(UI, /from the page, ' \+ booked \+/, 'the three origins are counted apart');
    assert.match(UI, /by\('direct_booking'\)/);
});

test('payment-link reads the request before it writes anything', () => {
    const block = API.slice(API.indexOf("scope === 'payment-link'"), API.indexOf("scope === 'retry-alert'"));
    // Match the actual calls. A first draft of this test matched the word "hset" inside a comment
    // and failed on correct code, which is its own small lesson about asserting on prose.
    const read = block.indexOf('redis.hgetall');
    const write = block.indexOf('redis.hset');
    assert.ok(read > -1, 'payment-link must read the request');
    assert.ok(read < write, 'the read has to happen before the write, or a bad id creates a ghost record');
    assert.match(block, /no such request/);
});

test('save-draft also reads first, so it cannot invent a record', () => {
    const block = API.slice(API.indexOf("scope === 'save-draft'"), API.indexOf("scope === 'sync'"));
    assert.ok(block.indexOf('redis.hgetall') > -1);
    assert.ok(block.indexOf('redis.hgetall') < block.indexOf('redis.hset'));
    assert.match(block, /no such request/);
});

test('health asks the matcher, not the environment, which event types count', () => {
    const block = API.slice(API.indexOf('calendly:'), API.indexOf('email: {'));
    assert.match(block, /expectedEventTypes\(\)/, 'health must call the same function the matcher uses');
    assert.ok(!/PILOT_EVENT_TYPES \? '' :/.test(block), 'it must not decide from the env var alone');
    // And the note has to reflect the shipped default rather than calling it unset.
    assert.match(block, /counting bookings on/);
});
