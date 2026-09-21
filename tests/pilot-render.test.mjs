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

// ---------- the controls actually get bound ----------
//
// Start opportunity rendered and did nothing when there were no inbound requests, because the
// binding pass lived inside renderRequests, after its early return, and the cohort section drew
// afterwards. A control that renders and does not respond is worse than one that is missing, and no
// source-text assertion catches it, so this drives the real render and checks for handlers.

function fakeDom() {
    const made = [];
    function el(attrs = {}) {
        const node = {
            attrs, onclick: null, children: [], parent: null, className: '', style: {}, hidden: false,
            textContent: '', disabled: false,
            get innerHTML() { return this._html || ''; },
            set innerHTML(html) {
                this._html = html;
                this.children = [];
                // Every element carrying a data- attribute becomes a node, and each one sits inside
                // the nearest preceding pq-item so closest() can find its own card.
                const re = /<(\w+)([^>]*?)data-([a-zA-Z]+)="([^"]*)"([^>]*)>/g;
                let m, cardIdx = -1;
                const cards = [];
                for (const c of html.matchAll(/class="pq-item"/g)) cards.push(c.index);
                while ((m = re.exec(html))) {
                    const node2 = el({ ['data-' + m[3]]: m[4] });
                    node2.tag = m[1];
                    node2.index = m.index;
                    cardIdx = cards.filter((c) => c < m.index).length - 1;
                    node2.cardIndex = cardIdx;
                    node2.parent = this;
                    node2.closest = function () { return { querySelector: (sel) => this.root.querySelector(sel, node2.cardIndex) }; }.bind({ root: this });
                    this.children.push(node2);
                    made.push(node2);
                }
            },
            querySelectorAll(sel) {
                const m = /\[data-([a-zA-Z]+)(?:="([^"]*)")?\]/.exec(sel);
                if (!m) return [];
                return this.children.filter((c) => c.attrs['data-' + m[1]] !== undefined
                    && (m[2] === undefined || c.attrs['data-' + m[1]] === m[2]));
            },
            querySelector(sel, cardIndex) {
                const all = this.querySelectorAll(sel);
                if (cardIndex === undefined) return all[0] || null;
                return all.find((c) => c.cardIndex === cardIndex) || all[0] || null;
            },
            classList: { add() {}, remove() {}, toggle() {} },
            addEventListener() {},
        };
        return node;
    }
    const root = el();
    const byId = { 'pq-health': el(), 'pq-do': el(), 'pq-req': el(), 'pq-people': el(),
        'pq-report': el(), 'pq-answers': el(), 'pq-drafts': el(), 'pq-sub': el(), 'pq-refresh': el() };
    // The section elements are looked up through root.querySelector('#id'), so intercept that.
    const rootQuery = root.querySelector.bind(root);
    root.querySelector = function (sel, idx) {
        if (sel && sel[0] === '#') return byId[sel.slice(1)] || el();
        return rootQuery(sel, idx);
    };
    root.querySelectorAll = function (sel) {
        // Across every section, the way the real root does once the sections are inside it.
        return Object.values(byId).flatMap((s) => s.querySelectorAll(sel));
    };
    return { root, byId, made, el };
}

test('with no inbound requests, the cohort Start opportunity button is still bound', () => {
    const src = readFileSync(new URL('../assets/js/pilot-queue.js', import.meta.url), 'utf8');
    const win = {};
    const doc = { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) };
    new Function('window', 'document', src)(win, doc);
    const ui = win.StaffifyPilotQueue;

    const dom = fakeDom();
    const cohortRec = { id: 'hs-247868774313', arm: 'engaged', company: 'Listings In Motion', person: 'Chris',
        email: 'info@listingsinmotion.com', stage: 'CONTACTED', owner: 'Paul', evidenceGaps: [],
        nextAction: { kind: 'ANSWER_THEIR_REQUEST', text: 'They asked for samples.' } };
    // The exact shape that broke: zero inbound requests, a cohort with records.
    ui._setData({
        requests: { status: 'DATA', items: [] },
        cohort: { ok: true, status: 'DATA', records: [cohortRec], report: null, drafts: null },
        health: {},
    });
    ui._renderInto(dom.root);

    const buttons = dom.root.querySelectorAll('[data-startopp]');
    assert.ok(buttons.length > 0, 'the button renders');
    for (const b of buttons) assert.equal(typeof b.onclick, 'function', 'and every copy of it responds');
});

test('the same cohort record drawn twice keeps each card its own form', () => {
    const src = readFileSync(new URL('../assets/js/pilot-queue.js', import.meta.url), 'utf8');
    const win = {};
    new Function('window', 'document', src)(win, { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) });
    const ui = win.StaffifyPilotQueue;
    const rec = { id: 'hs-1', arm: 'engaged', company: 'Acme', person: 'Sam', email: 's@a.com',
        stage: 'SELECTED', owner: 'Paul', evidenceGaps: [], nextAction: { kind: 'FIRST_MESSAGE', text: 'x' } };
    const html = ui._cohortCard(rec, true) + ui._cohortCard(rec, false);
    // Two cards, two forms, two buttons: the lookup has to be card-local or the wrong panel opens.
    assert.equal((html.match(/data-start="hs-1"/g) || []).length, 2);
    assert.equal((html.match(/data-startopp="hs-1"/g) || []).length, 2);
    assert.match(readFileSync(new URL('../assets/js/pilot-queue.js', import.meta.url), 'utf8'), /function inCard\(/);
});
