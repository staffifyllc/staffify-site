// Who has a card open right now, so two reps never call the same person at once.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "after that person's called, it should be removed from the database. Otherwise,
// it's going to be impossible to have multiple sales reps in here working at the same time. So
// really need to make sure that as he's going through these people, my numbers are also changing
// and going down too."
//
// The queue already hands a called prospect to whoever logged the outcome (callOwner), so it leaves
// everyone else's new pile. What it lacked was the minutes BEFORE an outcome: two reps open the
// same first card and both dial it, and nobody else's count moves until they reload. So:
//   open     a rep has the card on screen. Held for OPEN_MS, renewed while it stays open.
//   calling  they tapped Call now. Held for CALL_MS, long enough to talk and log it.
//   called   they saved an outcome. Shown for CALLED_MS so every open dialer drops it at once,
//            until the next full load reads the owner from the queue itself.
// The guard is one key per card taken with SET NX, so only one rep can hold it; an index hash lists
// the holds for the dialers polling every 30 seconds. A hold coordinates; it never blocks anyone
// from a card they own, and a hold store that cannot be read never stops a rep from calling.
export const OPEN_MS = 4 * 60000, CALL_MS = 15 * 60000, CALLED_MS = 12 * 3600e3;
export const HK = {
    one: id => 'staffify:call-hold:' + id,
    index: 'staffify:call-holds',
};
const TTL = { open: OPEN_MS, calling: CALL_MS, called: CALLED_MS };
const norm = e => String(e || '').trim().toLowerCase();
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const firstOf = n => String(n || '').trim().split(/\s+/)[0] || null;

/**
 * Take or renew a hold. `kind` is open, calling or called. Returns { ok:true, hold } or
 * { ok:false, heldBy } when somebody else has it.
 */
export async function takeHold(kv, id, rep, kind = 'open', now = Date.now()) {
    const ms = TTL[kind]; if (!ms || !id) return { ok: false, error: 'bad hold' };
    const me = norm(rep && rep.email);
    const hold = { id, by: me, name: firstOf(rep && rep.name) || me.split('@')[0], kind, at: new Date(now).toISOString(), until: new Date(now + ms).toISOString() };
    const ex = Math.ceil(ms / 1000);
    if (!await kv.set(HK.one(id), hold, { nx: true, ex })) {
        const cur = parse(await kv.get(HK.one(id)));
        if (cur && cur.by !== me && Date.parse(cur.until) > now) return { ok: false, heldBy: { name: cur.name, kind: cur.kind, until: cur.until } };
        // Mine already (or a stale record): renew it. A called card is never downgraded to open.
        if (cur && cur.by === me && cur.kind === 'called' && kind !== 'called') return { ok: true, hold: cur };
        await kv.set(HK.one(id), hold, { ex });
    }
    await kv.hset(HK.index, { [id]: JSON.stringify(hold) });
    return { ok: true, hold };
}

/** Let go of a card this rep had open. A called mark stays: the prospect has been called. */
export async function releaseHold(kv, id, rep) {
    const cur = parse(await kv.get(HK.one(id)));
    if (!cur || cur.by !== norm(rep && rep.email) || cur.kind === 'called') return { ok: true, released: false };
    await kv.del(HK.one(id));
    await kv.hdel(HK.index, id);
    return { ok: true, released: true };
}

/** Every live hold, by card id. Expired entries are dropped from the index as they are seen. */
export async function listHolds(kv, now = Date.now()) {
    const all = (await kv.hgetall(HK.index)) || {};
    const live = {}, dead = [];
    for (const [id, v] of Object.entries(all)) {
        const h = parse(v);
        if (h && Date.parse(h.until) > now) { live[id] = { by: h.by, name: h.name, kind: h.kind, until: h.until, ms: Date.parse(h.until) - now }; continue; }
        // A hold re-taken between this read and the delete must not be dropped: the card's own key decides.
        const cur = parse(await kv.get(HK.one(id)).catch(() => null));
        if (cur && Date.parse(cur.until) > now) { live[id] = { by: cur.by, name: cur.name, kind: cur.kind, until: cur.until, ms: Date.parse(cur.until) - now }; await kv.hset(HK.index, { [id]: JSON.stringify(cur) }).catch(() => {}); }
        else dead.push(id);
    }
    if (dead.length) await kv.hdel(HK.index, ...dead).catch(() => {});
    return live;
}

/** Is this card someone else's right now? For the dialer and its tests. */
export const heldByOther = (holds, id, me, now = Date.now()) => {
    const h = holds && holds[id];
    return !!h && norm(h.by) !== norm(me) && Date.parse(h.until) > now;
};
