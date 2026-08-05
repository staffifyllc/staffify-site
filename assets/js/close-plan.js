/* Staffify AI Close Plan — shared client widget.
   Posts a call transcript to /api/call-review/ and renders the returned playbook.
   The Anthropic key lives server-side only; nothing sensitive is exposed here.
   Usage:
     StaffifyClosePlan.run(
       { mode:'prep', transcript, name, company, grade, phone },
       resultEl,   // a container element to render into
       btnEl       // the button that was clicked (for loading state)
     );
*/
(function () {
  if (window.StaffifyClosePlan) return;

  var STYLE_ID = 'sfy-cp-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.cp-btn{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid rgba(13,130,184,.5);background:linear-gradient(135deg,#0d82b8,#0d56a4);color:#fff;font-weight:700;font-size:12.5px;letter-spacing:.02em;cursor:pointer;box-shadow:0 2px 10px rgba(13,86,164,.25);transition:filter .15s,opacity .15s}' +
      '.cp-btn:hover{filter:brightness(1.08)}' +
      '.cp-btn:disabled,.cp-btn.cp-loading{opacity:.65;cursor:default}' +
      '.cp-btn::before{content:"\\2726";font-size:12px;opacity:.9}' +
      '.cp-out{margin-top:10px;display:none}' +
      '.cp-box{border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);border-radius:12px;padding:14px 15px;font-size:12.5px;color:#c9ced7;line-height:1.5}' +
      '.cp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px}' +
      '.cp-hl{font-weight:800;font-size:13.5px;color:#fff;line-height:1.35}' +
      '.cp-rate{white-space:nowrap;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid transparent}' +
      '.cp-rate b{font-size:12.5px;margin-right:2px}' +
      '.cp-hi{color:#7ff0c0;background:rgba(46,204,113,.12);border-color:rgba(46,204,113,.30)}' +
      '.cp-mid{color:#ffd98a;background:rgba(241,196,15,.12);border-color:rgba(241,196,15,.30)}' +
      '.cp-lo{color:#ffb4a8;background:rgba(231,76,60,.12);border-color:rgba(231,76,60,.30)}' +
      '.cp-open{margin:8px 0 10px;padding:9px 11px;border-left:3px solid #0d82b8;background:rgba(13,130,184,.08);border-radius:6px;font-style:italic;color:#e6eaf0}' +
      '.cp-open-l{display:block;font-style:normal;font-weight:800;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#5fb2d6;margin-bottom:3px}' +
      '.cp-sec{margin-top:10px}' +
      '.cp-sec-t{font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8fa0b3;margin-bottom:5px}' +
      '.cp-ul{margin:0;padding-left:16px}' +
      '.cp-ul li{margin:3px 0}' +
      '.cp-next{margin-top:12px;padding:10px 12px;border-radius:8px;background:linear-gradient(135deg,rgba(13,130,184,.16),rgba(13,86,164,.10));border:1px solid rgba(13,130,184,.30);font-weight:600;color:#eaf2f8}' +
      '.cp-next-l{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#5fb2d6;font-weight:800;margin-bottom:3px}' +
      '.cp-note{font-size:12px;color:#9ba1ab;padding:8px 2px}' +
      '.cp-pulse{animation:cpp 1.2s ease-in-out infinite}' +
      '@keyframes cpp{0%,100%{opacity:.5}50%{opacity:1}}';
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ratingChip(r) {
    if (!r || r.value == null) return '';
    var v = parseInt(r.value, 10);
    if (isNaN(v)) return '';
    v = Math.max(0, Math.min(100, v));
    var tone = v >= 75 ? 'cp-hi' : (v >= 50 ? 'cp-mid' : 'cp-lo');
    var label = esc(r.label || (r.kind === 'score' ? 'Score' : 'Confidence'));
    return '<span class="cp-rate ' + tone + '"><b>' + v + '</b>' + label + '</span>';
  }

  function render(obj) {
    if (!obj) return '<div class="cp-note">No response. Try again.</div>';
    if (obj.error === 'not_configured') return '<div class="cp-note">AI close plan is not switched on yet. Add the Anthropic key in Vercel and redeploy.</div>';
    if (obj.error === 'no_transcript') return '<div class="cp-note">' + esc(obj.headline || 'No transcript on this call yet, so there is nothing to build a plan from.') + '</div>';
    if (obj.error === 'rate_limited') return '<div class="cp-note">' + esc(obj.headline || 'The AI is busy right now. Give it a moment and try again.') + '</div>';
    if (obj.error) return '<div class="cp-note">' + esc(obj.headline || 'Could not build a plan right now. Try again in a moment.') + '</div>';

    var h = '';
    h += '<div class="cp-head"><div class="cp-hl">' + esc(obj.headline || 'Close plan') + '</div>' + ratingChip(obj.rating) + '</div>';
    if (obj.open_with) {
      h += '<div class="cp-open"><span class="cp-open-l">Open with</span>&ldquo;' + esc(obj.open_with) + '&rdquo;</div>';
    }
    (Array.isArray(obj.sections) ? obj.sections : []).forEach(function (sec) {
      if (!sec) return;
      h += '<div class="cp-sec"><div class="cp-sec-t">' + esc(sec.title || '') + '</div><ul class="cp-ul">';
      (Array.isArray(sec.bullets) ? sec.bullets : []).forEach(function (b) { h += '<li>' + esc(b) + '</li>'; });
      h += '</ul></div>';
    });
    if (obj.next_action) {
      h += '<div class="cp-next"><span class="cp-next-l">Next step</span>' + esc(obj.next_action) + '</div>';
    }
    return h;
  }

  function run(payload, outEl, btnEl) {
    injectStyle();
    if (!outEl) return Promise.resolve(null);
    var oldTxt = btnEl ? btnEl.textContent : '';
    if (btnEl) { btnEl.disabled = true; btnEl.classList.add('cp-loading'); btnEl.textContent = 'Building plan...'; }
    outEl.style.display = 'block';
    outEl.innerHTML = '<div class="cp-note cp-pulse">Reading the call and building your close plan...</div>';

    return fetch('/api/call-review/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
      .then(function (r) {
        return r.json().catch(function () { return { error: 'bad_json', headline: 'The AI service returned something unexpected.' }; });
      })
      .then(function (j) { outEl.innerHTML = '<div class="cp-box">' + render(j) + '</div>'; return j; })
      .catch(function () { outEl.innerHTML = '<div class="cp-note">Network error. Try again.</div>'; return null; })
      .then(function (j) {
        if (btnEl) { btnEl.disabled = false; btnEl.classList.remove('cp-loading'); btnEl.textContent = oldTxt || 'AI close plan'; }
        return j;
      });
  }

  // Render an already-fetched result object into a container (used to survive dashboard re-renders).
  function showInto(outEl, obj) {
    if (!outEl || !obj) return;
    injectStyle();
    outEl.style.display = 'block';
    outEl.innerHTML = '<div class="cp-box">' + render(obj) + '</div>';
  }

  injectStyle();
  window.StaffifyClosePlan = { run: run, render: render, showInto: showInto, esc: esc };
})();
