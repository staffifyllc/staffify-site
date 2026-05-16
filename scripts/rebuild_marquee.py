#!/usr/bin/env python3
"""
Regenerate the home-page client logo marquee.

Scans /assets/clients/*.png and rebuilds the marquee HTML in index.html.
Run after dropping new logo PNGs into the folder.

Usage:
    python3 scripts/rebuild_marquee.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLIENTS = ROOT / 'assets/clients'
INDEX = ROOT / 'index.html'

def main():
    logos = sorted(CLIENTS.glob('*.png'))
    if not logos:
        print("No logos found in assets/clients/")
        return

    def alt(slug):
        return slug.replace('-', ' ').title()

    items = '\n        '.join(
        f'<div class="marquee-item"><img src="/assets/clients/{p.name}" '
        f'alt="{alt(p.stem)} client logo" loading="lazy"></div>'
        for p in logos
    )

    new_block = f'''<!-- ─── MARQUEE (client logos) ─── -->
<div class="marquee-section">
    <div class="marquee-eyebrow"><span class="dot">●</span>Trusted by service businesses across the US and abroad</div>
    <div class="marquee-wrap">
        <div class="marquee-track">
        {items}
        <!-- Duplicate for seamless infinite loop -->
        {items}
        </div>
    </div>
</div>'''

    content = INDEX.read_text()
    pattern = re.compile(
        r'<!-- ─── MARQUEE \(client logos\) ─── -->.*?</div>\s*</div>\s*</div>',
        re.DOTALL
    )
    new_content = pattern.sub(new_block, content, count=1)

    if new_content == content:
        print("⚠ Could not find marquee block to replace. Did the HTML structure change?")
        return

    INDEX.write_text(new_content)
    print(f"✓ Marquee rebuilt with {len(logos)} logos:")
    for p in logos:
        print(f"  · {p.name}")

if __name__ == '__main__':
    main()
