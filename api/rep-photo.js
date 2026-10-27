// GET /api/rep-photo/?m=<mailbox>  ->  the rep's signature headshot, as an image.
// ------------------------------------------------------------------
// Public on purpose: it is loaded by the prospect's mail client from the signature, like the logo and
// banner in /assets/email/. Only a mailbox in REP_MAILBOXES with an uploaded photo answers; anything
// else is a 404. Uploaded in the composer (POST /api/rep-email/ {action:'photo'}).
import { redis } from './_auth.js';
import { profileFor } from './_rep-email.js';
import { K } from './rep-email.js';

export default async function handler(req, res) {
    const box = String((req.query && req.query.m) || '').trim().toLowerCase();
    const notFound = () => { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain'); res.end('Not found'); };
    if (!profileFor(box)) return notFound();
    let p = await redis.get(K.photo(box)).catch(() => null);
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch { p = null; } }
    if (!p || !p.data || !/^image\/(jpeg|png)$/.test(p.type || '')) return notFound();
    res.statusCode = 200;
    res.setHeader('Content-Type', p.type);
    // Versioned by ?v= in the signature, so a long cache never shows an old face.
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(Buffer.from(p.data, 'base64'));
}
