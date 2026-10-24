// The Campaigns page, actually rendered, on all three screens.
// ------------------------------------------------------------------
// Drives the real page script against a stubbed API. The failures that matter are invisible to a
// source grep: a refusal rendered as an empty page, data rendered as markup, and a screen that
// draws nothing because one field was missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../campaigns/industries/index.html', import.meta.url), 'utf8');
const SRC = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

function dom() {
    const make = tag => {
        const n = { tag, children: [], className: '', href: '', _text: '', dataset: {}, style: {}, attrs: {}, type: '', colSpan: 1,
            set textContent(v) { this._text = String(v); this.children = []; }, get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
            append(...k) { this.children.push(...k); }, replaceChildren(...k) { this.children = k; this._text = ''; },
            setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
        return n;
    };
    const app = make('main'); app.id = 'app';
    const document = { getElementById: id => (id === 'app' ? app : null), createElement: make, createTextNode: t => ({ tag: '#text', textContent: String(t), children: [] }) };
    return { app, document };
}
const all = (node, out = []) => { out.push(node); for (const c of node.children || []) all(c, out); return out; };

async function run(search, payload, ok = true) {
    const { app, document } = dom();
    const fetch = async () => ({ ok, json: async () => payload });
    const location = { search, href: 'https://www.gostaffify.com/campaigns/industries/' + search };
    const history = { replaceState() {} };
    const URL_ = globalThis.URL;
    const body = SRC.replace(/^\s*\(async \(\) => \{/m, '').replace(/\}\)\(\);\s*$/m, '');
    await new Function('document', 'fetch', 'location', 'history', 'URL', 'URLSearchParams', `return (async()=>{${body}})()`)(document, fetch, location, history, URL_, globalThis.URLSearchParams);
    return app;
}

const CAMP = (over = {}) => ({ id: 'staffify-agency-outreach', name: 'Staffify agency outreach', motion: 'email_call', motionLabel: 'Email, then call', badge: null, candidates: false,
    summary: 'Four emails, then a call.', total: 1508, contacted: 1271, fourDone: 900, replies: 38, repliesWaiting: 6, connected: 12, callbacksDue: 2, ready: 771, findingNumber: 54, noNumberPossible: 0, won: null,
    replyRate: { label: '3%', note: '38 of 1271', small: false, unknown: false }, connectRate: { label: '1.3%', note: '12 of 900', small: false, unknown: false },
    industries: [{ key: 're-media', label: 'Real estate media', n: 1447 }], unclassified: 0, spans: false, dominant: 're-media', strays: 61,
    evidenceNote: '221 of 1508 are classified from the campaign the list was built as, not from evidence about the business.',
    offTargetNote: '61 of 1508 look like something other than Real estate media. Worth a look before they are called.', ...over });
const CEO = CAMP({ id: 'staffify-tobit-outreach', name: 'CEO B2B outreach', badge: 'Spearhead', total: 23, contacted: 23, fourDone: 23, replies: 0, repliesWaiting: 0, connected: 0, callbacksDue: 1, ready: 5, findingNumber: 1,
    replyRate: { label: '—', note: 'n=23, below 30', small: true, unknown: false }, connectRate: { label: '—', note: 'n=23, below 30', small: true, unknown: false },
    industries: [{ key: 'software', label: 'Software', n: 6 }, { key: 'construction', label: 'Construction', n: 4 }], unclassified: 5, spans: true, offTargetNote: null, evidenceNote: null });
const NOTES = ['A rate is withheld below 30 contacted.'];

const OVERVIEW = { view: 'overview', totals: { records: 1630, campaigns: 3, ready: 776, repliesWaiting: 6, callbacksDue: 3 }, unclassified: 110,
    spanning: [CEO],
    industries: [{ key: 're-media', label: 'Real estate media', started: true, campaigns: [CAMP()], prospects: 1508, ready: 771, repliesWaiting: 6 },
        { key: 'hvac', label: 'HVAC', started: false, campaigns: [], prospects: 0, note: 'No campaign yet. Nothing has been sent, so every figure is unknown rather than zero.' }],
    filters: { industries: [{ key: 're-media', label: 'Real estate media', n: 1447 }, { key: 'software', label: 'Software', n: 6 }], motions: [{ key: 'email_call', label: 'Email, then call', n: 1531 }, { key: 'email', label: 'Email only', n: 99 }, { key: 'call', label: 'Call first', n: 0 }] },
    notes: NOTES };

test('screen 1: the three jobs on the board, both rails, the band above the industries', async () => {
    const app = await run('', OVERVIEW);
    const text = app.textContent;
    assert.match(text, /6replies waiting for a human/);
    assert.match(text, /3callbacks due now/);
    assert.match(text, /776ready to call/);
    assert.match(text, /Industry/); assert.match(text, /Outreach type/);
    assert.match(text, /Real estate media1,447/, 'the chip carries its count');
    assert.ok(!/Call first/.test(text), 'a type with nobody in it is not offered as a filter');
    assert.ok(text.indexOf('Reaches across industries') < text.indexOf('By industry'));
    assert.match(text, /n=23, below 30/);
    assert.match(text, /won, not tracked here/);
    assert.match(text, /HVAC.*Not started/s);
    assert.match(text, /61 of 1508 look like something other than/);
    // Every card ends in an action.
    const hrefs = all(app).map(x => x.href).filter(Boolean);
    assert.ok(hrefs.some(h => h.startsWith('/dialer/?campaign=staffify-agency-outreach')), 'the call queue is one click away');
    assert.ok(hrefs.some(h => h === '/outreach-review/?view=replies'), 'so are the replies');
});

test('screen 2: the funnel names its denominators and keeps reaching campaigns apart', async () => {
    const app = await run('?view=industry&industry=re-media', { view: 'industry', industry: { key: 're-media', label: 'Real estate media', started: true },
        funnel: { total: 1509, contacted: 1272, fourDone: 900, replies: 38, repliesWaiting: 6, connected: 12, callbacksDue: 2, ready: 771, findingNumber: 54, noNumberPossible: 0, won: null,
            replyRate: { label: '3%', note: '38 of 1272', small: false, unknown: false }, connectRate: { label: '1.3%', note: '12 of 900', small: false, unknown: false } },
        campaigns: [CAMP()], alsoReaching: [{ id: 'staffify-tobit-outreach', name: 'CEO B2B outreach', badge: 'Spearhead', here: 1, total: 23 }],
        queue: { ready: 771, callbacksDue: 2, repliesWaiting: 6 }, note: null, notes: NOTES });
    const text = app.textContent;
    assert.match(text, /The funnel/);
    assert.match(text, /38 of 1272/);
    assert.match(text, /Campaigns built for this industry/);
    assert.match(text, /Also reaching this industry/);
    assert.match(text, /CEO B2B outreach · 1 of 23 here/);
    assert.ok(text.indexOf('Campaigns built for this industry') < text.indexOf('Also reaching this industry'), 'own campaigns first');
    // Paul, 2026-10-23: a queue opened from an industry kept landing on the campaign's first card.
    const hrefs = all(app).map(x => x.href).filter(Boolean);
    assert.ok(hrefs.some(h => h.startsWith('/dialer/?campaign=staffify-agency-outreach&industry=re-media')), 'the queue opens on this industry');
});

test('screen 3: prospects sorted by what needs a person, the real email copy, the real replies', async () => {
    const app = await run('?view=campaign&campaign=staffify-agency-outreach', { view: 'campaign', campaign: CAMP(),
        prospects: [
            { id: 'a', company: 'Loft & Light', name: 'Priya', email: 'p@x.com', emails: 3, lastTouch: '2026-10-20T12:00:00Z', state: 'reply', stateLabel: 'Replied, needs a human', nextCallAt: null, callOwner: null, phone: null },
            { id: 'b', company: 'Cincy Photo Pro', name: 'Krista', email: 'k@x.com', emails: 4, lastTouch: '2026-10-01T12:00:00Z', state: 'ready', stateLabel: 'Ready to call', nextCallAt: null, callOwner: null, phone: { number: '+1', status: 'available' } },
            { id: 'c', company: 'Eastside Pics', name: 'Marcus', email: 'm@x.com', emails: 4, lastTouch: '2026-09-29T12:00:00Z', state: 'finding', stateLabel: 'Finding a number', nextCallAt: null, callOwner: null, phone: null }],
        sequence: [{ n: 1, subject: 'A quick hello, Krista', body: 'Hi Krista, first email.' }, { n: 2, subject: null, body: 'Second.' }],
        replies: [{ id: 'a', company: 'Loft & Light', name: 'Priya', email: 'p@x.com', at: '2026-10-20T12:00:00Z', subject: 'Re: hello', excerpt: 'What would this actually cost us monthly?', needsHuman: true }],
        calls: { placed: 128, attempts: 143, connected: 12, callbacks: [{ id: 'd', company: 'Front Door Media', name: 'Dana', at: '2026-10-22T18:00:00Z', owner: 'milton@trystaffify.com', due: true }] },
        next: { ready: 771, callbacksDue: 2, repliesWaiting: 1, findingNumber: 54, noNumberPossible: 0 }, notes: NOTES,
        copy: { leader: 'conversational-2026-10-04', minSends: 40, exploreShare: 0.2, variants: [
            { id: 'conversational-2026-10-04', label: 'The work between shoots', subject: 'The work between shoots', sends: 367, replies: 9, replyRate: 2.5, conversations: 0, meetings: 0, meetingRate: null, won: 0, active: true, lastSent: '2026-10-14T00:00:00Z', note: '9 of 367 replied' },
            { id: 'handoff-list-2026-10-23', label: 'Fifteen tasks', subject: '15 tasks to hand off after the shoot', sends: 3, replies: 0, replyRate: null, conversations: 0, meetings: 0, meetingRate: null, won: 0, active: true, lastSent: null, note: '3 sent; a rate needs 40' },
            { id: 'subject:other', label: 'Other earlier subjects', subject: '12 subjects, each sent fewer than 5 times', sends: 30, replies: 1, replyRate: null, conversations: 0, meetings: 0, meetingRate: null, won: 0, active: false, lastSent: '2026-09-29T00:00:00Z', note: '30 sent; a rate needs 40' } ] } });
    const text = app.textContent;
    // Which opener is winning: the leader is marked, a withheld rate shows its reason, retired copy says so.
    assert.match(text, /Which opener is winning/);
    assert.match(text, /New prospects get the leading opener 80% of the time/);
    assert.match(text, /The work between shoots.*Leading.*367.*2\.5% · 9 of 367/s);
    assert.match(text, /3 sent; a rate needs 40/);
    assert.match(text, /Other earlier subjects.*Retired/s);
    assert.match(text, /Needs a human 1/);
    assert.match(text, /Ready to call 1/);
    assert.ok(text.indexOf('Loft & Light') < text.indexOf('Cincy Photo Pro'), 'the reply is above the callable one');
    assert.match(text, /What would this actually cost us monthly\?/);
    assert.match(text, /Email 1 · A quick hello, Krista/);
    assert.match(text, /Hi Krista, first email\./);
    assert.match(text, /143call attempts/);
    assert.match(text, /Front Door Media/);
    assert.match(text, /due now/);
    assert.match(text, /Open the call queue · 771 ready/);
});

test('screen 3 at real scale: 1,508 prospects does not crash the page', async () => {
    // Live, the campaign screen died with "Cannot read properties of undefined (reading 'style')"
    // on the over-200 note, which a 3-prospect fixture never reached.
    const many = Array.from({ length: 1508 }, (_, i) => ({ id: 'p' + i, company: 'Studio ' + i, name: 'Pat', email: `p${i}@x.com`, emails: 4, lastTouch: '2026-10-01T12:00:00Z', state: i < 6 ? 'reply' : 'ready', stateLabel: i < 6 ? 'Replied, needs a human' : 'Ready to call', nextCallAt: null, callOwner: null, phone: null }));
    const app = await run('?view=campaign&campaign=staffify-agency-outreach', { view: 'campaign', campaign: CAMP(), prospects: many, sequence: [{ n: 1, subject: 'A quick hello', body: 'Hi.' }], replies: [],
        calls: { placed: 128, attempts: 143, connected: 12, callbacks: [] }, next: { ready: 771, callbacksDue: 0, repliesWaiting: 6, findingNumber: 54, noNumberPossible: 0 }, notes: NOTES });
    const text = app.textContent;
    assert.ok(!/Cannot read properties/.test(text), 'no crash text');
    assert.match(text, /Showing the first 200 of 1,508/);
    assert.match(text, /Needs a human 6/);
    assert.match(text, /Ready to call 1502/);
    // The stored-copy caveat appears when only one email is on file and people got all four.
    assert.match(text, /Only email 1 is stored here/);
});

test('a refusal is shown as a refusal, not as an empty page', async () => {
    const app = await run('', { error: 'Sign in to your Staffify account' }, false);
    assert.match(app.textContent, /Sign in/);
    assert.match(app.textContent, /not a statement that there are no campaigns/);
});

test('names are text, never markup', async () => {
    const evil = JSON.parse(JSON.stringify(OVERVIEW));
    evil.spanning[0].name = '<img src=x onerror=alert(1)>';
    const app = await run('', evil);
    assert.ok(!/\.innerHTML\s*=/.test(SRC), 'the page never assigns innerHTML');
    assert.match(app.textContent, /<img src=x/, 'it lands as literal text');
});
