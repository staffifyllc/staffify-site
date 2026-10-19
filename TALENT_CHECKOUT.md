# Stripe talent onboarding checkout

October 19 authorization: paid onboarding BEFORE interviews and hiring. Standard USD 2,499; first online checkout USD 2,099. One hiring search, not a fee per shortlisted candidate. No recurring staffing charges at checkout.

## Offer definition shown to the buyer
First checkout attached to email/browser, valid within that session for up to 24 hours (Stripe's checkout lifetime), or until explicitly ended. Back from Stripe or refresh resumes the same immutable order. Ending/expiry forfeits the offer; subsequent checkout USD 2,499. Atomic Redis Lua reservation records both email hash and random browser ID. Clearing cookies cannot reset that email; this is not identity verification across unrelated email addresses. Technical retries use Stripe idempotency and never create a new discounted order.

## Secure configuration — never paste keys into chat or source control
Vercel project staffify-site:
- STRIPE_SECRET_KEY: Stripe server secret, test key during testing, live key only after verification.
- STRIPE_TALENT_WEBHOOK_SECRET: signing secret for this endpoint in the same Stripe account/mode.
- TALENT_CHECKOUT_ENABLED: `true` only once the matching credentials, webhook and test verification are complete.
Webhook URL: https://www.gostaffify.com/api/talent-stripe-webhook/
Events: checkout.session.completed, checkout.session.async_payment_succeeded.
Stripe business settings need the public service/checkout terms URL. Card-only one-time hosted Checkout.
No publishable key required: browser receives only Stripe-hosted checkout URL.

Until configured, production displays 'Online payment is being connected' and keeps the payment action disabled. The old talent interview intake source returns 402; no free interview bypass is presented. Public browsing remains available.

## Evidence and fulfillment
Success URL is not proof. Server retrieves Checkout Session with expanded PaymentIntent/latest charge, matches order/session IDs, USD amount, paid/complete state, succeeded received amount, mode and unrefunded/undisputed charge. Signed webhook validates raw payload and five-minute timestamp tolerance and rereads Stripe. Live paid orders enter the existing authenticated sales lead queue, source talent-marketplace-paid. Deterministic lead ID and hsetnx preserve staff edits on retries. Payment evidence is stored separately under talent:paid; neither won nor booked nor hired is inferred.

Test payments never create live leads or staff alerts. Real Stripe test mode has NOT been exercised until keys are supplied. Validate discounted first checkout, refresh, standard-price next checkout after explicit cancel, cleared-cookie same-email eligibility, decline, asynchronous retry, return without payment, webhook replay/signature rejection, and paid receipt in TEST mode. Only then activate live credentials. Do not create real charges for verification.

No accounting rewrite or QuickBooks payment verification changes. Stripe receipts are separate evidence; reconcile them in accounting rather than pretending they are QBO payments. Refund/dispute handling remains with staff in Stripe; this flow checks those states before initial fulfillment but does not reverse an already-arranged interview or placement automatically.
