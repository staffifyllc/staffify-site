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
import { sectorFor } from './_sectors.js';
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

// A caller books onto their OWN calendar. Sending every prospect to the same link puts meetings
// in front of whoever owns that one, which is not the person who just had the conversation.
// Keyed by the signed-in address, with Paul's shared link as the fallback for anyone unmapped.
// EMPTY ON PURPOSE. Section 4 of Milton's signed agreement (2026-10-20) requires every discovery
// call to be booked through Paul's link and states the Representative "must not use another
// scheduling link without the Company's written authorization". Section 6 then ties his commission
// attribution to the booking being recorded under Section 4, so routing him to his own link would
// put his own fee at risk, not just breach the clause.
//
// His link exists and works (calendly.com/go-staffify/milton). Add the entry back the moment Paul
// gives that authorization in writing, and every surface picks it up from here.
const CALLER_LINKS = {
    // 'milton@trystaffify.com': 'https://calendly.com/go-staffify/milton',
};
export const bookingLinkFor = email => CALLER_LINKS[String(email || '').trim().toLowerCase()] || DISCOVERY_LINK;

// Paul, 2026-10-20. Said straight after they let you continue, before any question. The first
// half takes the edge off a cold call by being honest about it; the second is the only credential
// that matters to a media owner, and it is his own, not a claim about the product.
// Rewritten in Paul's own words, 2026-10-22: "our CEO started his own agencies that needed this
// talent, many of those agencies operate at 7-8 figures today using this workforce which is how
// we've grown to over 500 employees we help folks just like (their company)". It now names the
// company at the end, which is why it takes one.
const reasonFor = company => "Hey, real quick, I don't make calls like this all day. I only call a few "
    + "people, and you looked like a good fit. So the reason I'm calling: our CEO started his own "
    + "agencies that needed this exact talent. A lot of those agencies are doing seven and eight "
    + "figures today using this workforce, and that is how we have grown to over 500 employees. "
    + "We help folks just like " + (company || 'your business') + ".";

const CLOSE = "Would it be worth half an hour to map out what that role actually looks like? No pitch, I genuinely just want to see whether it's a fit.";

