# Calendly Webhook → Role-Tailored Case Study Emails

When someone books a discovery call, we now automatically send them a tailored "before our call" email based on which role they're exploring. The role is detected from the `utm_content` parameter we append to Calendly links on each role landing page.

Setup is one-time. ~10 minutes.

---

## What's already wired up

**Calendly links on role pages now carry a role tag:**

| Page | Calendly URL tail |
|---|---|
| `/editors/` and `/case-studies/flylisted/` | `?utm_content=editors` |
| `/admins/` | `?utm_content=admins` |
| `/csr/` | `?utm_content=csr` |
| `/campaigns/` | `?utm_content=sales` |
| Everywhere else (homepage, blog, about) | no tag → falls back to playbook email |

**The webhook handler** lives at `/api/calendly-webhook/`. It:

1. Verifies Calendly's HMAC-SHA-256 signature (rejects replays older than 5 min)
2. Reads `payload.tracking.utm_content` to detect the role
3. Sends the role-specific email via Resend
4. Stores the prospect in Upstash with `source: discovery-call-booked`
5. Is idempotent — same person + same role within 24h won't get the email twice

**Email maps:**
- `editors` → Flylisted case study link
- `admins` → Operator Trap blog + Delegation Matrix
- `csr` → First Employee vs. VA blog
- `sales` → Outbound stack overview + Operator Trap
- (no tag) → Operator's Playbook

---

## 1. Create the webhook in Calendly

In Calendly:

1. **Account → Integrations → API & Webhooks → Webhook subscriptions**
2. Click **Create New Webhook**
3. Fill in:
   - **URL:** `https://www.gostaffify.com/api/calendly-webhook/`
   - **Events:** check `invitee.created` (uncheck everything else)
   - **Scope:** Organization or User (either is fine — User is simpler)
4. Click **Create webhook subscription**
5. Calendly shows you a **Signing key** (one time, looks like a long random string starting with letters and numbers). **Copy it.**

If you miss the signing key, delete the webhook and recreate it.

## 2. Add the signing key to Vercel

Vercel → project **staffify-site** → **Settings → Environment Variables → Add New**:

- **Key:** `CALENDLY_WEBHOOK_SIGNING_KEY`
- **Value:** the signing key you just copied
- **Environments:** Production, Preview
- **Sensitive:** on

Hit **Save**. Then trigger a redeploy: **Deployments → latest → ⋯ → Redeploy** (uncheck "Use existing build cache" if Vercel asks).

## 3. Test it

Best test path:

1. Open https://www.gostaffify.com/editors/ in an incognito window
2. Click any "Book a Call" button — Calendly opens with `?utm_content=editors` in the URL
3. Book a test slot using a real email you can check
4. Within ~5 seconds you should get the Flylisted case study email
5. Cancel the test booking in Calendly

If the email doesn't arrive, check **Vercel → staffify-site → Logs → Functions → /api/calendly-webhook** for the failure reason.

---

## Pulling who has booked

The same admin endpoint that powers the subscriber export works here. Bookings show up with `source: discovery-call-booked` and a `role` field:

```bash
curl "https://www.gostaffify.com/api/subscribers/?token=YOUR_ADMIN_TOKEN" | jq '.subscribers[] | select(.source == "discovery-call-booked")'
```

There's also a separate per-prospect booking record at `discovery:{email}` in Upstash that includes the Calendly event name, scheduled start time, and the utm_content tag — useful if you want to build a "show all bookings this week" view later.

---

## Adding a new role

Want a new role (say `bookkeeping`)? Two edits:

1. In `api/calendly-webhook.js`:
   - Add the role to `normalizeRole()`
   - Add a template under `TEMPLATES`
2. On the new role landing page, append `?utm_content=bookkeeping` to the Calendly link

That's it. Deploy and it works.

## Adding a real case study email

When you have a real case study for a role (admins, CSR, etc.), edit the `TEMPLATES` block in `api/calendly-webhook.js` to swap the blog-post link for the case study link.
