// Paul, 2026-10-30: "put this sales call in our training so other people can come and listen to it".
process.env.KV_REST_API_URL ||= 'https://example.invalid'; process.env.KV_REST_API_TOKEN ||= 'x';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { byteRange, CALLS } from '../api/training-call.js';

test('the player can seek: byte ranges in every form a browser sends', () => {
    assert.equal(byteRange(undefined, 1000), null);
    assert.equal(byteRange('bytes=-', 1000), null);
    assert.deepEqual(byteRange('bytes=0-', 1000), { start: 0, end: 999 });
    assert.deepEqual(byteRange('bytes=100-199', 1000), { start: 100, end: 199 });
    assert.deepEqual(byteRange('bytes=900-5000', 1000), { start: 900, end: 999 });
    assert.deepEqual(byteRange('bytes=-100', 1000), { start: 900, end: 999 });
    assert.throws(() => byteRange('bytes=1000-', 1000));
    assert.throws(() => byteRange('bytes=500-100', 1000));
});

test('every call in the library has its recording beside the function, outside the public site', () => {
    for (const file of Object.values(CALLS)) assert.ok(existsSync(new URL('../api/_training/' + file, import.meta.url)), file);
    const cfg = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.equal(cfg.functions['api/training-call.js'].includeFiles, 'api/_training/**');
    const page = readFileSync(new URL('../training/sales/calls/milton-books-the-meeting/index.html', import.meta.url), 'utf8');
    assert.match(page, /src="\/api\/training-call\/\?id=milton-books-the-meeting"/);
    assert.doesNotMatch(page, /—/);
});
