// A small DOM for driving page scripts in Node.
// ------------------------------------------------------------------
// Enough of the real thing for the workspace scripts: a tree, text, attributes, classList and
// dataset, simple selectors (tag, #id, .class, [attr=value], descendant, comma), events with
// bubbling, and the few browser globals the scripts touch. append() returns undefined, as in the
// browser, because a chained append is exactly the bug this harness exists to catch.
export function makeDom({ href = 'https://www.gostaffify.com/dialer/' } = {}) {
    class ClassList {
        constructor(node) { this.node = node; }
        get list() { return (this.node.attrs.class || '').split(/\s+/).filter(Boolean); }
        set list(v) { this.node.attrs.class = v.join(' '); }
        add(...c) { this.list = [...new Set([...this.list, ...c])]; }
        remove(...c) { this.list = this.list.filter(x => !c.includes(x)); }
        contains(c) { return this.list.includes(c); }
        toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; on ? this.add(c) : this.remove(c); return on; }
    }
    class Node {
        constructor(tag) {
            this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {};
            this.classList = new ClassList(this); this.style = {}; this._text = ''; this.listeners = {}; this.hidden = false; this.disabled = false; this.value = '';
        }
        get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
        set textContent(v) { this._text = String(v); for (const c of this.children) c.parentNode = null; this.children = []; }
        get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = String(v); }
        get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = String(v); }
        get title() { return this.attrs.title || ''; } set title(v) { this.attrs.title = String(v); }
        get isConnected() { let n = this; while (n) { if (n === document.body) return true; n = n.parentNode; } return false; }
        _adopt(x) { const n = typeof x === 'string' ? document.createTextNode(x) : x; if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; return n; }
        append(...k) { for (const x of k) this.children.push(this._adopt(x)); }
        prepend(...k) { this.children.unshift(...k.map(x => this._adopt(x))); }
        appendChild(n) { this.append(n); return n; }
        insertBefore(n, ref) { const i = this.children.indexOf(ref); const a = this._adopt(n); if (i < 0) this.children.push(a); else this.children.splice(i, 0, a); return a; }
        removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentNode = null; return n; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        after(...k) { const p = this.parentNode; if (!p) return; let i = p.children.indexOf(this); for (const x of k) { const a = p._adopt(x); i = p.children.indexOf(this); p.children.splice(i + 1, 0, a); } }
        get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return i >= 0 ? p.children[i + 1] || null : null; }
        replaceWith(n) { const p = this.parentNode; if (!p) return; const i = p.children.indexOf(this); p.children[i] = p._adopt(n); this.parentNode = null; }
        replaceChildren(...k) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; this.append(...k); }
        setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
        addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); } removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
        dispatchEvent(ev) { ev.target ||= this; let n = this; while (n && !ev._stopped) { n._fire(ev); n = n.parentNode; } if (!ev._stopped) document._fire(ev); return !ev.defaultPrevented; }
        _fire(ev) { ev.currentTarget = this; for (const fn of this.listeners[ev.type] || []) fn(ev); const h = this['on' + ev.type]; if (h) h(ev); }
        click() { if (this.disabled) return; this.dispatchEvent(makeEvent('click')); }
        focus() { document.activeElement = this; } blur() {} scrollIntoView() {} select() {}
        contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
        closest(sel) { let n = this; while (n && n.tagName !== '#document') { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
        querySelector(sel) { return queryAll(this, sel)[0] || null; }
        querySelectorAll(sel) { return queryAll(this, sel); }
        get firstChild() { return this.children[0] || null; }
        get textNodes() { return this.children.filter(c => c.tagName === '#text'); }
    }
    const makeEvent = (type, props = {}) => ({ type, defaultPrevented: false, _stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stopped = true; }, bubbles: true, ...props });

    // ---- selectors -----------------------------------------------------------------------------
    function parseCompound(c) {
        const out = { tag: null, id: null, classes: [], attrs: [] };
        const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
        let m; while ((m = re.exec(c))) { if (m[1]) out.tag = m[1].toUpperCase(); else if (m[2]) out.id = m[2]; else if (m[3]) out.classes.push(m[3]); else out.attrs.push([m[4], m[5] === undefined ? null : m[5]]); }
        return out;
    }
    function matchCompound(n, c) {
        if (n.tagName === '#text') return false;
        if (c.tag && n.tagName !== c.tag) return false;
        if (c.id && n.id !== c.id) return false;
        for (const cl of c.classes) if (!n.classList.contains(cl)) return false;
        for (const [k, v] of c.attrs) { const dk = k.startsWith('data-') ? n.dataset[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] : undefined; const have = dk !== undefined ? dk : n.getAttribute(k); if (have === null || have === undefined) return false; if (v !== null && String(have) !== v) return false; }
        return true;
    }
    function matches(n, sel) {
        return sel.split(',').some(part => {
            const chain = part.trim().split(/\s+/).map(parseCompound);
            if (!matchCompound(n, chain[chain.length - 1])) return false;
            let i = chain.length - 2, p = n.parentNode;
            while (i >= 0 && p) { if (matchCompound(p, chain[i])) i--; p = p.parentNode; }
            return i < 0;
        });
    }
    function walk(n, out = []) { for (const c of n.children) { if (c.tagName !== '#text') { out.push(c); walk(c, out); } } return out; }
    function queryAll(root, sel) { return walk(root).filter(n => matches(n, sel)); }

    // ---- document and globals --------------------------------------------------------------------
    const document = new Node('#document');
    document.body = new Node('body'); document.body.parentNode = document;
    document.documentElement = new Node('html');
    document.head = new Node('head');
    document.children = [document.body];
    document.createElement = tag => new Node(tag);
    document.createElementNS = (_ns, tag) => new Node(tag);
    document.createTextNode = t => { const n = new Node('#text'); n._text = String(t); return n; };
    document.getElementById = id => walk(document.body).find(n => n.id === id) || null;
    document.querySelector = sel => queryAll(document.body, sel)[0] || null;
    document.querySelectorAll = sel => queryAll(document.body, sel);
    document.activeElement = document.body;
    document.hidden = false;
    document.dispatchEvent = ev => { ev.target ||= document.body; document._fire(ev); return true; };

    const storage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), clear: () => m.clear(), get size() { return m.size; } }; };
    const u = new URL(href);
    const location = { href: u.href, search: u.search, pathname: u.pathname, hostname: u.hostname, origin: u.origin };
    const g = {
        document, window: null, location, history: { replaceState(_s, _t, url) { const n = new URL(String(url)); location.href = n.href; location.search = n.search; } },
        sessionStorage: storage(), localStorage: storage(),
        navigator: { clipboard: { writeText: async () => {} } },
        confirm: () => true, prompt: () => null, alert: () => {},
    };
    const winListeners = {};
    g.window = Object.assign(Object.create(null), { confirm: (...a) => g.confirm(...a), prompt: (...a) => g.prompt(...a), alert: (...a) => g.alert(...a),
        addEventListener: (t, fn) => { (winListeners[t] ||= []).push(fn); }, removeEventListener: (t, fn) => { winListeners[t] = (winListeners[t] || []).filter(f => f !== fn); },
        dispatchEvent: ev => { for (const fn of winListeners[ev.type] || []) fn(ev); return true; } });
    return { ...g, Node, makeEvent, queryAll, text: n => n.textContent.replace(/\s+/g, ' ').trim() };
}

/** Install the fake on globalThis for one script, returning a function that restores what was there. */
export function install(dom) {
    const keys = ['document', 'window', 'location', 'history', 'sessionStorage', 'localStorage', 'navigator', 'confirm', 'prompt', 'alert'];
    const prior = new Map(keys.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    for (const k of keys) Object.defineProperty(globalThis, k, { value: dom[k], configurable: true, writable: true });
    return () => { for (const [k, d] of prior) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } };
}
