// Taking a business's own published number off their own site.
// ------------------------------------------------------------------
// Seven of the Spearhead accounts had no number, four of them behind generic inboxes that a
// person-lookup vendor can never resolve. A wrong number is worse than none, so this is about what
// the extractor REFUSES as much as what it finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { phonesOnPage, contactLinks, findSitePhone, last10 } from '../api/_site-phone.js';

const page = (html, url = 'https://example.com/') => ({ url, html, text: html.replace(/<[^>]+>/g, ' ') });

test('an explicit tel: link beats a number floating in the copy', () => {
    const hits = phonesOnPage(page(`
        <p>Serving clients since 1998. Suite 212 555 0100.</p>
        <a href="tel:+12399007772">Call us</a>
        <p>Fax 239-900-1111</p>`));
    assert.equal(hits[0].digits, '2399007772', 'the linked number is the stated one');
    assert.ok(hits.length >= 2);
});

test('a labelled number outranks a bare one', () => {
    const hits = phonesOnPage(page('<p>Investor relations 408-230-9999</p><p>Phone: 408-230-7342</p>'));
    assert.equal(hits[0].digits, '4082307342');
});

test('it refuses the things that merely look like phone numbers', () => {
    const hits = phonesOnPage(page(`
        <script>var id = "2125550123"; var t = 8005551234;</script>
        <style>.a{content:"312-555-0188"}</style>
        <!-- 646-555-0133 -->
        <p>Order #1234567890. EIN 11-1111111. Founded 1998, 2026 revenue.</p>
        <p>Call 555-555-5555 for the demo theme.</p>
        <p>Suite 100, 123 Main St, zip 90210-1234</p>`));
    const found = hits.map(h => h.digits);
    assert.ok(!found.includes('2125550123'), 'nothing from a script block');
    assert.ok(!found.includes('3125550188'), 'nothing from a style block');
    assert.ok(!found.includes('6465550133'), 'nothing from a comment');
    assert.ok(!found.includes('1234567890'), 'an order number is not a phone number');
    assert.ok(!found.includes('5555555555'), 'a placeholder is not a phone number');
    assert.ok(!found.some(d => /^1/.test(d) || /^0/.test(d)), 'no undialable area code');
});

test('the 555-01xx fiction range is never offered to a caller', () => {
    assert.deepEqual(phonesOnPage(page('<a href="tel:+12125550123">Call</a>')).map(h => h.digits), []);
    assert.deepEqual(phonesOnPage(page('<p>Phone: (310) 555-0199</p>')).map(h => h.digits), []);
});

test('the same number written three ways is one number', () => {
    const hits = phonesOnPage(page('<p>(239) 900-7772</p><p>239.900.7772</p><p>+1 239 900 7772</p>'));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].digits, '2399007772');
});

test('it looks at contact and about pages, on their own domain only', () => {
    const links = contactLinks(page(`
        <a href="/contact-us/">Contact</a>
        <a href="/who-we-are/">Who we are</a>
        <a href="/blog/post">Blog</a>
        <a href="https://facebook.com/contact">Facebook</a>
        <a href="/contact-us/#form">Contact anchor</a>`));
    assert.deepEqual(links, ['https://example.com/contact-us/', 'https://example.com/who-we-are/']);
    assert.ok(!links.some(l => l.includes('facebook')), 'never off their own domain');
});

test('it walks to the contact page when the homepage has nothing, and reports where it looked', async () => {
    const pages = {
        'https://bootcivil.com/': page('<a href="/contact/">Contact</a><p>Civil engineering.</p>', 'https://bootcivil.com/'),
        'https://bootcivil.com/contact/': page('<p>Phone: (512) 900-4433</p>', 'https://bootcivil.com/contact/'),
    };
    const out = await findSitePhone({ website: 'https://bootcivil.com/', fetchSite: async u => pages[u] });
    assert.equal(out.phone, '+15129004433');
    assert.equal(out.sourceUrl, 'https://bootcivil.com/contact/', 'the caller can see where it came from');
    assert.equal(out.source, 'business website');
});