const SCRIPTS = {
    // Real estate media agency owners. This is the only place QC, editing and shoots belong.
    // Paul, 2026-10-27, after listening to Milton's calls, gave the opening in his own words:
    // "hey this is milton with staffify how are you? (wait) good, the reason for my call is that we
    // work with a lot of real estate media agency owners helping them bring video editing costs
    // down, helping with customer service issues, my founder actually owns his own real estate
    // media agency too. You mind me asking if you have in covered?" Earlier the same day: "its worth
    // mentioning EARLY our team was founded by a real estate media company, Flylisted", and "Using
    // BUZZWORDS like do you have anyone helping you with QC in the morning? What about client issues
    // while you are out shooting". So: his greeting, a pause for their answer, his reason with
    // Flylisted named, and his two lines as the first questions. Every line is short enough to say
    // without reading it twice.
    [CAMPAIGN_ID]: {
        audience: 'real estate media owner',
        opener: caller => `Hey {first}, this is ${caller} with Staffify. How are you?`,
        openChoices: [['They answered (good, fine)', 'reason'], ["Who is this? / What's this about?", 'context'], ['Bad time', 'busy'], ['Not interested', 'stop'], ['Wrong person', 'gate']],
        // Paul, 2026-10-27: "we should say, I apolgoize for calling you out of nowhere but we reached
        // out a few times". True of everyone on this list: the queue only holds people sent four emails.
        reason: () => "Good. I apologize for calling you out of nowhere, but we reached out a few times. "
            + "The reason for my call is that we work with a lot of real estate media agency owners, helping them bring "
            + 'video editing costs down and helping with customer service issues. My founder actually owns his own real estate media '
            + 'agency too, Flylisted. Do you mind me asking if you have that covered?',
        reasonNote: 'Wait for their answer to "how are you" before this. Then say it once and stop talking.',
        reasonChoices: [["Not really / it's me", 'discover'], ['We have it covered', 'elsewhere'], ['They pushed back', 'busy']],
        context: them => `Sure. We work with a lot of real estate media agency owners, helping them bring video editing costs down and helping with customer service issues. My founder owns his own real estate media agency too, Flylisted. I'm not selling you anything on this call. I just wanted to find out whether any of that is a problem at ${them}.`,
        voicemail: (caller, company) => `Hi, it's ${caller} at Staffify. We work with real estate media agency owners on video editing `
            + `costs and customer service. My founder owns his own real estate media agency too, Flylisted. We sent you a few notes `
            + `by email about ${company}. If it's useful, replying to that email is the easiest way to reach me. Thanks.`,
        questions: [
            "Quick question. Do you have anyone helping you with QC in the morning, or is that still on you?",
            // Paul, 2026-10-20: ask for a number, not a feeling. Paul, 2026-10-27: frame it as the
            // client issue that lands while they are out shooting.
            "And what about client issues while you're out shooting? When an agent needs a fix or a reshoot, how long does it usually take to sort out?",
            "When a heavy week hits, what slips first? The editing, getting back to agents, or the scheduling?",
            'If you could hand one of those off on Monday, which one would it be?',
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
        'Get a name and a time. Log it as Gatekeeper with whatever you learned.'],
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
function callTree(q, company, script = {}) {
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
        open: { choices: script.openChoices || [['Go ahead', 'reason'], ["What's this about?", 'context'], ['Bad time', 'busy'], ['Not interested', 'stop'], ['Wrong person', 'gate']] },
        // Said before the first question, every time. One beat, then straight into discovery.
        reason: { say: (script.reason || reasonFor)(company), note: script.reasonNote || 'Say it once and stop talking. The question after this is what the call is for.', choices: script.reasonChoices || [['Keep going', 'discover'], ['They pushed back', 'busy']] },
        context: {
            say: script.context ? script.context(them) : `Fair enough. We place dedicated remote team members with owners like you, people who sit on the editing queue, the client follow-up, the scheduling. I'm not selling you anything on this call. I just wanted to find out whether any of that is actually a problem at ${them}.`,
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
            note: 'If they give a window, log Not interested: timing with that date. They come back round when it arrives AND they go into the email nurture meanwhile. Only use Not interested / stop if they want to be left alone.',
            log: 'timing',
        },
        busy: {
            say: "Totally fair, I've caught you cold. Is there a better time later this week, or would you rather I left you to it?",
            note: 'Log Callback with the time they give.',
            log: 'callback',
        },
        gate: {
            say: 'No problem, I may well have the wrong person. Who looks after the day-to-day there? And is there a decent time to catch them?',
            note: 'Log Gatekeeper. Put who answered, who to ask for and the best time in the notes.',
            log: 'gatekeeper',
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
export function callScript({ campaignId, caller, callerEmail, company, firstName, website = '', excerpt = '', crmIndustry = '', title = '', igBranch = null }) {
    const base = SCRIPTS[campaignId] || SCRIPTS[TOBIT_ID];
    const who = company || 'your business';
    // Paul, 2026-10-22: "can we wire up the spearheads account to behave exactly like the other
    // call format". It does now, which means the Spearhead cohort comes through this function
    // rather than its own page. The one thing that had to survive that move is the sector: a bank,
    // a builder and a children's charity do not share a question, and the generic business-owner
    // set said nothing to any of them.
    const sector = campaignId === TOBIT_ID ? sectorFor({ company, website, excerpt, crmIndustry, title }) : null;
    // Three questions and the close, which is the shape this campaign already had. NOT four: the
    // branching tree assigns its choice labels by position, and a five-question script gets the
    // media-only "how long until it is resolved" node with its Same day / A day or two buttons.
    // Under a sector question like "who picks it up when it backs up" those answers are nonsense,
    // and a caller mid-conversation would be reading buttons that do not match what was asked.
    let questions = sector ? [...sector.questions.slice(0, 2), sector.questions[3], CLOSE] : null;
    // Paul, 2026-10-22: the Instagram opener for marketing agencies. It REPLACES the first
    // discovery question only when verified evidence exists, and the gate that decides that lives
    // in _instagram-branch.js. Without evidence this is null and the ordinary question stands, so
    // there is no path where the line is said on a guess.
    if (questions && igBranch && igBranch.say) questions = [igBranch.say, ...questions.slice(1)];
    const pick = questions ? { audience: sector.label.toLowerCase(), questions } : base;
    return {
        audience: pick.audience,
        ...(sector ? { sector: { key: sector.key, label: sector.label, source: sector.source } } : {}),
        ...(igBranch ? { instagramBranch: igBranch } : {}),
        opener: (pick.opener || opener)(caller, who).replace('{first}', firstName || 'there'),
        questions: pick.questions,
        stages: (STAGE_LABELS[pick.questions.length] || STAGE_LABELS[4]).map((label, i) => ({ label, say: pick.questions[i] })).filter(s => s.say),
        objections: OBJECTIONS.map(([label, say, note]) => ({ label, say, note })),
        voicemail: (pick.voicemail || voicemail)(caller, who),
        reason: (pick.reason || reasonFor)(who),
        bookingUrl: bookingLinkFor(callerEmail),
        tree: callTree(pick.questions, company, pick),
    };
}

// HIRING NOW (api/_hiring-intent.js). Call first: nothing was emailed before this call, so no line
// here says it was (PM, 2026-10-27: "must not say 'we sent a few emails' for these 0-touch
// records"). The reason for the call is their own job post, which is on the caller's screen with
// the date it was checked. With no named contact the opener asks for whoever is hiring the role.
const HIRING_WORK = { support: 'customer support', admin: 'admin and executive support', scheduling: 'scheduling and front desk', account: 'account support', sales: 'sales' };
// Paul, 2026-10-28: "Ultimately, we're looking to create partnerships with people where we are doing all
// their hiring for remote teams, like customer service, sales, and admin support." The open role is the
// reason for the call; the offer is to run that hiring for them, this seat and the ones after it.
/** A posted title as a caller says it: "Customer Service Representative - $40k-$60k/yr + commission" is "Customer Service Representative". */
export function spokenRole(title) {
    const t = String(title || '').split(/\s[-–—|]\s|\(|,|;|\s\$/)[0].replace(/\s*\/\s*/g, ' and ').replace(/\s+/g, ' ').replace(/[\s:.-]+$/, '')
        .replace(/^(allstate|farmers(\s+insurance)?|state\s+farm)\s+/i, '').replace(/\s+(i{1,3}|iv|[1-4])$/i, '').trim();
    return t || String(title || '').trim().slice(0, 60);
}
// The people the seat is, in the plural, as Paul says it ("dedicated EAs"): seniority, carrier names and level
// numbers dropped, each person-noun pluralised, "Customer Service and Retention Specialist" left grammatical.
const PERSON_NOUN = /(er|or|ist|ant|ent|ive|rep|admin|manager|assistant|secretary|paralegal|agent|coordinator|setter|specialist|representative|associate|clerk|dispatcher|receptionist|officer|expert|consultant|producer|planner|closer|csr|sdr|bdr|va)$/i;
const plural = w => (/[^s]s$/i.test(w) ? w : /[^aeiou]y$/i.test(w) ? w.slice(0, -1) + 'ies' : /(ss|x|ch|sh)$/i.test(w) ? w + 'es' : /^[A-Z0-9]+$/.test(w) ? w + 's' : w + 's');
export function pluralRole(role) {
    let r = String(role || '').replace(/\s+to\s+(the\s+)?\S.*$/i, '').trim();
    for (let i = 0; i < 6; i++) r = r.replace(/^(remote|senior|sr\.?|junior|jr\.?|experienced|entry[- ]level|part[- ]time|full[- ]time|level|allstate|farmers(\s+insurance)?|state\s+farm)\s+/i, '');
    r = r.replace(/\s+(i{1,3}|iv|\d+)$/i, '').trim();
    if (/^executive\s+assistant$/i.test(r)) return 'EAs';
    const parts = r.split(/\s+and\s+/i);
    // "Customer Service" is the work, not the person: those are "Customer Service staff".
    return parts.map((p, i) => { const ws = p.split(/\s+/), last = ws[ws.length - 1]; return PERSON_NOUN.test(last) ? [...ws.slice(0, -1), plural(last)].join(' ') : i === parts.length - 1 ? p + ' staff' : p; }).join(' and ');
}
/** "a" or "an" as it is said: an Account Manager, an L1 Technical Support Agent, an SDR, a Senior Paralegal. */
export const articleFor = w => (/^[aeiou]/i.test(w) || /^[FHLMNRSX][A-Z0-9]*\b/.test(w) ? 'an' : 'a');
export function hiringCallScript({ caller, callerEmail, company, firstName, jobTitle, family, offshore, city, direct = false }) {
    const who = company || 'your company';
    const role = jobTitle ? spokenRole(jobTitle) : 'that role';
    const aRole = articleFor(role) + ' ' + role;
    // "hiring an Executive Assistant", but "hiring for a Customer Service role" when the title names the work.
    const hiringWhat = PERSON_NOUN.test(role.replace(/\s+(to|for)\s+\S.*$/i, '').split(/\s+/).pop() || '') ? aRole : `for ${aRole} role`;
    const inCity = city ? ' in ' + city : '';
    const work = HIRING_WORK[family] || 'support';
    // Paul, 2026-10-28: "Can our script say I'm looking to speak with (prospect name i.e Eric) or the person in
    // charge of hiring". The number is usually a front desk or main line, so the opener asks for the person; the
    // cold-call line comes once they are on (the tree's 'intro').
    // Paul, later the same day: "can the beginning of the call script mention the job we're calling about?" The
    // job comes first, so whoever answers knows why we are calling before we ask for anyone. The intro names it
    // again, because the person put through has not heard the opener.
    // The owner's own cell: they answer it themselves, so greet them and say why, no front-desk ask.
    const opener = direct && firstName
        // Paul: "Hi, is this Shirley? then wait, then say Hi Fname.... This is Paul with Staffify."
        ? `Hi, is this ${firstName}? (Wait for them.) Hi ${firstName}, this is ${caller} with Staffify.`
        : firstName
        ? `Hi, this is ${caller} with Staffify. I'm calling about the ${role} job you posted${inCity}. I'm looking to speak with ${firstName}, or the person in charge of hiring. Is that you?`
        : `Hi, this is ${caller} with Staffify. I'm calling about the ${role} job you posted${inCity}. I'm looking to speak with the person in charge of hiring for it. Is that you, or could you point me to them?`;
    const intro = `Great, thanks. I'll be straight with you, this is a cold call. Do you have a quick second?`;
    // Paul, 2026-10-28 evening, word for word with the role swapped in ("but of course reference the actual role").
    const reason = `The reason I'm calling is I saw you're hiring ${hiringWhat}. We help companies hire dedicated ${pluralRole(role)} from Latin America and the Philippines, and we handle the recruiting, vetting, and ongoing management. I wanted to see if you'd be open to a quick conversation with our team so we can learn more about the role and see if we can put a few great candidates in front of you.`;
    // Paul, 2026-10-28: "if they filled the role, one thing we want to be able to pivot to is ... Is it okay if I stay in
    // touch with you ... And then we can schedule a callback for a month from now."
    const filled = `Okay, and just wanted to let you know, the reason I'm calling is I work for a company called Staffify, and we fill these positions for people with remote offshore team members that typically cost 50% of what the advertised position pays. Is it okay if I stay in touch with you and see if there's a chance that this person doesn't work out, that we could connect in the future?`;
    const questions = [
        'How is the search going so far? Have you found the right person yet?',
        'What will that person spend most of their day on? Tickets, phones, chat, scheduling?',
        "That's the kind of seat we fill. If I sent you two or three vetted people who have done exactly that work, already screened for English and the tools you use, would that be useful?",
        "The easiest next step is fifteen minutes with Paul, our founder, to scope this role and how we would handle the next hires like it. What does later this week look like?",
    ];
    const tree = {
        open: { choices: direct && firstName ? [["Yes, that's me", 'reason'], ["What's this about?", 'context'], ['Wrong person', 'gate'], ['Bad time', 'busy'], ['Not interested', 'stop']] : [["That's me / putting you through", 'intro'], ["What's this about?", 'context'], ['Not here / someone else', 'gate'], ['Bad time', 'busy'], ['Not interested', 'stop']] },
        intro: { say: intro, choices: [['Go ahead', 'reason'], ['Bad time', 'busy'], ['Not interested', 'stop']] },
        reason: { say: reason, note: (offshore ? `Their post is open to candidates in ${offshore}: say so, it is exactly where our people are. ` : '') + 'Say it once and stop talking. Their answer decides the next step.', choices: [['Yes, open to it', 'close'], ['Tell me more first', 'discover'], ['Already filled it', 'filled'], ['We only hire in-house', 'inhouse'], ['Bad time', 'busy'], ['Not interested', 'stop']] },
        context: { say: `Of course. ${reason}`, choices: [['Yes, open to it', 'close'], ['Tell me more first', 'discover'], ['Not interested', 'stop']] },
        discover: { say: questions[0], choices: [['Still looking', 'dig'], ['Filled it', 'filled'], ['We only hire in-house', 'inhouse']] },
        dig: { say: questions[1], note: 'Write down the work, the hours and the tools. It is what we match people to.', choices: [['They described it', 'offer']] },
        offer: { say: questions[2], choices: [['Yes', 'close'], ['Maybe, send something', 'sendinfo'], ['No', 'future']] },
        filled: { say: filled, note: 'A filled seat is not a no. A yes is a callback in a month, set for you on the next step.', choices: [['Yes, stay in touch', 'keepintouch'], ['They have another seat open', 'dig'], ['No thanks', 'stop']] },
        keepintouch: { say: "Perfect. I'll send you a quick email with who we are, and check back in about a month to see how the new hire is working out. What's the best email to send that to?", note: 'Send the summary from the button below while you have them. The callback is set for a month from today; change it if they gave you a date, then save it as Callback.', log: 'callback', callbackDays: 30, email: 'hiring-stay-in-touch' },
        inhouse: { say: "Understood. Is that a set policy, or just how you've hired so far? A lot of teams try one remote seat first to see how it goes.", note: 'Do not argue. If it is a policy, log Not interested: timing and move on.', choices: [['Open to it', 'offer'], ["It's a policy", 'future']] },
        close: { say: questions[3], choices: [['Booked', 'booked'], ['Send something first', 'sendinfo']] },
        booked: { say: 'Brilliant. Before I let you go, is there anything about the role you want covered so we turn up prepared?', note: 'Log Connected / interested. Put the booking and exactly what they asked for in the notes. Send the summary below so the booking link is in their inbox.', log: 'connected', email: 'hiring-thanks' },
        sendinfo: { say: 'No problem. So I send something useful rather than a brochure, should I aim it at the role itself or at how a placement works?', note: 'Send it from the button below while you have them, written for this job. Then log Connected / interested with the specific ask.', log: 'connected', email: 'hiring-thanks' },
        future: { say: 'Understood. Would it be worth me checking back in a few months, or would you rather I left it?', note: 'If they give a window, log Not interested: timing with that date. Only use Not interested / stop if they want to be left alone.', log: 'timing' },
        busy: { say: "Totally fair, I've caught you cold. Is there a better time later this week, or would you rather I left you to it?", note: 'Log Callback with the time they give.', log: 'callback' },
        gate: { say: `No problem. Who is hiring for the ${role} role? And is there a decent time to catch them?`, note: 'Log Gatekeeper. Put who answered, who to ask for and the best time in the notes.', log: 'gatekeeper' },
        stop: { say: "Understood, and I appreciate you telling me straight. I'll take you off the list.", note: 'Use Not interested / stop so the exclusion is recorded. Never argue this one.', log: 'suppress' },
    };
    const objections = [
        ['Busy', "Totally fair, I've caught you cold. Is there a better time later this week, or would you rather I left you to it?", 'If they offer a time, log it as a callback.'],
        ['Already filled it', filled, 'A filled seat is not a no. If they say yes, log a Callback for a month out.'],
        ['We only hire in-house', "Understood. Is that a set policy, or just how you've hired so far? A lot of teams try one remote seat first to see how it goes.", 'If it is a policy, log Not interested: timing.'],
        ['We use an agency', 'Makes sense. Where we usually differ: we manage the person day to day, and if someone does not work out we replace them under our lifetime replacement guarantee.', 'Only the lifetime replacement guarantee. Never a time-limited one.'],
        ['How much?', "It depends on the role and the hours, and I'd rather give you a real number than a guess. Can I ask what the work would actually be first?", 'Use current approved pricing only. Onboarding is paid in full upfront. No financing, instalments or discounts.'],
        ['Send information', 'Happy to. So I send something useful rather than a brochure, should I aim it at the role itself or at how a placement works?', 'Get the specific ask and the best email, log Connected / interested, and a person follows up.'],
        ['Wrong person / gatekeeper', `No problem. Who is hiring for the ${role} role? And is there a decent time to catch them?`, 'Get a name and a time. Log it as Gatekeeper.'],
        ['Not interested / stop', "Understood, and I appreciate you telling me straight. I'll take you off the list.", 'Use Not interested / stop below so the exclusion is recorded. Never argue this one.'],
    ];
    return {
        audience: 'businesses hiring now',
        opener, reason, questions,
        stages: STAGE_LABELS[4].map((label, i) => ({ label, say: questions[i] })),
        objections: objections.map(([label, say, note]) => ({ label, say, note })),
        voicemail: `Hi${firstName ? ' ' + firstName : ''}, it's ${caller} at Staffify. I saw ${who} is hiring ${hiringWhat}. We run hiring for remote customer service, sales and admin roles, and I can have a few vetted candidates in front of you this week if that helps. I'll try you again in a couple of days. Thanks.`,
        bookingUrl: bookingLinkFor(callerEmail),
        tree,
    };
}
