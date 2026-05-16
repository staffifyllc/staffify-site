#!/usr/bin/env python3
"""
Staffify blog generator.

Pulls the next pending topic from blog/topics.json, calls Claude to draft a
long-form post, renders it into blog/<slug>/index.html using blog/_template.html,
and regenerates blog/index.html (the listing page).

Run locally:
    ANTHROPIC_API_KEY=sk-... python3 scripts/generate_post.py

In CI: the GitHub Actions workflow at .github/workflows/blog-publish.yml runs
this on a cron and commits the result.

Exit codes:
    0  generated a post
    2  no pending topics in the queue (nothing to do)
    1  any other failure
"""
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BLOG_DIR = REPO_ROOT / "blog"
TOPICS_FILE = BLOG_DIR / "topics.json"
TEMPLATE_FILE = BLOG_DIR / "_template.html"
INDEX_FILE = BLOG_DIR / "index.html"
INDEX_TEMPLATE = BLOG_DIR / "_index_template.html"

MODEL = "claude-opus-4-7"

SYSTEM_PROMPT = """You are a senior business writer for Staffify, a workforce-infrastructure company that places vetted full-time talent (video editors, executive admins, B2B lead gen) into service businesses.

Your audience: founder-operators of US service businesses doing $300K to $5M in annual revenue. They're smart, time-poor, skeptical of marketing fluff, and tired of generic "scale your business" advice.

Voice rules (HARD):
1. NO em dashes. Ever. Use periods, commas, or restructure. Em dashes scream AI.
2. Short sentences. Vary length. Don't open every paragraph with the same cadence.
3. Concrete over abstract. Numbers, specifics, real examples. No "in today's competitive landscape" filler.
4. Confident, not hyped. No "game-changing", "revolutionary", "the secret to". Operators see through it.
5. Useful first, persuasive second. The reader should leave with something they can apply this week. The pitch is implicit.
6. Write at a high school reading level for clarity. Smart people prefer simple language.
7. Never reference yourself as an AI. Write as a senior operator.
8. Never write a "conclusion" header. End with insight, not summary.

Format rules:
- Output JSON only. No prose around it.
- Keys: title, dek, body_html, tags
- title: 50 to 70 characters, SEO-friendly, must include the main keyword naturally
- dek: 140 to 180 characters, a single sharp sentence that makes the reader want to keep reading
- body_html: 1500 to 2200 words of clean HTML. Allowed tags: <p>, <h2>, <h3>, <ul>, <ol>, <li>, <blockquote>, <strong>, <em>, <a>, <hr>, <code>. NEVER use <h1> (that's the page title). Start with a strong opening paragraph (no header). Use 4 to 6 <h2> sections. Use lists sparingly.
- tags: array of 3 to 5 short topic tags

Do not output markdown code fences. Do not output explanation text. Output the raw JSON object only."""

# ────────────────────────────────────────────────────────────────────────────
# Topic queue
# ────────────────────────────────────────────────────────────────────────────
def load_topics():
    with open(TOPICS_FILE) as f:
        return json.load(f)

