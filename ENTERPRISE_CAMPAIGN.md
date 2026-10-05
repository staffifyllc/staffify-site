# Enterprise account development V1

Private workspace: `/campaigns/enterprise/`.

## What is live

Two lanes, six initial accounts, source-linked buying-structure research, explicit unknowns, opportunity hypotheses, transparent research-priority scores, buying-group role maps, separate four-step sequence drafts, shared Paul/Madison ownership, research contact capture, next actions, capability profile and attributed activity notes. Data is stored under `staffify:enterprise-accounts:v1`, separate from the original outreach queue. No existing prospect is migrated.

A daily authenticated Vercel job at `/api/enterprise-review/` evaluates overdue actions and evidence older than 30 days. Its timestamps prove planning evaluation only. It does not refresh research, verify emails or send enterprise mail. The screen states this explicitly.

The original agency scheduler, sender, quotas, enrollment and call rules are unchanged. Its existing campaign-ID gate rejects enterprise records. The enterprise API cannot write to the agency datastore.

## Launch progression

1. Confirm Staffify's delivery countries, employment model, role coverage, real capacity/ramp, references, security/screening, insurance and commercial terms in the capability profile. No invented certifications, enterprise clients or savings claims.
2. Finish identifying 3–6 relevant named stakeholders per account. Role placeholders are not people. Do not guess contact addresses. Published supplier routing inboxes are intake routes, not verified individual contacts.
3. Verify selected business email via the existing verifier and establish one coordinated owner and one initial recipient per account. Research should identify the buyer's actual intake path, not merely an HR title.
4. Implement and validate an enterprise-specific Gmail sender/reply reconciler before activation. It must consult live global opt-outs, clients, human conversations, duplicate contact/domain enrollment and shared mailbox limits immediately before sending, with fail-closed checks and durable retry idempotency. No enterprise send endpoint exists in this V1.
5. Start with routing/fit questions for the six accounts. Separate Direct and Partner copy is stored in `_enterprise.js`; account-specific openers are in the account records. Intended cadence is 0/7/14/21 days from actual sends, max four account touches; do not simultaneously email the entire buying group. Any human reply pauses the account for a person. No automatic calling or generic agency-call enrollment.
6. Supplier profiles and registrations require accurate corporate representations. Registration is not approved status, an opportunity, a meeting or revenue. Bookings require provider evidence; approved-supplier status requires written confirmation. Keep outreach and revenue separate.

## Research priorities

KellyOCG publishes a dedicated prospective-supplier team. AGS has SupplySphere/Supplier Advocacy. Magnit publishes supplier criteria and intake. Pontoon documents supplier selection but the current intake owner remains unidentified. Capital One publishes an MSP-managed professional-services category and Beeline for contracting invoices; its current MSP identity is not confirmed here. JPMorganChase publishes contingent-worker controls and purchasing onboarding, but those purchasing systems must not be called its VMS.

Staffify service-fit statements and scores are analyst hypotheses, not proof of demand or purchase probability. Named leaders are supported by public sources; no personal mailbox is inferred. Initial sources were reviewed October 5, 2026. Follow source links in the private UI.

## Operations

API: `GET/POST /api/enterprise-accounts/`, existing authenticated Paul/Madison/admin access. Writes require same-site origin or machine authentication, revision checks and atomic compare-and-swap. Notes and ownership changes retain attribution. Contact entries are always unverified. Concurrent changes return 409 without overwriting.

Cron: daily at 12:15 UTC. Failures return a non-200 response; `lastReview` exposes successful execution time. There is no additional third-party paid API usage in this V1. No Slack delivery or autonomous research is claimed.

Tests include campaign separation, immutable prior state, source references, unsafe stages, duplicate/capped contacts, URL validation, stale-evidence reporting and the existing outreach regression suite. Re-verify existing routes, scheduler and mailbox health after deployment.

## Coordinated LinkedIn and email tasks

Added October 5: a single primary stakeholder per account, two manual LinkedIn tasks and four email drafts at planned days 0/3/10/14/21/28. Delayed completed touches push the next task out by at least three days. Starting a plan sends nothing. A contact requires a researched individual LinkedIn profile, validated against linkedin.com/in/ URLs. Connection acceptance is explicitly operator-reported; a follow-up LinkedIn message cannot be recorded before acceptance. Skipping a step requires a reason.

Each actual completion is recorded with operator, time, channel and message/reference. These are operator reports, not Gmail-verified sends; they do not modify original outreach counts. A reply, meeting, opt-out, client or human-owned conversation sets a persistent enterprise account stop across both task channels. Ordinary status editing cannot remove it. LinkedIn replies are not automatically read; the rep must log them here. Existing agency global suppression is not modified by this research/task workflow. Before enterprise sending is connected, the sender must integrate those shared controls as described above.

The daily cloud review also counts actionable engagement tasks. It schedules work, not browser actions, invitations or emails. Enterprise automatic email delivery and verified-contact enrichment are still incomplete.
