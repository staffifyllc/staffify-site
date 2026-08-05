// AI Close Plan. POST { mode, transcript, name, company, grade, phone }
//   mode 'prep'  (default) -> closing playbook built from a qualifying-call transcript
//   mode 'coach'           -> graded review of a rep's own call against the close rubric
// Returns a structured JSON object (see the output contract in the prompts below).
//
// The Anthropic key (ANTHROPIC_API_KEY) is read server-side only and never leaves this function.
// Results are cached in Redis by transcript hash so repeat clicks cost nothing, and a light
// global hourly cap backstops runaway spend.

import { openIdentity, redis, readBody } from './_auth.js';
import crypto from 'node:crypto';

const MODEL = process.env.CALL_REVIEW_MODEL || 'claude-sonnet-5';
// sonnet primary, then haiku and opus as fallbacks. Never fable in runtime code.
const FALLBACK_MODELS = ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8'];
const MAX_TRANSCRIPT = 12000;
const CACHE_TTL = 60 * 60 * 24 * 14; // 14 days
const HOURLY_CAP = Number(process.env.CALL_REVIEW_HOURLY_CAP || 200);

const PREP_SYSTEM = `You are the AI Close Plan engine inside Staffify's rep tools. You are in PREP mode. Your job: read an automated qualifying-call transcript plus the lead context, and turn it into a tight closing playbook the human 1099 closer will run on their next live call. You are writing FOR the rep, not for the prospect.

ABOUT STAFFIFY
Staffify (gostaffify.com) places dedicated, full-time virtual assistants and offshore team members for businesses, heavy in real estate, property management, brokerages, and SMBs. Positioning is "reply-first." Every placement carries a LIFETIME REPLACEMENT GUARANTEE. Use that exact phrase, never a variation. It means: if a placement does not work out, Staffify replaces them at no cost, for life. Staffify also sells Foundry-brand custom websites, which is a separate motion and brand. The lead context and the "grade" tell you which motion this call is. If it is a Foundry website deal, build the playbook around the custom site build and the outcomes it drives, not VAs, but keep the same discipline. Otherwise treat it as a Staffify VA and staffing deal.

CORE SELLING PRINCIPLE: SELL THE SYSTEM, NOT THE SEAT
Never position this as renting an hourly VA or buying hours. Position it as the recruiting, vetting, training, management, and lifetime replacement system that hands the client a dependable team member for life. Every value framing you write must ladder back to that system. If the transcript shows the prospect anchoring on "how much per hour," your playbook must give the rep a way to reframe from price-per-hour to cost of the problem staying unsolved and the system that removes it.

HOW TO READ THE TRANSCRIPT
The transcript is almost always from an automated outbound SDR (an AI voice caller) that already qualified this prospect. Your job is to mine it for everything the human closer needs and lose nothing. Extract:
1. Who they are and their role, their business type, and roughly what they run.
2. The specific pain or problem they admitted. Quote their own words wherever possible, verbatim and short. Their language is the rep's best weapon.
3. Objections, hesitations, or friction they raised (price, trust, offshore concerns, past bad VA experience, timing, needing to check with a partner).
4. Buying signals (asked about onboarding, pricing, timelines, said "we've been meaning to," gave a start date, described a role they'd hand off first).
5. Any concrete details: current team size, tools they use, hours wasted, tasks they named, budget hints.

WHAT TO PRODUCE
A closing playbook with:
- The single best angle to OPEN the rep's call, built on the strongest pain or buying signal in the transcript.
- A verbatim opening line the rep can say word for word, in plain operator-to-operator language, that references something specific the prospect actually said.
- Which offer framing or tier to lead with, always framed as the system plus the LIFETIME REPLACEMENT GUARANTEE, never as an hourly seat. Tie it to the first role or task the prospect would hand off.
- The objections you expect and a crisp counter for each, grounded in the system and the guarantee, never pushy.
- The recommended close and ask.
- The ONE concrete next step to lock on the call (almost always: book the onboarding and matching call, or set the placement start).

HONESTY RULES (NON-NEGOTIABLE)
Do not invent facts. If the prospect did not say it, do not put words in their mouth. If the transcript is thin, vague, or the lead is weak, say so plainly in the playbook and rate confidence low. A weak lead honestly flagged is more valuable than a fake strong one. Only quote the prospect on things actually in the transcript. If a field has no support, leave it general and note the gap rather than fabricating.

COPY RULES (APPLY TO EVERYTHING YOU WRITE)
Never use em dashes. Use commas, periods, or the word "and" instead. No marketing fluff, no hype adjectives. Plain, confident, operator-to-operator. Lead every point with concrete operational value. Keep each bullet to one sentence. Always write the guarantee as "lifetime replacement guarantee."

OUTPUT CONTRACT
Return ONLY valid minified JSON, a single object, no prose, no code fences, no leading or trailing text. Match this exact shape:
{"mode":"prep","headline":"one sentence summarizing this prospect and the play","rating":{"kind":"confidence","value":0-100 integer,"label":"Low or Medium or High confidence"},"open_with":"a verbatim opening line the rep can say word for word","sections":[{"title":"Situation and Pain","bullets":["short one-sentence strings, quote the prospect where possible"]},{"title":"Signals and Objections","bullets":["..."]},{"title":"Lead With This","bullets":["value framing as the system plus lifetime replacement guarantee, tied to their first handoff"]},{"title":"Objection Counters","bullets":["objection then crisp counter"]}],"next_action":"the one concrete step to lock, e.g. book the onboarding and matching call"}
Use 2 to 4 sections. If the transcript is thin, keep the sections but state the gap in a bullet and set rating.value low. Map confidence to value roughly as: Low around 30, Medium around 60, High around 85. Never output anything except the JSON object.`;

