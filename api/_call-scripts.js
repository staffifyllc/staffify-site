// What the caller actually says, per campaign.
// ------------------------------------------------------------------
// Paul, 2026-10-20: "these need to be much more conversational and encouraging, like saying
// things, if you don't mind me asking do you tend to get caught up in QC, revisions and stuff?"
// and "that should only be for media agency owners".
//
// So the register is a real conversation: ask permission, name the work in THEIR words, and give
// them an easy way to say no. Contractions throughout, because a caller reading "I will be
// straight with you" off a screen sounds like a robot.
//
// The media-specific language (QC, revisions, editing turnaround) is fenced to the agency
// campaign. A CEO on the b2b list has no revisions queue, and a talent-network prospect must
// never hear anything sourced from a resume.
import { CAMPAIGN_ID } from './_outreach-campaign.js';
import { TOBIT_ID } from './_tobit-campaign.js';
import { TALENT_ID } from './_talent-network-campaign.js';

// Every campaign opens the same way: name yourself, say why you are calling, and hand them the
// exit immediately. A caller who earns the next thirty seconds has done the opener's whole job.
const opener = (caller, company) =>
    `Hi {first}, this is ${caller} with Staffify. I'll be straight with you, this is a cold call. `
    + `We sent you over a few notes by email about handing off recurring work at ${company}. `
    + `Do you have a quick second?`;

// Paul's discovery call, the same link the pitch pages use. Server-supplied so a caller always
// has a working one: the live Calendly fetch can come back empty, and "no confirmed discovery
// link available" in the middle of a good call is the worst possible moment to find that out.
export const DISCOVERY_LINK = 'https://calendly.com/go-staffify/discovery-call';

// Paul, 2026-10-20. Said straight after they let you continue, before any question. The first
// half takes the edge off a cold call by being honest about it; the second is the only credential
// that matters to a media owner, and it is his own, not a claim about the product.
const REASON = "Hey, real quick, I don't make calls like this all day. I only call a few people, "
    + "and you looked like a good fit. So the reason I'm calling: our CEO owns a real estate media "
    + "agency, he grew it past six million, and one of the biggest things he did was hire brilliant "
    + "overseas talent. That's the whole reason this company exists.";

const CLOSE = "Would it be worth half an hour to map out what that role actually looks like? No pitch, I genuinely just want to see whether it's a fit.";

const SCRIPTS = {
    // Media agency owners. This is the only place QC, revisions and turnaround belong.
    [CAMPAIGN_ID]: {
        audience: 'media agency owner',
        questions: [
            "If you don't mind me asking, do you still get pulled into the QC and revisions side of things, or have you got that off your plate by now?",
            // Paul, 2026-10-20: the pain point worth asking a media owner. It works whether or not
            // they are still doing QC themselves, which is why it sits after the opening probe
            // rather than competing with it, and it asks for a number rather than a feeling.
            "And when a client comes back with a problem, a reshoot or a correction, how long does it usually take you to get that resolved?",
            "And when a heavy week hits, what's the first thing to slip? Is it the editing turnaround, the client follow-up, or the scheduling?",
            'If you could hand one of those off on Monday and genuinely stop thinking about it, which one would you pick?',
            CLOSE,
        ],
    },
    // Recruiter-sourced business contacts. Same shape, no studio language.
    [TOBIT_ID]: {
        audience: 'business owner',
        questions: [
            "If you don't mind me asking, what's still landing on your desk each week that probably shouldn't be?",
            "And when things get busy, what's the first thing to slip?",
            'If one recurring thing could come off your plate on Monday, what would it be?',
            CLOSE,
        ],
    },
    // Resume-informed research. Ask about today's workflow only. Never reference an applicant,
    // a resume or a vacancy: that evidence is historical and is not theirs to hear about.
    [TALENT_ID]: {
        audience: 'business owner',
        questions: [
            "If you don't mind me asking, how are you covering the day-to-day admin side at the moment?",
            'And when it gets busy, what tends to slip first?',
            'If one recurring task could come off your plate, which one would help most?',
            CLOSE,
        ],
    },
};

