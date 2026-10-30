// Paul, 2026-10-30: "we need a really nice way for folks to unsubscribe, maybe not a button but have them tell me to kick
// rocks, and make each different for the sequence". And whoever takes the offer, or asks plainly, is let go everywhere.
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x'; process.env.CRON_SECRET ||= 'test-secret';
import test from 'node:test';
import assert from 'node:assert/strict';
import { KICK_LINES, SEQUENCE_LINES, REP_LINES, kickLine, kickStart, kicksRocks, asksToStop, withoutOurLines } from '../api/_kick-rocks.js';
import { classify, replyText } from '../api/_outreach-policy.js';
import { hiringDripCopy, refreshDripCopy, COPY_VERSION, HIRING_DRIP_ID } from '../api/_hiring-drip-copy.js';
import { sweepRepInboxes, LOG } from '../api/_rep-optout-sweep.js';
import { sign, kickLink } from '../lib/unsubscribe-token.js';
import { unsubscribe } from '../api/unsubscribe.js';
import { mime } from '../api/_outreach-gmail.js';

test('the lines: a pool of six, all different, no link, in Paul\'s rules; each person moves one on per email', () => {
    // Paul, 2026-10-30: "do no link, but just tell them to respond with like the kick rocks ... like 5 different versions".
    assert.ok(KICK_LINES.length >= 5);
    assert.equal(new Set(KICK_LINES).size, KICK_LINES.length);
    for (const l of [...KICK_LINES, ...SEQUENCE_LINES, ...REP_LINES]) { assert.match(l, /kick rocks/); assert.doesNotMatch(l, /—|–|[“”’]|\bi\b|https?:/); }
    for (const l of KICK_LINES) assert.doesNotMatch(l, /not interested|\bstop\b|\bremove\b|unsubscribe|leave (me|us) alone|no more/i, 'a quoted copy of ours never reads as a stop to the worker');
    for (const who of ['dana@acme.com', 'nate@korrect.com', 'x@y.co']) {
        const seq = [0, 1, 2, 3, 4, 5].map(n => kickLine(who, n));
        assert.equal(new Set(seq).size, 6, 'six emails to one person, six different lines');
        assert.equal(kickLine(who.toUpperCase(), 2), seq[2], 'the same person however the address is typed');
    }
    assert.ok(new Set(['a@a.com', 'b@b.com', 'c@c.com', 'd@d.com', 'e@e.com', 'f@f.com', 'g@g.com'].map(e => kickLine(e, 0))).size >= 3, 'owners on the same day see different first lines');
    assert.equal(kickLine('a@a.com', -3), kickLine('a@a.com', 0));
});

