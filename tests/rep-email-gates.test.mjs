// Who may not be emailed from the Hub. The 2026-10-27 review proved these gaps with fakes; each is
// pinned here: the dialer's own exclusion, a STOP from a number on file, and HubSpot's stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rowStop, crmStop, knownNumbers, stopsFor } from '../api/_rep-email-gates.js';

const kv = (data = {}, fail = false) => ({ async get(k) { if (fail) throw Error('down'); return data[k] ?? null; } });
const ROW = { recipient: 'Nick@Realkit.com', phone: '+14043135871', status: 'sent' };

test('the dialer\'s Not interested / stop, and a bounce, stop an email', () => {
    assert.match(rowStop({ status: 'suppressed' }), /excluded from all outreach/);
    assert.match(rowStop({ status: 'bounce_hold' }), /bounced/);
    assert.equal(rowStop(ROW), null);
});

test('every number on file is checked, from the card and the dialer\'s stores', async () => {
    const nums = await knownNumbers(ROW, kv({ 'staffify:call-phone-vendor:nick@realkit.com': { phone: '+14045505181', alternates: ['(404) 555-0100'] }, 'staffify:call-site-phone:nick@realkit.com': { phone: '404-313-5871' } }));
    assert.deepEqual(nums.sort(), ['4043135871', '4045505181', '4045550100']);
    await assert.rejects(knownNumbers(ROW, kv({}, true)), 'a store that cannot be read throws, so the send fails closed');
});

test('HubSpot stops: opt-out, DNC, a client, an open deal, a conversation someone else owns', () => {
    assert.match(crmStop({ hs_email_optout: 'true' }), /do not contact/);
    assert.match(crmStop({ rep_lifecycle_state: 'NOT_INTERESTED' }), /asked not to be contacted/);
    assert.match(crmStop({ rep_terminal_state: 'DNC_TEXT_STOP' }), /asked not to be contacted/);
    assert.match(crmStop({ lifecyclestage: 'customer' }), /client/);
    assert.match(crmStop({ lifecyclestage: 'opportunity' }), /open deal/);
    assert.match(crmStop({ rep_lifecycle_state: 'HUMAN_OWNED' }), /owns this conversation/);
    assert.match(crmStop({ firstname: 'Mike', lastname: 'Haymes' }), /do-not-contact/);
    assert.equal(crmStop({ lifecyclestage: 'lead' }), null);
    assert.equal(crmStop({ lifecyclestage: 'customer' }, { reply: true }), null, 'a client who wrote in can be answered');
    assert.match(crmStop({ do_not_contact: 'true' }, { reply: true }), /do not contact/, 'but never someone who opted out');
});

test('stopsFor: a STOP from any number, a CRM that cannot answer, and a contact the CRM does not have', async () => {
    const optedNumber = async ({ phone }) => phone === '4045505181';
    const store = kv({ 'staffify:call-phone:nick@realkit.com': { phone: '+1 404 550 5181' } });
    assert.match(await stopsFor(ROW, 'nick@realkit.com', { kv: store, isOptedOut: optedNumber, contact: async () => ({ properties: {} }) }), /replied STOP/);
    assert.match(await stopsFor(ROW, 'nick@realkit.com', { kv: kv(), isOptedOut: async () => false, contact: async () => { throw Error('CRM unavailable: request queue busy'); } }), /CRM could not be checked/);
    assert.equal(await stopsFor(ROW, 'nick@realkit.com', { kv: kv(), isOptedOut: async () => false, contact: async () => { throw Error('CRM contact missing'); } }), null, 'no CRM contact is not a stop; the client guard still runs');
    assert.match(await stopsFor({ ...ROW, status: 'suppressed' }, 'nick@realkit.com', { kv: kv(), isOptedOut: async () => false, contact: async () => ({ properties: {} }) }), /excluded/);
    assert.match(await stopsFor(ROW, 'nick@realkit.com', { kv: kv({}, true), isOptedOut: async () => false, contact: async () => ({ properties: {} }) }), /could not be checked/, 'fails closed');
});
