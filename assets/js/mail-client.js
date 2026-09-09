/* Send through Front, not Apple Mail.
 *
 * Paul, 2026-09-08: "we are using FRONT app to send emails, its right now opening the default mail app".
 * A mailto: link hands off to whatever the operating system registered, which on these Macs is Apple Mail.
 * Front documents three ways in (help.front.com/t/y7249s):
 *   front-web      https://app.frontapp.com/compose?mailto=<encoded mailto>   works anywhere, no setup
 *   front-desktop  mailto-frontapp:...                                        needs the desktop app installed
 *   default        mailto:...                                                 the OS handler
 *
 * This rewrites every mailto link on the page at click time. It reads the same 'sfy_mailclient' key the
 * dialer's compose button writes, so a rep sets it once and both obey it.
 *
 * Front's plain-text body parameter is `text`. Its `body` is treated as HTML, which would swallow the
 * line breaks, so any body carried on the link is moved across to `text`.
 *
 * Only load this on rep tools. On a public marketing page a visitor's own mail app is the correct target.
 */
(function () {
  'use strict';
  function pref() {
    try { return localStorage.getItem('sfy_mailclient') || 'front-web'; } catch (e) { return 'front-web'; }
  }

  function rewrite(href) {
    var who = pref();
    if (who === 'default') return null;                 // leave it to the operating system
    var rest = href.replace(/^mailto:/i, '');
    var cut = rest.indexOf('?');
    var addr = cut === -1 ? rest : rest.slice(0, cut);
    var qs = cut === -1 ? '' : rest.slice(cut + 1);

    // Front wants plain text under `text`. Carry anything already on the link across unchanged.
    if (qs) qs = qs.replace(/(^|&)body=/, '$1text=');

    if (who === 'front-desktop') return 'mailto-frontapp:' + addr + (qs ? '?' + qs : '');
    return 'https://app.frontapp.com/compose?mailto=' +
      encodeURIComponent('mailto:' + addr + (qs ? '?' + qs : ''));
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="mailto:"]') : null;
    if (!a) return;
    var url = rewrite(a.getAttribute('href') || '');
    if (!url) return;
    ev.preventDefault();
    if (url.indexOf('https:') === 0) { window.open(url, '_blank', 'noopener'); return; }
    // A custom scheme needs a real anchor click. window.open can leave an orphaned blank tab behind.
    var t = document.createElement('a');
    t.href = url; t.style.display = 'none';
    document.body.appendChild(t); t.click();
    setTimeout(function () { t.remove(); }, 0);
  }, true);
})();
