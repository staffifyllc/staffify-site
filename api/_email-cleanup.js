// The cleanup pass every rep email gets before it can be sent.
// ------------------------------------------------------------------
// Paul, 2026-10-27: "it should always take an ai pass at it and clean up any issues".
//
// Two layers. Claude proofreads (spelling, grammar, capitalization, clumsy phrasing, Paul's house
// rules) and says what it changed. Then the rules below run over its answer anyway, so the
// non-negotiables (no em dashes, a capital I, a capital at the start of every sentence) hold even
// when the model misses one. If Claude cannot be reached, the rules alone run and the rep is told.
//
// The model may not change what the rep is vouching for: every link, email address and phone
// number in the draft must come back exactly as written, or its answer is thrown away.
import Anthropic from '@anthropic-ai/sdk';

export const CLEANUP_MODEL = 'claude-opus-5-5';

const SCHEMA = {
    type: 'object',
    properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        changes: { type: 'array', items: { type: 'string' } },
    },
    required: ['subject', 'body', 'changes'],
    additionalProperties: false,
};

export const SYSTEM = `You proofread a short email that a Staffify sales rep wrote to a prospect, usually right after a phone call. Return the corrected subject and body, and a short list of what you changed.

Fix spelling, grammar, punctuation, capitalization, missing words, and clumsy phrasing that would confuse the reader.

Keep the rep's meaning, tone and voice. Keep every name, company, date, time, number, phone number, email address and link exactly as written. Keep the greeting, the sign-off, and the blank lines between paragraphs. Keep it about the same length or shorter. If the email is already fine, return it unchanged with an empty list of changes.

Never add a fact, claim, statistic, price, promise or name that is not already in the email. Do not add a signature; one is attached separately.

House rules, always applied:
- No em dashes, and no en dashes used as punctuation. Use a comma, a period, or a new sentence instead.
- The pronoun "I" is always a capital I, and every sentence starts with a capital letter.
- Plain words. Cut hype such as testament, crucial, pivotal, landscape, delve, robust, seamless, vibrant, game-changer, cutting-edge, unlock, elevate.
- No "it's not just X, it's Y" or "not X, but Y" constructions. Say the point directly.
- Never state how many clients Staffify has. If the email does, take that number out.
- A guarantee, if one is mentioned, is the "lifetime replacement guarantee", never a time-limited one.

Write each change as a few plain words a rep would understand, such as "Capitalized I" or "Fixed the spelling of receive". At most six.`;

// ---- the rules -------------------------------------------------------------------------------
const ABBREV = /(?:\b(?:a\.m|p\.m|e\.g|i\.e|etc|vs|approx|mr|mrs|ms|dr|st|no)\.)$/i;
const notWord = t => /^(?:https?:|www\.)/i.test(t) || /@/.test(t);

