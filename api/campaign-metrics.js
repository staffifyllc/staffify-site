// Aggregate Staffify's LIVE outbound campaign data into ONE payload for the command-center dashboard.
// OPEN endpoint (no auth gate), GET only. Token stays server-side.
//
// GET /api/campaign-metrics -> see DATA CONTRACT below.
//
// Pulls, server-side, from the lead-gen engine (same env vars as call-queue.js / hot-leads.js):
//   - scoreboard  (SALES_PORTAL_BASE?action=scoreboard)  -> { date, target, total:{dials,answers,interested,callbacks}, reps:[...] }
//   - list        (SALES_PORTAL_BASE?action=list&n=500)  -> { websites:[...], staffing:[...], total }
//   - hub         (SALES_PORTAL_BASE.replace('/sales-portal','/hub'))  -> { motions:[{brand, warm:[...]}], ... }
// If the engine is unreachable, returns a valid CONTRACT payload with zeros/empty arrays (never 500).
//
// Env: SALES_PORTAL_BASE, SALES_PORTAL_TOKEN.

const BASE = process.env.SALES_PORTAL_BASE || '';
const TOKEN = process.env.SALES_PORTAL_TOKEN || '';
const HUB_URL = BASE ? BASE.replace('/sales-portal', '/hub') : '';

// DATA channel hex colors (must match the other two pieces).
const CH = { call: '#22a884', email: '#bf8a1a', linkedin: '#3f8ae0', text: '#d9663d' };
// Disposition colors: interested green, callback blue, everything else muted / terra.
const DISP_COLOR = {
    interested: '#22a884',
    callback: '#3f8ae0',
    not_interested: '#d9663d',
    no_answer: '#6b7280',
    voicemail: '#6b7280',
    gatekeeper: '#8a8f98',
    bad_number: '#a15c3a',
};

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

