#!/usr/bin/env python3
"""
One-time seeder: writes a hand-crafted sample post for the first topic so
the blog has something visible before the Claude-driven cron runs.

Pulls render_post / regenerate_index / update_sitemap from generate_post.py
so the output is byte-identical to what the cron will produce.

Run once:
    python3 scripts/seed_first_post.py

Then delete this file. The cron handles every subsequent post.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate_post import (
    load_topics, save_topics, next_pending,
    render_post, regenerate_index, update_sitemap,
)

DRAFT = {
    "title": "First Employee Or First VA? The Decision Framework Most Service Businesses Get Wrong",
    "dek": "Most owners default to the wrong answer. Here's the four-question test that tells you which one your business actually needs, and the trap that catches almost everyone.",
    "tags": ["hiring", "operations", "delegation"],
    "body_html": """<p>You hit the moment every service business hits. The phone keeps ringing. The work keeps coming. And you're working sixty hours a week to keep up with thirty hours of actual revenue-generating output. Everyone tells you the same thing. You need help.</p>

<p>So you start asking around. Half the people say hire a VA. Cheap, fast, no commitment. The other half say no, hire a real employee. Quality matters. Don't cut corners. Both groups sound certain. Both groups are wrong about half the time.</p>

<p>The honest answer is that it depends on four things, none of which most owners think about before they start interviewing. I'll walk you through them. By the end you'll know which path actually fits your business, and you'll spot the trap that catches almost everyone who picks the wrong one.</p>

<h2>The four-question test</h2>

<p>Forget what you've read about VAs versus employees. Before you choose, answer these four questions honestly. No directional answers. Numbers and specifics.</p>

<p><strong>1. How much of the work you'd hand off is process-based versus judgment-based?</strong></p>

<p>Process-based work is everything that has a right answer if you follow the steps. Sending a contract. Setting up a calendar invite. Cleaning data in a CRM. Following up on an invoice. If you can write down the steps in under thirty minutes, it's process-based.</p>

<p>Judgment-based work is everything else. Talking to a confused client. Deciding which leads to prioritize. Writing a proposal that doesn't sound like every other proposal. Diagnosing why a project is stuck. If the right answer changes based on context, it's judgment.</p>

<p>Most owners overestimate how much of their work is judgment-based. Audit your last two weeks. Be honest. If 70% or more of what you'd hand off is process, a VA is almost always the right answer.</p>

<p><strong>2. How standardized is your current operation?</strong></p>

<p>Hiring solves a workload problem. It does not solve a process problem. If your business runs on tribal knowledge in your head, hiring anyone, employee or VA, will multiply the chaos, not reduce it. The new person has to ask you fifty questions to do anything. Now you're managing them instead of doing the work yourself, and the work is still not getting done.</p>

<p>If you don't have basic SOPs for the work you'd hand off, you have a process problem disguised as a hiring problem. Fix the process first. A trained VA following a clear SOP outperforms a smart employee guessing.</p>

<p><strong>3. How much of the role lives in client-facing communication?</strong></p>

<p>If the role is 50% or more direct client communication, the cultural and language fluency bar goes up a lot. That doesn't mean it has to be a US employee. It means you need to be more rigorous about vetting. The top tier of offshore talent communicates better than the bottom half of US candidates. The bottom half of offshore talent will burn client trust faster than you can recover it.</p>

<p>The real question isn't location. It's vetting depth. Most cheap VA arrangements skip the vetting that makes client-facing work safe.</p>

<p><strong>4. What's your effective hourly rate?</strong></p>

<p>Take your last twelve months of profit. Divide by the hours you personally worked. That's your effective hourly rate. If it's $80, anything you're doing that someone else could do for $25 is costing you $55 every hour you do it. The math doesn't lie. It just hurts.</p>

<p>The owners who delay hiring the longest are usually the ones with the highest effective hourly rate, because they can grind it out. They're also the ones who plateau first. There's a ceiling on what one person can do, and you don't get to skip it by working harder.</p>

<h2>The trap almost everyone falls into</h2>

<p>Here's the pattern. Owner hires a VA from a marketplace. Pays $5 an hour. Three weeks in, the VA is juggling four other clients to make rent and dropping balls on all of them. Owner concludes "VAs don't work" and swings to the opposite extreme. Hires a US employee at $55K plus benefits, plus payroll tax, plus a desk, plus equipment, plus the management overhead they didn't anticipate.</p>

