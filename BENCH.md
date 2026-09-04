# The Bench

A browsable roster of pre-vetted candidates on gostaffify.com. Buyers filter, read a
profile, and **reserve an interview** — they never get contact details. Staffify still
makes the offer, employs the person, and runs payroll. The browse layer replaces the
shortlist email; it does not replace the business model.

Built as a product line inside the existing site: same stack, same design system, same
lead queue. Lives on the `bench` branch and is `noindex` until you say otherwise.

## Look at it right now

```bash
node scripts/bench-preview.mjs
open http://localhost:8899/bench/
```

No Redis, no Vercel, no deploy. 12 demo profiles from `scripts/bench-seed-data.json`.
Reserve submissions print to the terminal.

## Files

| Path | What it does |
|---|---|
| `bench/index.html` | Public browse page — filters, cards, detail drawer, reserve flow |
| `bench/admin/` | Internal manager — add people, record consent, confirm availability |
| `api/_bench.js` | Schema, the public allowlist, consent + freshness gates |
| `api/bench.js` | Public read. Unauthenticated, redacted |
| `api/bench-admin.js` | Admin CRUD. Needs `ADMIN_TOKEN` / `CRON_SECRET` / `HUB_TOKEN` |
| `api/bench-reserve.js` | Interview reservation → `leads:by_date` + Slack |
| `scripts/seed-bench.mjs` | Seed Redis from the JSON fixture |
| `scripts/bench-preview.mjs` | Local preview server |

## The three gates

A profile is invisible to the public unless **all three** pass. They are enforced in
one place, `isPubliclyVisible()` in `api/_bench.js`.

1. **Availability** is `available`.
2. **Consent** has been recorded and not withdrawn. The Philippine NPC has ruled that
   implied consent is not consent, so seeding a profile does not make it public —
   somebody records the grant in `/bench/admin/`. Colombia is stricter again.
3. **Freshness.** Someone confirmed availability within 14 days. This is the operational
   one: availability has a shelf life measured in weeks, and a bench full of ghosts is
   how these directories die. Profiles warn at 10 days and hide themselves at 14.

Redaction is separate and stricter: `publicProfile()` is an **allowlist**. Surname,
email, phone, internal notes and raw assessment data have no path to a browser. Adding a
private field to the schema does not leak it; adding it to the allowlist does. Don't.

## Weekly operating rhythm

Open `/bench/admin/`. Anything showing **Aging** or **Stale** needs a message to that
person asking if they're still looking. Press **Confirm** when they reply. That is the
entire maintenance job and it is the difference between this working and this rotting.

## Seeding it with real people

The demo profiles are placeholders. The real seed is the shortlists you already ran:
every past search produced four or five vetted candidates who didn't get placed. Those
people are the inventory.

```bash
vercel env pull .env.local          # gets KV_REST_API_URL / KV_REST_API_TOKEN
node scripts/seed-bench.mjs --dry   # check what would land
node scripts/seed-bench.mjs
```

Then in `/bench/admin/`: record consent per person, press Confirm, and they go live.

## Going live

1. Merge `bench` into `main`.
2. Remove the two `noindex` lines from `bench/index.html` and `bench/admin/index.html`.
3. Add `/bench/` to the nav in the page templates.
4. Swap the CTA in the outbound sequences from "book a call" to "browse 87 pre-vetted VAs".

Step 4 is the actual test. Measure browse → reserve against cold email → call.

## What this is not

Not a contact unlock, and it must never become one. The moment a buyer can pay to get
someone's email, the placement fee is gone and you are competing with OnlineJobs.ph at
$69/month. The reserve flow keeps Staffify in the middle. That is the whole design.
