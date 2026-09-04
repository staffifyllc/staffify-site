// Hubstaff, serverless. Hours worked per client, which is what pays a rep's per-hour residual.
//
// Hubstaff projects = clients. Hubstaff users = VAs. A VA working under a client's name produces
// time entries against that client's project, and that is the signal a residual is owed on.
//
// THE ONE THING THAT WILL BREAK THIS. Hubstaff's token endpoint ROTATES the refresh token: every
// successful exchange can return a NEW refresh token and invalidate the old one. The local
// FastAPI dashboard handled that by writing the new token back to config.yaml. A serverless
// function has no config.yaml, so if the rotated token is not persisted the integration works
// exactly once and then dies with invalid_grant, silently, until someone checks. That is almost
// certainly what happened to the existing token, which is dead as of 2026-09-04.
// So: the refresh token lives in Redis, is written back on every rotation, and a failure here is
// surfaced as a blocker rather than swallowed.

import { redis } from './_auth.js';

const ACCOUNT = 'https://account.hubstaff.com/access_tokens';
const API = 'https://api.hubstaff.com/v2';
const RT_KEY = 'hubstaff:refresh_token';   // rotates, so Redis is the source of truth, not env
const AT_KEY = 'hubstaff:access_token';    // short-lived bearer, cached to avoid a rotation per call

// Hubstaff sits behind Cloudflare, which 403s (error 1010) on a default scripting user-agent.
// This bit me while diagnosing on 2026-09-04: it reads as an auth failure and is not one.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/127 Safari/537.36';

export const ORG_ID = process.env.HUBSTAFF_ORG_ID || '699143';

// Clients that are us, not customers. Hours here are real but no rep earns a residual on them.
// Flylisted is a separate business billed through Staffify's books, never a rep's commission.
const NOT_A_CLIENT = /^(staffify|flylisted|internal|admin|training|onboarding|bench)$/i;

async function currentRefreshToken() {
    const stored = await redis.get(RT_KEY).catch(() => null);
    return stored || process.env.HUBSTAFF_REFRESH_TOKEN || '';
}

async function mintAccessToken() {
    const rt = await currentRefreshToken();
    if (!rt) return { ok: false, error: 'no_refresh_token', hint: 'Set a Hubstaff personal access token. Redis key ' + RT_KEY + ', or HUBSTAFF_REFRESH_TOKEN.' };

    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt });
    let r, j;
    try {
        r = await fetch(ACCOUNT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body });
        j = await r.json().catch(() => ({}));
    } catch (e) {
        return { ok: false, error: 'network', hint: String(e).slice(0, 120) };
    }
    if (!r.ok || !j.access_token) {
        return {
            ok: false, error: j.error || `http_${r.status}`,
            hint: j.error === 'invalid_grant'
                ? 'The Hubstaff refresh token is expired or revoked. Generate a new personal access token in Hubstaff (Settings -> Personal access tokens) and store it.'
                : (j.error_description || '').slice(0, 160),
        };
    }
    // Persist the rotation FIRST. If this write is lost the next call fails with invalid_grant and
    // the whole residual feed goes quiet, which is the failure mode that killed the last token.
    if (j.refresh_token && j.refresh_token !== rt) await redis.set(RT_KEY, j.refresh_token).catch(() => {});
    const ttl = Math.max(60, Number(j.expires_in || 3600) - 120);
    await redis.set(AT_KEY, j.access_token, { ex: ttl }).catch(() => {});
    return { ok: true, token: j.access_token };
}

async function bearer() {
    const cached = await redis.get(AT_KEY).catch(() => null);
    if (cached) return { ok: true, token: cached };
    return mintAccessToken();
}

export async function hubstaffConnected() {
    const b = await bearer();
    return !!b.ok;
}

// Same check, but it says WHY when it fails. A boolean false sends whoever is debugging looking for
// the wrong thing: a missing token, an expired one and a Cloudflare block all read identically.
export async function hubstaffStatus() {
    const b = await bearer();
    if (b.ok) return { connected: true };
    return { connected: false, reason: b.hint || b.error || 'unknown' };
}

async function api(path) {
    const b = await bearer();
    if (!b.ok) return { ok: false, ...b };
    const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${b.token}`, 'User-Agent': UA } });
    if (r.status === 401) {                       // cached bearer went stale mid-flight
        await redis.del(AT_KEY).catch(() => {});
        const b2 = await mintAccessToken();
        if (!b2.ok) return { ok: false, ...b2 };
        const r2 = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${b2.token}`, 'User-Agent': UA } });
        if (!r2.ok) return { ok: false, error: `http_${r2.status}` };
        return { ok: true, data: await r2.json() };
    }
    if (!r.ok) return { ok: false, error: `http_${r.status}` };
    return { ok: true, data: await r.json() };
}

// Hours per client between two dates. Hubstaff caps a page, so this follows the cursor rather than
// taking the first page and quietly reporting a fraction of the hours as if it were the total.
export async function hoursByClient({ start, stop }) {
    const projects = {};
    const pr = await api(`/organizations/${ORG_ID}/projects?status=active&page_limit=100`);
    if (!pr.ok) return { connected: false, ...pr, clients: [] };
    (pr.data.projects || []).forEach(p => { projects[p.id] = p.name; });

    const byProject = {};
    let cursor = '';
    let pages = 0;
    do {
        const q = `/organizations/${ORG_ID}/activities/daily?date[start]=${start}&date[stop]=${stop}&page_limit=500${cursor ? `&page_start_id=${cursor}` : ''}`;
        const a = await api(q);
        if (!a.ok) return { connected: false, ...a, clients: [] };
        (a.data.daily_activities || []).forEach(d => {
            const pid = d.project_id;
            if (!pid) return;
            const k = String(pid);
            const rec = byProject[k] || (byProject[k] = { projectId: pid, name: projects[pid] || `project ${pid}`, seconds: 0, vas: new Set(), days: new Set() });
            rec.seconds += Number(d.tracked) || 0;
            if (d.user_id) rec.vas.add(d.user_id);
            if (d.date) rec.days.add(d.date);
        });
        cursor = (a.data.pagination && a.data.pagination.next_page_start_id) || '';
        pages++;
    } while (cursor && pages < 40);

    const clients = Object.values(byProject)
        .filter(r => !NOT_A_CLIENT.test(String(r.name || '').trim()))
        .map(r => ({
            projectId: r.projectId,
            name: r.name,
            hours: Math.round((r.seconds / 3600) * 10) / 10,
            vaCount: r.vas.size,
            daysWorked: r.days.size,
        }))
        .sort((a, b) => b.hours - a.hours);

    return { connected: true, clients, truncated: pages >= 40 };
}
