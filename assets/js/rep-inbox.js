// My inbox: your own mailbox, read and answered inside the Hub.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "he should have an area where he can check his inbox, its only notifying him to
// check it if he has a notification". The server (api/rep-inbox.js) reads the signed-in rep's Gmail
// and matches each conversation to a prospect card; this draws the list, one conversation, and the
// reply box. A reply is cleaned up before it can go, like every email from the Hub: the first Send
// runs the cleanup and shows what changed, the next one sends exactly what is on screen.
// Built with DOM nodes, never HTML strings: every word here came from someone's email.
const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
let data = null, openId = params.get('thread') || null, onlyProspects = params.get('show') === 'prospects';
// Back from connecting Gmail: say what happened, once (api/outreach-connect.js adds ?gmail=).
const gmailNote = params.get('gmail');
if (gmailNote) { try { const u = new URL(location.href); u.searchParams.delete('gmail'); history.replaceState(null, '', u); } catch { /* keep going */ } }

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
const button = (label, fn, cls = 'btn') => { const b = el('button', label, cls); b.type = 'button'; b.onclick = fn; return b; };
const link = (label, href, cls) => { const a = el('a', label, cls); a.href = href; if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; } return a; };
async function api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' } : { cache: 'no-store', credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = Error(j.error || j.reason || 'HTTP ' + r.status); e.payload = j; e.status = r.status; throw e; }
    return j;
}
function toast(text, warn) { const t = document.getElementById('ib-toast'); if (!t) return; t.textContent = text; t.className = 'ib-toast show' + (warn ? ' warn' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = 'ib-toast'; }, 7000); }
const when = iso => { const d = new Date(iso); if (isNaN(d)) return ''; const today = new Date().toDateString() === d.toDateString(); return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
const full = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const newNonce = () => { try { return crypto.randomUUID(); } catch { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); } };
const draftKey = id => 'staffify-inbox-reply:' + id;
const readDraft = id => { try { return sessionStorage.getItem(draftKey(id)) || ''; } catch { return ''; } };
const keepDraft = (id, v) => { try { sessionStorage.setItem(draftKey(id), v); } catch { /* private window */ } };
const dropDraft = id => { try { sessionStorage.removeItem(draftKey(id)); } catch { /* nothing kept */ } };
function syncUrl() { const u = new URL(location.href); openId ? u.searchParams.set('thread', openId) : u.searchParams.delete('thread'); onlyProspects ? u.searchParams.set('show', 'prospects') : u.searchParams.delete('show'); history.replaceState(null, '', u); }

/** Load the list and draw the page. Exported for tests. */
export async function load() {
    if (gmailNote && !load.told) { load.told = true; toast(gmailNote === 'connected' ? 'Gmail connected. Your inbox is here.' : 'Gmail was not connected: ' + gmailNote, gmailNote !== 'connected'); }
    try { data = await api('/api/rep-inbox/?view=list' + (onlyProspects ? '&prospects=1' : '')); }
    catch (e) { app.replaceChildren(el('h1', 'Inbox'), el('p', e.status === 403 || e.status === 401 ? e.message : 'Your inbox could not be read just now (' + e.message + '). Try Refresh in a minute.', 'ib-alert'), button('Refresh', load)); return null; }
    if (data.connected === false) {
        const box = el('div', null, 'ib-thread');
        box.append(el('h2', 'Connect ' + data.mailbox), el('p', 'One time only. Google asks you to let the Hub read your mail and send as ' + data.mailbox + '. After that your inbox is here, and replies go out from your own Gmail with your signature.', 'ib-note'));
        const c = link('Connect Gmail', data.connectUrl, 'btn primary'); c.id = 'ib-connect'; box.append(c);
        app.replaceChildren(el('h1', 'Inbox'), box);
        return data;
    }
    draw();
    if (openId) openThread(openId);
    return data;
}

