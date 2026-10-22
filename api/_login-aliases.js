// Addresses that are the same person.
// ------------------------------------------------------------------
// Milton, 2026-10-22: "I logged out and try to log back in to test it and it didnt let me",
// with the Hub answering "That Google account is not set up as a rep yet."
//
// His Google account is milton@trystaffify.com, which is also the address on his signed agreement
// and on his Quo seat. The Hub rep record was provisioned as "miltion", a misspelling. getRep looks
// up rep:<address>, found nothing for the correct spelling, and the sign-in was refused. He has
// been locked out of the platform entirely.
//
// The fix is an alias, not a second rep record. Creating rep:milton@ alongside rep:miltion@ would
// give him two identities, and everything downstream keys off rep.email: his call ownership, his
// logged outcomes and his credited onboarding fees would split in half depending on which address
// he happened to sign in with that day.
//
// This list is EXPLICIT and short on purpose. It is not a fuzzy matcher and must never become one:
// quietly treating two addresses as one person is exactly how one rep ends up reading another rep's
// queue. Every pair here is a known provisioning mistake, recorded so it can be unwound later.
export const ALIAS_PAIRS = [
    ['miltion@trystaffify.com', 'milton@trystaffify.com'],
];

const MAP = new Map();
for (const pair of ALIAS_PAIRS) {
    for (const a of pair) MAP.set(a, pair);
}

/**
 * Every address this person might sign in as, their own first. A single-element list for anyone
 * without a recorded alias, which is almost everyone.
 */
export const loginAliases = email => {
    const e = String(email || '').trim().toLowerCase();
    if (!e) return [];
    const pair = MAP.get(e);
    return pair ? [e, ...pair.filter(x => x !== e)] : [e];
};
