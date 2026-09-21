// WHAT PAUL SENDS, PREPARED FROM WHAT THEY ACTUALLY SAID.
//
// Every one of these is a DRAFT. Rendering one changes nothing: it does not mark anything sent, it
// does not touch the record's state, and nothing here is wired to a sender. The hub shows the text
// and a mailto; Paul edits and sends from his own mailbox.
//
// The rules the copy obeys, from the approved plan:
//   * their words, quoted, or the draft says plainly that they did not say anything yet
//   * no savings percentage, no retention claim, no count of who we work with, no guarantee of time
//     saved, and nothing that implies a relationship that does not exist
//   * the published price, in full, including what is owed if they cancel on the deferred path
//   * no deadline, and no Action Taker incentive, because this pilot does not use urgency

export const PRICING = Object.freeze({
    onboarding: 2499,
    rates: { 'C-List': 11.25, 'B-List': 12.50, 'A-List': 14 },
    typical: 12.50,
    deferred: 'You can carry the $2,499 instead of paying it: $1 an hour on top of your rate, or $2 an hour, '
        + 'until it is paid off. No interest, no fees. Repayment tracks hours actually worked, so at roughly '
        + '40 hours a week that is about 14 months at $1 or 7 months at $2.',
    cancellation: 'If you stop before the onboarding is paid off, the remaining balance is due. You are '
        + 'deferring it, not avoiding it.',
    guarantee: 'If the hire does not work out we run the whole sourcing and onboarding process again with no '
        + 'additional recruiting or replacement charge, under the lifetime replacement guarantee.',
});

const firstName = (r) => String(r.name || '').trim().split(/\s+/)[0] || 'there';
const theirWords = (r) => String(r.pain || '').trim();

export function replyDraft(r) {
    const said = theirWords(r);
    const body = [
        `Hey ${firstName(r)},`,
        '',
        said
            ? `Thanks for writing. You said: "${said}"`
            : 'Thanks for asking for the role map.',
        '',
        said
            ? 'Before I write it up, one question so I get the hours right: how often does that happen in a normal week?'
            : 'One question so I get this right: what part of the work still comes back to you, and how often does that '
              + 'happen in a normal week?',
        '',
        'I will send back what a second person could take over, what has to stay with you, how the review would work, '
        + 'an hours estimate with the assumptions shown, and what it costs at those hours. If there is not enough there '
        + 'to hand over, I will tell you that instead.',
        '',
        'Paul',
    ].join('\n');
    return { kind: 'reply', subject: `Re: role map for ${r.company || 'your agency'}`, body, draft: true };
}

/** The brackets a role map cannot ship with. Rendering one lists them; it never pretends they are filled. */
export const ROLE_MAP_REQUIRED = Object.freeze([
    ['tasks', 'the specific recurring tasks a second person takes over, each with how often'],
    ['hours', 'the hours estimate'],
    ['assumption', 'the assumption the hours rest on, written out so they can correct it'],
    ['successMeasure', 'the one measure of a good first month, and the baseline it is measured against'],
    ['nextStep', 'who does what by when, or plainly that there is nothing worth doing'],
]);

