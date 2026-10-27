// A caller's week for the Caller review tests, shaped like gatherRange's result.
// The notes are the kinds Milton actually wrote (Oct 21-26, 2026), on invented companies and numbers.
import { daysBetween } from '../../api/_daily-report.js';

export const USER = { email: 'miltion@trystaffify.com', name: 'Milton Hodgson' };
const et = (day, hm) => new Date(`${day}T${hm}:00-04:00`).toISOString();
const AG = 'staffify-agency-outreach', CEO = 'staffify-tobit-outreach';

// [id, company, campaign, number, day, ET time, outcome, note, next call (hours later, or null)]
const LOG = [
    ['r1', 'Harbor Light Media', AG, '2125550101', '2026-10-21', '19:01', 'no_answer', 'His VM is " Hello this is Dakoda, can you hear me?', 20],
    ['r2', 'Lakeshore Photo', AG, '3125550102', '2026-10-21', '19:06', 'voicemail', 'Too late to call', 20],
    ['r3', 'Pine Ridge Media', AG, '4155550103', '2026-10-21', '19:20', 'no_answer', 'No number to call', 20],
    ['r4', 'Kerr Realty Group', CEO, '7705550104', '2026-10-22', '19:09', 'callback', 'She stated that she was busy with her family and that I can call back tomorrow.', 20],
    ['r1', 'Harbor Light Media', AG, '2125550101', '2026-10-22', '20:45', 'timing', 'He hang up when I told him the intro', 2160],
    ['r5', 'Bigco Software', CEO, '6505550105', '2026-10-22', '17:30', 'wrong_number', '', null],
    ['r6', 'Lilac Studio', AG, '6125550106', '2026-10-23', '17:46', 'no_answer', 'She hung up', 20],
    ['r7', 'Spacecraft Photo', AG, '6125550107', '2026-10-23', '17:49', 'no_answer', 'This is a  business number.', 20],
    ['r8', 'Visual Estate Co', AG, '2145550108', '2026-10-26', '15:58', 'voicemail', "Kaya, Nima's assistant, stated that she's not in,", 20],
    ['r9', 'Helio Homes', AG, '3035550109', '2026-10-26', '16:00', 'connected', 'Left a message with the assistant', null],
    ['r10', 'Cine Media', AG, '6125550110', '2026-10-26', '16:06', 'callback', "Carla  stated that he's in Asia. Call him on 612-555-0199. Need to FU", 48],
    ['r11', 'Elevate Travel', AG, '9545550111', '2026-10-26', '17:21', 'connected', 'He hang up', null],
    ['r2', 'Lakeshore Photo', AG, '3125550102', '2026-10-26', '17:31', 'no_answer', 'Hang up', 20],
    ['r7', 'Spacecraft Photo', AG, '6125550107', '2026-10-26', '17:45', 'no_answer', 'Leave message with GK', 20],
    ['r12', 'Grain Photography', AG, '5415550112', '2026-10-26', '17:03', 'no_answer', 'Wont dial out', 20],
    ['r2', 'Lakeshore Photo', AG, '3125550102', '2026-10-27', '10:15', 'voicemail', 'LVM', 20],
    ['r13', 'Riverbend Media', AG, '6055550113', '2026-10-26', '18:40', 'voicemail', 'They never answer', 48],
];

export function source({ quoOk = true, calendlyOk = true, hubOk = true } = {}) {
    const records = new Map();
    for (const [id, company, campaignId, phone, day, hm, outcome, notes, next] of LOG) {
        const r = records.get(id) || { id, company, campaignId, recipient: id + '@example.com', phone, status: 'sent', callHistory: [] };
        const at = et(day, hm);
        r.callHistory.push({ at, outcome, notes, caller: USER.email, nextCallAt: next ? new Date(Date.parse(at) + next * 3600000).toISOString() : null });
        records.set(id, r);
    }
    const entries = [], cards = {};
    for (const r of records.values()) {
        r.callHistory.forEach((c, i) => entries.push({ id: r.id + '#' + i, recordId: r.id, company: r.company, recipient: r.recipient, campaignId: r.campaignId, at: c.at, outcome: c.outcome, tag: null, notes: c.notes, nextCallAt: c.nextCallAt, numbers: [r.phone], dialledRecorded: false }));
        cards[r.id] = { status: r.status, history: r.callHistory.map(c => ({ at: c.at, outcome: c.outcome, caller: USER.email })) };
    }
    // One Quo dial a minute before each logged outcome, two dials with nothing logged, one on another day.
    const calls = LOG.map((l, i) => ({ id: 'q' + i, at: new Date(Date.parse(et(l[4], l[5])) - 60000).toISOString(), number: l[3], answered: true, seconds: 40 }));
    calls.push({ id: 'qx1', at: et('2026-10-26', '18:55'), number: '7185550199', answered: true, seconds: 70 }, { id: 'qx2', at: et('2026-10-26', '19:10'), number: '7185550198', answered: false, seconds: 0 });
    const from = '2026-10-20', to = '2026-10-27';
    const days = daysBetween(from, to);
    const activityByDay = {}, shiftByDay = {};
    for (const d of days) {
        activityByDay[d] = d < '2026-10-23' ? { notMeasured: true, reason: 'Hub activity was not measured before Oct 23, 2026.' } : { measured: d === '2026-10-23' || d === '2026-10-26', activeMinutes: d === '2026-10-26' ? 81 : d === '2026-10-23' ? 42 : 0, idleMinutes: 0, elapsedMinutes: 0, sessions: 0, events: [] };
        shiftByDay[d] = d < '2026-10-24' ? { notMeasured: true, reason: 'Shifts were not declared in the Hub before Oct 24, 2026.' } : d === '2026-10-26' ? { shifts: 1, clockedMinutes: 240, breakMinutes: 0, needsReview: 0, open: 0, list: [] } : { shifts: 0, clockedMinutes: 0, breakMinutes: 0, needsReview: 0, open: 0, list: [] };
    }
    return {
        user: USER, from, to, days,
        hub: hubOk ? { ok: true, entries, cards, readAt: et('2026-10-27', '10:30'), records: [...records.values()] } : { ok: false, error: 'the queue store answered with nothing' },
        quo: quoOk ? { configured: true, ok: true, seat: { email: 'milton@trystaffify.com', actorId: 'US1' }, complete: true, readAt: et('2026-10-27', '10:30'), calls } : { configured: true, ok: false, seat: null, error: 'Quo 503: down' },
        calendly: calendlyOk ? { configured: true, ok: true, bookings: [], readAt: et('2026-10-27', '10:30') } : { configured: true, ok: false, error: 'Calendly 500' },
        activityByDay, shiftByDay, now: Date.parse(et('2026-10-27', '10:31')),
    };
}
export const GENERATED = new Date('2026-10-27T14:31:00Z').toISOString();