<p>Six months later they're cash-strained, the employee turned out to need more training than they expected, and they're back to working sixty hours a week. Now with an extra mouth to feed.</p>

<p>The trap is treating it as a binary. Cheap VA versus real employee. It isn't binary. It's a quality spectrum, and the price-to-performance curve looks nothing like what most owners assume.</p>

<blockquote>The best offshore talent at fair wages outperforms the middle of the US labor market at three times the cost. The worst offshore talent at $5 an hour destroys client relationships faster than you can fix them. The variable is rigor, not geography.</blockquote>

<p>What actually works is treating talent as infrastructure, not as a labor arbitrage play. Pay for vetting. Pay for accountability systems. Pay for someone whose full-time job is making the placement productive. Either build that yourself, which takes 18 to 24 months and a six-figure investment, or buy it from a partner whose whole business is doing that for you.</p>

<h2>What "infrastructure" actually means</h2>

<p>A lot of companies say "managed VA" and what they mean is "we found someone on Upwork and added a markup." That's not infrastructure. That's brokerage.</p>

<p>Infrastructure is the stuff that makes a placement work whether the person is in your office or 8,000 miles away:</p>

<ul>
<li>A vetting pipeline that filters out 99% of applicants before you ever see a name</li>
<li>Documented role expectations so you and the placement agree on what success looks like in the first week</li>
<li>Performance monitoring that surfaces problems in week two, not month four</li>
<li>A replacement guarantee that makes turnover the placement company's problem, not yours</li>
<li>Onboarding scaffolding so the first thirty days aren't a black box</li>
</ul>

<p>If you're getting all five, the placement works regardless of geography. If you're getting none of them, it doesn't matter how much you paid. You bought a name on a contract, not a teammate.</p>

<h2>So which one does your business need?</h2>

<p>Run the four questions. Then map your answers to one of three paths.</p>

<p><strong>Path A. Process-heavy work, standardized operation, low client-facing surface, mid-to-high effective hourly rate.</strong> A vetted full-time VA with proper infrastructure wins on every dimension. You'll be productive in two weeks. The total cost loaded is one-quarter to one-third of a US hire. Quality risk is low if you don't cheap out on vetting.</p>

<p><strong>Path B. Mixed process and judgment work, partially standardized, moderate client-facing time.</strong> A vetted full-time VA still wins, but you need to invest in SOPs upfront. The placement company should help. If they don't, find a different one.</p>

<p><strong>Path C. Heavy judgment work, strategic decision-making, deep client relationships, role requires sitting across the table from someone.</strong> Now you're hiring for character and judgment as much as skill. A US employee may make sense, but more often what you actually need is a senior offshore operator paired with a specific kind of accountability layer. The category is real but the role is hard to fill. Plan a six-month timeline.</p>

<p>The mistake I see most often is owners who fit cleanly into Path A or B but hire for Path C because that's what their peers told them to do. They burn six months and $30K to learn that the work they actually needed done was 80% process the whole time.</p>

<h2>The cost of waiting</h2>

<p>The other mistake is just not deciding. Spending another quarter "thinking about it" while you do the $25-an-hour work yourself at your $80-an-hour rate. That's $55 an hour times every hour you spend on it. Twenty hours a week of that is over $50K a year you're leaving on the table by being the cheapest labor in your own business.</p>

<p>You hit this moment because the business is asking you to grow. The question isn't whether to hire. The question is what kind of hire moves you forward. Run the four-question test honestly, pick the right path, and put real infrastructure underneath it. The version of your business that comes out the other side looks nothing like the one you're running today.</p>"""
}

def main():
    topics_data = load_topics()
    topic = next_pending(topics_data)
    if not topic:
        print("No pending topic to seed. (Has one already been generated?)")
        sys.exit(2)

    if topic["slug"] != "first-employee-vs-va":
        print(f"Refusing to seed: next topic is '{topic['slug']}', not 'first-employee-vs-va'.")
        print("This seeder is only intended for the first post. Delete this file once seeded.")
        sys.exit(1)

    meta = render_post(topic, DRAFT)
    print(f"✓ wrote blog/{topic['slug']}/index.html")

    topic["status"] = "done"
    topic["published_iso"] = meta["published_iso"]
    save_topics(topics_data)
    print(f"✓ marked topic done in topics.json")

    regenerate_index()
    update_sitemap()
    print(f"\nSeeded. View: http://localhost:4200/blog/{topic['slug']}/")

if __name__ == "__main__":
    main()
