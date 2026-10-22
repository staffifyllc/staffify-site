// Pull the number a business publishes on its own website.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "any ones missing numbers, go get them please."
//
// Seven of the twenty-one Spearhead accounts have no number. RocketReach has already been asked
// about all of them and found nothing, and re-asking would spend credits to be told the same
// thing: four of the seven are generic inboxes (info@, hello@, together@), and a vendor that looks
// up a PERSON by their email address has no person to find behind a shared mailbox.
//
// Their main line is sitting on their contact page. It is free, it is corroborated by definition
// because they published it themselves, and a main line you can call and ask for someone by name
// beats no number at all. That is the whole job: the caller should not be the one googling.
//
// A WRONG number is worse than none, so the matching is deliberately narrow. Only North American
// formats, only from the visible page or an explicit tel: link, and everything that merely looks
// like a phone number is rejected by rule rather than by hope.
const digits = s => String(s || '').replace(/\D/g, '');
export const last10 = s => digits(s).slice(-10);

// Formats a business actually prints: (239) 900-7772, 239-900-7772, 239.900.7772, +1 239 900 7772.
const PATTERN = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})(?!\d)/g;

// Reserved, fictional and placeholder exchanges. 555-01xx is the fiction range; a real business
// does not print it, and a demo theme sometimes does.
const FAKE = /^(\d)\1{9}$|^1234567890$|^(\d{3})5550(1\d{2})$/;
const PLACEHOLDER = new Set(['0000000000', '1111111111', '1234567890', '9999999999']);

/** Everything that is definitely not a phone number, stripped before matching. */
function visible(html) {
    return String(html || '')
        .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * Candidate numbers on one page, best first.
 *
 * `tel:` links come first because a link is an explicit statement that this is a phone number,
 * where loose text is an inference. After that, proximity to the words a business puts next to its
 * own number.
 */
export function phonesOnPage(page) {
    const html = visible(page && page.html);
    const text = String((page && page.text) || '') + ' ' + html.replace(/<[^>]+>/g, ' ');
    const out = new Map();

    const add = (raw, rank, context) => {
        const d = last10(raw);
        if (d.length !== 10 || PLACEHOLDER.has(d) || FAKE.test(d)) return;
        // An area code or exchange starting 0 or 1 is not dialable.
        if (!/^[2-9]\d\d[2-9]/.test(d)) return;
        const existing = out.get(d);
        if (!existing || rank < existing.rank) out.set(d, { digits: d, rank, context: String(context || '').slice(0, 80) });
    };

    for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) add(m[1], 0, 'tel: link');

    // Near a word that labels a phone number.
    const LABEL = /(?:tel|telephone|phone|call us|call|contact|toll[- ]free|main|office|sales|support)\D{0,24}/i;
    for (const m of text.matchAll(PATTERN)) {
        const before = text.slice(Math.max(0, m.index - 40), m.index);
        add(m[0], LABEL.test(before) ? 1 : 2, (before.trim().split(/\s+/).slice(-4).join(' ') + ' ' + m[0]).trim());
    }
    return [...out.values()].sort((a, b) => a.rank - b.rank);
}

/** Pages worth trying after the homepage, in the order a human would try them. */
export function contactLinks(page, limit = 3) {
    const html = visible(page && page.html);
    let origin;
    try { origin = new URL(page.url).origin; } catch { return []; }
    const scored = [];
    for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
        let u; try { u = new URL(m[1], page.url); } catch { continue; }
        if (u.origin !== origin) continue;
        const path = u.pathname.toLowerCase();
        const rank = /contact/.test(path) ? 0 : /about|who-we-are|team|locations?|offices?/.test(path) ? 1 : null;
        if (rank === null) continue;
        scored.push({ href: u.href.split('#')[0], rank });
    }
    const seen = new Set();
    return scored.sort((a, b) => a.rank - b.rank)
        .filter(x => !seen.has(x.href) && seen.add(x.href))
        .map(x => x.href).slice(0, limit);
}

/**
 * The number a company publishes, with the page it came from.
 * Returns null rather than guessing. Never throws.
 */
export async function findSitePhone({ website, fetchSite, maxPages = 3 }) {
    if (!website) return null;
    const visited = [];
    let first;
    try { first = await fetchSite(website); } catch { return null; }
    if (!first) return null;
    visited.push(first);

    let hit = phonesOnPage(first);
    if (!hit.length) {
        for (const url of contactLinks(first, maxPages - 1)) {
            let p; try { p = await fetchSite(url); } catch { continue; }
            if (!p) continue;
            visited.push(p);
            hit = phonesOnPage(p);
            if (hit.length) break;
        }
    }
    if (!hit.length) return null;
    const page = visited[visited.length - 1];
    const fmt = d => '+1' + d;
    return {
        phone: fmt(hit[0].digits),
        alternates: hit.slice(1, 4).map(h => fmt(h.digits)),
        sourceUrl: page.url,
        context: hit[0].context || null,
        checkedAt: new Date().toISOString(),
        source: 'business website',
    };
}
