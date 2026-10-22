// A script per Spearhead account, built from what we can actually verify.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "I need to get scripts that pertain to these different companies for each and
// every single one for spearhead accounts."
//
// The 21 Spearhead accounts are nothing like each other. A bank, a civil engineering firm, a data
// security company, a children's heart charity and an EV manufacturer do not share a pain point,
// and the one generic business-owner script they currently share says nothing to any of them.
//
// WHAT THIS DOES NOT DO. It does not invent facts about these companies. Not one of the 21 records
// carries a researched excerpt: the enterprise sites are JavaScript-rendered or bot-protected, so
// the research pass stored the URL and an empty excerpt, correctly. Writing "I saw you just
// launched X" from my own guesswork is exactly the thing the caller truth rules forbid, and on a
// CEO call it is the fastest way to be caught out.
//
// So every line here is built from something we hold: the company name, the sector inferred from
// their name and domain (labelled as inferred, never asserted to them), the emails we genuinely
// sent, and where a real sourced sentence exists, that sentence. Nothing else.
import { sectorFor } from './_sectors.js';
import { bookingLinkFor, DISCOVERY_LINK } from './_call-scripts.js';

export { sectorFor };

/**
 * The opener. It states only things that are true and checkable: who is calling, that we have
 * emailed them, how many times, and the subject line they would recognise.
 */
function opener({ caller, company, firstName, sentTouches, subject }) {
    const who = firstName || 'there';
    const sent = Number(sentTouches) > 0
        ? `I have sent you ${sentTouches === 1 ? 'an email' : `${sentTouches} emails`}${subject ? `, the first one was "${subject}"` : ''}, and I have not heard back, which is completely fair.`
        : "We have not spoken before.";
    return `Hi ${who}, this is ${caller || 'a caller'} with Staffify. I will be straight with you, this is a cold call. ${sent} Have I caught you in the middle of something?`;
}

// Paul's own words, 2026-10-22: "our CEO started his own agencies that needed this talent, many of
// those agencies operate at 7-8 figures today using this workforce which is how we've grown to over
// 500 employees we help folks just like (their company)". The company name lands at the end, which
// is the part that makes it a reason for calling THEM rather than a company blurb.
const reasonFor = company => "Real quick, I do not make calls like this all day, I only call a few "
    + "people. So the reason I am calling you specifically: our CEO started his own agencies that "
    + "needed this exact talent. A lot of those agencies are doing seven and eight figures today "
    + "using this workforce, and that is how we have grown to over 500 employees. We help folks "
    + "just like " + (company || 'your business') + ".";

const CLOSE = "Look, I am not going to pitch you on a cold call. What I would rather do is put twenty "
    + "minutes in the diary with Paul, our CEO, and he will walk you through exactly how he would staff "
    + "that. Worst case you get an hour of his thinking for free. Does later this week work?";

/**
 * A full script for one Spearhead account.
 * Everything in it is derived from the record, never from outside knowledge of the company.
 */
export function spearheadScript({ company, firstName, website = '', excerpt = '', crmIndustry = '', title = '', caller, callerEmail, sentTouches = 0, subject = '' } = {}) {
    const sector = sectorFor({ company, website, excerpt, crmIndustry, title });
    const name = company || 'your business';
    const questions = [...sector.questions, CLOSE];
    const labels = ['Where the work piles up', 'Who is carrying it', 'What they have tried', 'What they would hand over', 'The ask'];
    return {
        company: name,
        sector: { key: sector.key, label: sector.label, source: sector.source },
        // Said plainly on the card. An inferred sector is a starting assumption for the caller, not
        // a fact to assert to the prospect, and the difference matters on a CEO call.
        sectorNote: sector.source === 'named'
            ? `Sector read from the company name. Treat it as a starting point, not something to assert to ${firstName || 'them'}.`
            : sector.source === 'default'
            ? 'No sector could be determined, so these are the general questions. Ask, do not assume.'
            : 'Sector inferred from their name and website. Treat it as a starting point, not something to assert.',
        opener: opener({ caller, company: name, firstName, sentTouches, subject }),
        reason: reasonFor(name),
        questions,
        stages: labels.map((label, i) => ({ label, say: questions[i] })).filter(s => s.say),
        // Only present when a real sourced sentence exists. Never filled with a guess.
        sourcedFact: String(excerpt || '').trim() || null,
        sourcedFactNote: String(excerpt || '').trim()
            ? 'Taken from their own website. Safe to reference.'
            : 'We hold no sourced fact about this company. Do not invent one. Ask about their operation instead.',
        voicemail: `Hi ${firstName || 'there'}, ${caller || 'this'} is from Staffify. I emailed you a few times about handling off recurring work at ${name}. No pitch on a voicemail, I will try you again. If it is easier, the email thread is there and I am happy to just reply.`,
        bookingUrl: bookingLinkFor(callerEmail) || DISCOVERY_LINK,
    };
}