// The media script asks one more question than the others, so the labels are chosen by length
// rather than fixed at four. A stage with no question behind it would render blank.
const STAGE_LABELS = {
    4: ['Understand the work', 'Find the bottleneck', 'Make it useful', 'Agree a next step'],
    5: ['Understand the work', 'How long clients wait', 'Find the bottleneck', 'Make it useful', 'Agree a next step'],
};

/**
 * `say` is read aloud. `note` is for the caller only and is never spoken. They are separate
 * fields because the old bank mixed an instruction into the sentence, so a caller reading off
 * the screen would say "use current approved pricing" down the phone.
 */
const OBJECTIONS = [
    ['Busy',
        "Totally fair, I've caught you cold. Is there a better time later this week, or would you rather I left you to it?",
        'If they offer a time, log it as a callback. If they want to be left alone, respect it.'],
    ['Already have help',
        "That's good to hear. What do they cover for you? I'm mostly curious whether anything still bounces back to you.",
        'Existing help is not a no. Listen for the work that falls between their current cover.'],
    ['Not hiring',
        "Understood, and I'm not really asking you to hire. I was more curious what still lands on you day to day. If it's all covered, genuinely no problem.",
        'Take the pressure off. Most good conversations start right after this line.'],
    ['Send information',
        'Happy to. So I send something useful rather than a brochure, which side is it: the client coordination, the admin, or something else?',
        'Get the specific ask before agreeing, then create a human follow-up. Do not promise a send you cannot make.'],
    ['How much?',
        "It depends on the role and the hours, and I'd rather give you a real number than a guess. Can I ask what the work would actually be first?",
        'Use current approved pricing only. Onboarding is paid in full upfront. No financing, instalments or discounts.'],
    ['Wrong person / gatekeeper',
        'No problem, I may well have the wrong person. Who looks after the day-to-day there? And is there a decent time to catch them?',
        'Get a name and a time. Log it as a callback with whatever you learned.'],
    ['Not interested / stop',
        "Understood, and I appreciate you telling me straight. I'll take you off the list.",
        'Use Not interested / stop below so the exclusion is recorded. Never argue this one.'],
];

const voicemail = (caller, company) =>
    `Hi, it's ${caller} at Staffify. We sent you over a few notes by email about handing off recurring `
    + `work at ${company}. Nothing urgent, I just wanted to put a voice to it. If it's useful, replying `
    + `to that email is the easiest way to reach me. Thanks.`;

