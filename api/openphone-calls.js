// Read-only endpoint: pull recent OpenPhone calls and surface POSITIVE ones for the sales dashboard.
// OPEN (no auth gate) like the other read endpoints. Never 500s.
// Env: OPENPHONE_API_KEY (required to be "connected"), OPENPHONE_PHONE_NUMBER_ID (optional, e.g. 'PNxxxxxxxx')
//
// Contract (see also /api/campaign-metrics):
// { connected:boolean,
//   calls:[ {id,name,company,phone,direction,durationSec,at,recordingUrl,summary,positive} ],
//   positives:[ ...same shape, positives only ],
//   stats:{ total, answered, positive, avgDurationSec } }

const OP_BASE = 'https://api.openphone.com/v1';

const EMPTY_STATS = { total: 0, answered: 0, positive: 0, avgDurationSec: 0 };

const POSITIVE_WORDS = [
    'interested', 'booked', 'demo', 'follow up', 'follow-up', 'followup',
    'send', 'pricing', 'quote', 'yes', 'schedule', 'call back', 'next step',
];

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function firstStr(...vals) {
    for (const v of vals) {
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

// OpenPhone participants can be an array of E.164 strings, or objects with a phoneNumber/name field.
function pickPhone(call) {
    const parts = call?.participants || call?.to || call?.from || [];
    const arr = Array.isArray(parts) ? parts : [parts];
    for (const p of arr) {
        if (typeof p === 'string' && p.trim()) return p.trim();
        if (p && typeof p === 'object') {
            const ph = firstStr(p.phoneNumber, p.number, p.e164, p.value);
            if (ph) return ph;
        }
    }
    // Fallbacks: direction-based single fields
    return firstStr(call?.to, call?.from, call?.phoneNumber);
}

function pickName(call) {
    const parts = call?.participants || [];
    const arr = Array.isArray(parts) ? parts : [parts];
    for (const p of arr) {
        if (p && typeof p === 'object') {
            const nm = firstStr(p.name, p.displayName, p.contactName);
            if (nm) return nm;
        }
    }
    return firstStr(call?.name, call?.contactName, call?.callerName);
}

function pickRecording(call) {
    const rec = call?.recordingUrl || call?.recording || call?.media || call?.recordings;
    if (typeof rec === 'string') return rec;
    if (Array.isArray(rec) && rec.length) {
        const r = rec[0];
        if (typeof r === 'string') return r;
        if (r && typeof r === 'object') return firstStr(r.url, r.mediaUrl, r.href);
    }
    if (rec && typeof rec === 'object') return firstStr(rec.url, rec.mediaUrl, rec.href);
    return '';
}

function normDirection(d) {
    const s = (d || '').toString().toLowerCase();
    if (s === 'incoming' || s === 'inbound') return 'incoming';
    if (s === 'outgoing' || s === 'outbound') return 'outgoing';
    return 'outgoing';
}

function isAnsweredStatus(status) {
    const s = (status || '').toString().toLowerCase();
    return s === 'completed' || s === 'answered';
}

function classifyPositive({ summary, status, durationSec }) {
    const txt = (summary || '').toLowerCase();
    if (txt) {
        for (const w of POSITIVE_WORDS) {
            if (txt.includes(w)) return true;
        }
    }
    if (isAnsweredStatus(status) && durationSec >= 90) return true;
    // Duration-only fallback when status is unknown but the call was clearly a real conversation.
    if (!status && durationSec >= 90) return true;
    return false;
}

async function opFetch(path, apiKey) {
    const res = await fetch(`${OP_BASE}${path}`, {
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`OpenPhone ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

async function fetchSummaryText(callId, apiKey) {
    try {
        const j = await opFetch(`/call-summaries/${encodeURIComponent(callId)}`, apiKey);
        const data = j?.data || j || {};
        // Summary may be a string, an array of bullet strings, or {summary:[...]}
        const raw = data.summary ?? data.text ?? data.nextSteps ?? data;
        if (typeof raw === 'string') return raw;
        if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string').join(' ');
        if (raw && typeof raw === 'object') {
            const parts = [];
            for (const k of ['summary', 'nextSteps', 'text']) {
                const v = raw[k];
                if (typeof v === 'string') parts.push(v);
                else if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
            }
            return parts.join(' ').trim();
        }
        return '';
    } catch {
        // 404 / plan-not-available / any error: no summary, keep going.
        return '';
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    const apiKey = process.env.OPENPHONE_API_KEY;

    // Not configured: return a clean, dashboard-safe empty payload.
    if (!apiKey) {
        return res.status(200).json({
            connected: false,
            calls: [],
            positives: [],
            stats: { ...EMPTY_STATS },
        });
    }

    const phoneNumberId = process.env.OPENPHONE_PHONE_NUMBER_ID;

    let rawCalls = [];
    try {
        const params = new URLSearchParams();
        if (phoneNumberId) params.set('phoneNumberId', phoneNumberId);
        params.set('maxResults', '50');
        // Best-effort newest-first hint; ignored by the API if unsupported.
        params.set('sortBy', 'createdAt');
        params.set('sortDirection', 'desc');
        const j = await opFetch(`/calls?${params.toString()}`, apiKey);
        rawCalls = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : []);
    } catch {
        // Key was set but the list call failed: stay connected, return empties.
        return res.status(200).json({
            connected: true,
            calls: [],
            positives: [],
            stats: { ...EMPTY_STATS },
        });
    }

    // Best-effort summaries for the ~20 most recent completed calls.
    const summaryTargets = rawCalls
        .filter((c) => isAnsweredStatus(c?.status) || num(c?.duration) > 0)
        .slice(0, 20);

    const summaryById = {};
    try {
        const results = await Promise.all(
            summaryTargets.map(async (c) => {
                const id = firstStr(c?.id, c?.callId);
                if (!id) return null;
                const text = await fetchSummaryText(id, apiKey);
                return text ? [id, text] : null;
            })
        );
        for (const pair of results) {
            if (pair) summaryById[pair[0]] = pair[1];
        }
    } catch {
        // ignore: summaries are optional
    }

    const calls = rawCalls.map((c) => {
        const id = firstStr(c?.id, c?.callId);
        const durationSec = num(c?.duration ?? c?.durationSec);
        const summary = summaryById[id] || firstStr(c?.summary);
        const status = c?.status;
        const positive = classifyPositive({ summary, status, durationSec });
        return {
            id,
            name: pickName(c),
            company: '',
            phone: pickPhone(c),
            direction: normDirection(c?.direction),
            durationSec,
            at: c?.createdAt ? (Date.parse(c.createdAt) || 0) : 0,
            recordingUrl: pickRecording(c),
            summary,
            positive,
        };
    });

    const answered = calls.filter((c) => c.durationSec > 0).length;
    const positives = calls.filter((c) => c.positive);
    const totalDuration = calls.reduce((s, c) => s + c.durationSec, 0);
    const avgDurationSec = calls.length ? Math.round(totalDuration / calls.length) : 0;

    return res.status(200).json({
        connected: true,
        calls,
        positives,
        stats: {
            total: calls.length,
            answered,
            positive: positives.length,
            avgDurationSec,
        },
    });
}
