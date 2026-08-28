# /talent — the public bench

`gostaffify.com/talent` is **not built in this repo.** It is served from the
talent console (`staffify-talent-console`, Next.js + Supabase, deployed at
`recruiting.gostaffify.com`) and proxied onto this domain by the `rewrites`
block in `vercel.json`.

That is deliberate. The bench shows the same candidates the client landers
show, and the console is where those candidates, their test scores, their
English evaluations and their headshots already live. Rebuilding a second
profile store here would mean entering every candidate twice and watching the
two copies drift.

## What the rewrite covers

| Source | Why |
|---|---|
| `/talent`, `/talent/`, `/talent/:path*` | The bench itself |
| `/_next/:path*` | The console's JS and CSS. Safe because this site is plain static HTML and has no `/_next` of its own. **If this site ever adopts Next.js, this line breaks it.** |
| `/api/avatar` | Candidate headshot proxy |
| `/api/video-proxy` | Intro video proxy |

Canonical URLs on those pages point at `gostaffify.com/talent`, not the
recruiting subdomain, so the two hosts do not compete for the same page.
That is set by `NEXT_PUBLIC_BENCH_ORIGIN` in the console.

If the `/_next` proxying ever causes trouble, the alternative is a subdomain
(`talent.gostaffify.com` pointed straight at the console), which needs no
rewrites at all but puts the bench off the marketing domain.

## Where to actually work on it

Everything lives in `staffify-talent-console`:

- `src/app/talent/` — the public browse page and profile
- `src/app/(app)/bench/` — the recruiter manager
- `src/lib/domain/bench-listing.ts` — the visibility gate and the redaction allowlist
- `src/server/services/bench.ts` — assembly
- `supabase/migrations/0106_bench_listings.sql` — the publish gate

Read that repo's `CLAUDE.md` before changing any of it. Four rules there are
not up for refactoring: the allowlist, reserve-is-not-a-contact-unlock,
explicit recorded consent, and the 14-day availability decay.
