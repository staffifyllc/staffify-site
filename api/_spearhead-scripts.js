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
import { industryFor } from './_industry.js';
import { bookingLinkFor, DISCOVERY_LINK } from './_call-scripts.js';

// Four questions per sector, in the order a call actually goes: where the work piles up, what it
// costs them, what they have already tried, then what they would hand over. They are questions
// about THEIR operation, which is why they can be specific without asserting anything.
const BY_SECTOR = {
    software: {
        label: 'Software and security',
        frame: "engineering time going into work that is not engineering",
        questions: [
            "Most software teams I talk to have a pile of work that is not really engineering: support triage, QA passes, documentation, onboarding new customers. Which of those is eating the most of your people right now?",
            "And who ends up absorbing it? Is that falling on the engineers themselves, or do you have people in between?",
            "Have you tried hiring for that layer before, or has it mostly been handled by stretching the team you have?",
            "If that whole layer came off your engineers on Monday, what would they actually get back to?",
        ],
    },
    finance: {
        label: 'Finance and banking',
        frame: "process work that has to be done accurately and never stops",
        questions: [
            "In a bank or a finance team the volume work never really stops: reconciliation, documentation, onboarding files, the follow-up chasing. Which of those is the most painful right now?",
            "And when that backs up, who picks it up? Is it the licensed people doing it, or do you have support underneath them?",
            "Have you looked at adding capacity there before, or has headcount been hard to justify for that kind of work?",
            "If one of those queues was genuinely cleared every day without you thinking about it, which one would you want it to be?",
        ],
    },
    construction: {
        label: 'Construction and engineering',
        frame: "the office work behind every job",
        questions: [
            "On the construction and engineering side the field work is usually fine and the office work is where it jams: submittals, RFIs, takeoffs, scheduling, the paperwork behind every job. Which of those is slowing you down most?",
            "And who is doing that today? Is it your project managers doing it after hours, or do you have coordinators on it?",
            "Have you tried putting dedicated support on that before, or has it been absorbed by the PMs?",
            "If your project managers got that time back, what would you rather they were doing with it?",
        ],
    },
    education: {
        label: 'Education',
        frame: "administrative load on people who should be with students or customers",
        questions: [
            "In education the admin load has a way of landing on the people who should be in front of students or customers. Where is that worst for you right now?",
            "And when the school year peaks, what is the first thing that slips?",
            "Have you added support staff for that before, or has it mostly been handled by asking people to absorb it?",
            "If one recurring administrative job came off your team entirely, which one would move the needle most?",
        ],
    },
    health: {
        label: 'Healthcare',
        frame: "the non-clinical work that pulls people away from patients",
        questions: [
            "In healthcare the non-clinical work is usually what pulls people away from patients: intake, records, scheduling, insurance follow-up, reporting. Which of those is the heaviest for you?",
            "And who absorbs it when it backs up? Does that land on clinical staff?",
            "Have you been able to hire for that side, or has it been hard to fund against clinical roles?",
            "If that work was genuinely handled, what would your people be doing instead?",
        ],
    },
    nonprofit: {
        label: 'Nonprofit',
        frame: "a small team covering too many functions",
        questions: [
            "With a mission-driven organisation it is usually a small team covering a lot of ground: donor follow-up, grant reporting, scheduling, the admin behind every programme. Which of those is stretching you thinnest?",
            "And when things get busy, what is the first thing that does not get done?",
            "Have you been able to add capacity there before, or does the budget have to go to programme work?",
            "If one of those came off your plate without taking money away from the mission, which would you pick?",
        ],
    },
    property: {
        label: 'Property and real estate',
        frame: "the volume work behind every unit and every resident",
        questions: [
            "In property management the volume work is relentless: leasing follow-up, applications, maintenance coordination, resident communication, reporting to owners. Which of those is the biggest drag right now?",
            "And who is carrying that at the site level? Is that on your managers?",
            "Have you tried centralising any of it, or is each property handling its own?",
            "If one of those was handled centrally and consistently, which would you want first?",
        ],
    },
    marketing: {
        label: 'Marketing',
        frame: "production work sitting on strategists",
        questions: [
            "In an agency the production work has a habit of landing on the people who should be doing strategy: reporting, trafficking, QA on campaigns, client updates. Which of those is eating the most time?",
            "And when a heavy month hits, what is the first thing to slip?",
            "Have you hired for that production layer before, or has the team been absorbing it?",
            "If your strategists got that time back, what would you want them spending it on?",
        ],
    },
    manufacturing: {
        label: 'Manufacturing and hardware',
        frame: "the coordination work around building a physical product",
        questions: [
            "With a physical product the coordination around it is usually the bottleneck: supplier follow-up, documentation, order and service admin, the reporting that holds it together. Which of those is heaviest for you?",
            "And who is doing it today? Is that falling on engineering or operations people?",
            "Have you added support for that before, or has the team been stretching to cover it?",
            "If that coordination layer ran without you chasing it, what changes for you?",
        ],
    },
};

// Where nothing above fits. Still specific about the shape of the problem, still asks about THEIR
// operation, and never pretends to know their business.
const GENERIC = {
    label: 'Business',
    frame: "recurring work landing on senior people",
    questions: [
        "What is still landing on your desk each week that honestly should not be?",
        "And when things get busy, what is the first thing to slip?",
        "Have you tried hiring for that before, or has the team just absorbed it?",
        "If one recurring thing came off your plate on Monday, what would it be?",
    ],
};

// A handful of these companies are not classified correctly by name and domain alone. Each entry
// here is a judgement about SECTOR only, the same call a person makes reading the company name, and
// never a claim about the company that a caller would repeat on the phone.
const SECTOR_OVERRIDES = {
    'diebold nixdorf': 'manufacturing',
    'drako motors': 'manufacturing',
    'ncino': 'software',
    'highradius': 'software',
    'zenoti': 'software',
    'rubrik, inc.': 'software',
    'rubrik': 'software',
    'securiti': 'software',
    'forcepoint': 'software',
    'frontline education': 'education',
    'jefferson bank': 'finance',
    'aog living': 'property',
    'wickfire': 'marketing',
    'vivent health': 'health',
    'heartgift': 'nonprofit',
    'arch-con corporation': 'construction',
    'boot civil': 'construction',
    'mckinstry': 'construction',
    'ardmore roderick': 'construction',
};

// Deliberately NOT guessed: CPM Texas, HPI and T. Kerr Group. Their names and domains do not say
// what they do, and a wrong sector means four wrong questions and a dead call. They get the general
// script, which asks instead of assuming. Paul knows these accounts; adding a line above is all it
// takes to give them their own.
export const UNCLASSIFIED_NOTE = 'No sector on file. Add the company to SECTOR_OVERRIDES in api/_spearhead-scripts.js to give it a tailored script.';

const norm = s => String(s || '').trim().toLowerCase();

/** The sector, and where that judgement came from, so a wrong one is traceable. */
export function sectorFor({ company, website = '', excerpt = '', crmIndustry = '', title = '' } = {}) {
    const override = SECTOR_OVERRIDES[norm(company)];
    if (override) return { key: override, ...BY_SECTOR[override], source: 'named' };
    const guess = industryFor({ company, excerpt: excerpt + ' ' + website, crmIndustry, title });
    const key = guess && BY_SECTOR[guess.key] ? guess.key
        : guess && guess.key === 're-media' ? 'marketing'
        : guess && ['logistics', 'home-services', 'hospitality'].includes(guess.key) ? 'manufacturing'
        : null;
    return key ? { key, ...BY_SECTOR[key], source: guess.source } : { key: null, ...GENERIC, source: 'default' };
}

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
