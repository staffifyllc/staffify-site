// One-off maintenance: strip invented summaries off hot leads already in the store.
// ------------------------------------------------------------------
// Paul, 2026-08-14: a card claimed the owner "agreed to receive more information" from a call
// where the transcript was one line, our own opener, and the recording was 0:00. The cause is
// fixed in call-intel and in hot-lead, but records written before that still carry the false
// summary. This rewrites them in place. Runs on Vercel, where the KV credentials actually live.
//
//   GET /api/hot-rescrub          report only, changes nothing
//   GET /api/hot-rescrub?apply=1  rewrite them
// Signed-in hub session is enough; no token needs to change hands.
// ------------------------------------------------------------------
import { redis, requireAccess } from './_auth.js';

const NO_CONVO = 'No conversation. The line opened but the other side never spoke, so there is no outcome to report.';
const humanTurns = (t) => (String(t || '').match(/^\s*(user|human|customer|prospect)\s*:/gim) || []).length;

export default async function handler(req, res) {
    // A logged-in rep OR an admin token. Paul is already signed into the hub, so he can just
    // open this in the browser rather than anyone passing a secret around.
    const who = await requireAccess(req);
    if (!who) return res.status(401).json({ error: 'sign in to the hub first, then reload this page' });
    const apply = req.query.apply === '1';

    const ids = (await redis.zrange('hotleads', 0, -1)) || [];
    const out = { stored: ids.length, invented: 0, real: 0, noSummary: 0, rewritten: 0, examples: [] };

    for (const id of ids) {
        const lead = await redis.hgetall(id);
        if (!lead || !lead.summary) { out.noSummary++; continue; }
        if (lead.summary === NO_CONVO) { out.invented++; continue; }   // already scrubbed
        if (humanTurns(lead.transcript) > 0) { out.real++; continue; }

        out.invented++;
        if (out.examples.length < 10) {
            out.examples.push({ company: lead.company || lead.phone, claimed: String(lead.summary).slice(0, 140) });
        }
        if (apply) {
            await redis.hset(id, { summary: NO_CONVO, noConversation: 'true', rescrubbedAt: new Date().toISOString() });
            out.rewritten++;
        }
    }
    // A person opens this, not a script. Raw JSON in a browser is unreadable, so render a page.
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = out.examples.map((e) => `<tr><td>${esc(e.company)}</td><td class="claim">${esc(e.claimed)}</td></tr>`).join('');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Call summaries with no call behind them</title><style>
:root{--bg:#0b0f14;--card:#121821;--line:#1f2937;--ink:#e6edf3;--mut:#8b97a8;--bad:#ff8a7a;--ok:#5fd39a;--acc:#1ABDE1}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;padding:32px 20px 80px}
.w{max-width:900px;margin:0 auto}
h1{font-size:26px;letter-spacing:-.02em;margin-bottom:6px}
.sub{color:var(--mut);margin-bottom:26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.stat b{display:block;font-size:30px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.stat span{color:var(--mut);font-size:12.5px;text-transform:uppercase;letter-spacing:.08em}
.stat.bad b{color:var(--bad)} .stat.ok b{color:var(--ok)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--mut)}
tr:last-child td{border-bottom:none}
.claim{color:var(--bad)}
a.btn{display:inline-block;margin-top:24px;background:var(--acc);color:#04212b;font-weight:800;padding:13px 22px;border-radius:11px;text-decoration:none}
.done{margin-top:24px;background:rgba(45,190,120,.1);border:1px solid rgba(45,190,120,.4);color:var(--ok);border-radius:12px;padding:16px;font-weight:700}
.none{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;text-align:center;color:var(--mut)}
</style></head><body><div class="w">
<h1>Call summaries with no call behind them</h1>
<div class="sub">A summary only means something if the other person actually spoke. These were written from a transcript containing nothing but our own opener.</div>
<div class="grid">
  <div class="stat"><b>${out.stored}</b><span>Hot leads stored</span></div>
  <div class="stat bad"><b>${out.invented}</b><span>Nothing was said</span></div>
  <div class="stat ok"><b>${out.real}</b><span>Real conversation</span></div>
  <div class="stat"><b>${out.noSummary}</b><span>No summary at all</span></div>
</div>
${out.examples.length ? `<table><tr><th>Business</th><th>What the card claimed</th></tr>${rows}</table>` : '<div class="none">Nothing to clean up. Every stored summary has a real conversation behind it.</div>'}
${apply ? `<div class="done">Rewritten ${out.rewritten}. Those cards now say there was no conversation.</div>`
        : (out.invented ? '<a class="btn" href="?apply=1">Rewrite these ' + out.invented + '</a>' : '')}
</div></body></html>`);
}