export function roleMapDraft(r, opts = {}) {
    const said = theirWords(r);
    const f = (k, fallback) => {
        const v = String(opts[k] || r[`draft_${k}`] || '').trim();
        return v || fallback;
    };
    const missing = ROLE_MAP_REQUIRED
        .filter(([k]) => !String(opts[k] || r[`draft_${k}`] || '').trim())
        .map(([, why]) => why);
    if (!said) missing.unshift('what they actually said: without it this is a template, not a role map');
    const body = [
        `Role map for ${r.company || firstName(r)}`,
        `Written by Paul after your note on ${String(r.createdAt || '').slice(0, 10) || 'your enquiry'}. This is a draft for you to argue with.`,
        '',
        'WHAT YOU SAID',
        said ? `"${said}"` : '(you have not told me yet, so the rest of this is a guess and should be treated as one)',
        '',
        'WHAT A SECOND PERSON TAKES OVER',
        '  ' + f('tasks', '[not written yet: the specific recurring tasks, each with how often]'),
        '',
        'WHAT STAYS WITH YOU',
        '  The quality standard, in writing. Final approval on anything the checklist does not cover.',
        '  Taste calls. The client relationship. Anything a mistake would cost you the account.',
        '',
        'HOW THE HANDOFF WORKS',
        '  They check against your written checklist: pass, fail, or unsure. Unsure comes to you.',
        '  Fails go back to the editor quoting the line they missed.',
        '  You review everything at first, and move to a sample only when you decide the work holds up.',
        '  Escalation is a rule, not a judgement call: new client, new property type, anything not on the checklist.',
        '',
        'HOURS',
        '  ' + f('hours', '[not estimated yet]') + ', based on ' + f('assumption', '[the assumption this rests on, not written yet]'),
        '',
        'WHAT IT COSTS AT THOSE HOURS',
        `  Onboarding $${PRICING.onboarding} once. Hourly $${PRICING.rates['C-List']} to $${PRICING.rates['A-List']} `
        + `depending on level, most placements at $${PRICING.typical}, all in: payroll, HR, training and the replacement guarantee.`,
        `  ${PRICING.deferred}`,
        `  ${PRICING.cancellation}`,
        '',
        'WHAT GOOD LOOKS LIKE IN MONTH ONE',
        '  ' + f('successMeasure', '[not agreed yet: one measure you would recognise, against a baseline we write down first]'),
        '',
        'WHEN I WOULD TELL YOU NOT TO HIRE',
        '  Under about ten hours a week of coordination: write the checklist first and see what is left.',
        '  Seasonal work that is thin between peaks: part-time or nothing.',
        '  A standard that really is pure taste every time: it stays with you.',
        '',
        'NEXT STEP',
        '  ' + f('nextStep', '[not decided yet]'),
    ].join('\n');
    return { kind: 'roleMap', subject: `Role map for ${r.company || 'your agency'}`, body, draft: true,
        needs: missing, ready: missing.length === 0,
        fields: ROLE_MAP_REQUIRED.map(([k, why]) => ({ key: k, why, value: String(opts[k] || r[`draft_${k}`] || '') })) };
}

export function proposalDraft(r, { hours, level = 'B-List', role = '' } = {}) {
    const rate = PRICING.rates[level] || PRICING.typical;
    // No assumed week. A proposal with invented hours is an invented price.
    const h = Number(hours || r.draft_hours || 0);
    const needs = [];
    if (!h) needs.push('the hours a week this role actually needs, from the conversation');
    if (!String(role || r.draft_role || '').trim()) needs.push('the role title');
    const monthly = h ? Math.round(rate * h * 52 / 12) : null;
    const body = [
        `DRAFT proposal for ${r.company || firstName(r)}`,
        'Not sent. Not an invoice. Review every line before this goes anywhere.',
        '',
        `Role: ${String(role || r.draft_role || '').trim() || '[role title not set]'}, `
        + `${h ? h + ' hours a week' : '[hours not set]'}, ${level} at $${rate.toFixed(2)} an hour.`,
        monthly
            ? `That is about $${monthly.toLocaleString()} a month at ${h} hours a week, all in: payroll, benefits, `
              + 'HR support, time tracking, ongoing training and the replacement guarantee.'
            : 'The monthly figure follows once the hours are set. Everything in the rate is all in: payroll, benefits, '
              + 'HR support, time tracking, ongoing training and the replacement guarantee.',
        '',
        `Onboarding: $${PRICING.onboarding}, one time.`,
        PRICING.deferred,
        PRICING.cancellation,
        '',
        PRICING.guarantee,
        '',
        'No long-term contract on the hourly rate. If you paid onboarding up front you can stop whenever you want, with '
        + 'hours already worked and any open invoices still payable.',
    ].join('\n');
    return { kind: 'proposal', subject: `Proposal for ${r.company || 'your agency'}`, body, draft: true,
        needs, ready: needs.length === 0,
        amount: monthly, onboarding: PRICING.onboarding, rate, hours: h || null, level,
        // For the operator, not for the buyer. This never appears in anything anyone is sent.
        operatorNotes: ['No savings percentage, no promise of hours saved and no retention claim are in this draft, '
            + 'because we do not have evidence from their numbers. Do not add one.'] };
}

export const DRAFTS = { reply: replyDraft, roleMap: roleMapDraft, proposal: proposalDraft };

/** A mailto the hub can open, so Paul sends it himself from his own mailbox. */
export function mailto(to, draft) {
    return `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
}