def save_topics(data):
    with open(TOPICS_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")

def next_pending(topics_data):
    for t in topics_data["topics"]:
        if t.get("status") == "pending":
            return t
    return None

# ────────────────────────────────────────────────────────────────────────────
# Claude call
# ────────────────────────────────────────────────────────────────────────────
def draft_post(topic):
    try:
        from anthropic import Anthropic
    except ImportError:
        print("ERROR: `anthropic` package not installed. Run: pip install anthropic", file=sys.stderr)
        sys.exit(1)

    client = Anthropic()
    user_prompt = f"""Write a blog post for Staffify.

TOPIC: {topic['title']}
INTENT: {topic['intent']}
TARGET KEYWORDS (use naturally, do not stuff): {", ".join(topic['keywords'])}
URL SLUG (for context only, do not include in output): {topic['slug']}

Output the raw JSON object now."""

    print(f"  → calling Claude ({MODEL})...", file=sys.stderr)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=8000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    raw = resp.content[0].text.strip()

    # Strip code fences if model added them despite instruction
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: Claude returned non-JSON.\nFirst 400 chars:\n{raw[:400]}", file=sys.stderr)
        raise

    required = {"title", "dek", "body_html", "tags"}
    missing = required - set(data.keys())
    if missing:
        raise ValueError(f"Claude response missing keys: {missing}")

    # Enforce voice rule: strip em dashes if any slipped through
    em_dash_count = data["body_html"].count("—") + data["title"].count("—") + data["dek"].count("—")
    if em_dash_count:
        print(f"  ⚠ stripping {em_dash_count} em-dash(es) Claude slipped in", file=sys.stderr)
        for k in ("title", "dek", "body_html"):
            data[k] = data[k].replace(" — ", ". ").replace("—", ", ")

    return data

# ────────────────────────────────────────────────────────────────────────────
# Render
# ────────────────────────────────────────────────────────────────────────────
def fill_template(template_str, mapping):
    out = template_str
    for k, v in mapping.items():
        out = out.replace("{{" + k + "}}", v)
    return out

def estimate_read_time(html_body):
    text = re.sub(r"<[^>]+>", " ", html_body)
    words = len(text.split())
    return max(2, round(words / 220))

def json_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")

def render_post(topic, drafted):
    template = TEMPLATE_FILE.read_text()
    now = datetime.now(timezone.utc)

    mapping = {
        "TITLE": drafted["title"],
        "TITLE_JSON": json_escape(drafted["title"]),
        "DESCRIPTION": drafted["dek"],
        "DESCRIPTION_JSON": json_escape(drafted["dek"]),
        "DEK": drafted["dek"],
        "SLUG": topic["slug"],
        "PUBLISHED_ISO": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "PUBLISHED_HUMAN": now.strftime("%B %-d, %Y") if sys.platform != "win32" else now.strftime("%B %#d, %Y"),
        "READ_TIME": str(estimate_read_time(drafted["body_html"])),
        "BODY_HTML": drafted["body_html"],
    }
    html = fill_template(template, mapping)

    post_dir = BLOG_DIR / topic["slug"]
    post_dir.mkdir(parents=True, exist_ok=True)
    (post_dir / "index.html").write_text(html)

    # Save a small metadata file alongside, used by the index regenerator
    meta = {
        "slug": topic["slug"],
        "title": drafted["title"],
        "dek": drafted["dek"],
        "tags": drafted["tags"],
        "read_time": estimate_read_time(drafted["body_html"]),
        "published_iso": mapping["PUBLISHED_ISO"],
        "published_human": mapping["PUBLISHED_HUMAN"],
    }
    (post_dir / "meta.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n")
    return meta

# ────────────────────────────────────────────────────────────────────────────
# Blog index regen
# ────────────────────────────────────────────────────────────────────────────
def regenerate_index():
    """Scan blog/*/meta.json and rewrite blog/index.html."""
    posts = []
    for meta_path in BLOG_DIR.glob("*/meta.json"):
        try:
            posts.append(json.loads(meta_path.read_text()))
        except Exception as e:
            print(f"  ⚠ skipping {meta_path}: {e}", file=sys.stderr)

    posts.sort(key=lambda p: p["published_iso"], reverse=True)

    cards = []
    for p in posts:
        tags_html = " ".join(f'<span class="post-tag">{t}</span>' for t in p.get("tags", [])[:3])
        cards.append(f'''        <a href="/blog/{p["slug"]}/" class="post-card">
            <div class="post-card-meta">
                <span>{p["published_human"]}</span>
                <span>·</span>
                <span>{p["read_time"]} min read</span>
            </div>
            <h2 class="post-card-title">{p["title"]}</h2>
            <p class="post-card-dek">{p["dek"]}</p>
            <div class="post-card-tags">{tags_html}</div>
            <span class="post-card-arrow">Read post →</span>
        </a>''')

    posts_html = "\n".join(cards) if cards else '<div class="empty-state"><p>New posts coming soon.</p></div>'

    template = INDEX_TEMPLATE.read_text()
    html = template.replace("{{POSTS_HTML}}", posts_html).replace("{{POST_COUNT}}", str(len(posts)))
    INDEX_FILE.write_text(html)
    print(f"  ✓ regenerated blog/index.html with {len(posts)} post(s)")

# ────────────────────────────────────────────────────────────────────────────
# Sitemap
# ────────────────────────────────────────────────────────────────────────────
def update_sitemap():
    sitemap_path = REPO_ROOT / "sitemap.xml"
    base = "https://www.gostaffify.com"
    urls = [
        f"{base}/", f"{base}/about/", f"{base}/editors/", f"{base}/admins/",
        f"{base}/campaigns/", f"{base}/academy/", f"{base}/blog/",
    ]
    for meta_path in sorted(BLOG_DIR.glob("*/meta.json")):
        m = json.loads(meta_path.read_text())
        urls.append(f"{base}/blog/{m['slug']}/")

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        lines.append(f"  <url><loc>{u}</loc></url>")
    lines.append("</urlset>\n")
    sitemap_path.write_text("\n".join(lines))
    print(f"  ✓ wrote sitemap.xml ({len(urls)} URLs)")

# ────────────────────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────────────────────
def main():
    data = load_topics()
    topic = next_pending(data)
    if not topic:
        print("No pending topics. Add more to blog/topics.json or set status=pending on existing ones.", file=sys.stderr)
        sys.exit(2)

    print(f"Generating: {topic['title']}", file=sys.stderr)
    print(f"  slug: {topic['slug']}", file=sys.stderr)

    drafted = draft_post(topic)
    meta = render_post(topic, drafted)
    print(f"  ✓ wrote blog/{topic['slug']}/index.html ({meta['read_time']} min read)")

    topic["status"] = "done"
    topic["published_iso"] = meta["published_iso"]
    save_topics(data)
    print(f"  ✓ marked topic done in topics.json")

    regenerate_index()
    update_sitemap()
    print(f"\nDone. Published: {meta['title']}")
    print(f"URL: https://www.gostaffify.com/blog/{topic['slug']}/")

if __name__ == "__main__":
    main()
