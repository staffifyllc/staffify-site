// "Right now": is each caller working, and today's quiet stretches on shift. For owners.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "I need to know if Milton is active and working, and when he is not."
// Drawn on Performance (its own tab) and at the top of Activity, from GET /api/activity/?live=1
// (api/_live-status.js says what each status means). Redrawn every minute while the tab is visible.
// Built with DOM nodes, never HTML strings.
const el = (t, text, cls) => { const e = document.createElement(t); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const timeET = iso => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const mins = n => (n >= 60 ? Math.floor(n / 60) + 'h ' + (n % 60) + 'm' : n + 'm');
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const answerText = s => (s.prompted ? (s.answer === 'No answer' ? 'prompted, no answer' : 'prompted, ' + String(s.answer || '').toLowerCase()) : 'not prompted');

async function read(url) {
    const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(Error(j.error || 'HTTP ' + r.status), { status: r.status });
    return j;
}

/** Draw once into `box`. Exported for tests. */
export async function drawLive(box) {
    let j;
    try { j = await read('/api/activity/?live=1'); }
    catch (e) {
        box.replaceChildren(el('h2', 'Right now'), el('p', e.status === 403 ? 'Only owners see who is working right now.' : 'Live status could not be read just now (' + e.message + '). That is not a sign of anyone being idle.', 'live-note'));
        return null;
    }
    box.replaceChildren(el('h2', 'Right now'));
    if (!(j.people || []).length) { box.append(el('p', 'Nobody with the caller role yet.', 'live-note')); return j; }
    for (const p of j.people) {
        const st = p.status || { key: 'unknown', label: 'Unknown' };
        const facts = [];
        if (st.key === 'working') facts.push('last activity ' + (st.quietMinutes ? st.quietMinutes + ' min ago' : 'just now'));
        if (st.key === 'quiet') facts.push('nothing since ' + timeET(st.since) + (st.prompt ? (st.prompt.answered ? ' · prompted at ' + timeET(st.prompt.at) + ', answered' : ' · prompt on screen since ' + timeET(st.prompt.at) + ', not answered') : ''));
        if (st.key === 'break' && st.since) facts.push('since ' + timeET(st.since));
        if (st.detail) facts.push(st.detail);
        facts.push('last Hub activity ' + (p.lastHubAt ? timeET(p.lastHubAt) : 'none today'));
        facts.push('last Quo call ' + (p.quo === 'read' ? (p.lastCallAt ? timeET(p.lastCallAt) : 'none today') : p.quo === 'no seat' ? 'no Quo seat' : 'unknown (Quo not read)'));
        if (p.today && p.today.onShiftMinutes) facts.push('quiet on shift today ' + mins(p.today.quietMinutes) + ' of ' + mins(p.today.onShiftMinutes));
        const row = el('div', null, 'live-row');
        row.append(el('b', p.name), el('span', st.label, 'live-pill ' + st.key), el('span', facts.join(' · '), 'live-facts'));
        box.append(row);
        if (p.today && p.today.stretches && p.today.stretches.length) {
            const d = el('details', null, 'live-stretches');
            d.append(el('summary', plural(p.today.stretches.length, 'quiet stretch', 'quiet stretches') + ' on shift today'));
            const ul = el('ul');
            for (const x of p.today.stretches) ul.append(el('li', timeET(x.from) + ' to ' + (x.open ? 'now' : timeET(x.to)) + ' · ' + mins(x.minutes) + ' · ' + answerText(x)));
            d.append(ul); box.append(d);
        }
    }
    box.append(el('p', (j.note || '') + ' Updates every minute.', 'live-note'));
    return j;
}

/** Draw now, then every minute while the page is visible. Returns stop(). */
export function mountLive(box, { everyMs = 60000 } = {}) {
    box.classList.add('live-box');
    drawLive(box);
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') drawLive(box); }, everyMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // Node tests only; a browser returns a number
    const onShow = () => { if (document.visibilityState === 'visible') drawLive(box); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onShow); };
}
