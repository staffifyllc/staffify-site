# staffify-site

Marketing site and serverless backend for gostaffify.com. Staffify places vetted
overseas staff (Philippines, LATAM, South Africa) into US service businesses and acts as
the employer of record — payroll, compliance, HR, replacement. We are an implementation
partner, not a recruiter, and the copy should never make us sound like a job board.

## Stack

Plain static HTML, one `index.html` per route directory. **No framework, no build step.**
Styles are inlined per page in a `<style>` block. Deployed on Vercel with `cleanUrls` and
`trailingSlash`.

- `/api/*.js` — Vercel serverless functions, Node ESM. Files prefixed `_` are shared
  helpers and are not routed as endpoints.
- Datastore is **Upstash Redis** via `@upstash/redis`, imported from `api/_auth.js`.
  There is no SQL database behind the site.
- `api/_auth.js` — sessions, `adminAuthorized()`, `readBody()`, `redis`, `newToken()`.
- `api/_slack.js` — `slackNotify()`.
- Auth for admin endpoints is a bearer token: `ADMIN_TOKEN`, `CRON_SECRET`, or `HUB_TOKEN`.
- Inbound leads land in the Redis sorted set `leads:by_date` and reps work them in
  `/campaigns/`. Anything that captures a lead should go to that same queue.

`staffify-dashboard` (separate repo, FastAPI + SQLite + Hubstaff sync) is the internal
payroll and roster console. It holds *placed* staff, not candidates. Don't confuse it
with the bench.

## Design system

Dark. Black ground, `Inter`, cyan-to-blue gradient as the single accent.

```
--c: #1abde1  --c2: #0fa3c5  --c3: #0d82b8  --c4: #1456a4
--card: #0d0d0d  --muted: #a1a1a6  --subtle: #6e6e73  --mid: #3a3a3c
--divider: rgba(255,255,255,.07)  --divider2: rgba(255,255,255,.12)
--grad: linear-gradient(105deg, #1abde1 0%, #0fa3c5 25%, #0d82b8 55%, #1456a4 100%)
```

Radial gradient washes on `body`, a masked dot grid on `body::before`, `.g` for gradient
text. New pages copy these tokens rather than importing — there is no shared stylesheet
beyond `assets/css/ux.css`.

## Voice

Concrete over clever. Say what a thing does, not how it feels. No motivational framing,
no "unlock your potential", no exclamation marks. Numbers where we have them. A button
says exactly what happens when you press it. See `staffify-marketing/staffify-voice-guide.md`.

---

# The Bench (branch: `bench`)

A browsable roster of pre-vetted candidates at `/bench/`. Buyers filter, read a profile,
and **reserve an interview**. Full detail in `BENCH.md`. Read it before changing bench code.

Currently `noindex` and unlinked from the nav. It ships when Paul says so.

## Why it exists

Staffify's growth problem is that every client is farmed one at a time. The bench turns
candidates we already sourced into a browsable conversion asset, so the sales motion
starts from "here are 87 people" instead of "book a call". It is a **conversion asset,
not an acquisition channel** — directories lost ground in Google's March 2026 core
update and "hire a virtual assistant" is only ~8,100 searches a month globally. Don't
build this expecting SEO to carry it.

The commercial model it supports: ~$1,995 one-time placement plus ~$199–249/seat/month
that keeps an open-ended replacement guarantee alive. The recurring fee is what funds the
guarantee; a lifetime guarantee on a one-time fee is actuarially unsound at 30%+ offshore
attrition.

## Four rules that are not up for refactoring

1. **`publicProfile()` in `api/_bench.js` is an allowlist.** Every field that may reach a
   browser is named there. Never add `last_name`, `email`, `phone`, `internal_notes`, or
   raw assessment data to it. If a new field is private, simply don't list it — the
   allowlist fails closed by design.

2. **Reserve is never a contact unlock.** Buyers get a scheduled interview, never
   contact details. The moment someone can pay to reach a candidate directly, the
   placement fee is gone and we're competing with OnlineJobs.ph at $69/month. If asked
   to add "unlock contact" or "message this candidate", push back and say why.

3. **Consent is explicit and recorded.** Seeding a profile does not make it public.
   `consent.granted_at` must be set through the admin, and the Philippine NPC has ruled
   implied consent is not consent. Colombia (Ley 1581) is stricter again. Never add a
   code path that publishes a profile without a recorded grant.

4. **Availability decays.** 14 days without re-confirmation and a profile hides itself
   (warns at 10). Do not raise `STALE_DAYS` to make the bench look fuller. A bench of
   ghosts is the documented failure mode for every reverse job board that died.

All four gates converge in `isPubliclyVisible()`. Keep them there — one function, one
place to audit.

## Working on it

```bash
node scripts/bench-preview.mjs     # localhost:8899/bench/ — no Redis, no deploy
node scripts/seed-bench.mjs --dry  # what a seed would write
```

`scripts/bench-seed-data.json` holds 12 demo profiles. Real inventory is the unplaced
shortlist candidates from past searches.

Files: `bench/index.html` (browse), `bench/admin/` (manage), `api/_bench.js` (schema +
gates), `api/bench.js` (public read), `api/bench-admin.js` (CRUD), `api/bench-reserve.js`
(reservation → `leads:by_date` + Slack).

## Open work, roughly in order

- Seed real candidates from past shortlists; record consent per person.
- Per-profile pages at `/bench/<slug>/` for when we do want indexing. Needs a build step
  or a Vercel rewrite — the site has neither today, so think before adding one.
- Video intro hosting. Currently just a URL field; unlisted links only.
- A weekly re-confirmation nudge (cron in `vercel.json` → Slack digest of Aging/Stale).
- Reserve → Calendly handoff so times are offered automatically.
- Instrument browse → reserve conversion so it can be compared against cold email → call.

## Repo hygiene

The git remote currently embeds a GitHub PAT in plaintext in `.git/config`. It should be
rotated and replaced with SSH or the `gh` credential helper. Don't copy that URL anywhere.
