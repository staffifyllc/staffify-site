// The Hiring now drip as the email engine knows it: its id, its card, and where its follow-ups come from. The copy,
// who qualifies and the card's stop rules are in api/_hiring-drip-copy.js; enrolment in api/_hiring-drip.js.
export const HIRING_DRIP_ID = 'staffify-hiring-now-outreach';
export const HIRING_DRIP_CAMPAIGN = { id: HIRING_DRIP_ID, name: 'Hiring now outreach', description: 'Owners of companies hiring a remote seat we fill: four emails, 48 hours apart, while the Hub callers keep calling.', sendWindow: 'Weekdays, 9 AM–9 PM America/New_York', maxEmails: 4, minimumSpacingHours: 48, calling: 'Hub callers (Hiring now)' };
export function hiringDripFollowup(row) {
    const text = row.followupBodies && row.followupBodies[String(row.sentTouches + 1)];
    if (!text) throw Error('Hiring now follow-up missing');
    return text;
}
