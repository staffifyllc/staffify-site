// GET    /api/sales-applicants?token=ADMIN_TOKEN               — HTML dashboard of all sales applicants
// GET    /api/sales-applicants?token=ADMIN_TOKEN&format=json   — raw JSON
// GET    /api/sales-applicants?token=ADMIN_TOKEN&format=csv    — CSV export
// DELETE /api/sales-applicants?token=ADMIN_TOKEN&id=salesapp:...  — prune one
//
// Env vars: ADMIN_TOKEN (or CRON_SECRET), KV_REST_API_URL, KV_REST_API_TOKEN

import { Redis } from '@upstash/redis';

const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
});

function authorized(req) {
    const validSecrets = [process.env.ADMIN_TOKEN, process.env.CRON_SECRET].filter(Boolean);
    if (!validSecrets.length) return false;
    const provided = (req.query.token || '').toString();
    if (provided && validSecrets.includes(provided)) return true;
    const hdr = req.headers['authorization'] || '';
    const m = /^Bearer\s+(.+)$/i.exec(hdr);
    return !!m && validSecrets.includes(m[1]);
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const COLS = ['created_at','name','email','phone','location','linkedin','experience','availability','sold','win','video','ip'];

function toCSV(rows) {
    const header = COLS.join(',');
    const lines = rows.map(r =>
        COLS.map(c => {
            const v = r[c] == null ? '' : String(r[c]);
            return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(',')
    );
    return [header, ...lines].join('\n');
}

export default async function handler(req, res) {
    // open-share: reading applicants needs no login. Pruning (DELETE) stays admin-only.
    if (req.method === 'DELETE') {
        if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
        const id = (req.query.id || '').toString();
        if (!id.startsWith('salesapp:')) return res.status(400).json({ error: 'bad_id' });
        await redis.del(id);
        await redis.zrem('salesapps:by_date', id);
        return res.status(200).json({ ok: true, deleted: id });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // Newest first
    const ids = await redis.zrange('salesapps:by_date', 0, -1, { rev: true });
    const rows = [];
    for (const id of ids) {
        const rec = await redis.hgetall(id);
        if (rec && rec.email) rows.push({ _id: id, ...rec });
    }

    const format = (req.query.format || 'html').toString();

    if (format === 'json') {
        return res.status(200).json({ count: rows.length, applicants: rows });
    }
    if (format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="staffify-sales-applicants.csv"');
        return res.status(200).send(toCSV(rows));
    }

    // HTML dashboard
    const fmtDate = ts => {
        const n = Number(ts);
        if (!n) return '';
        return new Date(n).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
    };

    const cards = rows.map(r => `
      <div class="card">
        <div class="card-top">
          <div>
            <div class="name">${escapeHtml(r.name)}</div>
            <div class="meta">${escapeHtml(r.location || '')} · ${escapeHtml(r.experience || '?')} yrs B2B · ${escapeHtml(r.availability || '?')} hrs/wk</div>
          </div>
          <div class="when">${fmtDate(r.created_at)}</div>
        </div>
        <div class="contact">
          <a href="mailto:${escapeHtml(r.email)}">${escapeHtml(r.email)}</a>
          ${r.phone ? `<span>·</span><a href="tel:${escapeHtml(r.phone)}">${escapeHtml(r.phone)}</a>` : ''}
          ${r.linkedin ? `<span>·</span><a href="${escapeHtml(r.linkedin)}" target="_blank" rel="noopener">LinkedIn</a>` : ''}
          ${r.video ? `<span>·</span><a href="${escapeHtml(r.video)}" target="_blank" rel="noopener">Video intro</a>` : ''}
        </div>
        <div class="block"><span class="lbl">Sold</span>${escapeHtml(r.sold || '')}</div>
        <div class="block"><span class="lbl">Biggest win</span>${escapeHtml(r.win || '')}</div>
      </div>`).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Sales Applicants (${rows.length}) | Staffify Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: "Inter", -apple-system, sans-serif; background:#050507; color:#fff; padding: 40px 24px 80px; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 26px; font-weight: 900; letter-spacing: -0.02em; }
  h1 .n { color:#1abde1; }
  .sub { color:#9ba1ab; font-size:13.5px; margin: 6px 0 28px; }
  .sub a { color:#1abde1; text-decoration:none; }
  .card { background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 22px 24px; margin-bottom: 16px; }
  .card-top { display:flex; justify-content:space-between; align-items:flex-start; gap: 16px; }
  .name { font-size: 19px; font-weight: 800; }
  .meta { color:#9ba1ab; font-size: 13.5px; margin-top: 3px; }
  .when { color:#6e7681; font-size: 12.5px; white-space: nowrap; }
  .contact { margin: 12px 0 4px; font-size: 14px; display:flex; gap:8px; flex-wrap:wrap; }
  .contact a { color:#1abde1; text-decoration:none; }
  .contact span { color:#4a4f57; }
  .block { margin-top: 12px; font-size: 14.5px; line-height: 1.55; color:#d7dde2; background: rgba(255,255,255,0.03); border-left: 2px solid #1abde1; border-radius: 0 8px 8px 0; padding: 10px 14px; white-space: pre-wrap; }
  .block .lbl { display:block; font-size: 10.5px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color:#1abde1; margin-bottom: 4px; }
  .empty { text-align:center; color:#9ba1ab; padding: 80px 0; font-size: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Sales Applicants <span class="n">(${rows.length})</span></h1>
  <p class="sub">Newest first · <a href="?token=${escapeHtml(req.query.token || '')}&format=csv">Download CSV</a> · <a href="?token=${escapeHtml(req.query.token || '')}&format=json">JSON</a> · Posting: <a href="https://www.gostaffify.com/careers/sales/" target="_blank">gostaffify.com/careers/sales/</a></p>
  ${rows.length ? cards : '<div class="empty">No applications yet. Share the posting link to get the pipeline moving.</div>'}
</div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
}
