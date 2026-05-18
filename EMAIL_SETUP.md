# Native Email Setup (Resend + Upstash)

We don't use Mailchimp, Loops, or any marketing UI. The popup posts to our own Vercel serverless function (`/api/subscribe`), which:

1. Stores the email in **Upstash Redis** (key-value store we connect through Vercel — we own the data)
2. Sends the playbook delivery email through **Resend** (developer email API, no marketing UI)

Setup is one-time. ~20 minutes.

---

## 1. Connect Upstash Redis (free)

In Vercel: **Project → Storage → Create Database → KV (Upstash)**.

- Name: `staffify-emails`
- Region: same as your project (US East is fine)
- Plan: Free (10K commands/day — way more than you need)

Once created, Vercel automatically injects these env vars into the project:
- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- `KV_REST_API_READ_ONLY_TOKEN`
- `KV_URL`
- `REDIS_URL`

The `/api/subscribe` code uses `KV_REST_API_URL` and `KV_REST_API_TOKEN`. You don't need to copy/paste anything. Just hit **Connect**.

## 2. Set up Resend (free up to 3K emails/month)

1. Sign up at https://resend.com.
2. **Add domain** → enter `gostaffify.com`.
3. Resend gives you 3 DNS records (MX, TXT for SPF, TXT for DKIM). Add them in Cloudflare:
   - Cloudflare → gostaffify.com → DNS → Add record
   - Set proxy status to **DNS only** (gray cloud) for all three
4. Back in Resend, click **Verify**. Usually takes < 5 minutes.
5. **API Keys → Create API Key** → name it `staffify-site-prod`, full access, copy the key (starts with `re_...`).

## 3. Generate an admin token

This protects the `/api/subscribers` export endpoint so only you can pull the list. In your terminal:

```bash
openssl rand -hex 32
```

Copy the output. This is your `ADMIN_TOKEN`.

## 4. Set env vars in Vercel

Vercel project → **Settings → Environment Variables**. Add:

| Name | Value | Environments |
|---|---|---|
| `RESEND_API_KEY` | `re_...` (from step 2) | Production, Preview, Development |
| `FROM_EMAIL` | `Paul <paul@gostaffify.com>` | Production, Preview, Development |
| `ADMIN_TOKEN` | the hex string from step 3 | Production |

(`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` were auto-added in step 1.)

Save and redeploy the project (or just push a new commit — Vercel auto-redeploys).

## 5. Test

1. Visit https://www.gostaffify.com
2. Wait 25 seconds or trigger exit-intent
3. Submit a real email you can check
4. Within ~5 seconds the playbook email should arrive

If it doesn't show up, check **Vercel → your project → Logs → Functions** for errors.

---

## Pulling the subscriber list

Anytime. From the browser or curl:

```bash
# JSON
curl "https://www.gostaffify.com/api/subscribers?token=YOUR_ADMIN_TOKEN"

# CSV download
open "https://www.gostaffify.com/api/subscribers?token=YOUR_ADMIN_TOKEN&format=csv"
```

You can also browse them in the Upstash dashboard directly — every subscriber is stored at `subscriber:<email>` and chronologically in the sorted set `subscribers:by_date`.

## Sending future broadcasts

Two options for sending an update to the whole list:

**Option A — Quick blast script (best for occasional sends):**
Pull the CSV (above), then send a one-off Resend campaign via their API or dashboard ("Audiences" → import contacts → "Send broadcast").

**Option B — Nurture sequence as code:**
Add a Vercel cron (`vercel.json` with `crons`) that runs `/api/cron/nurture-day-3.js`, queries Redis for subscribers signed up exactly 3 days ago, and sends them the day-3 email via Resend. This is the path if you want a real drip without buying into a marketing platform.

Ask Claude for the nurture-sequence code when you're ready.

---

## What the popup does

- **Auto-opens** 25 seconds into the visit (once per browser, hidden for 14 days if dismissed).
- **Exit-intent:** also opens when the cursor leaves the viewport upward on desktop.
- **Tracks dismissals + submissions** in localStorage so it doesn't pester.
- **Honeypot field** silently rejects bots.
- **IP-based rate limit:** 10 signups per hour per IP.
- **Falls back gracefully** if the API errors (shows a fallback email address).

## What to do if the popup feels too aggressive

In `index.html`, adjust:

```js
var SHOW_AFTER_MS = 25000;     // delay before auto-open (default 25s)
var DISMISS_TTL_DAYS = 14;     // hide for N days after dismiss (default 14)
```
