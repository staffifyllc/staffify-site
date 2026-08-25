// Sitewide lead-capture modal. Self-injecting: builds its own CSS + HTML and
// runs the show/dismiss/submit logic. Loaded once by ux.js on every public
// marketing page, so there is a single source of truth for the popup instead
// of a copy pasted into each page.
//
// Frequency: one impression per visitor. Submitted -> never again. Dismissed
// -> 14-day cooldown. Fires 30s after load, or on desktop exit-intent,
// whichever comes first.
//
// Signups POST to /api/subscribe (Upstash + Resend), tagged source
// 'delegation-popup', and enroll in the automated nurture drip.
(function () {
    'use strict';

    // Do not pop on the pages that ARE the free asset, or on funnel/confirm
    // pages. (Most of these do not load ux.js anyway; this is belt-and-braces.)
    var DENY = ['/delegate', '/playbook', '/start', '/thank-you'];
    var path = location.pathname.replace(/\/+$/, '') || '/';
    for (var i = 0; i < DENY.length; i++) {
        if (path === DENY[i] || path.indexOf(DENY[i] + '/') === 0) return;
    }
    // Explicit page-level opt-out and double-injection guard.
    if (document.documentElement.hasAttribute('data-no-lead')) return;
    if (document.getElementById('leadModal')) return;

    var SUBSCRIBE_ENDPOINT = '/api/subscribe/';
    var SHOW_AFTER_MS = 30000;
    var DISMISS_TTL_DAYS = 14;
    var STORAGE_KEY = 'sf_lead_modal_v1';

    // ───── Styles ─────
    var css =
        '.lead-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.78);backdrop-filter:blur(8px);z-index:99998;opacity:0;visibility:hidden;transition:opacity .3s,visibility .3s;}' +
        '.lead-modal-bg.open{opacity:1;visibility:visible;}' +
        '.lead-modal{position:fixed;top:50%;left:50%;transform:translate(-50%,-45%);width:min(540px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow-y:auto;background:linear-gradient(180deg,#0d0d0d 0%,#060606 100%);border:1px solid rgba(26,189,225,0.25);border-radius:20px;padding:44px 40px 36px;box-shadow:0 0 80px rgba(26,189,225,0.18),0 24px 60px rgba(0,0,0,0.6);z-index:99999;opacity:0;visibility:hidden;transition:opacity .35s cubic-bezier(.16,1,.3,1),transform .35s cubic-bezier(.16,1,.3,1),visibility .35s;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box;}' +
        '.lead-modal.open{opacity:1 !important;visibility:visible !important;transform:translate(-50%,-50%) !important;}' +
        '.lead-modal *{box-sizing:border-box;}' +
        '.lead-modal-close{position:absolute;top:14px;right:14px;width:32px;height:32px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:50%;color:rgba(255,255,255,0.5);cursor:pointer;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;transition:color .2s,border-color .2s;}' +
        '.lead-modal-close:hover{color:#fff;border-color:rgba(255,255,255,0.25);}' +
        '.lead-modal-eyebrow{font-size:12.5px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#1abde1;margin-bottom:18px;}' +
        '.lead-modal h2{font-size:clamp(22px,3vw,28px);font-weight:800;letter-spacing:-0.02em;line-height:1.2;color:#fff;margin:0 0 14px;}' +
        '.lead-modal h2 span{color:#1abde1;}' +
        '.lead-modal p{font-size:16px;color:rgba(255,255,255,0.6);line-height:1.6;margin:0 0 22px;}' +
        '.lead-modal ul{list-style:none;margin:0 0 24px;padding:0;}' +
        '.lead-modal ul li{font-size:15px;color:rgba(255,255,255,0.65);padding:5px 0;display:flex;gap:10px;align-items:flex-start;}' +
        '.lead-modal ul li::before{content:"\\2713";color:#1abde1;font-weight:700;flex-shrink:0;}' +
        '.lead-modal form{display:flex;gap:10px;flex-direction:column;margin:0;}' +
        '@media(min-width:480px){.lead-modal form{flex-direction:row;}}' +
        '.lead-modal input[type=email]{flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:999px;padding:13px 20px;color:#fff;font-family:inherit;font-size:16px;outline:none;transition:border-color .2s;}' +
        '.lead-modal input[type=email]::placeholder{color:rgba(255,255,255,0.35);}' +
        '.lead-modal input[type=email]:focus{border-color:#1abde1;}' +
        '.lead-modal button[type=submit]{background:#1abde1;color:#000;border:none;border-radius:999px;padding:13px 26px;font-family:inherit;font-size:16px;font-weight:700;cursor:pointer;white-space:nowrap;transition:filter .2s;}' +
        '.lead-modal button[type=submit]:hover{filter:brightness(1.1);}' +
        '.lead-modal button[type=submit]:disabled{opacity:0.6;cursor:wait;}' +
        '.lead-modal-proof{margin:20px 0 0;font-size:13px;color:rgba(255,255,255,0.45);display:flex;align-items:center;gap:8px;}' +
        '.lead-modal-proof b{color:rgba(255,255,255,0.8);font-weight:700;}' +
        '.lead-modal-foot{margin-top:14px;font-size:12.5px;color:rgba(255,255,255,0.35);}' +
        '.lead-modal-success{text-align:center;padding:10px 0;}' +
        '.lead-modal-success a{display:inline-block;margin-top:14px;background:#1abde1;color:#000;padding:12px 26px;border-radius:999px;text-decoration:none;font-weight:700;font-size:16px;}' +
        '.lead-modal-error{color:#ff7070;font-size:15px;margin-top:12px;text-align:center;}';
    var styleEl = document.createElement('style');
    styleEl.id = 'leadModalStyle';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    // ───── Markup ─────
    var wrap = document.createElement('div');
    wrap.innerHTML =
        '<div class="lead-modal-bg" id="leadModalBg" aria-hidden="true"></div>' +
        '<div class="lead-modal" id="leadModal" role="dialog" aria-modal="true" aria-labelledby="leadModalTitle" aria-hidden="true">' +
            '<button type="button" class="lead-modal-close" id="leadModalClose" aria-label="Close">✕</button>' +
            '<div id="leadModalForm">' +
                '<div class="lead-modal-eyebrow">Free delegation framework</div>' +
                '<h2 id="leadModalTitle">The <span>Delegation Playbook</span></h2>' +
                '<p>The framework growing service businesses use to decide what to take off their plate first, and who to hand it to. Ten roles ranked by ROI, with the hours and dollars each one gives back.</p>' +
                '<ul>' +
                    '<li>The 10 highest-ROI delegations, ranked</li>' +
                    '<li>Hours saved and dollars recaptured per role</li>' +
                    '<li>How to hand off without dropping the ball</li>' +
                '</ul>' +
                '<form id="leadModalFormEl" novalidate>' +
                    '<input type="email" name="email" placeholder="your@email.com" required autocomplete="email">' +
                    '<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;">' +
                    '<button type="submit">Send me the framework →</button>' +
                '</form>' +
                '<div class="lead-modal-error" id="leadModalError" style="display:none;"></div>' +
                '<div class="lead-modal-proof">Built from <b>120+ real placements</b> across service businesses.</div>' +
                '<div class="lead-modal-foot">No spam. Unsubscribe in one click.</div>' +
            '</div>' +
            '<div class="lead-modal-success" id="leadModalSuccess" style="display:none;">' +
                '<div class="lead-modal-eyebrow" style="color:#4ade80;">You’re in</div>' +
                '<h2>Check your inbox. The framework is on the way.</h2>' +
                '<p style="text-align:center;">Or read it right now in your browser.</p>' +
                '<a href="/delegate/" target="_blank" rel="noopener">Read the Playbook →</a>' +
            '</div>' +
        '</div>';
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

    var bg = document.getElementById('leadModalBg');
    var modal = document.getElementById('leadModal');
    var closeBtn = document.getElementById('leadModalClose');
    var form = document.getElementById('leadModalFormEl');
    var formWrap = document.getElementById('leadModalForm');
    var success = document.getElementById('leadModalSuccess');
    var errBox = document.getElementById('leadModalError');

    function getState() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) { return {}; } }
    function setState(s) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) {} }
    function shouldShow() {
        var s = getState();
        if (s.submitted) return false;
        if (s.dismissedAt && (Date.now() - s.dismissedAt) < DISMISS_TTL_DAYS * 86400000) return false;
        return true;
    }
    function openModal() {
        if (!shouldShow()) return;
        modal.classList.add('open');
        bg.classList.add('open');
        modal.style.opacity = '1';
        modal.style.visibility = 'visible';
        modal.style.transform = 'translate(-50%, -50%)';
        bg.style.opacity = '1';
        bg.style.visibility = 'visible';
        modal.setAttribute('aria-hidden', 'false');
        bg.setAttribute('aria-hidden', 'false');
    }
    function closeModal(persistDismiss) {
        modal.classList.remove('open');
        bg.classList.remove('open');
        modal.style.opacity = '0';
        modal.style.visibility = 'hidden';
        modal.style.transform = 'translate(-50%, -45%)';
        bg.style.opacity = '0';
        bg.style.visibility = 'hidden';
        modal.setAttribute('aria-hidden', 'true');
        bg.setAttribute('aria-hidden', 'true');
        if (persistDismiss) {
            var s = getState();
            s.dismissedAt = Date.now();
            setState(s);
        }
    }

    // Auto-show after delay
    if (shouldShow()) setTimeout(openModal, SHOW_AFTER_MS);

    // Exit-intent (desktop only)
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
        document.addEventListener('mouseleave', function (e) {
            if (e.clientY < 10 && shouldShow()) openModal();
        }, { passive: true });
    }

    closeBtn.addEventListener('click', function () { closeModal(true); });
    bg.addEventListener('click', function () { closeModal(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modal.classList.contains('open')) closeModal(true); });

    form.addEventListener('submit', function (e) {
        e.preventDefault();
        errBox.style.display = 'none';
        var email = form.email.value.trim();
        if (!email || email.indexOf('@') < 0) {
            errBox.textContent = 'Please enter a valid email.';
            errBox.style.display = 'block';
            return;
        }
        var btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        btn.textContent = 'Sending...';

        fetch(SUBSCRIBE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email, source: 'delegation-popup', website: (form.website && form.website.value) || '' })
        }).then(function (r) {
            if (!r.ok) throw new Error('Status ' + r.status);
            return r.json();
        }).then(function () {
            var s = getState();
            s.submitted = true;
            s.email = email;
            setState(s);
            formWrap.style.display = 'none';
            success.style.display = 'block';
        }).catch(function (err) {
            console.error(err);
            errBox.textContent = 'Hmm, that didn’t go through. Try again or email hello@gostaffify.com.';
            errBox.style.display = 'block';
            btn.disabled = false;
            btn.textContent = 'Send me the framework →';
        });
    });
})();
