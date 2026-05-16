# Client Logo Outreach Email

Copy this email and send from your inbox to each client in `CLIENT_LOGO_TRACKING.md` whose status is `⏳ pending`. Personalize the `{First Name}` placeholder.

---

**Subject:** Quick favor — got 2 minutes?

Hey {First Name},

Building out the new Staffify website and would love to feature you as a client. Mind sending me your logo as a PNG (ideally transparent background)?

Just reply to this email with the file attached. I'll get it up on the site within a few days.

Thanks for the help — appreciate you.

Paul

---

## Tips for the workflow

- **Send from your own inbox** (gmail / outlook / whatever you use for clients). Not a marketing tool — keeps it personal.
- **Tag each thread** in your email so you can find replies fast.
- **When a reply comes in with a logo attached:**
  1. Save the PNG to `/Users/paulchareth/Claude Code/staffify-site/assets/clients/<slug>.png` (slug from the tracking sheet)
  2. Run `python3 scripts/rebuild_marquee.py` to regenerate the marquee HTML
  3. Commit + push: `git add -A && git commit -m "Marquee: add <client> logo" && git push`
  4. Update their status to `✅ uploaded` in `CLIENT_LOGO_TRACKING.md`

## If a client sends a logo with a white background

The marquee shows logos on a white tile, so a logo with a white background blends in fine. But if a logo has a colored or transparent edge that clashes, run:

```bash
sips --resampleHeight 200 assets/clients/<slug>.png
```

To resize and standardize.

## Batch-send templates

If you want to send 48 of these, use mail merge in Gmail (free with extensions like Gmass / YAMM) or paste into Loops / Mixmax / your CRM. Each email needs the recipient's name + their email; the body is identical.
