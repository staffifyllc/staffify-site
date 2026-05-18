# Loops Email Marketing Setup

The email capture popup is live on the home page. To make it actually save emails and send the playbook, do these 4 steps in your Loops dashboard.

---

## 1. Create a Loops account

Sign up at https://loops.so. Free tier covers 1,000 contacts which is plenty to start.

## 2. Create the form

In Loops: **Forms → New Form → Newsletter Form**.

- Name: `Playbook Popup`
- After signup goes to: `audienceGroup = newsletter` (so you can segment later)

Once created, you'll see a **Form ID** (looks like `abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx`).

## 3. Paste the Form ID into the site

Open `index.html` and find this line near the bottom of the file (search for `LOOPS_FORM_ID`):

```js
var LOOPS_FORM_ID = 'REPLACE_WITH_YOUR_LOOPS_FORM_ID';
```

Replace `REPLACE_WITH_YOUR_LOOPS_FORM_ID` with your actual form ID. Commit and push.

```bash
git add index.html
git commit -m "Wire popup to Loops form"
git push
```

## 4. Set up the automation in Loops

This is the part that actually sends the playbook to anyone who signs up.

In Loops: **Loops (sidebar) → New Loop**

- **Trigger:** `Submitted form` → select the `Playbook Popup` form
- **Action:** `Send transactional email`
- **Email template:** create a new one called `Playbook Delivery`

### Email template content

**Subject:** Your Service Business Operator's Playbook is here

**Body:**

```
Hey,

Here's the playbook you signed up for — six chapters on the operational moves that separate the $300K service businesses from the $3M ones.

→ Read the Playbook: https://www.gostaffify.com/playbook/

Practical frameworks you can apply this week:
- The Bottleneck Audit (60-minute framework)
- The Delegation Matrix
- The Hiring Funnel that doesn't collapse
- Pricing Power for Service Businesses
- The 95% Retention System
- The Operations Layer Behind Every Hire

If any of it lands and you want to talk about putting it into practice in your business, my calendar is here:

https://calendly.com/go-staffify/discovery-call

— Paul
Founder, Staffify
```

You can wire a nurture sequence after this too (a 5-email follow-up over 2-3 weeks), but the first one is the minimum to ship.

---

## What the popup does

- **Auto-opens** 25 seconds into the visit (once per browser, won't re-show for 14 days if dismissed).
- **Exit-intent:** also opens when the cursor leaves the viewport upward on desktop.
- **Tracks dismissals + submissions** in localStorage so it doesn't pester.
- **Submits to Loops** via the public newsletter-form endpoint.
- **Falls back gracefully** if Loops is down (shows an error + email).

## What to do if the popup feels too aggressive

In `index.html`, adjust these values:

```js
var SHOW_AFTER_MS = 25000;     // delay before auto-open (default 25s)
var DISMISS_TTL_DAYS = 14;     // hide for N days after dismiss (default 14)
```