function draw() {
    const threads = data.threads || [];
    const head = el('div', null, 'ib-head');
    const title = el('div'); title.append(el('h1', 'Inbox'));
    const unread = threads.filter(t => t.unread).length;
    title.append(el('p', data.mailbox + (unread ? ' · ' + unread + ' unread' : ''), 'ib-sub'));
    const controls = el('div', null, 'ib-controls');
    for (const [label, value] of [['All mail', false], ['Prospects', true]]) { const b = button(label, () => { onlyProspects = value; openId = null; syncUrl(); load(); }); b.setAttribute('aria-pressed', String(onlyProspects === value)); controls.append(b); }
    controls.append(button('Refresh', () => load()), link('Open Gmail', 'https://mail.google.com/mail/u/?authuser=' + encodeURIComponent(data.mailbox), 'btn'));
    head.append(title, controls);
    const grid = el('div', null, 'ib-grid');
    const list = el('div', null, 'ib-list'); list.setAttribute('role', 'list'); list.id = 'ib-list';
    if (!threads.length) list.append(el('p', onlyProspects ? (data.nextPage ? 'No prospect replies in your newest mail. Load more to look further back.' : 'No prospect has written to you in the last 60 days.') : 'Nothing in your inbox from the last 60 days.', 'ib-empty'));
    for (const t of threads) {
        const row = button(null, () => openThread(t.id), 'ib-row' + (t.unread ? ' unread' : '')); row.setAttribute('role', 'listitem'); row.dataset.id = t.id;
        if (t.id === openId) row.setAttribute('aria-current', 'true');
        const who = el('span', t.with || t.withAddr || 'Unknown', 'ib-who');
        if (t.prospect) who.append(el('span', t.prospect.company, 'ib-chip'));
        row.append(el('span', null, 'ib-dot'), who, el('span', when(t.at), 'ib-when'), el('span', t.subject, 'ib-line subj'), el('span', (t.lastFromMe ? 'You: ' : '') + t.snippet, 'ib-line'));
        list.append(row);
    }
    // More mail than one page: fetch the next page and add it under these.
    if (data.nextPage) { const more = button('Load more', async () => { more.disabled = true; more.textContent = 'Loading…'; try { const j = await api('/api/rep-inbox/?view=list&page=' + encodeURIComponent(data.nextPage) + (onlyProspects ? '&prospects=1' : '')); data = { ...data, threads: [...threads, ...(j.threads || [])], nextPage: j.nextPage || null, unreadable: (data.unreadable || 0) + (j.unreadable || 0) }; draw(); } catch (e) { more.disabled = false; more.textContent = 'Load more'; toast('Could not load more: ' + e.message, true); } }, 'btn btn-ghost'); more.id = 'ib-more'; list.append(more); }
    if (data.unreadable) list.append(el('p', data.unreadable + ' conversation' + (data.unreadable === 1 ? '' : 's') + ' could not be read just now and are not shown.', 'ib-empty'));
    const pane = el('section', null, 'ib-thread'); pane.id = 'ib-pane'; pane.setAttribute('aria-live', 'polite');
    pane.append(el('p', threads.length ? 'Pick a conversation to read it and reply.' : 'When a prospect writes back, it shows up here.', 'ib-note'));
    grid.append(list, pane);
    app.replaceChildren(head, grid);
}

/** Open one conversation in the pane. Exported for tests. */
export async function openThread(id) {
    openId = id; syncUrl();
    for (const r of document.querySelectorAll('.ib-row')) r.dataset.id === id ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current');
    const pane = document.getElementById('ib-pane'); if (!pane) return null;
    pane.replaceChildren(el('p', 'Loading the conversation…', 'ib-note'));
    let j;
    try { j = await api('/api/rep-inbox/?thread=' + encodeURIComponent(id)); if (j && j.connected === false) { location.href = j.connectUrl; return null; } }
    catch (e) { if (openId === id) pane.replaceChildren(el('p', 'This conversation could not be read just now (' + e.message + ').', 'ib-alert')); return null; }
    if (openId !== id) return null;   // another one was opened while this loaded
    const t = j.thread;
    const acts = el('div', null, 'ib-tactions');
    if (t.prospect) acts.append(link('Open ' + t.prospect.company + "'s card", '/dialer/?open=' + encodeURIComponent(t.prospect.recordId)));
    acts.append(link('Open in Gmail', j.gmailUrl));
    pane.replaceChildren(el('h2', t.subject), acts);
    for (const m of j.messages) {
        const card = el('article', null, 'ib-msg' + (m.mine ? ' mine' : ''));
        const h = el('header'); const from = el('span'); from.append(el('b', m.mine ? 'You' : m.from), document.createTextNode(m.mine ? '' : ' · ' + m.fromAddr)); h.append(from, el('span', full(m.at)));
        card.append(h, el('pre', m.text || '(no text in this message)'));
        pane.append(card);
    }
    if (t.withAddr && t.replyable !== false) pane.append(replyBox(id, t));
    else if (t.withAddr) pane.append(el('p', 'They have not written back in this conversation yet. To follow up, send a new email from their card in the dialer.', 'ib-note'));
    // A row opened here is read in the Hub, though Gmail keeps its own unread mark (the Hub cannot change it).
    const row = [...document.querySelectorAll('.ib-row')].find(r => r.dataset.id === id); if (row) row.classList.remove('unread');
    return j;
}

