// The shared sales navigation, actually built.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "can we put the spearhead accounts on its own tab up top at the navigation".
// It was in the More menu. The thing a source-text grep would miss is the duplicate: promoting a
// link without removing it from More leaves it in the bar twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../assets/js/portal-shell.js', import.meta.url), 'utf8');

// Enough DOM for the shell to build its nav and for us to read it back.
function build(pathname = '/spearhead/', search = '') {
    const made = [];
    const node = (tag) => {
        const n = {
            tag, children: [], className: '', id: '', textContent: '', href: '', open: false,
            attrs: {}, classList: { add(c) { n.className = (n.className + ' ' + c).trim(); } },
            setAttribute(k, v) { n.attrs[k] = v; },
            append(...kids) { n.children.push(...kids); },
            prepend(...kids) { n.children.unshift(...kids); },
            replaceWith() {}, focus() {}, contains() { return false; },
            closest() { return null; }, querySelector() { return null; },
        };
        made.push(n);
        return n;
    };
    const header = node('header');
    // The real page ships a static <nav> that the shell replaces, so the harness has to support
    // replaceWith rather than quietly dropping the new nav on the floor.
    const staticNav = node('nav');
    staticNav.replaceWith = replacement => {
        const i = header.children.indexOf(staticNav);
        if (i >= 0) header.children[i] = replacement; else header.children.push(replacement);
    };
    header.children.push(staticNav);
    header.querySelector = sel => (sel === 'nav' ? staticNav : null);
    const doc = {
        querySelector: sel => (sel === '.topbar' ? header : null),
        createElement: node,
        addEventListener() {},
        body: { prepend() {} },
    };
    const win = { location: { pathname, search } };
    new Function('document', 'location', 'window', SRC)(doc, win.location, win);
    // The nav the shell appended to the header.
    const nav = header.children.find(c => c.className === 'portal-nav');
    const links = nav.children.filter(c => c.tag === 'a').map(a => ({ text: a.textContent, href: a.href, active: a.className === 'active' }));
    const more = nav.children.find(c => c.className === 'portal-more');
    const menu = more && more.children.find(c => c.className === 'portal-menu');
    const moreLinks = menu ? menu.children.map(a => ({ text: a.textContent, href: a.href })) : [];
    return { links, moreLinks };
}

test('Spearhead is a top-level tab, not buried under More', () => {
    const { links } = build();
    const spearhead = links.find(l => l.href === '/spearhead/');
    assert.ok(spearhead, 'it is in the top row');
    assert.equal(spearhead.text, 'Spearhead');
});

test('promoting it did not leave a copy behind in More', () => {
    const { links, moreLinks } = build();
    const everywhere = [...links, ...moreLinks].filter(l => l.href === '/spearhead/');
    assert.equal(everywhere.length, 1, 'exactly one way to reach it');
    assert.ok(!moreLinks.some(l => l.href === '/spearhead/'));
});

test('it sits with the calling work rather than at the end', () => {
    const { links } = build();
    const order = links.map(l => l.href);
    assert.ok(order.indexOf('/spearhead/') > order.indexOf('/dialer/'), 'after Calls');
    assert.ok(order.indexOf('/spearhead/') < order.indexOf('/pipeline/'), 'before Pipeline');
});

test('the tab marks itself current when you are on the page', () => {
    const { links } = build('/spearhead/');
    assert.equal(links.find(l => l.href === '/spearhead/').active, true);
    const elsewhere = build('/pipeline/').links.find(l => l.href === '/spearhead/');
    assert.equal(elsewhere.active, false);
});

test('nothing else fell out of the bar', () => {
    const { links, moreLinks } = build();
    for (const href of ['/hub/', '/campaigns/', '/dialer/', '/pipeline/', '/commissions/'])
        assert.ok(links.some(l => l.href === href), href + ' is still a tab');
    for (const href of ['/my-day/', '/scoreboard/', '/training/sales/'])
        assert.ok(moreLinks.some(l => l.href === href), href + ' is still under More');
});
