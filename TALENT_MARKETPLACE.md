# Public talent collection

`/browse-talent/` is the public marketing collection. Do not use `/talent/`, which routes to the recruiting application.

Initial October 19, 2026 publication authorized by Paul: Hazel M. and Jedno P., from the two supplied real-estate-media candidate presentations. Public cards contain curated professional summaries, first name/last initial, photos and introductions. Client-specific lander URLs, client names, quotes, resumes, internal assessments and decision actions are intentionally not linked. Availability is not asserted; Staffify confirms it before arranging an interview.

The homepage section and footer link lead here. Role and free-text skill/tool filters run locally; raw search text and visitor contact details are not sent to analytics. Candidate details are HTML, readable without JavaScript. Current collection is curated, not a live Talent Console sync.

Interview requests POST to the existing `/api/intake/` endpoint, storing `source=talent-marketplace` and candidate identity in the lead `note`, indexed under `leads:by_date` for the sales queue. Slack notification is awaited. A saved request is not an interview booking or a hire. No client-specific lander decision is changed and no candidate is contacted automatically. Tests mock storage and Slack; do not create real test leads.

To add candidates: edit browse-talent/index.html with approved public details and current media; add matching ID/name to assets/js/talent-marketplace.js and the interview select. Keep role options consistent. To remove a candidate: remove the card, select option and JS ID together. Check actual availability before implying it. Do not automatically publish private recruiting records. Use WEBSITE_RELEASE.md for every release.

## October 19 paid-checkout update
The free interview form above is superseded by `/browse-talent/checkout/`. Candidate buttons now start onboarding. The old talent-marketplace intake source is rejected. See TALENT_CHECKOUT.md for prices, offer eligibility, required Stripe configuration and verified-payment fulfillment. No unpaid interview request is created by this new flow.