test('a plain ask to be left alone is heard; a friendly "stop by" and our own quoted line are not', () => {
    for (const yes of ['Your email is missing an unsubscribe option. Please remove me from your mailing and texting list.', 'kick rocks', 'Kick rocks lol', 'KICK ROCKS!!', 'Please unsubscribe me', 'Unsubscribe', 'take me off your list', 'take us off your mailing list', 'Not interested, thanks', 'Not interested at this time.', 'stop emailing me', 'quit calling me', 'Remove us please', 'Please remove me.', 'remove me', 'Stop', 'Do not contact me again', "Please don't call me", 'never email me', 'No more emails please', 'opt me out', 'opt-out', 'delete my info', 'remove my email', 'remove me from your database',
        'STOP\n\nSent from my iPhone', 'Please stop.\n\nSent from my iPhone', 'stop\n\nGet Outlook for iOS', 'Remove\n\nJohn Smith\nCEO, Acme', 'Stop please'])
        assert.equal(asksToStop(yes), true, yes);
    for (const no of ['Can you stop by the office Tuesday?', "Thanks, let's talk Tuesday at 2", 'Sounds good.\n' + REP_LINES[0], 'Great!\n\n' + SEQUENCE_LINES[2], 'We are interested, call me', 'Sure.\n\nIf you’d prefer no more emails, just let me know.',
        "Don't call me before 2, I'm in court", 'take me off the cc please', 'leave me alone till Monday lol', 'no need to kick rocks, call me', 'Not interested in a VA but we need a scheduler', 'I would say no\nThanks, Bob', 'Please remove me from the thread and add Jane', 'Ok.\n“Not a fit? Just tell me to kick rocks and I’ll take you off my list.”',
        // Round two of the review: warm replies the first matcher read as a stop.
        'Did you lose my number? Call me tomorrow, I am interested.', 'Sounds interesting. Can we opt out anytime if it is not working out?', 'Is there an opt-out clause in the contract?', "Please don't call me, I prefer email. Send pricing.", 'You never call me back! Still want to talk.', "We're not interested right now, but feel free to check back in the spring.",
        'Ha, love the kick rocks line. Yes it is still open, call me Tuesday.', "You don't have to kick rocks! Send me pricing.", "I'm not telling you to kick rocks, the role is open.", "Before you kick rocks, what's the rate?", 'No kicking rocks needed, call me',
        'Thanks.\n' + SEQUENCE_LINES[0] + '\nOne click works too: https://www.gostaffify.com/kick-rocks/?e=stop.now%40acme.com&t=abc',
        ...KICK_LINES.map(l => 'Sounds good, call me.\n\n' + l), ...KICK_LINES])
        assert.equal(asksToStop(no), false, no);
    assert.doesNotMatch(withoutOurLines('ok ' + SEQUENCE_LINES[1]), /kick rocks/);
    for (const l of KICK_LINES) assert.doesNotMatch(withoutOurLines('ok\n' + l.replace(/"/g, '“').replace(/'/g, '’').replace(/ /g, '\n')), /kick/i, 'rewrapped, curly-quoted copies of ours are ours');
    assert.equal(withoutOurLines('line one\nline two'), 'line one\nline two', 'their line breaks are kept');
    for (const l of REP_LINES) assert.doesNotMatch(l, /not interested|\bstop\b/i, 'a quoted copy of ours never reads as a stop to the worker');
});

test('"kick rocks" as their answer: under a long signature, after a greeting, or after the "yes" our line invites', () => {
    // Review, 2026-10-30: the reply is now the only way out shown, so the one phrase we ask for must always stop.
    const sig = '\n\nJane Doe\nOwner | Acme Insurance Agency\n123 Main St, Austin, TX 78701\nCall or text (512) 555-1234';
    for (const yes of ['Kick rocks.' + sig, 'kick rocks' + sig, 'Kick rocks please' + sig, 'Hi Paul,\nKick rocks.' + sig, 'Yes, kick rocks', 'Yep. Kick rocks', 'Rather not. Kick rocks.', 'No, kick rocks', 'Hi Paul, kick rocks']) {
        assert.equal(kicksRocks(yes), true, yes); assert.equal(asksToStop(yes), true, yes);
    }
    for (const warm of ['Kick rocks!! Just kidding, call me Tuesday', 'Hi Paul,\nYes, still open. Send the profiles.' + sig, 'Sure, send them', 'Open', 'Filled', 'Yes it is open. Love the kick rocks line'])
        assert.equal(kicksRocks(warm), false, warm);
    for (const line of KICK_LINES) assert.doesNotMatch(line, /had enough/i, 'every line reads right on a first, cold email');
    assert.ok(KICK_LINES.every((_, i) => kickLine('x' + i + '@a.com', 0) === KICK_LINES[kickStart('x' + i + '@a.com')]));
});

test('the email worker lets go of anyone who answers "kick rocks", and not of someone whose reply only quotes our line', () => {
    const me = 'paul@staffifyhq.com', them = 'jjohnson10@farmersagent.com';
    const reply = text => [{ id: 'r', from: them, to: [me], text, sent: false }];
    assert.equal(classify(reply('Kick rocks.'), them, [me]).status, 'suppressed');
    assert.equal(classify(reply('Thanks, interested!\n\n' + SEQUENCE_LINES[0]), them, [me]).status, 'human_reply_hold', 'a quoted copy of our line in a format we do not strip');
    assert.equal(classify(reply('Interested, call me.\n-------- Original message --------\nP.S. tell me to kick rocks'), them, [me]).status, 'human_reply_hold');
    // Only "kick rocks" is new to the worker: it re-reads stored threads, so a warm reply must never become a stop.
    for (const warm of ["Don't call me before 2, I'm in court", 'no need to kick rocks, call me', 'Leave me alone till Monday', 'I would say no\nThanks, Bob', "You don't have to kick rocks, send me pricing", "You don't need to kick rocks, I'm interested", "I don't want you to kick rocks, let's talk Tuesday", 'No kicking rocks needed, call me', 'Haha no need for you to kick rocks. When can we talk?', 'Ha, love the kick rocks line. Yes it is still open, call me Tuesday.',
        'Thanks.\n' + SEQUENCE_LINES[0] + '\nOne click works too: https://www.gostaffify.com/kick-rocks/?e=stop.now%40acme.com&t=abc', ...KICK_LINES.map(l => 'Yes, send the profiles.\n\n' + l)])
        assert.equal(classify(reply(warm), them, [me]).status, 'human_reply_hold', warm);
    assert.equal(classify(reply('Kick rocks.\n\nJane Doe\nOwner | Acme Insurance Agency\n123 Main St, Austin, TX 78701\nCall or text (512) 555-1234'), them, [me]).status, 'suppressed', 'a signature never hides the answer');
    assert.equal(classify(reply('Yes, kick rocks'), them, [me]).status, 'suppressed');
    assert.equal(replyText('Hi\n________________________________\nFrom: Paul'), 'Hi');
});

test('each email of the Hiring now sequence ends with its own way out: a reply, never a link', () => {
    const card = { id: 'hire:aaaaaaaaaaaaaaaa', company: { name: 'Acme', domain: 'acme.com' }, job: { title: 'Scheduler - $23/hr' }, contact: { firstName: 'Dana', email: 'dana@acme.com', status: 'verified' } };
    const c = hiringDripCopy(card);
    const bodies = [c.bodyText, c.followupBodies[2], c.followupBodies[3], c.followupBodies[4]];
    bodies.forEach((b, i) => assert.ok(b.endsWith('Paul\nStaffify\n\n' + kickLine('dana@acme.com', i)), 'touch ' + (i + 1)));
    assert.equal(new Set(bodies.map(b => b.split('\n\n').at(-1))).size, 4);
    for (const b of bodies) { assert.doesNotMatch(b, /kick-rocks\/|One click|unsubscribe/i); assert.equal(asksToStop(b.split('\n\n').at(-1)), false, 'our own line, quoted back, never reads as a stop'); }
});

test('a row moved from the older lines never hears the line it just got again', () => {
    for (const email of ['pat@b.com', 'dana@acme.com', 'a1@x.com', 'a2@x.com', 'a3@x.com', 'a4@x.com', 'a5@x.com', 'a6@x.com']) {
        const card = { id: 'hire:cccccccccccccccc', company: { name: 'Acme', domain: 'x.com' }, job: { title: 'Scheduler' }, contact: { firstName: 'Pat', email, status: 'verified' } };
        for (const after of [1, 2]) {
            const c = hiringDripCopy(card, { after });
            const lines = [2, 3, 4].filter(n => n > after).map(n => c.followupBodies[n].split('\n\n').at(-1));
            const sent = SEQUENCE_LINES.slice(0, after).map(l => l.slice(0, 12));
            for (const l of lines) assert.ok(!sent.some(x => KICK_LINES.find(k => k === l) && (l.slice(0, 12) === x || (x === 'Still not fo' && l.startsWith('Not for you')))), email + ' after ' + after + ': ' + l);
            assert.equal(new Set(lines).size, lines.length);
        }
    }
});

test('rows written with the older copy take the new lines for every email not yet written', () => {
    const card = { id: 'hire:bbbbbbbbbbbbbbbb', company: { name: 'Acme', domain: 'acme.com' }, job: { title: 'Scheduler' }, contact: { firstName: 'Dana', email: 'dana@acme.com', status: 'verified' } };
    const old = { 2: 'old 2', 3: 'old 3', 4: 'old 4' };
    const row = (over) => ({ campaignId: HIRING_DRIP_ID, hiringId: card.id, owner: 'Madison', copyVersion: 'hiring-now-2026-10-30', subject: 'old', bodyText: 'old 1', followupBodies: { ...old }, ...over });
    const state = { records: [
        row({ id: 'fresh', status: 'prepared', sentTouches: 0 }),
        row({ id: 'sent1', status: 'sent', sentTouches: 1, threadId: 't' }),
        row({ id: 'drafted2', status: 'draft_saved', sentTouches: 1, draftId: 'd', threadId: 't' }),
        row({ id: 'current', status: 'prepared', sentTouches: 0, copyVersion: COPY_VERSION }),
        row({ id: 'nocard', hiringId: 'hire:gone000000000000', status: 'prepared', sentTouches: 0 }),
        { id: 'other', campaignId: 'staffify-talent-network-outreach', bodyText: 'x' },
    ] };
    assert.equal(refreshDripCopy(state, new Map([[card.id, card]])), 3);
    const by = id => state.records.find(r => r.id === id);
    assert.ok(by('fresh').bodyText.endsWith('Madison\nStaffify\n\n' + kickLine('dana@acme.com', 0))); assert.doesNotMatch(by('fresh').bodyText, /One click/);
    assert.equal(by('sent1').bodyText, 'old 1', 'a sent email is history'); assert.ok(by('sent1').followupBodies[2].endsWith(kickLine('dana@acme.com', 1)));
    assert.equal(by('drafted2').followupBodies[2], 'old 2', 'the saved Gmail draft is never rewritten'); assert.ok(by('drafted2').followupBodies[3].endsWith(kickLine('dana@acme.com', 2)));
    assert.equal(by('current').bodyText, 'old 1'); assert.equal(by('nocard').bodyText, 'old 1');
    for (const id of ['fresh', 'sent1', 'drafted2']) assert.equal(by(id).copyVersion, COPY_VERSION);
});

function sweepWorld(messages) {
    const m = new Map(), lists = new Map();
    const kv = { m, lists, async get(k) { return m.has(k) ? m.get(k) : null; }, async set(k, v, o = {}) { if (o.nx && m.has(k)) return null; m.set(k, v); return 'OK'; }, async del(k) { m.delete(k); return 1; },
        async lpush(k, v) { lists.set(k, [v, ...(lists.get(k) || [])]); return 1; }, async ltrim() { return 'OK'; } };
    const queries = [], listFails = { n: 0 };
    const gmail = async (t, path) => {
        if (path.startsWith('messages?')) { if (listFails.n-- > 0) throw Error('Gmail 400 bad page'); queries.push(new URLSearchParams(path.slice('messages?'.length)).get('q')); return { messages: messages.map(x => ({ id: x.id })) }; }
        const x = messages.find(y => path === 'messages/' + y.id + '?format=full');
        if (!x) throw Error('unexpected ' + path);
        if (x.unreadable) throw Error('Gmail 500');
        return x;
    };
    const stopped = [];
    const deps = { kv, boxes: ['milton@trystaffify.com', 'madison@trystaffify.com'], access: async b => 'tok-' + b, gmail, headers: x => ({ from: x.from, subject: x.subject, ...(x.headers || {}) }), messageText: x => x.text, replyText,
        isProspect: async e => e !== 'stranger@x.com', stop: async q => { if (q.email === 'flaky@x.com' && !stopped.includes('retry')) { stopped.push('retry'); throw Error('store down'); } stopped.push(q.email); }, now: Date.parse('2026-10-30T19:00:00Z') };
    return { kv, deps, stopped, queries, listFails };
}

test('a rep inbox: a prospect who asks to be removed is stopped once; friends, strangers and our own mail are left alone', async () => {
    const msgs = [
        { id: 'jj', from: 'Joanna Johnson <jjohnson10@farmersagent.com>', subject: 'Re: Sorry I missed you', text: 'Hello Milton,\nYour email is missing an unsubscribe option. Please remove me from your mailing and texting list.\n\nOn Thu, Milton wrote:\n> Hi Joanna' },
        { id: 'kr', from: 'dana@acme.com', subject: 'Re: Scheduler', text: 'kick rocks' },
        { id: 'warm', from: 'sam@shop.com', subject: 'Re: hi', text: 'Can you stop by Tuesday?\n\n' + REP_LINES[1] },
        { id: 'strange', from: 'stranger@x.com', subject: 'unsubscribe', text: 'remove me' },
        { id: 'ours', from: 'Madison <madison@trystaffify.com>', subject: 'fwd', text: 'not interested' },
        { id: 'bot', from: 'mailer-daemon@googlemail.com', subject: 'Delivery failed', text: 'remove me' },
        { id: 'bad', from: 'x@y.com', unreadable: true },
        { id: 'flaky', from: 'flaky@x.com', subject: 'Re', text: 'Please take me off your list' },
        { id: 'news', from: 'news@shop.com', subject: 'Our October deals', text: 'Click here to unsubscribe', headers: { 'list-unsubscribe': '<https://shop.com/u>' } },
        { id: 'ooo', from: 'pat@co.com', subject: 'Out of office', text: 'I am away. Do not contact me until Monday', headers: { 'auto-submitted': 'auto-replied' } },
        { id: 'subj', from: 'lee@co.com', subject: 'Unsubscribe', text: '' },
        { id: 'resubj', from: 'kim@co.com', subject: 'Re: Not interested anymore, Kim?', text: 'Actually yes, call me Tuesday' },
    ];
    const w = sweepWorld(msgs);
    const r = await sweepRepInboxes(w.deps);
    assert.equal(r.box, 'milton@trystaffify.com');
    assert.deepEqual(w.stopped.filter(x => x !== 'retry'), ['jjohnson10@farmersagent.com', 'dana@acme.com', 'lee@co.com']);
    assert.equal(r.asked, 5, 'Joanna, kick rocks, the stranger, the flaky one, a subject of their own; not a newsletter, an auto-reply or our own subject');
    assert.match(w.queries[0], /^in:anywhere -in:sent -in:drafts -in:chats -in:spam -in:trash -from:me after:\d+ before:\d+$/, 'archived replies count too');
    assert.match(r.error, /store down/);
    assert.equal(r.retrying, 2, 'the unreadable one and the failed one wait on the retry list');
    assert.equal(w.kv.lists.get(LOG).length, 3);
    // The next run reads the next box; the run after comes back to Milton's and acts on what it could not before.
    const r2 = await sweepRepInboxes(w.deps);
    assert.equal(r2.box, 'madison@trystaffify.com');
    const r3 = await sweepRepInboxes(w.deps);
    assert.equal(r3.box, 'milton@trystaffify.com');
    assert.deepEqual(w.stopped.filter(x => x !== 'retry'), ['jjohnson10@farmersagent.com', 'dana@acme.com', 'lee@co.com', 'flaky@x.com'], 'the one that failed is tried again and stopped; everything else only once');
    assert.equal(r3.retrying, 1, 'still unreadable: still waiting');
});

test('a rep inbox that is not connected is skipped, and the turn passes to the next', async () => {
    const w = sweepWorld([]);
    w.deps.access = async b => { if (b === 'milton@trystaffify.com') throw Error('Mailbox authorization missing'); return 't'; };
    const r = await sweepRepInboxes(w.deps);
    assert.match(r.error, /not connected/);
    assert.equal((await sweepRepInboxes(w.deps)).box, 'madison@trystaffify.com');
    assert.deepEqual(await sweepRepInboxes({ ...w.deps, boxes: [] }), { skipped: 'no rep inboxes' });
});

function call(method, url) {
    const res = { code: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
    return { req: { method, url, headers: { host: 'www.gostaffify.com' } }, res };
}

test('the kick-rocks link: opening it only asks, the button stops them everywhere, a bad link changes nothing', async () => {
    const link = kickLink('Dana@Acme.com');
    assert.equal(link, 'https://www.gostaffify.com/kick-rocks/?e=dana%40acme.com&t=' + sign('dana@acme.com'));
    const path = link.replace('https://www.gostaffify.com', '') + '&style=kick';
    const stopped = [];
    const stop = async (e, src) => { stopped.push([e, src]); };
    const open = call('GET', path);
    await unsubscribe(open.req, open.res, { stop });
    assert.equal(open.res.code, 200); assert.match(open.res.body, /Unsubscribe dana@acme\.com from all Staffify emails, texts and calls\?/); assert.match(open.res.body, /<form method="post" action="\/kick-rocks\/\?e=dana%40acme\.com&amp;t=/);
    assert.match(open.res.body, /Yes, kick rocks/); assert.equal(stopped.length, 0, 'a mail scanner that opens the link unsubscribes nobody');
    const press = call('POST', path);
    await unsubscribe(press.req, press.res, { stop });
    assert.match(press.res.body, /Done\. You are unsubscribed\. Rocks: kicked\./); assert.deepEqual(stopped, [['dana@acme.com', 'kick-rocks-link']]);
    const forged = call('POST', '/kick-rocks/?e=boss%40acme.com&t=' + sign('dana@acme.com') + '&style=kick');
    await unsubscribe(forged.req, forged.res, { stop });
    assert.equal(forged.res.code, 400); assert.match(forged.res.body, /That link did not work/); assert.equal(stopped.length, 1);
    const broken = call('POST', path);
    await unsubscribe(broken.req, broken.res, { stop: async () => { throw Error('store down'); } });
    assert.equal(broken.res.code, 500); assert.match(broken.res.body, /Yes, kick rocks/, 'the button stays, so they can press again');
    for (const r of [open, press, forged]) assert.doesNotMatch(r.res.body, /—/);
});

test('a mail client\'s one-click Unsubscribe (List-Unsubscribe-Post) stops them at once; the old drip link still works', async () => {
    const stopped = [];
    const one = call('POST', '/api/unsubscribe/?e=dana%40acme.com&t=' + sign('dana@acme.com'));
    await unsubscribe(one.req, one.res, { stop: async (e, s) => stopped.push([e, s]) });
    assert.equal(one.res.code, 200); assert.deepEqual(stopped, [['dana@acme.com', 'one-click-link']]);
    // The website drips' older link asks first too: a scanner opening it takes nobody off.
    const legacy = call('GET', '/api/unsubscribe/?e=dana%40acme.com&t=' + sign('dana@acme.com'));
    await unsubscribe(legacy.req, legacy.res, { stop: async (e, s) => stopped.push([e, s]) });
    assert.equal(legacy.res.code, 200); assert.equal(stopped.length, 1); assert.match(legacy.res.body, /Yes, kick rocks/);
    assert.doesNotMatch(legacy.res.body, /—/);
    const evil = call('GET', '/api/unsubscribe/?e=%3Csvg%2Fonload%3Dalert(1)%3E%40x.co&t=abc');
    await unsubscribe(evil.req, evil.res, { stop: async () => {} });
    assert.equal(evil.res.code, 400); assert.doesNotMatch(evil.res.body, /<svg/, 'nothing they send is put on the page');
});

test('worker mail carries the mail client\'s Unsubscribe header, to the same address', () => {
    const decode = raw => Buffer.from(raw, 'base64url').toString();
    const link = kickLink('dana@acme.com');
    const head = decode(mime({ sender: 'paul@staffifyhq.com', to: 'dana@acme.com', subject: 'Hi', body: 'x', id: 'a', unsubscribe: link }));
    assert.ok(head.includes('\r\nList-Unsubscribe: <' + link + '>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'));
    assert.doesNotMatch(decode(mime({ sender: 'a@b.com', to: 'c@d.com', subject: 'Hi', body: 'x', id: 'a', unsubscribe: 'javascript:alert(1)' })), /List-Unsubscribe/);
});

test('the retry list survives the window moving on, a broken page restarts the window, and a run out of time keeps its place', async () => {
    const w = sweepWorld([{ id: 'jj', from: 'jjohnson10@farmersagent.com', subject: 'Re: hi', text: 'Please remove me from your mailing and texting list.' }]);
    let fail = true;
    w.deps.isProspect = async () => { if (fail) throw Error('hgetall failed'); return true; };
    w.deps.boxes = ['milton@trystaffify.com'];
    const r1 = await sweepRepInboxes(w.deps);
    assert.equal(r1.retrying, 1); assert.deepEqual(w.stopped, []);
    // The window moved on (the cursor is past this message); the retry list brings it back.
    w.deps.gmail = (orig => async (t, path) => (path.startsWith('messages?') ? { messages: [] } : orig(t, path)))(w.deps.gmail);
    fail = false;
    const r2 = await sweepRepInboxes(w.deps);
    assert.deepEqual(w.stopped, ['jjohnson10@farmersagent.com']); assert.equal(r2.retrying, 0);
    const b = sweepWorld([{ id: 'a', from: 'a@x.com', subject: 'Re', text: 'kick rocks' }]);
    b.kv.m.set('staffify:rep-optout:cursor:milton@trystaffify.com', { after: 1, page: 'stale', until: 2 });
    b.listFails.n = 1;
    const broken = await sweepRepInboxes(b.deps);
    assert.match(broken.error, /list failed/); assert.deepEqual(b.kv.m.get('staffify:rep-optout:cursor:milton@trystaffify.com'), { after: 1 });
    assert.equal((await sweepRepInboxes(b.deps)).box, 'madison@trystaffify.com', 'the turn passes on');
    const c = sweepWorld([{ id: 'late', from: 'z@x.com', subject: 'Re', text: 'kick rocks' }]);
    const cut = await sweepRepInboxes(c.deps, { deadline: Date.now() - 1 });
    assert.equal(cut.cut, true); assert.equal(c.kv.m.get('staffify:rep-optout:cursor:milton@trystaffify.com'), undefined, 'the window is not moved');
});