test('a site with no number returns nothing rather than a guess, and a dead site does not throw', async () => {
    const empty = await findSitePhone({ website: 'https://example.com/', fetchSite: async () => page('<p>No numbers here.</p>') });
    assert.equal(empty, null);
    const dead = await findSitePhone({ website: 'https://example.com/', fetchSite: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(dead, null);
    assert.equal(await findSitePhone({ website: '', fetchSite: async () => page('<a href="tel:+12399007772">x</a>') }), null);
});

test('last10 normalises every way a number gets written', () => {
    for (const s of ['+1 (239) 900-7772', '239.900.7772', '12399007772', '2399007772'])
        assert.equal(last10(s), '2399007772');
});

// ---- the 2026-10-30 Workable dry run --------------------------------------------------------------------------------
test('a page cut off inside a <style> gives no numbers: CSS decimals are not phone numbers (Strauss Attorneys)', async () => {
    // strausslaw.com is over 500 KB; the reader stops there, inside an inline <style> that opens at byte 18,083 and never
    // closes. The reader's own text kept the CSS, and 0.5982142857rem became (598) 214-2857 on a ready card.
    const css = '.partial_socials li{letter-spacing:.5px;font-size:clamp(0.875rem,0.8446601942rem + 0.1vw,1rem)}h3{font-weight:700;font-size:clamp(0.8125rem,0.5982142857rem + 0.3348214286vw,1.25rem)}.row .inner h1{font-size:clamp(1.375rem, 1.3446601942rem + 1vw, 2rem)}';
    const html = '<html><head><title>Estate, Probate &amp; Elder Law Attorneys</title><style id="s3-site-styles">' + css.repeat(40);
    const cut = { url: 'https://strausslaw.com/', html, text: html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') };
    assert.deepEqual(phonesOnPage(cut), []);
    assert.equal(await findSitePhone({ website: cut.url, fetchSite: async () => cut }), null);
    // The same for an unclosed <script>, and for decimals in plain text, with or without a leading digit.
    assert.deepEqual(phonesOnPage(page('<p>Ratio 0.5982142857, 1.3446601942 and .4082307342</p><script>var a = "(408) 230-7342"')), []);
    // Real numbers before the cut still count, the all-dots format included.
    assert.deepEqual(phonesOnPage(page('<a href="tel:+12399007772">Call</a><p>Office 1.408.230.7342</p><style>.x{width:0.5982142857rem}')).map(h => h.digits), ['2399007772', '4082307342']);
});

test('a custom element named like <svg-icon> is not an <svg>: the tel: link after it is still read', () => {
    // alexanderwang.com puts <svg-icon> elements before its call link; read as an unclosed <svg>, they hid the rest of the page.
    assert.deepEqual(phonesOnPage(page(`<svg-icon src='icon-caret-right' style='--icon-size: 10px;'></svg-icon><a href='tel:+12399007772'>call</a>`)).map(h => h.digits), ['2399007772']);
    assert.deepEqual(phonesOnPage(page('<svg viewBox="0 0 10 10"><text>239-900-1111</text></svg><p>Phone: 239-900-7772</p>')).map(h => h.digits), ['2399007772']);
});

test('an officer is not an office: a press release and a loan officer\'s page are a person\'s, never the company line (BKF, First Southern)', () => {
    const links = contactLinks(page(`
        <a href="/bkf-appoints-andrew-esposito-chief-financial-officer/">BKF appoints a CFO</a>
        <a href="/loan-officers/">Loan officers</a>
        <a href="/smart-living/teaching-children-about-money/">Teaching children about money</a>
        <a href="/offices/">Offices</a>
        <a href="/aboutus.html">About</a>
        <a href="/our-team/">Our team</a>
        <a href="/about/reviews/">Reviews</a>`), 5);
    assert.deepEqual(links, ['https://example.com/offices/', 'https://example.com/aboutus.html', 'https://example.com/our-team/', 'https://example.com/about/reviews/']);
});