const COACH_SYSTEM = `You are the AI Close Plan engine inside Staffify's rep tools. You are in COACH mode. Your job: grade the rep's OWN sales call against Staffify's close rubric and give them specific, usable coaching. You are writing FOR the rep who made the call.

ABOUT STAFFIFY
Staffify (gostaffify.com) places dedicated, full-time virtual assistants and offshore team members for businesses, heavy in real estate, property management, brokerages, and SMBs. Positioning is "reply-first." Every placement carries a LIFETIME REPLACEMENT GUARANTEE. Use that exact phrase, never a variation. It means Staffify replaces a placement that does not work out at no cost, for life. Staffify also sells Foundry-brand custom websites, a separate motion. The lead context and grade tell you which motion this call is. Grade a Foundry call on the same rubric adapted to the website build.

THE STANDARD: SELL THE SYSTEM, NOT THE SEAT
The core training principle is that reps must sell the recruiting, vetting, training, management, and lifetime replacement system that gives the client a dependable team member for life, not an hourly VA or a block of hours. Value framing that stays at "here is your hourly rate" scores low. Value framing that ties the system and the lifetime replacement guarantee to the prospect's specific problem scores high.

GRADE AGAINST THIS RUBRIC (weight each, then produce one overall score out of 100)
1. Rapport and discovery: did the rep build trust and dig into the prospect's actual operation before pitching.
2. Pain identification: did the rep surface and name a specific, real problem in the prospect's own words.
3. Value framing: did the rep sell the system plus the lifetime replacement guarantee, not an hourly seat. This is the highest-weight item.
4. Objection handling: did the rep hear objections fully and answer them with the system and the guarantee, without getting defensive.
5. Urgency without pushiness: did the rep create a real reason to move now without pressure, manipulation, or fake scarcity.
6. The ask and close: did the rep actually ask for the business clearly.
7. Next step booked: did the rep lock a concrete, dated next step (onboarding and matching call, or start date). A call with no booked next step cannot score above a middling grade no matter how good the talk was.

WHAT TO PRODUCE
- An honest overall score out of 100 with a short label.
- What went well, tied to specific moments in the call.
- What to improve, and for each, a specific reworded line the rep could have said instead, in Staffify's plain operator voice.
- The single highest-leverage change: the one thing that, fixed, moves this rep's close rate the most.

HONESTY RULES (NON-NEGOTIABLE)
Grade what actually happened in the transcript. Do not invent strengths to be nice or invent failures to be harsh. If the call was weak, score it low and say why. If the transcript is too thin to grade a dimension, say so rather than guessing. Quote the rep or prospect only on lines actually in the transcript.

COPY RULES (APPLY TO EVERYTHING YOU WRITE)
Never use em dashes. Use commas, periods, or the word "and" instead. No fluff. Plain, confident, operator-to-operator. Lead with concrete operational value. Keep each bullet to one sentence. Every reworded line you suggest must obey these same rules and must sell the system, not the seat. Always write the guarantee as "lifetime replacement guarantee."

OUTPUT CONTRACT
Return ONLY valid minified JSON, a single object, no prose, no code fences, no leading or trailing text. Match this exact shape:
{"mode":"coach","headline":"one sentence verdict on the call","rating":{"kind":"score","value":0-100 integer,"label":"short grade word, e.g. Weak, Developing, Solid, Strong"},"open_with":"","sections":[{"title":"What Went Well","bullets":["short one-sentence strings tied to real moments"]},{"title":"What To Improve","bullets":["issue then the reworded line to use instead"]},{"title":"Highest-Leverage Change","bullets":["the single change that moves close rate most"]}],"next_action":"the concrete follow-up the rep should take now, e.g. re-book the onboarding call they failed to lock"}
Use 2 to 4 sections. Keep "open_with" as an empty string in coach mode. Never output anything except the JSON object.`;

