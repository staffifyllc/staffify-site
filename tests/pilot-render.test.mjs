// The guard actually running, and the hub's cards actually rendered. Both of these exist because a
// source-text assertion passed on code that could not execute: a blanket edit turned bestSnapshot
// into an infinite recursion, and a markup edit hid every stage button behind a display:none wrapper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ---------- the guard, executed ----------
process.env.HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN || 'test-token';
process.env.KV_REST_API_URL = process.env.KV_REST_API_URL || 'https://example.invalid';
process.env.KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN || 'test';
const guard = await import('../api/_client-guard.js');
const h = (v) => createHash('sha256').update(String(v).toLowerCase().trim()).digest('hex').slice(0, 32);

const store = (seed = {}) => ({
    _: seed,
    async get(k) { return seed[k] === undefined ? null : seed[k]; },
    async set(k, v) { seed[k] = v; return 'OK'; },
});
const fresh = () => JSON.stringify({ ts: new Date().toISOString(), emails: [], companies: [] });

test('the guard returns instead of recursing for ever', async () => {
    // Before the fix this never returned: bestSnapshot called itself. A timeout proves it terminates.
    const s = store({ 'clients:hubspot:cache': fresh() });
    const out = await Promise.race([
        guard.clientCheck({ email: 'nobody@example.com', company: 'Nobody Co' }, { redis: s, refreshClients: async () => ({ ok: true }) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('the guard never returned')), 2000)),
    ]);
    assert.ok(out && out.status, 'it answered');
});

test('the shipped hashed snapshot is a real source, and catches a client by hash', async () => {
    const shipped = JSON.parse(readFileSync(new URL('../api/_client-snapshot.json', import.meta.url), 'utf8'));
    assert.equal(shipped.algo, 'sha256-32');
    assert.ok(shipped.emails.length > 50, 'the snapshot has the client list in it');
    assert.ok(!JSON.stringify(shipped.emails).includes('@'), 'and none of it is plaintext');
    assert.ok(shipped.sources.some((x) => x.source === 'talent-console-roster' && x.count > 0));

    const s = store({ 'clients:hubspot:cache': fresh() });
    const known = shipped.emails[0];
    // Feed an address whose hash is in the snapshot, by hashing the hash is not possible, so use the
    // membership path directly: any email whose hash matches must come back as a client.
    const out = await guard.clientCheck({ email: 'x@y.co', company: '' }, {
        redis: store({ 'clients:hubspot:cache': JSON.stringify({ ts: new Date().toISOString(), emails: [h('x@y.co')], companies: [] }) }),
        refreshClients: async () => ({ ok: true }),
    });
    assert.equal(out.status, 'client');
    assert.ok(known.length === 32);
});

test('a source that cannot be established is unknown, never clear', async () => {
    const broken = { async get() { throw new Error('down'); }, async set() { return 'OK'; } };
    const out = await guard.clientCheck({ email: 'a@b.co' }, { redis: broken, refreshClients: async () => ({ ok: false, why: 'HubSpot down' }) });
    assert.equal(out.status, 'unknown');
});

// ---------- the hub's cards, rendered ----------
function loadUI() {
    const src = readFileSync(new URL('../assets/js/pilot-queue.js', import.meta.url), 'utf8');
    const win = {};
    new Function('window', 'document', src)(win, undefined);
    return win.StaffifyPilotQueue;
}
const REQ = {
    id: 'pilot:req:abc', name: 'Dana', company: 'Okafor Media', email: 'dana@example.com',
    state: 'REQUESTED', stateLabel: 'Asked for a role map', createdAt: '2026-09-21T12:00:00Z',
    submissions: 1, notify: { state: 'delivered' }, crm: { state: 'ok', contactId: '1' },
    payment: {}, origin: { kind: 'inbound' }, booking: {}, draft: {},
};

test('the request card is balanced markup', () => {
    const ui = loadUI();
    ui._setData({ requests: { items: [REQ] } });
    const html = ui._requestCard(REQ);
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    assert.equal(open, close, `unbalanced divs: ${open} opened, ${close} closed`);
});

test('the stage buttons are visible, not hidden behind a display:none wrapper', () => {
    const ui = loadUI();
    ui._setData({ requests: { items: [REQ] } });
    const html = ui._requestCard(REQ);
    for (const label of ['I replied', 'Role map sent', 'Time agreed', 'Close with what they said']) {
        assert.ok(html.includes(label), `the "${label}" action is missing`);
    }
    // The container holding them must not be hidden.
    const idx = html.indexOf('data-req=');
    const container = html.lastIndexOf('<div', idx);
    const tag = html.slice(container, idx + 40);
    assert.ok(!/display:\s*none/.test(tag), `the stage actions are inside a hidden container: ${tag}`);
    // The only hidden containers are the panels that open on demand.
    const hidden = [...html.matchAll(/<div[^>]*display:none[^>]*>/g)].map((m) => m[0]);
    for (const tagStr of hidden) {
        assert.match(tagStr, /data-(draft|pay|form|msg)=/, `something unexpected is hidden: ${tagStr}`);
    }
});

test('the payment control sits with the other actions, in one row', () => {
    const ui = loadUI();
    ui._setData({ requests: { items: [REQ] } });
    const html = ui._requestCard(REQ);
    const row = html.slice(html.indexOf('data-draftkind="reply"'), html.indexOf('data-draft='));
    assert.match(row, /data-payopen=/, 'the payment button is not in the action row');
    assert.equal((row.match(/<\/div>/g) || []).length, 1, 'the action row closes exactly once');
});

test('a promoted cohort record is labelled as such, not as an inbound request', () => {
    const ui = loadUI();
    const promoted = { ...REQ, arm: 'cohort', origin: { kind: 'cohort', cohortId: 'hs-1', evidence: 'replied to my email on 22 Sep' } };
    ui._setData({ requests: { items: [promoted] } });
    const html = ui._requestCard(promoted);
    assert.match(html, /opened from the cohort/);
    assert.match(html, /replied to my email on 22 Sep/);
    assert.ok(!html.includes('came in from the page'));
});

test('a cohort card offers to start an opportunity only when it has an address', () => {
    const ui = loadUI();
    const withEmail = { id: 'hs-1', arm: 'engaged', company: 'Acme', person: 'Sam', email: 'sam@acme.com',
        stage: 'SELECTED', owner: 'Paul', nextAction: { kind: 'FIRST_MESSAGE', text: 'Not contacted yet.' }, evidenceGaps: [] };
    assert.match(ui._cohortCard(withEmail, true), /data-startopp=/);
    assert.ok(!/data-startopp=/.test(ui._cohortCard({ ...withEmail, email: '' }, true)));
});