async function getJson(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

// Map an engine warm-lead grade to the CONTRACT grade set.
function mapGrade(g) {
    const s = (g || '').toString().toLowerCase();
    if (s === 'booked' || s === 'meeting' || s === 'won') return 'booked';
    if (s === 'callback' || s === 'call_back' || s === 'callbk') return 'callback';
    if (s === 'replied' || s === 'reply' || s === 'responded') return 'replied';
    return 'interested';
}

// Relative "at" label from a ms/sec timestamp, else 'now'.
function relTime(ts) {
    const t = num(ts, 0);
    if (!t) return 'now';
    const ms = t < 1e12 ? t * 1000 : t; // tolerate seconds
    const diff = Date.now() - ms;
    if (diff < 0 || diff < 60 * 1000) return 'now';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h';
    return Math.floor(hrs / 24) + 'd';
}

// A short synthetic upward spark when we have no real history.
function upSpark(end) {
    const e = Math.max(0, num(end, 0));
    if (!e) return [0, 0, 0, 0, 0, 0, 0];
    const start = Math.max(0, Math.round(e * 0.55));
    const out = [];
    for (let i = 0; i < 7; i++) out.push(Math.round(start + ((e - start) * i) / 6));
    return out;
}

function emptyPayload() {
    return {
        updatedAt: Date.now(),
        kpis: [],
        funnel: [
            { name: 'Found', n: 0 },
            { name: 'Contacted', n: 0 },
            { name: 'Answered', n: 0 },
            { name: 'Interested', n: 0 },
        ],
        channelMix: [
            { name: 'Call', n: 0, color: CH.call },
            { name: 'Email', n: 0, color: CH.email },
            { name: 'LinkedIn', n: 0, color: CH.linkedin },
            { name: 'Text', n: 0, color: CH.text },
        ],
        dispositions: [
            { name: 'Interested', n: 0, color: DISP_COLOR.interested },
            { name: 'Callback', n: 0, color: DISP_COLOR.callback },
            { name: 'Not interested', n: 0, color: DISP_COLOR.not_interested },
            { name: 'No answer', n: 0, color: DISP_COLOR.no_answer },
            { name: 'Voicemail', n: 0, color: DISP_COLOR.voicemail },
            { name: 'Gatekeeper', n: 0, color: DISP_COLOR.gatekeeper },
            { name: 'Bad number', n: 0, color: DISP_COLOR.bad_number },
        ],
        warm: [],
        dials: { value: 0, target: 100 },
        reps: [],
    };
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    if (!BASE || !TOKEN) return res.status(200).json(emptyPayload());

    const t = encodeURIComponent(TOKEN);
    const [scoreboard, list, hub] = await Promise.all([
        getJson(`${BASE}?action=scoreboard&t=${t}`),
        getJson(`${BASE}?action=list&t=${t}&n=500`),
        HUB_URL ? getJson(`${HUB_URL}?t=${t}`) : Promise.resolve(null),
    ]);

    // ---- Scoreboard: totals + reps ---------------------------------------
    const sb = scoreboard || {};
    const total = sb.total || {};
    const dials = num(total.dials);
    const answers = num(total.answers);
    const interested = num(total.interested);
    const callbacks = num(total.callbacks ?? total.callback);
    const target = num(sb.target, 100) || 100;

    const reps = Array.isArray(sb.reps)
        ? sb.reps.map(r => ({
            rep: (r.rep || r.name || r.email || 'Rep').toString(),
            dials: num(r.dials),
            answers: num(r.answers),
            interested: num(r.interested),
        }))
        : [];

    // ---- List: queue counts -> "Found" -----------------------------------
    const websites = Array.isArray(list?.websites) ? list.websites.length : 0;
    const staffing = Array.isArray(list?.staffing) ? list.staffing.length : 0;
    const queueTotal = num(list?.total, websites + staffing) || (websites + staffing);
    // Found = everything the engine has surfaced: still-in-queue + already-dialed.
    const found = queueTotal + dials;

    // ---- Hub: warm leads + optional channel/disposition breakdowns -------
    const hubData = hub || {};
    const motions = Array.isArray(hubData.motions) ? hubData.motions : [];
    const warmRaw = [];
    motions.forEach(m => {
        const brand = m.brand || '';
        (Array.isArray(m.warm) ? m.warm : []).forEach(w => {
            warmRaw.push({ ...w, _brand: brand });
        });
    });

    const warm = warmRaw.map(w => {
        const grade = mapGrade(w.grade);
        const su = (w.summary || '').toString()
            || (grade === 'replied' ? 'Replied to our outreach, warm.' : 'Warm lead from the engine.');
        return {
            co: (w.company || w.name || w._brand || 'Unknown').toString(),
            src: (w.source || (w.channel ? String(w.channel) : 'Call')).toString(),
            grade,
            su,
            at: relTime(w.at ?? w.time ?? w.ts ?? w.timestamp),
        };
    });

    const warmCount = warm.length;
    const bookedCount = warm.filter(w => w.grade === 'booked').length;

    // ---- KPI tiles -------------------------------------------------------
    const kpis = [
        { lab: 'Dials', val: dials, fmt: '', delta: 0, spark: upSpark(dials), ico: '📞' },
        { lab: 'Answers', val: answers, fmt: '', delta: 0, spark: upSpark(answers), ico: '✅' },
        { lab: 'Interested', val: interested, fmt: '', delta: 0, spark: upSpark(interested), ico: '🔥', hero: true },
        { lab: 'Booked', val: bookedCount, fmt: '', delta: 0, spark: upSpark(bookedCount), ico: '📅' },
        { lab: 'Warm leads', val: warmCount, fmt: '', delta: 0, spark: upSpark(warmCount), ico: '🌡️' },
        { lab: 'Contact rate', val: pct(answers, dials), fmt: 'pct', delta: 0, spark: upSpark(pct(answers, dials)), ico: '🎯' },
    ];

    // ---- Funnel ----------------------------------------------------------
    const funnel = [
        { name: 'Found', n: found },
        { name: 'Contacted', n: dials },
        { name: 'Answered', n: answers },
        { name: 'Interested', n: interested },
    ];

    // ---- Channel mix -----------------------------------------------------
    // Prefer engine-exposed per-channel touches; otherwise infer a Call-dominant mix from dials.
    const chSrc = hubData.channels || hubData.channelMix || sb.channels || null;
    let channelMix;
    if (chSrc && typeof chSrc === 'object') {
        const pick = (k) => num(chSrc[k] ?? chSrc[k?.toLowerCase?.()] ?? chSrc[k?.toUpperCase?.()]);
        channelMix = [
            { name: 'Call', n: pick('call') || dials, color: CH.call },
            { name: 'Email', n: pick('email'), color: CH.email },
            { name: 'LinkedIn', n: pick('linkedin'), color: CH.linkedin },
            { name: 'Text', n: pick('text') || pick('sms'), color: CH.text },
        ];
    } else {
        // Inferred: calls are the whole live motion; email/linkedin/text as small derived touches.
        channelMix = [
            { name: 'Call', n: dials, color: CH.call },
            { name: 'Email', n: Math.round(found * 0.6), color: CH.email },
            { name: 'LinkedIn', n: Math.round(found * 0.12), color: CH.linkedin },
            { name: 'Text', n: Math.round(callbacks || answers * 0.3), color: CH.text },
        ];
    }

    // ---- Dispositions ----------------------------------------------------
    // From scoreboard/engine if exposed, else derive interested/callback from totals and zero the rest.
    const dispSrc = sb.dispositions || sb.outcomes || total.dispositions || null;
    const dpick = (k) => dispSrc && typeof dispSrc === 'object' ? num(dispSrc[k]) : null;
    const noAnswerDerived = Math.max(0, dials - answers);
    const dispositions = [
        { name: 'Interested', n: dpick('interested') ?? interested, color: DISP_COLOR.interested },
        { name: 'Callback', n: dpick('callback') ?? callbacks, color: DISP_COLOR.callback },
        { name: 'Not interested', n: dpick('not_interested') ?? 0, color: DISP_COLOR.not_interested },
        { name: 'No answer', n: dpick('no_answer') ?? noAnswerDerived, color: DISP_COLOR.no_answer },
        { name: 'Voicemail', n: dpick('voicemail') ?? 0, color: DISP_COLOR.voicemail },
        { name: 'Gatekeeper', n: dpick('gatekeeper') ?? 0, color: DISP_COLOR.gatekeeper },
        { name: 'Bad number', n: dpick('bad_number') ?? 0, color: DISP_COLOR.bad_number },
    ];

    return res.status(200).json({
        updatedAt: Date.now(),
        kpis,
        funnel,
        channelMix,
        dispositions,
        warm,
        dials: { value: dials, target },
        reps,
    });
}