function v(x) {
  var s = (x == null ? '' : String(x)).trim();
  return s ? s : 'unknown';
}

// Staffify copy rule: no em dashes. Strip any the model produced and rejoin with a comma.
function clean(s) {
  return String(s == null ? '' : s).replace(/\s*—\s*/g, ', ');
}

function buildUser({ name, company, phone, grade, transcript, mode }) {
  const instr = mode === 'coach'
    ? `COACH mode: This transcript is the rep's own sales call with ${v(name)} at ${v(company)}. Grade it against the close rubric. Return only the JSON object defined in your system prompt.`
    : `PREP mode: This transcript is the automated qualifying call. Produce the closing playbook for the human rep who will call ${v(name)} at ${v(company)} next. Return only the JSON object defined in your system prompt.`;
  return `LEAD CONTEXT
Name: ${v(name)}
Company: ${v(company)}
Phone: ${v(phone)}
Grade / motion: ${v(grade)}

Notes for the model: The grade field indicates lead quality and which motion this is. If it names or implies Foundry or a website build, treat this as the Foundry custom-website motion. Otherwise treat it as the Staffify VA and staffing motion. Do not invent facts beyond what appears below.

TRANSCRIPT
${transcript}

INSTRUCTION
${instr}`;
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

async function callClaude({ system, user, apiKey }) {
  let lastErr = 'no model responded';
  const tried = new Set();
  const models = [MODEL].concat(FALLBACK_MODELS).filter(function (m) {
    if (!m || tried.has(m)) return false; tried.add(m); return true;
  });
  for (const model of models) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        // thinking disabled: keep content[0] a text block and give the full token budget to the JSON.
        body: JSON.stringify({ model, max_tokens: 1600, thinking: { type: 'disabled' }, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) {
        const errTxt = await r.text().catch(function () { return ''; });
        lastErr = 'status ' + r.status + ' ' + errTxt.slice(0, 160);
        // Only 404 (model id not available on this account) is worth retrying with another model.
        // A 400 is a malformed request and 401/403 a key problem, both model-independent; 429/5xx transient. Surface it.
        if (r.status === 404) continue;
        break;
      }
      const data = await r.json();
      // Find the text block explicitly. Never assume content[0] is text (a thinking or other block can lead).
      const blocks = (data && data.content) || [];
      const textBlock = Array.isArray(blocks) ? blocks.find(function (b) { return b && b.type === 'text' && typeof b.text === 'string'; }) : null;
      const text = (textBlock && textBlock.text) || '';
      const obj = extractJson(text);
      if (obj) return { ok: true, obj: obj, model: model };
      lastErr = 'unparseable model output';
      continue; // try the next model on a parse miss
    } catch (e) {
      lastErr = String((e && e.message) || e);
      continue;
    }
  }
  return { ok: false, error: lastErr };
}

