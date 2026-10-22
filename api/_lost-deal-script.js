// The call back to somebody we already met and did not close.
// ------------------------------------------------------------------
// Paul, 2026-10-22: "see if they filled the role, we met previously about (xxx take info from
// call) and build a script."
//
// This is a different call from a cold one and the script has to behave differently. They know who
// we are, so there is no pattern interrupt and no reason beat. There is one job: find out what
// happened to the thing they came to us about. "Did you fill it" is the whole opening, because
// either answer is useful. Filled means it was real and we can ask about the next one. Still open
// means the reason they did not buy may have expired.
//
// THE RULE THAT SHAPES EVERYTHING HERE: we only ever say we discussed something when we have a
// record of it. Telling a stranger "we spoke about hiring two editors" when they actually asked
// about bookkeeping is worse than admitting we do not have the notes. So the topic comes from what
// they typed on the booking form or from a note a host wrote, and where neither exists the script
// asks instead of asserting.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "14 August" style, in Eastern time, which is the date the caller and the prospect both mean. */
export function spokenDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' })
        .formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
    return { label: `${MONTHS[Number(parts.month) - 1]} ${Number(parts.day)}`, year: Number(parts.year), iso: d.toISOString() };
}

export function monthsSince(iso, now = Date.now()) {
    const d = Date.parse(iso);
    if (isNaN(d)) return null;
    return Math.max(0, Math.round((now - d) / (30 * 86400000)));
}

/**
 * What the meeting was about, from the record, or null.
 * The booking answers come first: they are the prospect's own words, written before the call.
 */
export function topicFrom({ answers = [], notes = null } = {}) {
    const useful = answers.filter(a => a.answer && a.answer.length > 2);
    if (useful.length) {
        const best = useful.slice().sort((a, b) => b.answer.length - a.answer.length)[0];
        return { text: best.answer, source: 'what they wrote when booking', question: best.question || null };
    }
    if (notes) return { text: notes.slice(0, 400), source: 'the note from the call', question: null };
    return null;
}

/** The branches a re-engagement call actually takes. */
function branches({ firstName, topicText }) {
    const them = firstName || 'there';
    const it = topicText ? 'that' : 'the role';
    return [
        ['They filled it',
            `Good, that is the main thing. How is it going so far? ${them === 'there' ? '' : ''}The reason I ask is most people fill the first one and then the same problem turns up somewhere else six months later. Is there anything else sitting on your plate that you would hand over if you could?`,
            'A filled role is not a dead lead. It proves the need was real and they were willing to act on it.'],
        ['Still not filled',
            `That is actually why I called. What has been the hold up, is it finding the right person or finding the time to run the search?`,
            'This is the live one. Let them say what stopped it, because that is the objection you have to answer.'],
        ['They went another way',
            `Fair enough. Who did you end up going with, and how is that working out? No pitch, I would genuinely just like to know what we were up against.`,
            'Ask what they chose and how it is going. Either it is working, which is good to know, or it is not, which is the opening.'],
        ['They do not remember us',
            `No problem at all. We spoke${topicText ? ' about ' + topicText : ''}, and I was calling to find out whether you got ${it} sorted in the end.`,
            'Do not relitigate the first call. One sentence of reminder, then back to the question.'],
        ['Bad time',
            `Understood. When would be better? I will put it in the diary now and call you back then rather than keep ringing.`,
            'Get a time, not a vague maybe. A dated callback is the only thing that makes this worth a second attempt.'],
    ];
}

/**
 * A full re-engagement script for one past meeting.
 * Returns a `verified` block naming exactly what is evidenced, so a caller can see what they are
 * allowed to assert.
 */
export function lostDealScript({ company, firstName, caller, callerEmail, metAt, eventName, answers = [], notes = null, bookingUrl, noShow = false, now = Date.now() } = {}) {
    const who = firstName || 'there';
    const date = spokenDate(metAt);
    const months = monthsSince(metAt, now);
    const topic = topicFrom({ answers, notes });
    const when = date ? `back in ${date.label}` : 'a while back';

    // A meeting that was booked and never attended is a different call. Saying "we spoke" to
    // somebody who stood us up is both wrong and memorable, so it gets its own opening.
    const opener = noShow
        ? `Hi ${who}, this is ${caller || 'a caller'} from Staffify. We had time booked in ${when} and it did not end up happening, which is completely fine, those weeks happen. I am not calling to chase that. I just wanted to find out whether you got sorted in the end.`
        : `Hi ${who}, this is ${caller || 'a caller'} from Staffify. We spoke ${when}${topic ? ' about ' + topic.text : ''}. I am not calling to pitch you, I genuinely just wanted to find out one thing: did you end up getting that filled?`;

    return {
        company: company || null,
        kind: noShow ? 'booked_but_no_show' : 'met_and_did_not_convert',
        met: date ? { label: date.label, year: date.year, iso: date.iso, monthsAgo: months } : null,
        eventName: eventName || null,
        opener,
        // Stated plainly so a caller knows the difference between what we recorded and what we think.
        verified: {
            weMet: !noShow,
            date: date ? `${date.label} ${date.year}` : null,
            topic: topic ? topic.text : null,
            topicSource: topic ? topic.source : null,
            note: topic
                ? `Safe to say out loud. This is ${topic.source}.`
                : 'We have no record of what this call was about. Do NOT guess at a topic. Ask them what it was you discussed.',
        },
        stages: [
            { label: 'Open', say: opener },
            { label: 'Then stop talking', say: 'Let them answer. Every branch below starts from what they say next, and the answer is the whole point of the call.' },
        ],
        branches: branches({ firstName, topicText: topic ? topic.text : null }).map(([label, say, note]) => ({ label, say, note })),
        close: `If it would help, I can put twenty minutes in with Paul, our CEO. He built his own agencies on this exact talent, so he is the one worth talking to rather than me. No pitch, and if it is not relevant you have lost twenty minutes. Does later this week work?`,
        voicemail: `Hi ${who}, ${caller || 'this'} is from Staffify. We spoke ${when} and I was just calling to see whether you got that filled in the end. No pitch, I will try you again. ${bookingUrl ? 'Or my calendar is ' + bookingUrl + ' if that is easier.' : ''}`.trim(),
        bookingUrl: bookingUrl || null,
        // Months since is the honest framing for how cold this is.
        staleness: months == null ? null
            : months <= 2 ? 'Recent. They will remember the conversation.'
            : months <= 6 ? 'A few months. Expect to remind them who you are.'
            : 'Over six months. Treat this as close to a cold call with a warm opening.',
    };
}
