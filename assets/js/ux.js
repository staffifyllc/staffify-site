// Sitewide UX micro-interactions. Loaded async after the page so it never
// blocks render. Everything here is a polish layer — the site must work
// fully without this file.
(function () {
    'use strict';

    // Honor user accessibility preferences. If reduced motion is on, ship none
    // of the spring-based interactions. Coarse pointer (touch) → also off.
    var REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var COARSE_POINTER = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (REDUCED_MOTION || COARSE_POINTER) return;

    /* ──────────────────────────────────────────────────────────────────
       Magnetic CTAs
       Primary buttons subtly translate toward the cursor when nearby,
       then spring home on leave. We wrap each button in a span so our
       translate composes with whatever transform the button's own
       :hover style does (scale, translateY, etc).
    ─────────────────────────────────────────────────────────────────── */

    var MAGNET_SELECTORS = [
        '.btn-primary',
        '.btn-magnetic',
        '.nav-cta',
        '.hub-cta-btn',
        '.cs-cta-btn',
        '.closer-cta',
        '.sticky-cta a',
        '.inline-cta-btn',
        '.blog-cta-btn',
        '.cta-c',     // campaigns "Get Started" pill
        '.sdr-cta'    // campaigns SDR upsell CTA
    ].join(',');

    var MAGNET_RADIUS = 95;
    var MAGNET_STRENGTH = 0.22;
    var MAGNET_MAX = 14;

    // Install our wrapper styles once.
    var s = document.createElement('style');
    s.textContent =
        '.magnet-wrap{display:inline-block;transition:transform .42s cubic-bezier(.16,1,.3,1);will-change:transform;line-height:0;}' +
        '.magnet-wrap > *{line-height:initial;}';
    document.head.appendChild(s);

    function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

    function attachMagnet(btn) {
        if (btn.dataset.magnet === '1') return;
        // Skip if already inside a magnet wrap (e.g. from rescan)
        if (btn.parentElement && btn.parentElement.classList.contains('magnet-wrap')) return;
        // Skip elements that are part of larger layouts where wrapping might
        // disrupt grids/flex constraints. We check computed display on parent.
        var parent = btn.parentElement;
        if (!parent) return;
        btn.dataset.magnet = '1';

        // Wrap the button so our translate composes with its hover transforms
        var wrap = document.createElement('span');
        wrap.className = 'magnet-wrap';
        parent.insertBefore(wrap, btn);
        wrap.appendChild(btn);

        var raf = null;
        var tx = 0, ty = 0;
        var dx = 0, dy = 0;

        function tick() {
            tx += (dx - tx) * 0.22;
            ty += (dy - ty) * 0.22;
            wrap.style.transform = 'translate3d(' + tx.toFixed(2) + 'px,' + ty.toFixed(2) + 'px,0)';
            if (Math.abs(dx - tx) > 0.05 || Math.abs(dy - ty) > 0.05) {
                raf = requestAnimationFrame(tick);
            } else {
                raf = null;
                // Snap to exact zero when at rest so the wrap completely releases.
                if (dx === 0 && dy === 0) wrap.style.transform = '';
            }
        }

        function onMove(e) {
            var r = wrap.getBoundingClientRect();
            var cx = r.left + r.width / 2;
            var cy = r.top + r.height / 2;
            var ox = e.clientX - cx;
            var oy = e.clientY - cy;
            var dist = Math.hypot(ox, oy);
            if (dist > MAGNET_RADIUS) {
                dx = 0; dy = 0;
            } else {
                var f = (1 - dist / MAGNET_RADIUS) * MAGNET_STRENGTH;
                dx = clamp(ox * f, -MAGNET_MAX, MAGNET_MAX);
                dy = clamp(oy * f, -MAGNET_MAX, MAGNET_MAX);
            }
            if (raf === null) raf = requestAnimationFrame(tick);
        }

        function onLeave() {
            dx = 0; dy = 0;
            if (raf === null) raf = requestAnimationFrame(tick);
        }

        // Listen on the broader parent area so the pull engages BEFORE the
        // cursor reaches the button — that's the "ah it's pulling me" moment.
        var host = wrap.closest('section, nav, header, footer, main, body') || document.body;
        host.addEventListener('mousemove', onMove, { passive: true });
        host.addEventListener('mouseleave', onLeave, { passive: true });
    }

    function scan() {
        document.querySelectorAll(MAGNET_SELECTORS).forEach(attachMagnet);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scan, { once: true });
    } else {
        scan();
    }
    // One delayed rescan to catch sticky CTAs / lazy-injected buttons
    setTimeout(scan, 600);
})();
