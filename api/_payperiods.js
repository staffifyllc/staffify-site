// Bi-weekly residual pay periods.
//
// Paul, 2026-09-04: residuals pay out bi-weekly, first payout 11 September 2026, every fortnight
// after that.
//
// WHAT A PAYOUT COVERS. The run on 11 September pays the fourteen days ENDING 10 September, so
// 28 August through 10 September inclusive. You cannot pay for the day you pay on: those hours are
// not tracked or reconciled yet. Every later period is the same shape, shifted fourteen days.
//
// All dates are handled as UTC calendar days. Local-time arithmetic across a DST boundary silently
// shifts a period by an hour, which moves a day's work into the wrong fortnight and pays the wrong
// amount. Hubstaff returns plain YYYY-MM-DD strings, so they are compared as strings, never as
// local Date objects.

export const PAY_ANCHOR = process.env.RESIDUAL_PAY_ANCHOR || '2026-09-11';
export const PERIOD_DAYS = Number(process.env.RESIDUAL_PERIOD_DAYS || 14);

const DAY = 864e5;
const utc = (iso) => Date.parse(iso + 'T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The period whose payout date is on or after `onOrAfter`, counting from the anchor in both
// directions so periods before the anchor are still well-defined rather than negative nonsense.
export function periodIndexFor(dateIso) {
    const diff = utc(dateIso) - utc(PAY_ANCHOR);
    return Math.floor(diff / (PERIOD_DAYS * DAY));
}

export function periodByIndex(i) {
    const payMs = utc(PAY_ANCHOR) + i * PERIOD_DAYS * DAY;
    return {
        index: i,
        payDate: iso(payMs),
        start: iso(payMs - PERIOD_DAYS * DAY),   // inclusive
        end: iso(payMs - DAY),                   // inclusive, the day before payday
    };
}

// The period that a given work date falls INTO, i.e. the one that will pay for it.
export function periodForWorkDate(dateIso) {
    // Period i covers [anchor + 14(i-1), anchor + 14i - 1], so the index for a work date is
    //   floor((date - anchor) / 14) + 1
    // Work on 10 Sep gives floor(-1/14) + 1 = 0, paid on the 11th. Work on 11 Sep gives
    // floor(0/14) + 1 = 1, which waits for the 25th. An earlier version added a day before
    // dividing and pushed every date a full fortnight late, i.e. it would have paid everyone one
    // period behind, forever. The assertions in the test file exist because of that.
    const i = Math.floor((utc(dateIso) - utc(PAY_ANCHOR)) / (PERIOD_DAYS * DAY)) + 1;
    return periodByIndex(i);
}

// Every period covering a span, oldest first. Used to lay out the dashboard columns.
export function periodsBetween(startIso, endIso) {
    const first = periodForWorkDate(startIso).index;
    const last = periodForWorkDate(endIso).index;
    const out = [];
    for (let i = first; i <= last; i++) out.push(periodByIndex(i));
    return out;
}

// ISO week key (Monday-based) for the weekly breakdown Paul asked for.
export function weekKey(dateIso) {
    const d = new Date(utc(dateIso));
    const day = (d.getUTCDay() + 6) % 7;              // Monday = 0
    const monday = new Date(d.getTime() - day * DAY);
    return iso(monday.getTime());
}

export function nextPayDate(todayIso) {
    let i = periodIndexFor(todayIso);
    while (periodByIndex(i).payDate < todayIso) i++;
    return periodByIndex(i);
}