// WHERE THE CALL GOES AFTER THE OPENER.
// Paul, 2026-10-20: "would [you like] to help direct where the call goes after this?"
// A linear next-question stepper is not how a call works. Each node is what to SAY, and the
// buttons are what THEY just said, so a caller always has the next move in front of them
// instead of improvising. Terminal nodes name the outcome to log, which is why `log` only ever
// uses the six dispositions the card actually accepts.
function callTree(q, company) {
    const them = company || 'your business';
    // Indexing q[1] and q[3] by hand broke the moment the media script gained a fifth question:
    // the close node started asking "which would you hand off" instead of asking for the meeting.
    // The roles are resolved by position-from-the-ends, which holds at any length.
    const open = q[0];
    const close = q[q.length - 1];
    const middle = q.slice(1, -1);
    // Five questions means the media script, which asks how long a client issue takes to resolve.
    // Counting the middle was wrong: a four-question script also has two middles.
    const resolve = q.length >= 5 ? middle[0] : null;
    const bottleneck = resolve ? middle[1] : middle[0];
    return {
        open: { choices: [['Go ahead', 'reason'], ["What's this about?", 'context'], ['Bad time', 'busy'], ['Not interested', 'stop'], ['Wrong person', 'gate']] },
        // Said before the first question, every time. One beat, then straight into discovery.
        reason: { say: REASON, note: 'Say it once and stop talking. The question after this is what the call is for.', choices: [['Keep going', 'discover'], ['They pushed back', 'busy']] },
        context: {
            say: `Fair enough. We place dedicated remote team members with owners like you, people who sit on the editing queue, the client follow-up, the scheduling. I'm not selling you anything on this call. I just wanted to find out whether any of that is actually a problem at ${them}.`,
            choices: [['Go ahead', 'reason'], ['Not interested', 'stop']],
        },
        discover: { say: open, choices: [["Yes, that's me", resolve ? 'resolve' : 'dig'], ["No, that's handled", 'elsewhere'], ["It's just me / too small", 'solo']] },
        // Only built when the campaign asks it. It works whether or not they still do the QC
        // themselves, which is exactly why both branches above run through it.
        ...(resolve ? { resolve: { say: resolve, note: 'Listen for a number. "However long it takes" is the answer you want, and it is the whole pitch.', choices: [['Same day', 'dig'], ['A day or two', 'dig'], ['Longer, or it depends', 'dig']] } } : {}),
        dig: { say: bottleneck, choices: [['They named something', 'quantify'], ['They were vague', 'quantify']] },
        elsewhere: {
            say: "Good, that's rarer than you'd think. What's left then? The scheduling, the invoicing, the inbox?",
            // A named pain still runs through the resolution question where the campaign asks it.
            // "Genuinely nothing" is a polite exit and must stay one.
            choices: [['They named something', resolve ? 'resolve' : 'quantify'], ['Genuinely nothing', 'nothing']],
        },

        solo: {
            say: "That's completely fine, almost everyone we work with started exactly there. The question is usually whether you want to still be doing the admin yourself as it grows.",
            choices: [['Open to it', 'quantify'], ['Not right now', 'future']],
        },
        quantify: {
            say: "Roughly how many hours a week do you reckon that's costing you?",
            note: 'Write the number in your notes. It is the single most useful thing you can bring back from this call.',
            choices: [['They gave a number', 'close'], ["They don't know", 'close']],
        },
        close: { say: close, choices: [['Yes', 'booked'], ['Maybe, send something', 'sendinfo'], ['No', 'future']] },
        booked: {
            say: "Brilliant. Before I let you go, is there anything you want covered on that call so I turn up prepared?",
            note: 'Log Connected / interested. Put the booking link in the notes and record exactly what they asked for.',
            log: 'connected',
        },
        sendinfo: {
            say: "No problem. So I send something useful rather than a brochure, what should I aim it at?",
            note: 'Log Connected / interested with the specific ask. Create a human follow-up. Do not promise a send you cannot make.',
            log: 'connected',
        },
        future: {
            say: "Understood. Would it be worth me trying you again further down the line, or would you rather I left it?",
            note: 'If they give a window, log Not interested: timing with that date and they come back round when it arrives. Only use Not interested / stop if they want to be left alone.',
            log: 'timing',
        },
        busy: {
            say: "Totally fair, I've caught you cold. Is there a better time later this week, or would you rather I left you to it?",
            note: 'Log Callback with the time they give.',
            log: 'callback',
        },
        gate: {
            say: 'No problem, I may well have the wrong person. Who looks after the day-to-day there? And is there a decent time to catch them?',
            note: 'Log Callback. Put the name and the time in the notes.',
            log: 'callback',
        },
        nothing: {
            say: "That's a good place to be, honestly. I'll leave you to it. If it ever gets heavy, you know where we are.",
            note: 'Log Connected / interested and note that there is no current need. They did not opt out, so do not suppress them.',
            log: 'connected',
        },
        stop: {
            say: "Understood, and I appreciate you telling me straight. I'll take you off the list.",
            note: 'Use Not interested / stop so the exclusion is recorded. Never argue this one.',
            log: 'suppress',
        },
    };
}

/** Everything the card needs to run the call, chosen by campaign. */
export function callScript({ campaignId, caller, company, firstName }) {
    const pick = SCRIPTS[campaignId] || SCRIPTS[TOBIT_ID];
    const who = company || 'your business';
    return {
        audience: pick.audience,
        opener: opener(caller, who).replace('{first}', firstName || 'there'),
        questions: pick.questions,
        stages: (STAGE_LABELS[pick.questions.length] || STAGE_LABELS[4]).map((label, i) => ({ label, say: pick.questions[i] })).filter(s => s.say),
        objections: OBJECTIONS.map(([label, say, note]) => ({ label, say, note })),
        voicemail: voicemail(caller, who),
        reason: REASON,
        bookingUrl: DISCOVERY_LINK,
        tree: callTree(pick.questions, company),
    };
}
