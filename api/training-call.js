// A recorded sales call for the training library (training/sales/calls/), played only to people signed in to the Hub:
// a prospect's voice and details are not put on the public site. Supports byte ranges, so the player can seek.
//   GET /api/training-call/?id=<call>
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireAccess } from './_auth.js';

// Paul, 2026-10-30: "put this sales call in our training so other people can come and listen to it".
export const CALLS = Object.freeze({ 'milton-books-the-meeting': 'milton-books-the-meeting.mp3' });

/** The byte range a player asked for, or null for the whole file. Throws on a range outside the file. */
export function byteRange(header, size) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
    if (!m || (m[1] === '' && m[2] === '')) return null;
    const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
    const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (!(start <= end) || start >= size) throw Error('range');
    return { start, end };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (!await requireAccess(req)) return res.status(401).json({ error: 'Sign in to the Hub to listen' });
    const file = CALLS[String(req.query && req.query.id || '')];
    if (!file) return res.status(404).json({ error: 'No such call' });
    const buf = await readFile(path.join(process.cwd(), 'api', '_training', file));
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    let r;
    try { r = byteRange(req.headers && req.headers.range, buf.length); }
    catch { res.setHeader('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
    if (!r) { res.setHeader('Content-Length', buf.length); return res.status(200).end(buf); }
    res.setHeader('Content-Range', `bytes ${r.start}-${r.end}/${buf.length}`);
    res.setHeader('Content-Length', r.end - r.start + 1);
    return res.status(206).end(buf.subarray(r.start, r.end + 1));
}