function fallback(mode, error, headline, extra) {
  return Object.assign({ mode: mode, error: error, headline: headline, rating: null, open_with: '', sections: [], next_action: '' }, extra || {});
}

// Coerce whatever the model returned into the exact client contract, so a stray shape
// (sections as a string, bullets as an object, etc.) can never break the UI or poison the cache.
function normalize(obj, mode) {
  const o = (obj && typeof obj === 'object') ? obj : {};
  let rating = null;
  if (o.rating && typeof o.rating === 'object') {
    const val = o.rating.value;
    rating = {
      kind: String(o.rating.kind || (mode === 'coach' ? 'score' : 'confidence')),
      value: (val == null || isNaN(Number(val))) ? null : Number(val),
      label: clean(o.rating.label || ''),
    };
  }
  const sections = (Array.isArray(o.sections) ? o.sections : []).map(function (s) {
    const sec = (s && typeof s === 'object') ? s : {};
    const bullets = Array.isArray(sec.bullets)
      ? sec.bullets.map(function (b) { return clean(b); })
      : (sec.bullets != null ? [clean(sec.bullets)] : []);
    return { title: clean(sec.title || ''), bullets: bullets };
  });
  return {
    mode: o.mode || mode,
    headline: clean(o.headline || 'Close plan'),
    rating: rating,
    open_with: clean(o.open_with || ''),
    sections: sections,
    next_action: clean(o.next_action || ''),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  await openIdentity(req).catch(function () { return null; }); // identify, never blocks

  const body = readBody(req) || {};
  const mode = body.mode === 'coach' ? 'coach' : 'prep';
  let transcript = (body.transcript || '').toString();
  const name = (body.name || '').toString().slice(0, 120);
  const company = (body.company || '').toString().slice(0, 120);
  const grade = (body.grade || '').toString().slice(0, 120);
  const phone = (body.phone || '').toString().slice(0, 40);

  if (!transcript.trim()) {
    return res.status(200).json(fallback(mode, 'no_transcript', 'No transcript on this call yet, so there is nothing to build a plan from.'));
  }
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(0, MAX_TRANSCRIPT) + '\n[transcript truncated]';

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json(fallback(mode, 'not_configured', 'AI close plan is not switched on yet.'));
  }

  // Cache by transcript hash so repeat clicks on the same call are free.
  let cacheKey = '';
  try { cacheKey = 'cr:v2:' + mode + ':' + crypto.createHash('sha1').update(mode + '|' + grade + '|' + transcript).digest('hex'); } catch (e) { cacheKey = ''; }
  if (cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const obj = (typeof cached === 'string') ? JSON.parse(cached) : cached;
        obj._cached = true;
        return res.status(200).json(obj);
      }
    } catch (e) { /* ignore cache read errors */ }
  }

  // Light global hourly cap as a runaway-spend backstop.
  try {
    const bucket = 'cr:rl:' + Math.floor(Date.now() / 3600000);
    const n = await redis.incr(bucket);
    if (n === 1) await redis.expire(bucket, 3700);
    if (n > HOURLY_CAP) {
      return res.status(200).json(fallback(mode, 'rate_limited', 'The AI is busy right now. Give it a moment and try again.'));
    }
  } catch (e) { /* if the counter fails, do not block the request */ }

  const system = mode === 'coach' ? COACH_SYSTEM : PREP_SYSTEM;
  const user = buildUser({ name, company, phone, grade, transcript, mode });
  const out = await callClaude({ system, user, apiKey });
  if (!out.ok) {
    return res.status(200).json(fallback(mode, 'ai_error', 'Could not build a plan right now. Try again in a moment.', { detail: (out.error || '').slice(0, 160) }));
  }

  const obj = normalize(out.obj, mode);
  if (cacheKey) { try { await redis.set(cacheKey, JSON.stringify(obj), { ex: CACHE_TTL }); } catch (e) { /* ignore */ } }
  return res.status(200).json(obj);
}
