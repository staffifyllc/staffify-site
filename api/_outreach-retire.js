// Retiring a sending mailbox from the hosted worker.
// ------------------------------------------------------------------
// Paul, 2026-10-29: "I don't have that email anymore, that email is milton@trystaffify.com". paul@trystaffify.com was
// renamed to Milton's account, so its Gmail authorization can never come back under that name, and one unreadable
// mailbox pauses every draft and send on every campaign (_outreach-worker-core.js historyComplete). Retiring it:
//   * the mailbox leaves the worker's inventory, so the rest of the engine runs again;
//   * a prospect not yet emailed from it moves to the owner's least-used remaining mailbox (nothing was sent, so
//     nothing is lost);
//   * a sequence already under way from it is held, never restarted from another address: its thread lives in the
//     renamed mailbox now, and a follow-up from a stranger address would read as a new sender;
//   * finished sequences, replies, suppressions and every record stay exactly as they are.
// Pure: returns the new config and queue state and what it did. The endpoint writes them under the worker lock.
const UNSTARTED = new Set(['prepared', 'contact_research_hold']);
export function retireSender({ cfg, state, email, replacedBy = null, now = new Date().toISOString() }) {
    const gone = String(email || '').trim().toLowerCase();
    if (!gone || !cfg || !Array.isArray(cfg.accounts) || !cfg.accounts.some(a => a.email === gone)) throw Error('That mailbox is not in the worker inventory');
    const accounts = cfg.accounts.filter(a => a.email !== gone);
    const owner = cfg.accounts.find(a => a.email === gone).owner;
    const choices = accounts.filter(a => a.brand === 'Staffify' && a.draftEnabled && a.owner === owner).map(a => a.email);
    if (!choices.length) throw Error('No other ' + owner + ' mailbox to move unstarted prospects to');
    const load = Object.fromEntries(choices.map(e => [e, 0]));
    for (const r of state.records || []) if (r.sender in load && r.recipient) load[r.sender]++;
    const out = { moved: 0, held: 0, untouched: 0, byStatus: {} };
    const records = (state.records || []).map(r => {
        if (r.sender !== gone) return r;
        const touches = Number(r.sentTouches) || 0;
        if (UNSTARTED.has(r.status) && !touches && !r.draftId && !r.threadId) {
            const to = choices.slice().sort((a, b) => load[a] - load[b] || a.localeCompare(b))[0];
            load[to]++; out.moved++;
            return { ...r, sender: to, senderMoved: { from: gone, to, at: now, why: 'mailbox retired' } };
        }
        if (touches < 4 && !['suppressed', 'bounce_hold', 'human_reply_hold', 'auto_reply_hold'].includes(r.status)) {
            out.held++; out.byStatus[r.status] = (out.byStatus[r.status] || 0) + 1;
            return { ...r, status: 'sender_retired_hold', heldFrom: r.status, heldAt: now, heldWhy: gone + ' was retired' + (replacedBy ? '; its thread is now in ' + replacedBy : '') + '. Follow up by hand from there.' };
        }
        out.untouched++;
        return r;
    });
    const retired = [...(cfg.retiredAccounts || []), { email: gone, owner, at: now, replacedBy }];
    return { cfg: { ...cfg, accounts, expectedAccounts: accounts.length, retiredAccounts: retired, updatedAt: now }, state: { ...state, records, revision: state.revision + 1, queueUpdatedAt: now }, summary: out };
}
