// The Instagram question, for marketing agency owners, only when we can prove it.
// ------------------------------------------------------------------
// Paul, via Codex, 2026-10-22. His line: "When's the last time you posted on Instagram?" then
// "Aren't you guys a marketing agency and you're not even marketing yourselves?" The angle is
// good: if their own marketing is slipping, what else is getting pushed aside.
//
// It is also the single easiest line in the whole script to be wrong about, and being wrong is
// expensive. Telling a marketing agency owner they have stopped marketing themselves, when they
// posted yesterday on an account we did not find, ends the call and earns the hang-up.
//
// So this branch is OFF by default and turns on only against positive evidence. Every one of these
// must be true or the caller gets the ordinary discovery question instead:
//
//   * They are a marketing agency. Not a real estate media studio, not "probably marketing".
//   * We hold the RIGHT profile, confirmed against the business, and the record says how.
//   * We saw the actual latest dated post, having looked at BOTH the grid and reels, with pinned
//     posts excluded. A pinned post from 2023 at the top of a grid is the classic way to conclude
//     somebody is dormant when they posted on Tuesday.
//   * That post is at least 10 days old.
//   * The check itself is recent. Evidence from six weeks ago cannot support "your last post was".
//
// ABSENCE IS NEVER EVIDENCE. A private profile, a login wall, a failed fetch, a search snippet
// with no date, no profile found, or not being able to see stories all mean UNKNOWN, and unknown
// omits the branch. We never reason from what we could not see.
//
// And the claim stays narrow: their Instagram posting specifically, never "you are not marketing
// anywhere". A deliberate choice to be off Instagram is a perfectly good answer, so the caller is
// given a way to take the correction and move on.

const DAY = 86400000;

/** A post must be at least this old before the question is fair. */
export const MIN_POST_AGE_DAYS = 10;
/** And our look must be at least this fresh to be worth quoting. */
export const MAX_CHECK_AGE_DAYS = 14;

/**
 * Is this evidence good enough to say the sentence out loud?
 * @returns {{ok:boolean, reason:string, postAgeDays?:number}}
 */
export function evidenceVerdict(ev, now = Date.now()) {
    if (!ev || typeof ev !== 'object') return { ok: false, reason: 'No Instagram evidence on file.' };

    // The profile has to be theirs, and the record has to say how we know.
    if (!ev.profileUrl) return { ok: false, reason: 'No profile URL recorded.' };
    if (ev.profileConfirmed !== true || !ev.profileConfirmedBy) {
        return { ok: false, reason: 'The profile was never confirmed as this business, so it may be somebody else.' };
    }

    // We must have looked everywhere a newer post could hide.
    const scan = ev.scanned || {};
    if (scan.feed !== true || scan.reels !== true) {
        return { ok: false, reason: 'Reels or the grid were not both checked, so a newer post could have been missed.' };
    }
    if (ev.pinnedExcluded !== true) {
        return { ok: false, reason: 'Pinned posts were not excluded, so the top of the grid may not be the latest post.' };
    }
    if (ev.private === true || ev.loginBlocked === true || ev.fetchFailed === true) {
        return { ok: false, reason: 'We could not actually see the account. Not seeing posts is not the same as there being none.' };
    }

    // A date we actually read, not one we inferred.
    const posted = Date.parse(ev.latestPostAt);
    if (!ev.latestPostAt || Number.isNaN(posted)) {
        return { ok: false, reason: 'No dated latest post, so there is nothing to quote.' };
    }
    const checked = Date.parse(ev.checkedAt);
    if (!ev.checkedAt || Number.isNaN(checked)) return { ok: false, reason: 'No check time recorded.' };
    if (now - checked > MAX_CHECK_AGE_DAYS * DAY) {
        return { ok: false, reason: `Last checked ${Math.round((now - checked) / DAY)} days ago, too stale to quote.` };
    }
    if (posted > now) return { ok: false, reason: 'The recorded post date is in the future, which means the record is wrong.' };

    const age = Math.floor((now - posted) / DAY);
    if (age < MIN_POST_AGE_DAYS) {
        return { ok: false, reason: `They posted ${age} day${age === 1 ? '' : 's'} ago. Nothing to raise.`, postAgeDays: age };
    }
    return { ok: true, reason: `Last post ${age} days ago, verified.`, postAgeDays: age };
}

const dateLabel = iso => {
    const d = new Date(iso);
    if (Number.isNaN(+d)) return null;
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' }).format(d);
};

/**
 * The branch, or null. Null means the caller asks the ordinary discovery question.
 * @param {{sector?:string, company?:string, evidence?:object, now?:number}} input
 */
export function instagramBranch({ sector, company, evidence, now = Date.now() } = {}) {
    // Marketing agencies only. A real estate media studio is not a marketing agency, and this
    // question does not land on one.
    if (sector !== 'marketing') return null;

    const verdict = evidenceVerdict(evidence, now);
    if (!verdict.ok) return null;

    const when = dateLabel(evidence.latestPostAt);
    const who = company || 'your agency';

    return {
        key: 'instagram',
        // The reviewed rendition. It states the observation, then asks a question about THEIR
        // priorities rather than announcing a conclusion about their business.
        say: `I noticed your last Instagram post was ${when}. Are you keeping everyone else's marketing moving and yours keeps getting pushed to the bottom? `
            + `What else gets pushed back when client work gets busy?`,
        // Paul's own line, kept as written, with the delivery note that makes it land as a joke
        // between two people who do this for a living rather than an accusation.
        variant: {
            label: "Paul's punchier version",
            say: `When's the last time you posted on Instagram? ... Aren't you guys a marketing agency and you're not even marketing yourselves?`,
            delivery: 'Say it smiling, like you are teasing a friend, and leave the pause. It only works warm. If it lands flat, go straight to the question about what else gets pushed back.',
        },
        // The claim, written down, so nobody stretches it on the phone.
        claim: `Their Instagram specifically has not been posted to since ${when}. That is all this evidence supports. It does NOT say they have stopped marketing, that the business is struggling, or that other channels are quiet.`,
        // What to do when they push back, which is a real and reasonable answer.
        ifCorrected: {
            label: 'They say it is deliberate',
            say: `That is fair, plenty of agencies have decided Instagram is not where their clients are. Where are you putting that effort instead?`,
            note: 'Take the correction, drop the line, and move on. Do not argue with somebody about their own channel strategy.',
        },
        evidence: {
            profileUrl: evidence.profileUrl,
            postUrl: evidence.latestPostUrl || null,
            postedAt: evidence.latestPostAt,
            postedLabel: when,
            ageDays: verdict.postAgeDays,
            checkedAt: evidence.checkedAt,
            confirmedBy: evidence.profileConfirmedBy,
            scanned: 'grid and reels, pinned posts excluded',
        },
        business: who,
    };
}
