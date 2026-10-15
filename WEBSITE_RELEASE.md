# Staffify shared website workflow

Source of truth is `origin/main` in `staffifyllc/staffify-site`.
Shared local website checkout for BOTH Claude and Codex:
`/Users/paulchareth/Documents/Codex/2026-09-22/ca-x20/work/staffify-team-visuals`

Before edits: inspect status, fetch origin, then fast-forward or merge origin/main.
Never discard someone else's dirty files. One agent edits this shared checkout at a time;
if work is already underway, use a separate branch FROM current origin/main and merge
it back before release. Do not reconstruct a page from an old scratchpad or memory.

Before publishing, review the diff against current origin/main, run applicable checks,
and commit only the intended files. Run `python3 scripts/release-website.py` to check,
then `python3 scripts/release-website.py --publish` when publication is authorized.
It fetches current main, blocks dirty/outdated source, and pushes the exact commit
without force. If main changes during the push, Git rejects the stale push; fetch and
reconcile, do not force it. Vercel's main-branch Git integration performs production builds.
Verify the deployment is Ready, its public domain alias, and public source/rendering.

DO NOT run direct `vercel --prod`, promote old deployments, or publish from the old
finance-cloud branch. Direct CLI uploads caused the October 14 rollback. The Claude
hook blocks recognized direct Staffify production commands, but it is not a Vercel
account-level restriction; external tools and manually disabled hooks can bypass it.
Existing Claude sessions may need to restart/reload hooks. Do not claim otherwise.

Approved baseline: restored hero, professional-first 2.5 seconds per word, no pause
button or extra role/enterprise hero prompts, cyan outline/gold shield, desktop/mobile
nav Exec Admins / CSR / Video Editors / Sales / Teams & Enterprise (neutral styling),
one consolidated comparison, no public homepage onboarding price, and Rachael video.
Preserve the booking funnel, candidate video covers, client stories and SEO guidance.
