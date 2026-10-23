// Who runs a company, from RocketReach's search, without naming the wrong company's people.
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROCKETREACH_KEY = 'test-key';
const { searchPeople } = await import('../api/_rocketreach.js');

function stub(status, body, seen = []) {
    globalThis.fetch = async (url, opts) => { seen.push({ url: String(url), opts }); return { ok: status < 400, status, text: async () => JSON.stringify(body) }; };
    return seen;
}

test('it posts the documented query and keeps only people at that company', async () => {
    const seen = stub(201, [
        { id: 1, name: 'Dean Allen', current_title: 'Chief Executive Officer', current_employer: 'McKinstry Co.', linkedin_url: 'https://linkedin.com/in/dean' },
        { id: 2, name: 'Other Person', current_title: 'CEO', current_employer: 'McKinsey & Company' },
        { id: 3, name: 'No Employer', current_title: 'Owner' },
    ]);
    const r = await searchPeople({ company: 'McKinstry' });
    assert.equal(seen[0].url, 'https://api.rocketreach.co/api/v2/person/search');
    assert.equal(seen[0].opts.method, 'POST'); assert.equal(seen[0].opts.headers['Api-Key'], 'test-key');
    const body = JSON.parse(seen[0].opts.body);
    assert.deepEqual(body.query.company_name, ['McKinstry']); assert.ok(body.query.current_title.includes('CEO')); assert.equal(body.page_size, 10);
    assert.deepEqual(r.profiles.map(p => p.name), ['Dean Allen', 'No Employer'], 'McKinsey is not McKinstry');
    assert.equal(r.profiles[0].linkedin_url, 'https://linkedin.com/in/dean');
});

test('a wrapped response is read too, and failures are typed', async () => {
    stub(200, { profiles: [{ id: 9, name: 'Ana Ruiz', current_title: 'Founder', current_employer: 'Zenoti' }] });
    assert.equal((await searchPeople({ company: 'Zenoti' })).profiles[0].name, 'Ana Ruiz');
    stub(429, {}); const rl = await searchPeople({ company: 'Zenoti' }); assert.equal(rl.retryable, true); assert.deepEqual(rl.profiles, []);
    stub(403, {}); assert.equal((await searchPeople({ company: 'Zenoti' })).fatal, true);
    stub(503, {}); assert.equal((await searchPeople({ company: 'Zenoti' })).retryable, true);
    stub(400, { detail: 'bad' }); const bad = await searchPeople({ company: 'Zenoti' }); assert.equal(bad.retryable, undefined); assert.deepEqual(bad.profiles, []);
    assert.deepEqual((await searchPeople({ company: '' })).profiles, []);
});
