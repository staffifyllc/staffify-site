// The review page's call brief: gated off shift, and pressing Start there must not break saving.
// The press used to be named `action`, shadowing the save function the brief was opened with, so
// the reopened brief called a string when the rep saved an outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, install } from './helpers/fake-dom.mjs';

test('Start from a gated brief reopens it with the number, and Save still calls the save function', async () => {
    const dom = makeDom({ href: 'https://www.gostaffify.com/outreach-review/' }); const restore = install(dom);
    let gated = true; const saved = [];
    const brief = () => ({ owner: 'Paul', name: 'Tom Rieck', company: 'Riley Jones', location: 'Wilmington, NC', checkedAt: new Date().toISOString(), crmUrl: 'https://app.hubspot.com/x', fact: null, opener: 'Hi Tom', questions: ['q1'], instruction: 'Read first.', events: [],
        ...(gated ? { phone: null, shiftGate: { required: true, state: 'off', allowed: false, message: 'Start your shift to call.' } } : { phone: '+19107695931', shiftGate: { required: true, state: 'on', allowed: true } }) });
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => brief() });
    globalThis.window.__staffifyShift = { start: async () => { gated = false; return { ok: true }; } };
    const { openCallBrief } = await import('../assets/js/outreach-calls.js?' + Date.now());
    const text = (t, s) => { const e = document.createElement(t); e.textContent = s; return e; };
    const card = document.createElement('div'); document.body.append(card);
    await openCallBrief({ id: 'r1', recipient: 'tom@x.com' }, card, { text, action: async body => { saved.push(body); return true; } });
    let box = card.querySelector('.call-brief');
    assert.match(dom.text(box), /Calling from the Hub needs a running shift\. Start your shift to call\. Notes and outcomes still save\./);
    assert.equal(dom.queryAll(box, 'a').filter(a => /^tel:/.test(a.href || '')).length, 0, 'no phone link off shift');
    dom.queryAll(box, 'button').find(b => dom.text(b) === 'Start shift').click();
    await new Promise(r => setTimeout(r, 30));
    box = card.querySelector('.call-brief');
    assert.ok(dom.queryAll(box, 'a').some(a => a.href === 'tel:+19107695931'), 'reopened with the number');
    box.querySelector('select').value = 'connected';
    dom.queryAll(box, 'button').find(b => /Save call result/.test(dom.text(b))).click();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(saved.length, 1, 'the save function was called, not a string'); assert.equal(saved[0].outcome, 'connected');
    delete globalThis.window.__staffifyShift; restore();
});
