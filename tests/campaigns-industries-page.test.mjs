// The alongside Campaigns page, actually rendered.
// ------------------------------------------------------------------
// Drives the real page script against a stubbed API, because the two failures that matter are
// invisible to a source grep: a refusal rendered as an empty page, and data rendered as markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../campaigns/industries/index.html', import.meta.url), 'utf8');
const SRC = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

// A small DOM: enough for createElement/append/textContent and getElementById.
function dom() {
    const ids = {};
    const make = tag => {
        const n = { tag, children: [], className: '', href: '', _text: '',
            set textContent(v) { this._text = String(v); }, get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
            append(...k) { this.children.push(...k); }, remove() { this.removed = true; } };
        return n;
    };
    for (const id of ['status', 'out']) ids[id] = make('div');
    return { ids, document: { getElementById: id => ids[id], createElement: make } };
}
async function run(payload, ok = true) {
    const { ids, document } = dom();
    const fetch = async () => ({ ok, json: async () => payload });
    await new Function('document', 'fetch', `return (async()=>{${SRC.replace(/^\s*\(async \(\) => \{/m, '').replace(/\}\)\(\);\s*$/m, '')}})()`)(document, fetch);
    return ids;
}

const PAYLOAD = {
    totals: { records: 1630, campaigns: 3 }, unclassified: 41,
    spanning: [{ id: 'staffify-tobit-outreach', name: 'CEO B2B outreach', motion: 'Email then call', badge: 'Spearhead',
        total: 23, contacted: 21, replies: 0, meetings: 0, won: null,
        replyRate: { label: '—', note: 'n=21, below 30', small: true, unknown: false },
        industries: [{ key: 'software', label: 'Software', n: 6 }, { key: 'construction', label: 'Construction', n: 4 }], unclassified: 5 }],
    industries: [
        { key: 're-media', label: 'Real estate media', started: true, prospects: 1508, campaigns: [
            { id: 'staffify-agency-outreach', name: 'Staffify agency outreach', motion: 'Email then call', total: 1508, contacted: 1157, replies: 38, meetings: 6, won: null,
              replyRate: { label: '3.3%', note: '38 of 1157', small: false, unknown: false }, industries: [{ key: 're-media', label: 'Real estate media', n: 1467 }], unclassified: 41,
              evidenceNote: '60 of 1508 are classified from the campaign the list was built as, not from evidence about the business.' }] },
        { key: 'hvac', label: 'HVAC', started: false, prospects: 0, campaigns: [], note: 'No campaign yet. Nothing has been sent, so every figure is unknown rather than zero.' },
    ],
};

test('spanning campaigns sit above the industries, with their spread and unclassified count', async () => {
    const ids = await run(PAYLOAD);
    const text = ids.out.textContent;
    assert.match(text, /Reaches across industries/);
    assert.match(text, /CEO B2B outreach/);
    assert.match(text, /Software · 6/);
    assert.match(text, /Unclassified · 5/);
    assert.ok(text.indexOf('Reaches across industries') < text.indexOf('By industry'), 'above, not filed inside one');
});

test('a withheld rate shows its reason, won shows unknown rather than zero', async () => {
    const text = (await run(PAYLOAD)).out.textContent;
    assert.match(text, /n=21, below 30/);
    assert.match(text, /won, not tracked here/);
    assert.match(text, /38 of 1157/);
});

test('a planned industry reads as not started, never as a failed one', async () => {
    const text = (await run(PAYLOAD)).out.textContent;
    assert.match(text, /HVAC/);
    assert.match(text, /Not started/);
    assert.match(text, /unknown rather than zero/);
});

test('the cohort assumption is disclosed where it applies', async () => {
    const text = (await run(PAYLOAD)).out.textContent;
    assert.match(text, /classified from the campaign the list was built as/);
    assert.match(text, /41 could not be classified/);
});

test('a refusal is shown as a refusal, not as an empty page', async () => {
    const ids = await run({ error: 'Sign in to your Staffify account' }, false);
    assert.match(ids.status.textContent, /Sign in/);
    assert.match(ids.status.textContent, /not a statement that there are no campaigns/);
    assert.equal(ids.out.children.length, 0);
});

test('campaign names are text, never markup', async () => {
    const evil = JSON.parse(JSON.stringify(PAYLOAD));
    evil.spanning[0].name = '<img src=x onerror=alert(1)>';
    const ids = await run(evil);
    // The comment at the top of the script mentions innerHTML to say it is never used, so the
    // check is for an assignment, not the word.
    assert.ok(!/\.innerHTML\s*=/.test(SRC), 'the page never assigns innerHTML');
    assert.match(ids.out.textContent, /<img src=x/, 'it appears as literal text');
});
