// The Performance page: Today and Caller review tabs, and the review drawn from the API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { makeDom, install } from './helpers/fake-dom.mjs';
import { buildReview, leadSupply } from '../api/_performance-review.js';
import { source, GENERATED, USER } from './fixtures/caller-review.mjs';

const MODULE = pathToFileURL(new URL('../assets/js/performance-review.js', import.meta.url).pathname).href;
const html = readFileSync(new URL('../scoreboard/index.html', import.meta.url), 'utf8');
const src = source();
const REVIEW = { ...buildReview(src, { generatedAt: GENERATED, emails: [USER.email] }), supply: { asOf: GENERATED, ...leadSupply([
    { id: 'a', campaignId: 'staffify-agency-outreach', callReady: true, callContact: { phone: '+12125550100', phoneStatus: 'business_listed' }, callHistory: [] },
    { id: 'b', campaignId: 'staffify-agency-outreach', callReady: true, callContact: { phone: '+12125550100', phoneStatus: 'crm_unconfirmed' }, callHistory: [] }], [USER.email]) } };

function page(href) {
    const dom = makeDom({ href }); const restore = install(dom);
    const tablist = document.createElement('div'); tablist.setAttribute('role', 'tablist');
    for (const [id, panel, on] of [['tab-today', 'app', true], ['tab-review', 'review', false]]) { const b = document.createElement('button'); b.id = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-controls', panel); b.setAttribute('aria-selected', on ? 'true' : 'false'); tablist.append(b); }
    const today = document.createElement('div'); today.id = 'app'; const review = document.createElement('div'); review.id = 'review'; review.hidden = true;
    document.body.append(tablist, today, review);
    return { dom, restore };
}
const respond = (asked, me) => async url => { const u = String(url); asked.push(u); const ok = b => ({ ok: true, status: 200, json: async () => b });
    if (u.startsWith('/api/auth-me/')) return me ? ok({ rep: me }) : { ok: false, status: 401, json: async () => ({ error: 'unauthenticated' }) };
    if (u.startsWith('/api/daily-report/?people=1')) return ok({ people: [{ email: USER.email, name: 'Milton Hodgson' }] });
    if (u.startsWith('/api/performance-review/')) return ok({ review: REVIEW });
    return { ok: false, status: 404, json: async () => ({}) }; };
const settle = () => new Promise(r => setTimeout(r, 30));

test('the page is called Performance, Today has no "picked up" figure, and the review tab is there', () => {
    assert.match(html, /<title>Performance · Staffify Sales<\/title>/);
    assert.ok(!/Picked up/i.test(html), 'Quo answered counts voicemail and menus; it is not shown as picked up');
    assert.match(html, /role="tablist"/); assert.match(html, /id="tab-review"[^>]*>Caller review</);
    assert.match(html, /<script type="module" src="\/assets\/js\/performance-review\.js\?v=\d+"><\/script>/);
    assert.ok(!/—/.test(html.match(/<title>.*<\/title>/)[0]));
});

test('an owner opens Caller review: the tab switches, the URL remembers it, and the review is drawn', async () => {
    const { dom, restore } = page('https://www.gostaffify.com/scoreboard/');
    const asked = []; globalThis.fetch = respond(asked, { email: 'hello@gostaffify.com', name: 'Paul', role: 'admin', financeAccess: true });
    await import(MODULE + '?owner' + Date.now());
    assert.equal(document.getElementById('review').hidden, true, 'Today opens first');
    assert.equal(asked.length, 0, 'nothing is fetched for the review until it is opened');
    document.getElementById('tab-review').click();
    await settle();
    assert.equal(document.getElementById('review').hidden, false); assert.equal(document.getElementById('app').hidden, true);
    assert.equal(document.getElementById('tab-review').getAttribute('aria-selected'), 'true');
    assert.match(location.href, /tab=review/); assert.match(location.href, /user=miltion%40trystaffify\.com/);
    const text = dom.text(document.getElementById('review'));
    assert.match(text, /Milton Hodgson/);
    assert.match(text, /19\s*dials in Quo/); assert.match(text, /5\s*people answered\s*2 conversations, 2 callbacks agreed, 1 not now/);
    assert.match(text, /5 calls reached a person, by the outcome chosen: 2 conversations, 2 callbacks agreed, 1 not now\. Of the 19 Quo dials, 5 reached a person \(26\.3%\)\./);
    assert.match(text, /Notes to check6 notes read as if the outcome may be wrong\. They are not counted above/);
    assert.ok(!/\b(he|his)\b/i.test(text.replace(/He hang up|Her cell|She hung up|She stated[^.]*|he's in Asia|Hang up|hung up|his VM[^.]*|His VM[^.]*|Call him on|Nima's assistant, stated that she's not in/gi, '')), 'no he/his in the page copy; notes are his own words');
    assert.equal(document.querySelector('.portal-skip'), null, 'no shell in this test');
    assert.match(text, /4 prospects of 13 had a number problem/);
    assert.match(text, /2 callable leads nobody has called/);
    assert.match(text, /Published on their own website/); assert.match(text, /CRM number, not found on their website/);
    assert.match(text, /Prospect's local time/); assert.match(text, /After 6 PM/);
    assert.match(text, /10 of 11 no answer and voicemail outcomes were set to call again within 36 hours/);
    assert.match(text, /2 dials have no outcome logged/); assert.match(text, /6 notes are listed to check under Who answered\./);
    assert.match(text, /Sat, Oct 24/, 'quiet days are named');
    assert.ok(!/undefined|NaN|\[object|null/.test(text), 'nothing unformatted');
    assert.ok(!/—/.test(text), 'no em dash');
    assert.ok(!/\d{10}|\d{3}-\d{3}-\d{4}/.test(text), 'no phone number on the page');
    assert.ok(asked.some(u => /^\/api\/performance-review\/\?user=miltion%40trystaffify\.com&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(u)));
    document.getElementById('tab-today').click();
    assert.equal(document.getElementById('app').hidden, false); assert.ok(!/tab=review/.test(location.href));
    restore();
});

test('a caller opening the link sees their own review, with no caller picker and no user in the request', async () => {
    const { dom, restore } = page('https://www.gostaffify.com/scoreboard/?tab=review&from=2026-10-20&to=2026-10-27');
    const asked = []; globalThis.fetch = respond(asked, { email: USER.email, name: 'Milton Hodgson', role: 'caller', financeAccess: false });
    await import(MODULE + '?caller' + Date.now());
    await settle();
    assert.equal(document.getElementById('review').hidden, false, '?tab=review opens the review');
    assert.equal(document.getElementById('pr-user'), null);
    assert.ok(asked.includes('/api/performance-review/?from=2026-10-20&to=2026-10-27'), asked.join(' '));
    assert.ok(!asked.some(u => u.includes('people=1')), 'only owners ask who has a review');
    assert.match(dom.text(document.body), /people answered/);
    restore();
});

test('signed out, the review says so instead of drawing zeros', async () => {
    const { dom, restore } = page('https://www.gostaffify.com/scoreboard/?tab=review');
    const asked = []; globalThis.fetch = respond(asked, null);
    await import(MODULE + '?out' + Date.now());
    await settle();
    assert.match(dom.text(document.getElementById('review')), /Sign in to your Staffify account to see the caller review/);
    assert.ok(!asked.some(u => u.startsWith('/api/performance-review/')));
    restore();
});
