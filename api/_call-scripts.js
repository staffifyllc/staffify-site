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
    + `Have I caught you in the middle of something?`;

const CLOSE = "Would it be worth half an hour to map out what that role actually looks like? No pitch, I genuinely just want to see whether it's a fit.";

const SCRIPTS = {
    // Media agency owners. This is the only place QC, revisions and turnaround belong.
    [CAMPAIGN_ID]: {
        audience: 'media agency owner',
        questions: [
            "If you don't mind me asking, do you still get pulled into the QC and revisions side of things, or have you got that off your plate by now?",
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

const STAGE_LABELS = ['Understand the work', 'Find the bottleneck', 'Make it useful', 'Agree a next step'];

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

/** Everything the card needs to run the call, chosen by campaign. */
export function callScript({ campaignId, caller, company, firstName }) {
    const pick = SCRIPTS[campaignId] || SCRIPTS[TOBIT_ID];
    const who = company || 'your business';
    return {
        audience: pick.audience,
        opener: opener(caller, who).replace('{first}', firstName || 'there'),
        questions: pick.questions,
        stages: STAGE_LABELS.map((label, i) => ({ label, say: pick.questions[i] })),
        objections: OBJECTIONS.map(([label, say, note]) => ({ label, say, note })),
        voicemail: voicemail(caller, who),
    };
}