function replyBox(id, t) {
    const wrap = el('div', null, 'ib-reply');
    const area = el('textarea'); area.id = 'ib-reply-text'; area.maxLength = 5000; area.value = readDraft(id) || ((t.with && !/@/.test(t.with) ? 'Hi ' + t.with.split(/\s+/)[0] + ',' : 'Hi,') + '\n\n');
    const lab = el('label', 'Reply to ' + (t.with || t.withAddr)); lab.htmlFor = area.id;
    area.oninput = () => keepDraft(id, area.value);
    const review = el('div', null, 'ib-review'); review.hidden = true;
    const row = el('div', null, 'ib-ractions');
    let nonce = newNonce(), reviewed = null;
    const send = button('Send reply', async () => {
        if (send.disabled) return;
        const body = area.value.replace(/\r\n/g, '\n').trim();
        if (body.replace(/^hi\b[^,\n]*,?/i, '').trim().length < 2) { toast('Write the reply first.', true); area.focus(); return; }
        send.disabled = true;
        if (!reviewed || reviewed !== body) {
            send.textContent = 'Checking…';
            let c; try { c = await api('/api/rep-inbox/', { action: 'clean', threadId: id, body }); } catch (e) { c = e.payload || { reason: 'Could not reach the server. Nothing was sent.' }; }
            if (!c || !c.body) { toast((c && c.reason) || 'The cleanup could not run. Nothing was sent.', true); send.disabled = false; send.textContent = 'Send reply'; return; }
            area.value = c.body; keepDraft(id, c.body); reviewed = c.body;
            review.replaceChildren(); review.hidden = !(c.changed || c.note);
            if (c.changed) { review.append(el('b', 'Cleaned up before sending')); const ul = el('ul'); for (const x of c.changes || []) ul.append(el('li', x)); review.append(ul); }
            if (c.note) review.append(el('p', c.note));
            if (c.changed) { review.append(el('p', 'Read it over, then press Send reply.')); send.disabled = false; send.textContent = 'Send reply'; return; }
        }
        send.textContent = 'Sending…';
        let j; try { j = await api('/api/rep-inbox/', { action: 'reply', threadId: id, body: reviewed, nonce }); } catch (e) { j = e.payload || { sent: false, uncertain: true, reason: 'The Hub could not confirm whether this was sent. Check your Gmail Sent folder before replying again.' }; }
        if (j.sent) { dropDraft(id); toast('Reply sent to ' + j.to + '. It is in your Gmail Sent folder.'); nonce = newNonce(); reviewed = null; await load(); return; }
        toast(j.reason || 'Not sent.', true);
        if (j.review) reviewed = null;
        if (j.connect) { location.href = '/api/rep-email/?action=connect&back=' + encodeURIComponent('/inbox/?thread=' + id); return; }
        if (j.uncertain) { send.textContent = 'Check your Sent folder'; return; }
        send.disabled = false; send.textContent = 'Send reply';
    }, 'btn primary');
    send.id = 'ib-send';
    row.append(send, el('span', 'Sent from your Gmail with your signature.', 'ib-mine'));
    wrap.append(lab, area, review, row);
    return wrap;
}

if (app && typeof window !== 'undefined' && !window.__staffifyInboxTest) load();