function capitalizeSentences(text) {
    // The first letter of each line ("hi Tom," / "thanks,"), unless the line is a link or an address.
    let t = text.replace(/^([ \t]*)([a-z])(\S*)/gm, (m, sp, c, rest) => (notWord(c + rest) ? m : sp + c.toUpperCase() + rest));
    // After a full stop, question mark or exclamation mark, unless it closed an abbreviation (10 a.m. on).
    t = t.replace(/([.!?]["”')]?[ \t]+)([a-z])(\S*)/g, (m, gap, c, rest, at, all) => {
        const before = all.slice(0, at + 1).trimEnd();
        return ABBREV.test(before) || notWord(c + rest) ? m : gap + c.toUpperCase() + rest;
    });
    return t;
}

/** Paul's non-negotiables, applied with no model at all. Returns the text and what changed. */
export function ruleClean({ subject, body }) {
    const changes = [];
    const run = (s, isSubject) => {
        let t = String(s || '');
        const dashed = t.replace(/[ \t]*—[ \t]*/g, ', ').replace(/[ \t]+–[ \t]+/g, ', ').replace(/, ([.,;:!?])/g, '$1');
        if (dashed !== t && !changes.includes('Replaced dashes')) changes.push('Replaced dashes');
        t = dashed;
        const eye = t.replace(/(^|[\s("“])i(?=$|[\s,.!?;:)"”]|['’](?:m|ll|ve|d)\b)/g, '$1I');
        if (eye !== t && !changes.includes('Capitalized I')) changes.push('Capitalized I');
        t = eye;
        const caps = isSubject ? t.replace(/^(\s*)([a-z])/, (m, sp, c) => sp + c.toUpperCase()) : capitalizeSentences(t);
        if (caps !== t && !changes.includes('Capitalized sentence starts')) changes.push('Capitalized sentence starts');
        t = caps;
        const spaced = t.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
        if (spaced !== t && !changes.includes('Removed extra spaces')) changes.push('Removed extra spaces');
        return spaced;
    };
    return { subject: run(subject, true).trim(), body: run(body, false).trim(), changes };
}

// ---- what the model may not touch ------------------------------------------------------------
const links = s => String(s).match(/https?:\/\/[^\s<>"')]+/gi) || [];
const addresses = s => String(s).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [];
const phones = s => (String(s).match(/\+?\d[\d\s().-]{6,}\d/g) || []).map(p => p.replace(/\D/g, '')).filter(d => d.length >= 7);

/** Why a cleaned version cannot be used, or null. */
export function aiProblem(before, after) {
    if (!after.subject || !after.body) return 'came back empty';
    if (/[\r\n]/.test(after.subject) || after.subject.length > 150 || after.body.length > 5000) return 'came back too long';
    if (after.body.length > Math.max(before.body.length * 1.5, before.body.length + 300)) return 'grew the email';
    const all = after.subject + '\n' + after.body;
    for (const l of links(before.subject + '\n' + before.body)) if (!all.includes(l)) return 'changed a link';
    for (const a of addresses(before.subject + '\n' + before.body)) if (!all.toLowerCase().includes(a)) return 'changed an email address';
    const kept = phones(all).join(' ');
    for (const p of phones(before.subject + '\n' + before.body)) if (!kept.includes(p)) return 'changed a phone number';
    return null;
}

const norm = ({ subject, body }) => ({ subject: String(subject || '').trim(), body: String(body || '').replace(/\r\n/g, '\n').trim() });

/**
 * One email through the pass. `client` is injectable for tests. Never throws: when the model is
 * unavailable the rules still run, and `by` says which happened.
 */
export async function cleanEmail(draft, { client = null, ai = true, timeoutMs = 25000 } = {}) {
    const before = norm(draft);
    const basic = ruleClean(before);
    const rulesOnly = note => ({ ...basic, by: 'rules', note });
    if (!ai) return rulesOnly('Only the basic fixes ran (dashes, capital I, sentence starts).');
    if (!client && !process.env.ANTHROPIC_API_KEY) return rulesOnly('The AI check is not set up on the server, so only the basic fixes ran (dashes, capital I, sentence starts).');
    try {
        const anthropic = client || new Anthropic({ timeout: timeoutMs, maxRetries: 1 });
        const response = await anthropic.beta.messages.create({
            model: CLEANUP_MODEL,
            max_tokens: 8000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
            system: SYSTEM,
            messages: [{ role: 'user', content: `<subject>${before.subject}</subject>\n<body>\n${before.body}\n</body>` }],
        });
        if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') throw Error('stopped: ' + response.stop_reason);
        const out = JSON.parse((response.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        const fixed = ruleClean(norm(out));
        const problem = aiProblem(before, fixed);
        if (problem) throw Error('the AI ' + problem);
        const unchanged = fixed.subject === before.subject && fixed.body === before.body;
        const said = (Array.isArray(out.changes) ? out.changes : []).map(c => String(c).trim()).filter(Boolean);
        const changes = unchanged ? [] : [...new Set([...said, ...fixed.changes])].slice(0, 6);
        return { subject: fixed.subject, body: fixed.body, changes: changes.length || unchanged ? changes : ['Tidied the wording'], by: 'ai' };
    } catch (e) {
        return { ...rulesOnly('The AI check could not run just now, so only the basic fixes ran (dashes, capital I, sentence starts).'), error: String((e && e.message) || e).slice(0, 140) };
    }
}
